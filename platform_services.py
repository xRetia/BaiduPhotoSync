"""Small platform boundary for desktop integration.

The rest of the application continues to use Qt widgets, QSettings, and the
existing sync/cache services. This module isolates only operations whose
implementation differs by operating system.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

from PySide6.QtCore import QStandardPaths, QUrl
from PySide6.QtGui import QDesktopServices


APPLICATION_DIRECTORY_NAME = "BaiduPhotoSync"


def app_data_directory() -> Path:
    """Return a writable per-user application directory on every desktop OS."""
    location = QStandardPaths.writableLocation(QStandardPaths.AppDataLocation)
    if location:
        return Path(location)
    # QStandardPaths normally supplies a directory after QApplication is
    # initialized. Keep a safe platform fallback for early-startup code.
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / APPLICATION_DIRECTORY_NAME
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / APPLICATION_DIRECTORY_NAME
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / APPLICATION_DIRECTORY_NAME


def open_system_viewer(path: Path) -> bool:
    """Request the desktop's default associated application for one local file."""
    return QDesktopServices.openUrl(QUrl.fromLocalFile(str(path.resolve())))


def clear_windows_registry_settings() -> None:
    """Remove the legacy QSettings registry key only where the registry exists."""
    if sys.platform != "win32":
        return
    try:
        import winreg

        key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Baidu", 0, winreg.KEY_ALL_ACCESS)
        try:
            winreg.DeleteKey(key, "BaiduPhotoSync")
        finally:
            winreg.CloseKey(key)
    except OSError:
        pass


def remove_application_data() -> None:
    """Delete current and historical per-user application data directories."""
    roots = {app_data_directory()}
    if sys.platform == "win32":
        appdata = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
        roots.update({appdata / "BaiduPhotoSync", appdata / "YikeSync"})
    for root in roots:
        shutil.rmtree(root, ignore_errors=True)


def migrate_legacy_windows_data() -> None:
    """Move an old Windows AppData folder once when the Qt path is empty."""
    if sys.platform != "win32":
        return
    legacy = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming")) / APPLICATION_DIRECTORY_NAME
    current = app_data_directory()
    if legacy == current or not legacy.exists() or current.exists():
        return
    try:
        current.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(legacy), str(current))
    except OSError:
        # A failed migration must never prevent startup. Existing runtime logic
        # will create fresh directories as required.
        return
