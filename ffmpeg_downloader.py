"""Secure on-demand Windows FFmpeg downloader for optional video compression."""
from __future__ import annotations

import hashlib
import os
import shutil
import time
import urllib.request
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from platform_services import app_data_directory


RELEASE_BASE = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download"
ARCHIVE_NAME = "ffmpeg-master-latest-win64-gpl.zip"
CHECKSUM_NAME = "checksums.sha256"
CHUNK_SIZE = 1024 * 512
ProgressCallback = Callable[[int, str], None]


class FFmpegDownloadError(RuntimeError):
    """The optional FFmpeg dependency could not be acquired safely."""


@dataclass(frozen=True)
class FFmpegDownloadResult:
    ffmpeg_path: Path
    ffprobe_path: Path
    downloaded: bool
    archive_sha256: str


def download_directory() -> Path:
    """Return a per-user writable application-data location for FFmpeg tools."""
    return app_data_directory() / "ffmpeg"


def _emit(progress: ProgressCallback | None, value: int, text: str) -> None:
    if progress:
        progress(max(0, min(100, int(value))), text)


def _read_checksum() -> str:
    url = f"{RELEASE_BASE}/{CHECKSUM_NAME}"
    try:
        with urllib.request.urlopen(url, timeout=25) as response:
            content = response.read().decode("utf-8", "replace")
    except OSError as exc:
        raise FFmpegDownloadError(f"无法读取 FFmpeg 校验文件：{type(exc).__name__}") from exc
    for line in content.splitlines():
        parts = line.strip().split()
        if len(parts) >= 2 and parts[-1].lstrip("*") == ARCHIVE_NAME:
            digest = parts[0].lower()
            if len(digest) == 64 and all(char in "0123456789abcdef" for char in digest):
                return digest
    raise FFmpegDownloadError("发布页校验文件中未找到目标 Windows FFmpeg 的 SHA-256。")


def _format_mib(value: float) -> str:
    return f"{value / 1024 / 1024:.1f} MB"


def _format_speed(value: float) -> str:
    return f"{value / 1024 / 1024:.1f} MB/秒"


def _download_archive(target: Path, progress: ProgressCallback | None) -> str:
    url = f"{RELEASE_BASE}/{ARCHIVE_NAME}"
    temporary = target.with_suffix(".part")
    try:
        with urllib.request.urlopen(url, timeout=30) as response, temporary.open("wb") as output:
            total = int(response.headers.get("Content-Length") or 0)
            digest = hashlib.sha256()
            downloaded = 0
            started = time.monotonic()
            while True:
                block = response.read(CHUNK_SIZE)
                if not block:
                    break
                output.write(block)
                digest.update(block)
                downloaded += len(block)
                elapsed = max(0.05, time.monotonic() - started)
                speed = downloaded / elapsed
                if total:
                    percentage = 5 + int(downloaded / total * 80)
                    text = f"正在下载 FFmpeg：{_format_mib(downloaded)} / {_format_mib(total)} · {_format_speed(speed)}"
                else:
                    percentage = 5
                    text = f"正在下载 FFmpeg：{_format_mib(downloaded)} · {_format_speed(speed)}"
                _emit(progress, percentage, text)
        temporary.replace(target)
        return digest.hexdigest().lower()
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise FFmpegDownloadError(f"FFmpeg 下载失败：{type(exc).__name__}") from exc


def _extract_tools(archive: Path, destination: Path) -> tuple[Path, Path]:
    """Install the two Windows executables without replacing their directory.

    Windows can deny a directory-level ``Path.replace`` even when no visible
    BaiduPhotoSync window is open: Explorer, Defender, or a previous ffmpeg
    child process can hold the AppData directory briefly.  The prior release's
    compatible behaviour was effectively file-based.  Extract to a sibling
    staging directory, then replace only the two executable files, retaining
    per-file backups until both promotions have completed.
    """
    nonce = f"{os.getpid()}-{time.time_ns()}"
    stage = destination.parent / f".ffmpeg_extracting-{nonce}"
    pending: dict[Path, Path] = {}
    backups: dict[Path, Path] = {}
    promoted: list[Path] = []
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive) as zip_file:
            names = {Path(info.filename).name: info for info in zip_file.infolist()}
            required = ((names.get("ffmpeg.exe"), "ffmpeg.exe"), (names.get("ffprobe.exe"), "ffprobe.exe"))
            if any(info is None for info, _name in required):
                raise FFmpegDownloadError("下载包中缺少 ffmpeg.exe 或 ffprobe.exe。")
            for info, name in required:
                assert info is not None
                with zip_file.open(info) as source, (stage / name).open("wb") as output:
                    shutil.copyfileobj(source, output)

        try:
            destination.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise FFmpegDownloadError("无法创建 FFmpeg 安装目录，请确认当前 Windows 用户具有应用数据目录写入权限。") from exc

        for name in ("ffmpeg.exe", "ffprobe.exe"):
            target = destination / name
            staged_file = stage / name
            pending_file = destination / f".{name}.installing-{nonce}"
            shutil.copy2(staged_file, pending_file)
            pending[target] = pending_file

        for target, pending_file in pending.items():
            backup = target.with_name(f".{target.name}.backup-{nonce}")
            if target.exists():
                try:
                    target.replace(backup)
                except PermissionError as exc:
                    raise FFmpegDownloadError(
                        f"{target.name} 正被占用。请结束正在运行的视频压缩任务后重试。"
                    ) from exc
                backups[target] = backup
            try:
                pending_file.replace(target)
                promoted.append(target)
            except PermissionError as exc:
                raise FFmpegDownloadError(
                    f"无法更新 {target.name}。请关闭占用 FFmpeg 的程序或安全软件扫描后重试。"
                ) from exc

        for backup in backups.values():
            backup.unlink(missing_ok=True)
        return destination / "ffmpeg.exe", destination / "ffprobe.exe"
    except FFmpegDownloadError:
        for target in reversed(promoted):
            backup = backups.get(target)
            try:
                target.unlink(missing_ok=True)
                if backup is not None and backup.exists():
                    backup.replace(target)
            except OSError:
                pass
        for target, backup in backups.items():
            if target not in promoted:
                try:
                    if not target.exists() and backup.exists():
                        backup.replace(target)
                except OSError:
                    pass
        raise
    except (OSError, zipfile.BadZipFile) as exc:
        for target in reversed(promoted):
            backup = backups.get(target)
            try:
                target.unlink(missing_ok=True)
                if backup is not None and backup.exists():
                    backup.replace(target)
            except OSError:
                pass
        raise FFmpegDownloadError(f"FFmpeg 解压或安装失败：{type(exc).__name__}") from exc
    finally:
        for pending_file in pending.values():
            pending_file.unlink(missing_ok=True)
        for target, backup in backups.items():
            try:
                if backup.exists() and target.exists():
                    backup.unlink(missing_ok=True)
            except OSError:
                pass
        shutil.rmtree(stage, ignore_errors=True)


def ensure_windows_ffmpeg(progress: ProgressCallback | None = None) -> FFmpegDownloadResult:
    """Download the optional Windows GPL static build once, with SHA-256 validation."""
    if os.name != "nt":
        raise FFmpegDownloadError("按需下载仅支持 Windows；请在 Windows 程序中启用视频压缩。")
    destination = download_directory()
    ffmpeg = destination / "ffmpeg.exe"
    ffprobe = destination / "ffprobe.exe"
    if ffmpeg.is_file() and ffprobe.is_file():
        _emit(progress, 100, "已检测到 FFmpeg，视频压缩可以使用。")
        return FFmpegDownloadResult(ffmpeg, ffprobe, False, "")

    destination.parent.mkdir(parents=True, exist_ok=True)
    archive = destination.parent / ARCHIVE_NAME
    _emit(progress, 2, "正在读取 FFmpeg 发布校验信息…")
    expected_sha256 = _read_checksum()
    _emit(progress, 5, "已获取校验信息，开始下载 FFmpeg…")
    actual_sha256 = _download_archive(archive, progress)
    _emit(progress, 87, "正在校验 FFmpeg 下载完整性…")
    if actual_sha256 != expected_sha256:
        archive.unlink(missing_ok=True)
        raise FFmpegDownloadError("FFmpeg SHA-256 校验失败，已删除下载文件。")
    _emit(progress, 93, "校验通过，正在安装 FFmpeg…")
    ffmpeg, ffprobe = _extract_tools(archive, destination)
    archive.unlink(missing_ok=True)
    _emit(progress, 100, "FFmpeg 已下载并校验完成。")
    return FFmpegDownloadResult(ffmpeg, ffprobe, True, actual_sha256)
