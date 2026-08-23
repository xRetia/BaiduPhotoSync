"""Persistent local scan cache for one sync root.

The cache stores only file metadata and validation results, never file content,
checksums, Cookies, or remote account data.  A cached verdict is reused only
when the file's relative path, size, mtime_ns, and ctime_ns all match.
"""
from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Optional, Tuple


CACHE_DIRECTORY_NAME = ".yike_cache"
CACHE_FILE_NAME = "local_media_validation_v2.json"
CACHE_VERSION = 2


class LocalScanCache:
    """Best-effort, process-safe-on-write cache for local media verdicts."""

    def __init__(self, root: Path):
        self.root = root
        self.directory = root / CACHE_DIRECTORY_NAME
        self.path = self.directory / CACHE_FILE_NAME
        self._lock = threading.RLock()
        self._entries: dict[str, dict[str, object]] = {}
        self._dirty = False
        self._load()

    @staticmethod
    def _metadata(path: Path) -> tuple[int, int, int]:
        stat = path.stat()
        return int(stat.st_size), int(stat.st_mtime_ns), int(stat.st_ctime_ns)

    def _key(self, path: Path) -> str:
        return path.relative_to(self.root).as_posix()

    def _load(self) -> None:
        try:
            payload = json.loads(self.path.read_text(encoding="utf-8"))
            if payload.get("version") != CACHE_VERSION or not isinstance(payload.get("entries"), dict):
                return
            self._entries = payload["entries"]
        except (OSError, ValueError, TypeError):
            # A missing/corrupt cache must never block a sync scan.
            self._entries = {}

    def lookup(self, path: Path) -> Optional[Tuple[bool, str]]:
        try:
            size, mtime_ns, ctime_ns = self._metadata(path)
            key = self._key(path)
        except (OSError, ValueError):
            return None
        with self._lock:
            entry = self._entries.get(key)
            if not isinstance(entry, dict):
                return None
            if (
                entry.get("size") != size
                or entry.get("mtime_ns") != mtime_ns
                or entry.get("ctime_ns") != ctime_ns
                or not isinstance(entry.get("is_media"), bool)
                or not isinstance(entry.get("message"), str)
            ):
                return None
            return bool(entry["is_media"]), str(entry["message"])

    def record(self, path: Path, is_media: bool, message: str) -> None:
        try:
            size, mtime_ns, ctime_ns = self._metadata(path)
            key = self._key(path)
        except (OSError, ValueError):
            return
        with self._lock:
            self._entries[key] = {
                "size": size,
                "mtime_ns": mtime_ns,
                "ctime_ns": ctime_ns,
                "is_media": bool(is_media),
                "message": str(message),
            }
            self._dirty = True

    def prune(self, live_keys: set[str]) -> None:
        with self._lock:
            stale_keys = [key for key in self._entries if key not in live_keys]
            if stale_keys:
                for key in stale_keys:
                    self._entries.pop(key, None)
                self._dirty = True

    def save(self) -> None:
        with self._lock:
            if not self._dirty:
                return
            payload = {"version": CACHE_VERSION, "entries": self._entries}
            try:
                self.directory.mkdir(parents=True, exist_ok=True)
                temporary = self.path.with_suffix(".tmp")
                temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
                os.replace(temporary, self.path)
                self._dirty = False
                if os.name == "nt":
                    try:
                        import ctypes

                        ctypes.windll.kernel32.SetFileAttributesW(str(self.directory), 0x02)
                    except Exception:
                        pass
            except OSError:
                # Cache write failure must not fail or slow a user sync.
                return
