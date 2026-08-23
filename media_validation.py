"""Extension-based media file scan used before any remote upload.

Files are accepted or rejected by their filename extension alone.  Content
signatures are deliberately not inspected: camera JPEGs that embed extra
frames (for example Canon/MPO containers) were previously misread as a
different format and wrongly skipped.  Files that a local scan cannot
vouch for are still accepted here; if the remote service rejects one, the
sync marks only that file as skipped and continues.
"""
from __future__ import annotations

from pathlib import Path
from typing import Tuple

PHOTO_EXTENSIONS = frozenset({
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
    ".bmp", ".tif", ".tiff",
})
VIDEO_EXTENSIONS = frozenset({
    ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".wmv", ".flv",
    ".webm", ".3gp", ".3g2", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts",
})
MEDIA_EXTENSIONS = PHOTO_EXTENSIONS | VIDEO_EXTENSIONS

# 普通（非超级会员）账号的上传大小上限：超过会被服务端 precreate 接口拒绝
# （通常返回 errno=2）。照片与视频均 < 30MB。
FREE_USER_PHOTO_MAX_BYTES = 30 * 1024 * 1024
FREE_USER_VIDEO_MAX_BYTES = 30 * 1024 * 1024


def media_kind(path: Path) -> str | None:
    """Return 'photo' or 'video' by extension, else None."""
    suffix = path.suffix.casefold()
    if suffix in PHOTO_EXTENSIONS:
        return "photo"
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    return None


def format_size(num_bytes: int) -> str:
    """Human-readable size (KB below 1MB, MB otherwise)."""
    if num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.0f} KB"
    megabytes = num_bytes / (1024 * 1024)
    if megabytes < 10:
        return f"{megabytes:.1f} MB"
    return f"{megabytes:.0f} MB"


def validate_media_file(path: Path) -> Tuple[bool, str]:
    """Return whether *path* has a supported media extension and is non-empty.

    The message is suitable for the GUI plan table and never includes file
    content.  A failure here is a skip, not an upload failure.
    """
    suffix = path.suffix.casefold()
    if suffix not in MEDIA_EXTENSIONS:
        return False, f"扩展名 {suffix or '无'} 不属于支持的照片或视频格式"
    try:
        if path.stat().st_size == 0:
            return False, "文件为空"
    except OSError as exc:
        return False, f"无法读取文件：{type(exc).__name__}"
    return True, "有效照片" if suffix in PHOTO_EXTENSIONS else "有效视频"


def free_user_size_message(path: Path, size: "int | None" = None) -> "str | None":
    """Return a friendly explanation if *path* exceeds the free-tier limit.

    Returns None when the file is a supported media type within the limit (or
    not a media type at all).  *size* may be supplied to avoid a redundant
    stat; when omitted the file is stat'ed.  Only used for UPLOAD decisions.
    """
    kind = media_kind(path)
    if kind is None:
        return None
    if size is None:
        try:
            size = path.stat().st_size
        except OSError:
            return None
    if size is None:
        return None
    if kind == "video" and size > FREE_USER_VIDEO_MAX_BYTES:
        return (
            f"视频大小 {format_size(size)} 超过普通用户 30MB 上限，"
            "普通账号无法上传，需开通超级会员或压缩后上传"
        )
    if kind == "photo" and size > FREE_USER_PHOTO_MAX_BYTES:
        return (
            f"照片大小 {format_size(size)} 超过普通用户 30MB 上限，"
            "普通账号无法上传，需开通超级会员或压缩后上传"
        )
    return None
