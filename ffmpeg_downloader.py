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
    """Return a per-user writable location; never write into Program Files."""
    appdata = os.environ.get("APPDATA")
    base = Path(appdata) if appdata else Path.home() / "AppData" / "Roaming"
    return base / "YikeSync" / "ffmpeg"


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
    stage = destination.parent / ".ffmpeg_extracting"
    shutil.rmtree(stage, ignore_errors=True)
    stage.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(archive) as zip_file:
            names = {Path(info.filename).name: info for info in zip_file.infolist()}
            ffmpeg_info = names.get("ffmpeg.exe")
            ffprobe_info = names.get("ffprobe.exe")
            if ffmpeg_info is None or ffprobe_info is None:
                raise FFmpegDownloadError("下载包中缺少 ffmpeg.exe 或 ffprobe.exe。")
            for info, name in ((ffmpeg_info, "ffmpeg.exe"), (ffprobe_info, "ffprobe.exe")):
                with zip_file.open(info) as source, (stage / name).open("wb") as output:
                    shutil.copyfileobj(source, output)
        shutil.rmtree(destination, ignore_errors=True)
        stage.replace(destination)
        return destination / "ffmpeg.exe", destination / "ffprobe.exe"
    except (OSError, zipfile.BadZipFile) as exc:
        shutil.rmtree(stage, ignore_errors=True)
        raise FFmpegDownloadError(f"FFmpeg 解压失败：{type(exc).__name__}") from exc


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
