"""Windows-only encrypted storage for the Baidu login session.

The GUI obtains the Cookie text from an ephemeral Qt WebEngine profile.  The
session is stored only after the remote API independently validates it.  On
Windows it is protected with DPAPI for the current user; on another OS this
module intentionally refuses persistence rather than silently writing a raw
credential to disk.
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


class SessionStoreError(RuntimeError):
    """The local encrypted credential store cannot be used."""


class _DataBlob(Structure):
    _fields_ = [("cbData", DWORD), ("pbData", POINTER(c_char))]


def _as_blob(data: bytes) -> tuple[_DataBlob, object]:
    buffer = ctypes.create_string_buffer(data)
    return _DataBlob(len(data), ctypes.cast(buffer, POINTER(c_char))), buffer


def _protect_windows(plain: bytes) -> bytes:
    if sys.platform != "win32":
        raise SessionStoreError("当前系统不支持 Windows DPAPI，登录 Cookie 将仅保留在内存中。")
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
    if sys.platform != "win32":
        raise SessionStoreError("当前系统不支持读取 Windows DPAPI 登录会话。")
    source, source_buffer = _as_blob(cipher)
    destination = _DataBlob()
    crypt32 = ctypes.windll.crypt32
    kernel32 = ctypes.windll.kernel32
    crypt32.CryptUnprotectData.argtypes = [
        POINTER(_DataBlob), c_void_p, c_void_p, c_void_p, c_void_p, DWORD, POINTER(_DataBlob)
    ]
    crypt32.CryptUnprotectData.restype = ctypes.c_bool
    if not crypt32.CryptUnprotectData(byref(source), None, None, None, None, 0, byref(destination)):
        raise SessionStoreError("本机保存的登录会话无法解密，可能已换 Windows 用户或数据已损坏。")
    try:
        return ctypes.string_at(destination.pbData, destination.cbData)
    finally:
        kernel32.LocalFree(destination.pbData)


class SessionStore:
    """Store one validated session for the current Windows user only."""

    def __init__(self, settings: QSettings):
        self.settings = settings

    def load(self) -> str:
        """Return a saved session without logging it; empty means no usable value."""
        payload = str(self.settings.value(SESSION_SETTING_KEY, ""))
        if payload:
            try:
                return _unprotect_windows(base64.b64decode(payload.encode("ascii"))).decode("utf-8")
            except (ValueError, UnicodeDecodeError, SessionStoreError):
                self.clear()
                return ""
        # One-release migration path for the old application.  The raw value is
        # not copied until it passes verify_login(), at which point save() moves
        # it into DPAPI and removes this legacy setting.
        return str(self.settings.value(LEGACY_COOKIE_SETTING_KEY, ""))

    def save(self, cookie_text: str) -> None:
        if not cookie_text.strip():
            raise SessionStoreError("不能保存空的登录会话。")
        protected = _protect_windows(cookie_text.encode("utf-8"))
        self.settings.setValue(SESSION_SETTING_KEY, base64.b64encode(protected).decode("ascii"))
        self.settings.remove(LEGACY_COOKIE_SETTING_KEY)
        self.settings.sync()

    def clear(self) -> None:
        self.settings.remove(SESSION_SETTING_KEY)
        self.settings.remove(LEGACY_COOKIE_SETTING_KEY)
        self.settings.sync()
