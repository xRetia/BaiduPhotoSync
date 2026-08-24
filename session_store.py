"""Secure per-user storage for one validated Baidu login session.

Windows retains the existing DPAPI format. macOS and Linux use the operating
system credential service through ``keyring`` when a secure backend is
available. If no secure backend can be used, the caller receives an error and
keeps the session in memory only; Cookies are never written as plaintext.
"""
from __future__ import annotations

import base64
import ctypes
import sys
from ctypes import POINTER, Structure, byref, c_char, c_void_p
from ctypes.wintypes import DWORD

from PySide6.QtCore import QSettings


SESSION_SETTING_KEY = "login_cookie_dpapi_v1"
LEGACY_COOKIE_SETTING_KEY = "saved_cookie"
KEYRING_MARKER_KEY = "login_cookie_keyring_v1"
KEYRING_SERVICE_NAME = "BaiduPhotoSync"
KEYRING_ACCOUNT_NAME = "validated-baidu-session"


class SessionStoreError(RuntimeError):
    """The local encrypted credential store cannot be used."""


class _DataBlob(Structure):
    _fields_ = [("cbData", DWORD), ("pbData", POINTER(c_char))]


def _as_blob(data: bytes) -> tuple[_DataBlob, object]:
    buffer = ctypes.create_string_buffer(data)
    return _DataBlob(len(data), ctypes.cast(buffer, POINTER(c_char))), buffer


def _protect_windows(plain: bytes) -> bytes:
    source, source_buffer = _as_blob(plain)
    destination = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    crypt32.CryptProtectData.argtypes = [
        POINTER(_DataBlob), c_void_p, c_void_p, c_void_p, c_void_p, DWORD, POINTER(_DataBlob)
    ]
    crypt32.CryptProtectData.restype = ctypes.c_bool
    if not crypt32.CryptProtectData(byref(source), None, None, None, None, 0, byref(destination)):
        raise SessionStoreError(f"Windows DPAPI 加密失败（错误码 {ctypes.get_last_error()}）。")
    try:
        return ctypes.string_at(destination.pbData, destination.cbData)
    finally:
        kernel32.LocalFree(destination.pbData)


def _unprotect_windows(cipher: bytes) -> bytes:
    source, source_buffer = _as_blob(cipher)
    destination = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    crypt32.CryptUnprotectData.argtypes = [
        POINTER(_DataBlob), c_void_p, c_void_p, c_void_p, c_void_p, DWORD, POINTER(_DataBlob)
    ]
    crypt32.CryptUnprotectData.restype = ctypes.c_bool
    if not crypt32.CryptUnprotectData(byref(source), None, None, None, None, 0, byref(destination)):
        raise SessionStoreError("本机保存的登录会话无法解密，可能已更换系统用户或数据已损坏。")
    try:
        return ctypes.string_at(destination.pbData, destination.cbData)
    finally:
        kernel32.LocalFree(destination.pbData)


def _keyring_module():
    try:
        import keyring
    except ImportError as exc:
        raise SessionStoreError("未安装系统凭据存储组件，登录会话仅在本次运行有效。") from exc
    return keyring


class SessionStore:
    """Store one validated session for the current system user only."""

    def __init__(self, settings: QSettings):
        self.settings = settings

    def load(self) -> str:
        """Return a secure saved session; empty means no usable value."""
        if sys.platform == "win32":
            payload = str(self.settings.value(SESSION_SETTING_KEY, ""))
            if payload:
                try:
                    return _unprotect_windows(base64.b64decode(payload.encode("ascii"))).decode("utf-8")
                except (ValueError, UnicodeDecodeError, SessionStoreError):
                    self.clear()
                    return ""
            # Retain Windows-only migration for the former raw settings value.
            return str(self.settings.value(LEGACY_COOKIE_SETTING_KEY, ""))
        if not self.settings.value(KEYRING_MARKER_KEY, False, type=bool):
            return ""
        try:
            return _keyring_module().get_password(KEYRING_SERVICE_NAME, KEYRING_ACCOUNT_NAME) or ""
        except Exception:
            # A locked/unavailable keyring must not prompt the application to
            # remove credentials or write a plaintext fallback.
            return ""

    def save(self, cookie_text: str) -> None:
        if not cookie_text.strip():
            raise SessionStoreError("不能保存空的登录会话。")
        if sys.platform == "win32":
            protected = _protect_windows(cookie_text.encode("utf-8"))
            self.settings.setValue(SESSION_SETTING_KEY, base64.b64encode(protected).decode("ascii"))
            self.settings.remove(LEGACY_COOKIE_SETTING_KEY)
            self.settings.sync()
            return
        try:
            _keyring_module().set_password(KEYRING_SERVICE_NAME, KEYRING_ACCOUNT_NAME, cookie_text)
        except Exception as exc:
            raise SessionStoreError("系统凭据存储不可用，登录会话仅在本次运行有效。") from exc
        self.settings.setValue(KEYRING_MARKER_KEY, True)
        self.settings.sync()

    def clear(self) -> None:
        if sys.platform == "win32":
            self.settings.remove(SESSION_SETTING_KEY)
            self.settings.remove(LEGACY_COOKIE_SETTING_KEY)
        else:
            try:
                _keyring_module().delete_password(KEYRING_SERVICE_NAME, KEYRING_ACCOUNT_NAME)
            except Exception:
                pass
            self.settings.remove(KEYRING_MARKER_KEY)
        self.settings.sync()
