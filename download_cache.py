"""Persistent, non-sensitive media download cache.

Cached data is keyed by remote album and media identifiers. It contains only files
that the user explicitly downloaded or previewed; it never stores account cookies,
API responses, or application settings. Entries are evicted by least-recent access
when the configured capacity is exceeded.
"""
from __future__ import annotations

import os
import shutil
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class CacheResult:
    """A reusable local cache entry and whether it came from an existing file."""

    path: Path
    hit: bool


class DownloadCache:
    """Own one persistent cache directory with bounded LRU-style eviction."""

    def __init__(self, root: Path, max_bytes: int):
        self.root = root
        self.max_bytes = max(0, int(max_bytes))
        self._lock = threading.RLock()
        self._entry_locks: dict[tuple[str, str, str], threading.Lock] = {}

    @staticmethod
    def _safe_component(value: str) -> str:
        return "".join(character if character.isalnum() or character in "-_." else "_" for character in value)[:160] or "item"

    def _entry_directory(self, album_id: str, fsid: str, variant: str = "original") -> Path:
        root = self.root / self._safe_component(album_id) / self._safe_component(fsid)
        # Preserve the original-file layout used by earlier releases while
        # isolating thumbnail and preview bytes below the same media key.
        return root if variant == "original" else root / self._safe_component(variant)

    def _entry_files(self, album_id: str, fsid: str, variant: str = "original") -> list[Path]:
        directory = self._entry_directory(album_id, fsid, variant)
        if not directory.is_dir():
            return []
        return [path for path in directory.iterdir() if path.is_file() and not path.name.endswith(".part")]

    @staticmethod
    def _matches_expected_size(path: Path, expected_size: int) -> bool:
        try:
            return expected_size <= 0 or path.stat().st_size == expected_size
        except OSError:
            return False

    def lookup(self, album_id: str, fsid: str, expected_size: int = 0, variant: str = "original") -> Path | None:
        """Return a complete matching entry and update its access time."""
        with self._lock:
            for path in self._entry_files(album_id, fsid, variant):
                if self._matches_expected_size(path, expected_size):
                    try:
                        os.utime(path, None)
                    except OSError:
                        pass
                    return path
            return None

    def get_or_download(
        self,
        album_id: str,
        fsid: str,
        expected_size: int,
        downloader: Callable[[Path], Path],
        variant: str = "original",
    ) -> CacheResult:
        """Return an existing entry or download atomically into its cache slot."""
        key = (album_id, fsid, variant)
        with self._lock:
            entry_lock = self._entry_locks.setdefault(key, threading.Lock())
        # Separate media keep separate locks, preserving multi-client transfer
        # concurrency while preventing duplicate downloads of the same file.
        with entry_lock:
            hit = self.lookup(album_id, fsid, expected_size, variant)
            if hit is not None:
                return CacheResult(hit, True)
            entry_directory = self._entry_directory(album_id, fsid, variant)
            shutil.rmtree(entry_directory, ignore_errors=True)
            entry_directory.mkdir(parents=True, exist_ok=True)
            try:
                downloaded = downloader(entry_directory)
                downloaded = Path(downloaded)
                if not downloaded.is_file():
                    raise RuntimeError("下载客户端没有生成缓存文件。")
                if not self._matches_expected_size(downloaded, expected_size):
                    raise RuntimeError("下载文件大小与云端媒体信息不一致。")
                os.utime(downloaded, None)
                self.enforce_limit(protected_path=downloaded)
                return CacheResult(downloaded, False)
            except Exception:
                shutil.rmtree(entry_directory, ignore_errors=True)
                raise

    def size_bytes(self) -> int:
        with self._lock:
            if not self.root.exists():
                return 0
            total = 0
            for path in self.root.rglob("*"):
                try:
                    if path.is_file() and not path.name.endswith(".part"):
                        total += path.stat().st_size
                except OSError:
                    continue
            return total

    def enforce_limit(self, max_bytes: int | None = None, protected_path: Path | None = None) -> int:
        """Evict least-recently-used files until the cache fits its limit.

        ``protected_path`` is the file that a live download or preview operation
        is about to consume. It is retained for that operation even when one
        file alone exceeds the configured cache budget.
        """
        with self._lock:
            if max_bytes is not None:
                self.max_bytes = max(0, int(max_bytes))
            if self.max_bytes <= 0:
                return self.clear()
            entries: list[tuple[float, int, Path]] = []
            total = 0
            if self.root.exists():
                for path in self.root.rglob("*"):
                    try:
                        if path.is_file() and not path.name.endswith(".part"):
                            stat = path.stat()
                            total += stat.st_size
                            entries.append((stat.st_mtime, stat.st_size, path))
                    except OSError:
                        continue
            removed = 0
            protected = Path(protected_path) if protected_path is not None else None
            for _accessed, size, path in sorted(entries, key=lambda entry: entry[0]):
                if total <= self.max_bytes:
                    break
                if protected is not None and path == protected:
                    continue
                try:
                    path.unlink(missing_ok=True)
                    total -= size
                    removed += size
                    parent = path.parent
                    while parent != self.root and parent.exists() and not any(parent.iterdir()):
                        parent.rmdir()
                        parent = parent.parent
                except OSError:
                    continue
            return removed

    def clear(self) -> int:
        """Remove all cached media and return the number of bytes reclaimed."""
        with self._lock:
            removed = self.size_bytes()
            shutil.rmtree(self.root, ignore_errors=True)
            return removed
