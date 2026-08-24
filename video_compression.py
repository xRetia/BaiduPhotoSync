"""Local video preparation for the free-tier upload limit.

The synchronizer keeps the user's original file untouched.  When enabled, an
oversize supported video is encoded in a private temporary directory, uploaded
under its original filename, and then deleted locally after the upload worker
returns.  FFmpeg is expected to be packaged beside the app in ``ffmpeg/``.
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterator, Optional

from media_validation import FREE_USER_VIDEO_MAX_BYTES, media_kind


LOGGER = logging.getLogger(__name__)

# Stay below the service's nominal 30 MiB limit to leave room for container
# overhead and small bitrate-control deviations.
TARGET_UPLOAD_BYTES = 28 * 1024 * 1024
TARGET_SAFETY_RATIO = 0.94
AUDIO_BITRATE_BPS = 96 * 1024
AMF_LOW_BITRATE_BPS = 550 * 1024


class VideoCompressionError(RuntimeError):
    """A local video could not be prepared within the safe upload budget."""


@dataclass(frozen=True)
class VideoCompressionOptions:
    enabled: bool = False
    target_bytes: int = TARGET_UPLOAD_BYTES

    def to_worker_dict(self) -> dict:
        return {"enabled": bool(self.enabled), "target_bytes": int(self.target_bytes)}

    @classmethod
    def from_worker_dict(cls, raw: Optional[dict]) -> "VideoCompressionOptions":
        raw = raw or {}
        try:
            target_bytes = int(raw.get("target_bytes", TARGET_UPLOAD_BYTES))
        except (TypeError, ValueError):
            target_bytes = TARGET_UPLOAD_BYTES
        return cls(enabled=bool(raw.get("enabled", False)), target_bytes=target_bytes)


@dataclass(frozen=True)
class VideoProbe:
    duration_seconds: float
    width: int
    height: int
    has_audio: bool


@dataclass(frozen=True)
class CompressionResult:
    path: Path
    encoder: str
    width: int
    height: int
    video_bitrate_bps: int
    source_bytes: int
    output_bytes: int


def _resource_base() -> Path:
    """Return the unpacked PyInstaller resource directory or source directory."""
    frozen_base = getattr(sys, "_MEIPASS", None)
    return Path(frozen_base) if frozen_base else Path(__file__).resolve().parent


def _find_tool(name: str) -> Path:
    executable = f"{name}.exe" if sys.platform.startswith("win") else name
    candidates = [
        _resource_base() / "ffmpeg" / executable,
        Path(sys.executable).resolve().parent / "ffmpeg" / executable,
        Path(__file__).resolve().parent / "ffmpeg" / executable,
    ]
    # Optional Windows dependency downloaded after the user enables video
    # compression.  The directory is per-user writable, unlike Program Files.
    try:
        from ffmpeg_downloader import download_directory
        candidates.append(download_directory() / executable)
    except ImportError:
        pass
    # 兼容旧版本留下的 AppData/YikeSync/ffmpeg 路径。
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "YikeSync" / "ffmpeg" / executable)
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    discovered = shutil.which(name)
    if discovered:
        return Path(discovered)
    if sys.platform.startswith("win"):
        message = (
            "未检测到 Windows FFmpeg。请在“高级设置 → 视频”启用“压缩视频到30M以内”，"
            "程序会下载并校验所需组件。"
        )
    elif sys.platform == "darwin":
        message = "未检测到 macOS FFmpeg。请安装 ffmpeg 与 ffprobe，并确认它们位于 PATH 后重新启用视频压缩。"
    else:
        message = "未检测到 Linux FFmpeg。请安装 ffmpeg 与 ffprobe，并确认它们位于 PATH 后重新启用视频压缩。"
    raise VideoCompressionError(message)


def locate_ffmpeg() -> Path:
    return _find_tool("ffmpeg")


def locate_ffprobe() -> Path:
    return _find_tool("ffprobe")


def needs_compression(path: Path, options: VideoCompressionOptions) -> bool:
    if not options.enabled or media_kind(path) != "video":
        return False
    try:
        return path.stat().st_size > FREE_USER_VIDEO_MAX_BYTES
    except OSError as exc:
        raise VideoCompressionError(f"无法读取视频大小：{path.name}（{type(exc).__name__}）") from exc


def _run_capture(command: list[str], timeout: int = 30) -> str:
    try:
        completed = subprocess.run(
            command,
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise VideoCompressionError(f"无法运行 {' '.join(command[:2])}：{type(exc).__name__}") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "未知错误").strip()[-1200:]
        raise VideoCompressionError(f"FFmpeg 命令失败：{detail}")
    return completed.stdout


def probe_video(path: Path) -> VideoProbe:
    ffprobe = locate_ffprobe()
    raw = _run_capture(
        [
            str(ffprobe), "-v", "error", "-show_entries",
            "format=duration:stream=codec_type,width,height", "-of", "json", str(path),
        ]
    )
    try:
        info = json.loads(raw)
        duration = float(info.get("format", {}).get("duration", 0))
        streams = list(info.get("streams", []))
        video = next(item for item in streams if item.get("codec_type") == "video")
        width = int(video.get("width", 0))
        height = int(video.get("height", 0))
        has_audio = any(item.get("codec_type") == "audio" for item in streams)
    except (ValueError, TypeError, StopIteration, json.JSONDecodeError) as exc:
        raise VideoCompressionError(f"无法读取视频时长或分辨率：{path.name}") from exc
    if duration <= 0 or width <= 0 or height <= 0:
        raise VideoCompressionError(f"视频元数据无效：{path.name}")
    return VideoProbe(duration, width, height, has_audio)


def available_encoders() -> list[str]:
    """Return encoder names compiled into the packaged FFmpeg executable."""
    ffmpeg = locate_ffmpeg()
    text = _run_capture([str(ffmpeg), "-hide_banner", "-encoders"])
    result = []
    for encoder in ("h264_amf", "h264_nvenc", "h264_qsv", "libx264"):
        if any(encoder in line.split() for line in text.splitlines()):
            result.append(encoder)
    return result


_USABLE_ENCODERS_CACHE: list[str] | None = None


def usable_encoders() -> list[str]:
    """Probe the actual driver/device, not just the FFmpeg compile flags.

    FFmpeg may list NVENC, QSV or AMF even when the current PC lacks that GPU,
    its driver, or an enabled hardware session.  One tiny null-output encode is
    cheaper and much clearer than discovering that on every user video.
    """
    global _USABLE_ENCODERS_CACHE
    if _USABLE_ENCODERS_CACHE is not None:
        return list(_USABLE_ENCODERS_CACHE)
    ffmpeg = locate_ffmpeg()
    working: list[str] = []
    for encoder in available_encoders():
        command = [
            str(ffmpeg), "-hide_banner", "-loglevel", "error", "-f", "lavfi",
            "-i", "color=c=black:s=64x64:r=1:d=1", "-frames:v", "1",
            "-c:v", encoder, "-f", "null", "-",
        ]
        try:
            completed = subprocess.run(
                command,
                check=False,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=15,
            )
            if completed.returncode == 0:
                working.append(encoder)
        except (OSError, subprocess.TimeoutExpired):
            continue
    _USABLE_ENCODERS_CACHE = working
    LOGGER.info("FFmpeg 可用编码器探测完成：%s", ", ".join(working) or "无")
    return list(working)


def _encoder_order(video_bitrate_bps: int) -> list[str]:
    installed = usable_encoders()
    ordered = [item for item in ("h264_amf", "h264_nvenc", "h264_qsv") if item in installed]
    # AMD AMF is generally fast, but at very low bitrates the software encoder
    # is deliberately preferred for visual quality.  If another accelerator is
    # available it may still be tried before the CPU fallback.
    if "h264_amf" in ordered and video_bitrate_bps < AMF_LOW_BITRATE_BPS:
        ordered.remove("h264_amf")
    if "libx264" in installed:
        ordered.append("libx264")
    if not ordered:
        raise VideoCompressionError("未探测到可用的 h264_amf、h264_nvenc、h264_qsv 或 libx264 编码器。")
    return ordered


def _candidate_sizes(probe: VideoProbe) -> list[tuple[int, int]]:
    """Keep source resolution first, then reduce only as quality budget requires."""
    candidates: list[tuple[int, int]] = []
    for max_height in (probe.height, 1080, 720, 480):
        height = min(probe.height, max_height)
        height -= height % 2
        if height < 2:
            continue
        width = max(2, int(round(probe.width * height / probe.height)))
        width -= width % 2
        pair = (width, height)
        if pair not in candidates:
            candidates.append(pair)
    return candidates


def _minimum_video_bitrate_bps(height: int) -> int:
    if height >= 1080:
        return 1800 * 1024
    if height >= 720:
        return 1050 * 1024
    if height >= 480:
        return 600 * 1024
    return 400 * 1024


def _video_bitrate_budget(probe: VideoProbe, target_bytes: int) -> int:
    total_bps = int((max(1, target_bytes) * 8 * TARGET_SAFETY_RATIO) / probe.duration_seconds)
    audio_bps = AUDIO_BITRATE_BPS if probe.has_audio else 0
    # Keep a nonzero rate even for very long videos; 480p is then used and AMF
    # may fall back to libx264 for quality.
    return max(160 * 1024, total_bps - audio_bps)


def _ffmpeg_command(
    source: Path,
    output: Path,
    encoder: str,
    width: int,
    height: int,
    video_bitrate_bps: int,
    has_audio: bool,
) -> list[str]:
    ffmpeg = locate_ffmpeg()
    bitrate = str(max(1, int(video_bitrate_bps)))
    command = [
        str(ffmpeg), "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
        "-progress", "pipe:1", "-i", str(source), "-map", "0:v:0", "-map", "0:a?",
        "-vf", f"scale={width}:{height}", "-c:v", encoder,
        "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", str(max(1, int(video_bitrate_bps) * 2)),
        "-pix_fmt", "yuv420p",
    ]
    if encoder == "h264_amf":
        command.extend(["-usage", "transcoding", "-quality", "quality", "-rc", "vbr_peak", "-vbaq", "true"])
    elif encoder == "h264_nvenc":
        command.extend(["-preset", "p6", "-rc", "vbr"])
    elif encoder == "h264_qsv":
        command.extend(["-preset", "medium"])
    else:
        command.extend(["-preset", "medium"])
    if has_audio:
        command.extend(["-c:a", "aac", "-b:a", str(AUDIO_BITRATE_BPS)])
    else:
        command.append("-an")
    if output.suffix.casefold() == ".mp4":
        command.extend(["-movflags", "+faststart"])
    command.append(str(output))
    return command


def _run_encode(command: list[str], duration_seconds: float, progress: Optional[Callable[[int, str], None]]) -> None:
    try:
        process = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except OSError as exc:
        raise VideoCompressionError(f"无法启动 FFmpeg：{type(exc).__name__}") from exc
    tail: list[str] = []
    assert process.stdout is not None
    for raw_line in process.stdout:
        line = raw_line.strip()
        tail.append(line)
        if len(tail) > 30:
            tail.pop(0)
        if progress and line.startswith("out_time_ms="):
            try:
                elapsed = int(line.split("=", 1)[1]) / 1_000_000
                percentage = min(96, max(1, int(elapsed / duration_seconds * 96)))
                progress(percentage, f"正在压缩视频（{percentage}%）")
            except (TypeError, ValueError, ZeroDivisionError):
                pass
    returncode = process.wait()
    if returncode:
        detail = "\n".join(tail)[-1500:] or f"退出码 {returncode}"
        raise VideoCompressionError(f"FFmpeg 压缩失败：{detail}")


def compress_video(source: Path, output: Path, options: VideoCompressionOptions, progress: Optional[Callable[[int, str], None]] = None) -> CompressionResult:
    """Compress *source* into *output* without ever modifying the source file."""
    probe = probe_video(source)
    source_bytes = source.stat().st_size
    base_budget = _video_bitrate_budget(probe, options.target_bytes)
    last_error: Optional[Exception] = None
    for width, height in _candidate_sizes(probe):
        budget = base_budget
        # If the current resolution is not viable, move to the next lower
        # candidate before sacrificing visual quality at a needlessly low rate.
        if budget < _minimum_video_bitrate_bps(height):
            # Do not trade all visible detail for a technically smaller file.
            # Once 480p cannot hold its minimum quality rate, report that the
            # requested 28MB budget is infeasible for this video's duration.
            continue
        for attempt in range(3):
            for encoder in _encoder_order(budget):
                try:
                    if output.exists():
                        output.unlink()
                    if progress:
                        progress(1, f"使用 {encoder} 压缩为 {width}×{height}")
                    _run_encode(_ffmpeg_command(source, output, encoder, width, height, budget, probe.has_audio), probe.duration_seconds, progress)
                    output_bytes = output.stat().st_size
                    if output_bytes <= options.target_bytes:
                        if progress:
                            progress(100, f"压缩完成：{output_bytes / 1024 / 1024:.1f} MB，准备上传")
                        return CompressionResult(output, encoder, width, height, budget, source_bytes, output_bytes)
                    # Estimate a safe retry rate from the actual output size.
                    observed_ratio = options.target_bytes / max(1, output_bytes)
                    budget = max(160 * 1024, int(budget * observed_ratio * 0.94))
                    last_error = VideoCompressionError(
                        f"压缩后仍为 {output_bytes / 1024 / 1024:.1f} MB，继续降低码率"
                    )
                    break
                except VideoCompressionError as exc:
                    last_error = exc
                    LOGGER.warning("视频压缩尝试失败：编码器=%s，分辨率=%sx%s，错误=%s", encoder, width, height, exc)
                    continue
            else:
                continue
            # A retry is allowed only if the next bitrate is still reasonable
            # for the current resolution.  Otherwise the outer loop lowers it.
            if budget < _minimum_video_bitrate_bps(height):
                break
    raise VideoCompressionError(
        f"无法在 {options.target_bytes / 1024 / 1024:.0f} MB 内以可接受画质压缩：{source.name}"
    ) from last_error


@contextmanager
def prepared_video_upload(
    source: Path,
    options: VideoCompressionOptions,
    progress: Optional[Callable[[int, str], None]] = None,
) -> Iterator[CompressionResult | None]:
    """Yield a temporary compressed video when needed, then clean it securely."""
    if not needs_compression(source, options):
        yield None
        return
    temporary_directory = Path(tempfile.mkdtemp(prefix="yike-video-upload-"))
    output = temporary_directory / source.name
    try:
        result = compress_video(source, output, options, progress)
        yield result
    finally:
        shutil.rmtree(temporary_directory, ignore_errors=True)
