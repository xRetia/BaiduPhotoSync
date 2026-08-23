from __future__ import annotations

import hashlib
import logging
import multiprocessing as mp
import re
import os
import queue
import threading
import time
import unicodedata
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, as_completed, wait
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Callable, Iterable

from local_scan_cache import CACHE_DIRECTORY_NAME, LocalScanCache
from media_validation import free_user_size_message, media_kind, validate_media_file
from file_client_worker import run_file_client
from video_compression import VideoCompressionOptions
from remote_client import RemoteAlbum, RemoteMedia, YikeRemoteClient


LOGGER = logging.getLogger(__name__)

# A file client is deliberately short-lived and handles exactly one assigned
# media file. The master decides whether to create a replacement client.
FILE_CLIENT_MAX_ATTEMPTS = 3
FILE_CLIENT_BASE_TIMEOUT_SECONDS = 120
# Use a deliberately pessimistic uplink estimate.  The payload is one full
# multipart body, and real Wi-Fi / residential uplinks are often slower than
# 256 KiB/s once background traffic and TLS framing are included.
FILE_CLIENT_BYTES_PER_SECOND = 128 * 1024
FILE_CLIENT_MAX_TIMEOUT_SECONDS = 2 * 60 * 60
# The request wrapper makes the original request plus up to three replays on a
# rewound body.  The master must budget all four wire attempts; otherwise it
# can terminate a healthy slow client while its final replay is still sending.
FILE_CLIENT_TIMEOUT_ATTEMPTS = 4
# A whole-file multipart upload competes for the same local uplink.  Running
# several video-sized request bodies at once turns a healthy connection into
# per-socket write timeouts, so large payloads receive an exclusive transfer
# lane while small photos may still use the configured parallelism.
LARGE_FILE_SERIAL_UPLOAD_BYTES = 16 * 1024 * 1024
# The master must not submit an unbounded addfile list. A completed album is
# associated in sequential chunks of at most 50 FSIDs; 201 files become 50, 50,
# 50, 50, 1.
ALBUM_ASSOCIATION_BATCH_SIZE = 50
# A missing FSID may still be propagating after addfile. Keep retries sparse;
# the remote client itself performs several read-only visibility checks first.
ASSOCIATION_MASTER_RETRY_DELAYS_SECONDS = (15, 30)
# The 一刻相册 API rejects bursts with a rate-limit envelope (errno 50005 /
# 50000, errmsg "操作过于频繁"). Instead of giving up, the master commits the
# FSIDs uploaded so far and backs off with a growing wait capped at 30 minutes.
RATE_LIMIT_ERRNOS = {"50000", "50005"}
RATE_LIMIT_BASE_WAIT_SECONDS = 30
RATE_LIMIT_MAX_WAIT_SECONDS = 30 * 60
RATE_LIMIT_MAX_RETRIES = 6
RATE_LIMIT_CONSECUTIVE_PAUSE_THRESHOLD = 3


def _is_rate_limit_error(text: str) -> bool:
    """True for the API "operation too frequent" rejection envelopes."""
    if not text:
        return False
    if "操作过于频繁" in text or "请求过于频繁" in text or "过于频繁" in text:
        return True
    if "'errno': 50005" in text or "'errno': 50000" in text:
        return True
    if "errno=50005" in text or "errno=50000" in text:
        return True
    return False


_ERRMSG_RE = re.compile(r"errmsg['\"]?\s*:\s*['\"]([^'\"]+)['\"]")


def _extract_errmsg(text: str) -> str:
    """Pull the API's human-readable errmsg out of an envelope, if present."""
    match = _ERRMSG_RE.search(text or "")
    if not match:
        return ""
    return match.group(1).strip()


def _friendly_error(text: str) -> str:
    """Return a clean, user-facing description with no raw codes or JSON."""
    if not text:
        return "操作失败，请查看日志"
    # Prefer the API's own Chinese errmsg when it supplied one (e.g. the
    # 一刻相册 "操作过于频繁，请稍后再试" envelope).
    errmsg = _extract_errmsg(text)
    if errmsg:
        return errmsg
    if _is_rate_limit_error(text):
        return "接口请求过于频繁（限流）"
    if "50801" in text:
        return "文件过大或需要开通会员"
    if "errno=2" in text or "超过普通用户" in text:
        return "文件超过普通用户大小上限（照片/视频均 30MB），请开通超级会员或压缩后再试"
    if "网络" in text or "ConnectionError" in text or "连接中断" in text:
        return "网络连接中断"
    if "SSL" in text or "TLS" in text or "证书" in text:
        return "安全连接中断，已自动换新连接"
    if "超时" in text or "Timeout" in text:
        return "请求超时"
    return "上传或接口调用失败，请查看日志"


def _wait_with_control(seconds: float, control: "SyncControl | None") -> bool:
    """Sleep in short slices, returning False early if the user stops the sync.

    Suspends (without counting down) while the sync is paused, so a manual or
    rate-limit pause during a backoff wait resumes cleanly instead of spinning.
    """
    if seconds <= 0:
        return True
    end = time.monotonic() + float(seconds)
    while time.monotonic() < end:
        if control is not None:
            if control.stopped:
                return False
            if control.paused:
                if not control.wait_until_runnable():
                    return False
        time.sleep(1)
    return True


class SyncDirection(str, Enum):
    LOCAL_TO_REMOTE = "本地 → 云端"
    REMOTE_TO_LOCAL = "云端 → 本地"
    BIDIRECTIONAL = "双向"


class SortField(str, Enum):
    NAME = "按文件夹名称"
    MODIFIED = "按文件夹修改日期"
    CREATED = "按文件夹创建日期"


class FileCompareMode(str, Enum):
    """How local media is compared with an existing target-album snapshot."""

    SMART = "智能（推荐：同名视频压缩版 + 内容去重）"
    NAME_ONLY = "仅按文件名（同名即视为已同步）"
    CONTENT_FIRST = "内容优先（同名非视频内容不同标记冲突）"


class PlanAction(str, Enum):
    CREATE_REMOTE_ALBUM = "创建云端相册"
    CREATE_LOCAL_FOLDER = "创建本地文件夹"
    UPLOAD = "上传到云端"
    DOWNLOAD = "下载到本地"
    DELETE_REMOTE = "删除云端媒体"
    DELETE_LOCAL = "删除本地媒体"
    CONFLICT = "需要处理冲突"
    SKIP = "无需操作"


@dataclass(frozen=True)
class LocalFile:
    path: Path
    name: str
    size: int
    modified_at: int
    created_at: int

    def md5(self) -> str:
        digest = hashlib.md5()
        with self.path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()


@dataclass(frozen=True)
class LocalFolder:
    path: Path
    name: str
    modified_at: int
    created_at: int
    files: tuple[LocalFile, ...]
    skipped_files: tuple[tuple[str, str], ...] = ()


@dataclass
class SyncAction:
    sequence: int
    action: PlanAction
    album_name: str
    media_name: str = ""
    source: str = ""
    detail: str = ""
    local_path: Path | None = None
    remote_album_id: str | None = None
    remote_fsid: str | None = None
    size: int = 0
    status: str = "待执行"

    @property
    def can_execute(self) -> bool:
        return self.action not in {PlanAction.CONFLICT, PlanAction.SKIP}


ProgressCallback = Callable[[int, str], None]
StatusCallback = Callable[[int, str], None]
AlertCallback = Callable[[str], None]


class SyncControl:
    """Thread-safe cooperative control for a running sync plan."""

    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._paused = False
        self._stopped = False
        self._fault_reason = ""

    def pause(self) -> None:
        with self._condition:
            self._paused = True

    def resume(self) -> None:
        with self._condition:
            self._paused = False
            self._condition.notify_all()

    def stop(self) -> None:
        with self._condition:
            self._stopped = True
            self._paused = False
            self._condition.notify_all()

    def fail_all(self, reason: str) -> None:
        """Trip the controller-wide safety barrier after one client faults."""
        with self._condition:
            if not self._fault_reason:
                self._fault_reason = reason
            self._stopped = True
            self._paused = False
            self._condition.notify_all()

    @property
    def fault_reason(self) -> str:
        with self._condition:
            return self._fault_reason

    @property
    def faulted(self) -> bool:
        with self._condition:
            return bool(self._fault_reason)

    @property
    def stopped(self) -> bool:
        with self._condition:
            return self._stopped

    @property
    def paused(self) -> bool:
        with self._condition:
            return self._paused

    def wait_until_runnable(self) -> bool:
        """Block while paused; return False if a safe stop was requested."""
        with self._condition:
            while self._paused and not self._stopped:
                self._condition.wait(timeout=0.25)
            return not self._stopped


class SyncEngine:
    """Build and execute a conservative, filename-presence-based sync plan.

    A matching media filename on both sides is considered already present and is
    intentionally omitted from the executable plan.  This avoids duplicate
    uploads/downloads when the third-party API exposes incomplete metadata.
    """

    def __init__(
        self,
        client: YikeRemoteClient,
        max_workers: int = 2,
        list_threads: int = 4,
        compare_mode: FileCompareMode = FileCompareMode.SMART,
        compression_options: VideoCompressionOptions | None = None,
    ):
        self.client = client
        # The master owns this pool. Each short-lived client uploads one exact
        # file; album association remains in the single master lane. The UI
        # permits up to ten clients for controlled throughput validation.
        self.max_workers = max(1, min(int(max_workers), 10))
        # Snapshotting every album's media list is read-only and benefits from
        # modest parallelism; the UI exposes 1–16 threads (default 4).
        self.list_threads = max(1, min(int(list_threads), 16))
        self.compare_mode = FileCompareMode(compare_mode)
        self.compression_options = compression_options or VideoCompressionOptions()

    @staticmethod
    def _name_key(name: str) -> str:
        """Normalize names for Windows-friendly local/remote matching."""
        return unicodedata.normalize("NFC", Path(name).name).strip().casefold()

    @staticmethod
    def scan_local(root: Path) -> list[LocalFolder]:
        if not root.is_dir():
            raise ValueError("请选择有效的本地根目录。")
        folders: list[LocalFolder] = []
        cache = LocalScanCache(root)
        live_cache_keys: set[str] = set()
        cache_hits = 0
        cache_misses = 0
        for entry in root.iterdir():
            # The cache belongs to the sync root, not to the user's album tree.
            if not entry.is_dir() or entry.name == CACHE_DIRECTORY_NAME:
                continue
            stat = entry.stat()
            files = []
            skipped_files = []
            for child in entry.iterdir():
                if child.is_file() and not child.name.startswith("."):
                    try:
                        live_cache_keys.add(child.relative_to(root).as_posix())
                    except ValueError:
                        pass
                    cached_verdict = cache.lookup(child)
                    if cached_verdict is None:
                        cache_misses += 1
                        is_media, reason = validate_media_file(child)
                        cache.record(child, is_media, reason)
                    else:
                        cache_hits += 1
                        is_media, reason = cached_verdict
                    if not is_media:
                        skipped_files.append((child.name, reason))
                        continue
                    item_stat = child.stat()
                    files.append(
                        LocalFile(
                            path=child,
                            name=child.name,
                            size=item_stat.st_size,
                            modified_at=int(item_stat.st_mtime),
                            created_at=int(item_stat.st_ctime),
                        )
                    )
            folders.append(
                LocalFolder(
                    path=entry,
                    name=entry.name,
                    modified_at=int(stat.st_mtime),
                    created_at=int(stat.st_ctime),
                    files=tuple(sorted(files, key=lambda row: SyncEngine._name_key(row.name))),
                    skipped_files=tuple(sorted(skipped_files, key=lambda row: SyncEngine._name_key(row[0]))),
                )
            )
        cache.prune(live_cache_keys)
        cache.save()
        LOGGER.debug("本地媒体校验缓存：命中 %s，重新校验 %s", cache_hits, cache_misses)
        return folders

    @staticmethod
    def _sorted_folders(folders: Iterable[LocalFolder], field: SortField, reverse: bool) -> list[LocalFolder]:
        if field == SortField.MODIFIED:
            key = lambda item: (item.modified_at, SyncEngine._name_key(item.name))
        elif field == SortField.CREATED:
            key = lambda item: (item.created_at, SyncEngine._name_key(item.name))
        else:
            key = lambda item: SyncEngine._name_key(item.name)
        return sorted(folders, key=key, reverse=reverse)

    def _remote_snapshot(self, progress: ProgressCallback | None = None) -> tuple[list[RemoteAlbum], dict[str, list[RemoteMedia]]]:
        albums = self.client.list_albums()
        media_by_album: dict[str, list[RemoteMedia]] = {}
        total = len(albums)
        if not total:
            return albums, media_by_album

        LOGGER.debug("并行读取 %s 个云端相册的媒体列表（%s 线程）", total, self.list_threads)
        if progress:
            progress(5, f"正在并行读取 {total} 个云端相册（{self.list_threads} 线程）")

        # Each album carries its own lock inside the remote client, so fetching
        # different albums concurrently is safe.  The thread count is user-tuned
        # (default 4, range 1–16) and bounds the load on the rate-limited album
        # service while still speeding up the snapshot.
        media_by_album = {}
        with ThreadPoolExecutor(max_workers=self.list_threads) as pool:
            futures = {
                pool.submit(self.client.list_media, album.album_id): album
                for album in albums
            }
            completed = 0
            for future in as_completed(futures):
                album = futures[future]
                completed += 1
                try:
                    media_by_album[album.album_id] = future.result()
                except Exception as exc:  # noqa: BLE001 - surfaced to build_plan
                    LOGGER.error(
                        "读取相册媒体失败：%s，错误=%s", album.title, type(exc).__name__
                    )
                    raise
                LOGGER.debug("已读取相册 %s：%s 个媒体", album.title, len(media_by_album[album.album_id]))
                if progress:
                    progress(5 + int(completed / total * 25), f"正在读取云端相册：{album.title}（{completed}/{total}）")
        return albums, media_by_album

    @staticmethod
    def _same_file(local: LocalFile, remote: RemoteMedia) -> bool:
        if local.size != remote.size:
            return False
        if remote.md5:
            return local.md5().lower() == remote.md5.lower()
        return True

    def build_plan(
        self,
        root: Path,
        direction: SyncDirection,
        sort_field: SortField,
        reverse: bool,
        enable_deletions: bool,
        progress: ProgressCallback | None = None,
        ignored_album_names: Iterable[str] = (),
        skip_oversize: bool = False,
    ) -> list[SyncAction]:
        if progress:
            progress(0, "正在扫描本地文件夹")
        local_folders = self._sorted_folders(self.scan_local(root), sort_field, reverse)
        local_by_key = {self._name_key(folder.name): folder for folder in local_folders}
        remote_albums, remote_media = self._remote_snapshot(progress)
        remote_by_key: dict[str, RemoteAlbum] = {}
        for album in remote_albums:
            key = self._name_key(album.title)
            if key in remote_by_key:
                LOGGER.warning("云端存在归一化名称重复的相册：%s / %s；同步使用第一个相册", remote_by_key[key].title, album.title)
                continue
            remote_by_key[key] = album
        ignored_keys = {self._name_key(name) for name in ignored_album_names if name.strip()}

        actions: list[SyncAction] = []
        sequence = 1

        def add(action: PlanAction, album_name: str, media_name: str = "", **kwargs) -> None:
            nonlocal sequence
            actions.append(
                SyncAction(
                    sequence=sequence,
                    action=action,
                    album_name=album_name,
                    media_name=media_name,
                    **kwargs,
                )
            )
            sequence += 1

        def add_upload(local_file, album_name: str, remote_album_id: str | None, detail: str) -> None:
            """Add an UPLOAD action, or a SKIP when the file is over the
            free-tier size limit (when *skip_oversize* is enabled)."""
            oversize = free_user_size_message(local_file.path, local_file.size)
            if oversize and self.compression_options.enabled and media_kind(local_file.path) == "video":
                add(
                    PlanAction.UPLOAD,
                    album_name,
                    local_file.name,
                    local_path=local_file.path,
                    remote_album_id=remote_album_id,
                    size=local_file.size,
                    detail="视频超过普通用户 30MB 限制：将临时压缩至不超过 28MB 后以原文件名上传（本地高清原件保留）",
                )
                LOGGER.info("计划压缩后上传超限视频：%s/%s", album_name, local_file.name)
                return
            if oversize and skip_oversize:
                add(
                    PlanAction.SKIP,
                    album_name,
                    local_file.name,
                    local_path=local_file.path,
                    size=local_file.size,
                    detail=f"已跳过：{oversize}",
                )
                LOGGER.info("计划跳过超大小限制文件：%s/%s（%s）", album_name, local_file.name, oversize)
                return
            add(
                PlanAction.UPLOAD,
                album_name,
                local_file.name,
                local_path=local_file.path,
                remote_album_id=remote_album_id,
                size=local_file.size,
                detail=detail,
            )

        if direction == SyncDirection.LOCAL_TO_REMOTE:
            candidate_keys = list(local_by_key)
        elif direction == SyncDirection.REMOTE_TO_LOCAL:
            candidate_keys = list(remote_by_key)
        else:
            candidate_keys = list(set(local_by_key) | set(remote_by_key))

        def order_key(name_key: str):
            local_folder = local_by_key.get(name_key)
            remote_album = remote_by_key.get(name_key)
            label = local_folder.name if local_folder else (remote_album.title if remote_album else name_key)
            if sort_field == SortField.MODIFIED:
                timestamp = local_folder.modified_at if local_folder else (remote_album.modified_at if remote_album else 0)
                return (timestamp or 0, self._name_key(label))
            if sort_field == SortField.CREATED:
                timestamp = local_folder.created_at if local_folder else (remote_album.created_at if remote_album else 0)
                return (timestamp or 0, self._name_key(label))
            return (self._name_key(label),)

        total_albums = len(candidate_keys)
        for album_index, album_key in enumerate(sorted(candidate_keys, key=order_key, reverse=reverse), start=1):
            local_folder = local_by_key.get(album_key)
            remote_album = remote_by_key.get(album_key)
            album_name = local_folder.name if local_folder else (remote_album.title if remote_album else album_key)

            if progress:
                progress(30 + int(album_index / total_albums * 60), f"正在比较：{album_name}（{album_index}/{total_albums}）")

            if album_key in ignored_keys:
                add(PlanAction.SKIP, album_name, detail="已加入忽略列表")
                LOGGER.debug("跳过已忽略相册：%s", album_name)
                continue

            if local_folder is not None:
                for media_name, reason in local_folder.skipped_files:
                    add(
                        PlanAction.SKIP,
                        album_name,
                        media_name,
                        local_path=local_folder.path / media_name,
                        detail=f"跳过：非有效照片/视频（{reason}）",
                    )
                    LOGGER.debug("跳过非媒体文件：%s/%s，原因=%s", album_name, media_name, reason)

            if local_folder is None and remote_album is not None:
                if direction in {SyncDirection.REMOTE_TO_LOCAL, SyncDirection.BIDIRECTIONAL}:
                    add(PlanAction.CREATE_LOCAL_FOLDER, album_name, remote_album_id=remote_album.album_id, detail="云端相册仅存在于云端")
                    for media in remote_media.get(remote_album.album_id, []):
                        add(PlanAction.DOWNLOAD, album_name, media.name, remote_album_id=remote_album.album_id, remote_fsid=media.fsid, size=media.size, detail="下载云端新增媒体")
                else:
                    add(PlanAction.SKIP, album_name, detail="仅存在于云端；本地→云端模式不处理")
                continue

            if local_folder is not None and remote_album is None:
                if direction in {SyncDirection.LOCAL_TO_REMOTE, SyncDirection.BIDIRECTIONAL}:
                    add(PlanAction.CREATE_REMOTE_ALBUM, album_name, local_path=local_folder.path, detail="本地文件夹仅存在于本地")
                    for media in local_folder.files:
                        add_upload(media, album_name, None, "上传本地新增媒体")
                else:
                    add(PlanAction.SKIP, album_name, detail="仅存在于本地；云端→本地模式不处理")
                continue

            if local_folder is None or remote_album is None:
                continue

            before = len(actions)
            local_files: dict[str, LocalFile] = {}
            for item in local_folder.files:
                local_files.setdefault(self._name_key(item.name), item)
            remote_files: dict[str, RemoteMedia] = {}
            for item in remote_media.get(remote_album.album_id, []):
                key = self._name_key(item.name)
                if key in remote_files:
                    LOGGER.warning("相册 %s 有同名云端媒体：%s；同步按首个条目判断", album_name, item.name)
                    continue
                remote_files[key] = item

            # Name match is the fast path. The service can automatically add
            # a numeric suffix when another album uploads the same filename.
            # For the remaining names, pair by size + MD5 so an auto-renamed
            # remote copy is not uploaded again or flagged as missing.
            matched_local_keys: set[str] = set()
            matched_remote_keys: set[str] = set()
            for media_key in sorted(set(local_files) & set(remote_files)):
                local_file = local_files[media_key]
                remote_file = remote_files[media_key]
                if self._same_file(local_file, remote_file):
                    matched_local_keys.add(media_key)
                    matched_remote_keys.add(media_key)
                    LOGGER.debug("两端已有同名同内容媒体，跳过：%s/%s", album_name, local_file.name)
                elif media_kind(local_file.path) == "video":
                    # The user may keep a high-bitrate original locally while
                    # a ≤30 MiB rendition with the same filename lives in the
                    # album.  This is deliberately treated as synced in every
                    # mode: a re-upload would only replace a valid backup.
                    matched_local_keys.add(media_key)
                    matched_remote_keys.add(media_key)
                    LOGGER.info(
                        "同名视频的云端内容与本地不同；按云端压缩替代版本视为已同步：%s/%s（本地 %s bytes，云端 %s bytes）",
                        album_name,
                        local_file.name,
                        local_file.size,
                        remote_file.size,
                    )
                elif self.compare_mode in {FileCompareMode.SMART, FileCompareMode.NAME_ONLY}:
                    matched_local_keys.add(media_key)
                    matched_remote_keys.add(media_key)
                    LOGGER.debug("同名非视频媒体按当前对比模式视为已同步：%s/%s", album_name, local_file.name)
                else:
                    # Content-first mode makes non-video same-name divergence
                    # explicit instead of uploading or silently accepting it.
                    matched_local_keys.add(media_key)
                    matched_remote_keys.add(media_key)
                    add(
                        PlanAction.CONFLICT,
                        album_name,
                        local_file.name,
                        local_path=local_file.path,
                        remote_album_id=remote_album.album_id,
                        remote_fsid=remote_file.fsid,
                        size=local_file.size,
                        detail="同名非视频媒体的大小或 MD5 不同；内容优先模式要求人工确认",
                    )

            remote_by_signature: dict[tuple[int, str], list[tuple[str, RemoteMedia]]] = {}
            if self.compare_mode != FileCompareMode.NAME_ONLY:
                for media_key, remote_file in remote_files.items():
                    if not remote_file.md5:
                        continue
                    signature = (remote_file.size, remote_file.md5.lower())
                    remote_by_signature.setdefault(signature, []).append((media_key, remote_file))

                remote_candidate_sizes = {signature[0] for signature in remote_by_signature}
                for media_key, local_file in local_files.items():
                    if media_key in matched_local_keys or local_file.size not in remote_candidate_sizes:
                        continue
                    signature = (local_file.size, local_file.md5().lower())
                    candidates = remote_by_signature.get(signature, [])
                    if not candidates:
                        continue
                    # Do not consume the remote candidate.  The service deduplicates
                    # identical blobs and may expose only one target-album item for
                    # several local copies with different names.  Consuming the
                    # candidate makes every later alias look missing on the next
                    # plan, even though retrying can only return the same FSID.
                    remote_key, remote_file = candidates[0]
                    matched_local_keys.add(media_key)
                    matched_remote_keys.add(remote_key)
                    LOGGER.debug(
                        "检测到目标相册已有相同内容（含服务端自动改名或本地重复副本），跳过重复同步：%s/%s -> %s",
                        album_name,
                        local_file.name,
                        remote_file.name,
                    )

            for media_key in sorted(set(local_files) - matched_local_keys):
                local_file = local_files[media_key]
                if direction in {SyncDirection.LOCAL_TO_REMOTE, SyncDirection.BIDIRECTIONAL}:
                    add_upload(local_file, album_name, remote_album.album_id, "上传本地新增媒体")
                elif enable_deletions:
                    add(PlanAction.DELETE_LOCAL, album_name, local_file.name, local_path=local_file.path, size=local_file.size, detail="按云端→本地删除策略移除本地多余媒体")

            for media_key in sorted(set(remote_files) - matched_remote_keys):
                remote_file = remote_files[media_key]
                if direction in {SyncDirection.REMOTE_TO_LOCAL, SyncDirection.BIDIRECTIONAL}:
                    add(PlanAction.DOWNLOAD, album_name, remote_file.name, remote_album_id=remote_album.album_id, remote_fsid=remote_file.fsid, size=remote_file.size, detail="下载云端新增媒体")
                elif enable_deletions:
                    add(PlanAction.DELETE_REMOTE, album_name, remote_file.name, remote_album_id=remote_album.album_id, remote_fsid=remote_file.fsid, size=remote_file.size, detail="按本地→云端删除策略移除云端多余媒体")

            if len(actions) == before:
                add(PlanAction.SKIP, album_name, detail="两端已存在同名媒体，无需同步")

        if direction == SyncDirection.BIDIRECTIONAL and enable_deletions:
            add(PlanAction.CONFLICT, "", detail="双向模式不自动推断删除意图；已忽略删除策略。")

        if progress:
            progress(100, f"已生成 {len(actions)} 项同步计划")
        return actions

    def execute_plan(
        self,
        root: Path,
        actions: list[SyncAction],
        progress: ProgressCallback | None = None,
        control: SyncControl | None = None,
        status_callback: StatusCallback | None = None,
        alert_callback: "AlertCallback | None" = None,
    ) -> list[SyncAction]:
        executable = [
            action
            for action in actions
            if action.can_execute
            and (
                action.status in {"待执行", "已停止"}
                or action.status.startswith("失败")
                or action.status.startswith("错误")
                or action.status.startswith("待重试")
            )
        ]
        # When every executable operation already has an explicit remote album
        # ID, avoid a redundant full album-directory request. This matters when
        # the list endpoint is temporarily rate-limited while a known current
        # album is still safe to process under the master gate.
        requires_remote_lookup = any(
            action.action == PlanAction.CREATE_REMOTE_ALBUM
            or (
                action.action in {PlanAction.UPLOAD, PlanAction.DOWNLOAD, PlanAction.DELETE_REMOTE}
                and not action.remote_album_id
            )
            for action in executable
        )
        remote_ids = (
            {album.title: album.album_id for album in self.client.list_albums()}
            if requires_remote_lookup
            else {}
        )
        total = max(1, len(executable))
        completed = 0
        report_lock = threading.Lock()
        # Counts back-to-back rate-limit hits across every operation. Once it
        # reaches the threshold we pause the whole sync and alert the user
        # instead of hammering the API further.
        consecutive_rate_limit = 0

        def set_status(action: SyncAction, status: str) -> None:
            action.status = status
            if status_callback:
                status_callback(action.sequence, status)

        def report(action: SyncAction) -> None:
            nonlocal completed
            with report_lock:
                completed += 1
                current_completed = completed
            if progress:
                progress(
                    int(current_completed / total * 100),
                    f"{current_completed}/{total} {action.action.value}：{action.album_name} {action.media_name}（{action.status}）".strip(),
                )

        def wait_for_control(action: SyncAction) -> bool:
            if control is None:
                return True
            if control.paused:
                set_status(action, "已暂停，等待继续")
            if not control.wait_until_runnable():
                set_status(action, "已停止")
                return False
            return True

        def run_with_rate_limit_retry(fn, action: SyncAction) -> bool:
            """Run fn, retrying on rate-limit/transient errors with a growing wait.

            Returns True when fn succeeded. Returns False if the user stopped the
            sync, if a rate-limit pause fired, or if retries were exhausted. Any
            other error is re-raised so the caller records it.
            """
            nonlocal consecutive_rate_limit
            waits = 0
            while True:
                try:
                    fn()
                    consecutive_rate_limit = 0
                    return True
                except Exception as exc:  # noqa: BLE001
                    error_text = str(exc)
                    if _is_rate_limit_error(error_text):
                        consecutive_rate_limit += 1
                        friendly = _friendly_error(error_text)
                        if consecutive_rate_limit >= RATE_LIMIT_CONSECUTIVE_PAUSE_THRESHOLD and not (
                            control and control.paused
                        ):
                            # Too many rate-limit hits in a row: stop hammering
                            # the API and let the user decide when to continue.
                            if control is not None:
                                control.pause()
                            if alert_callback is not None:
                                alert_callback(
                                    "连续多次触发「操作过于频繁」（errno 50005）。已自动暂停同步，"
                                    "请稍候点击「继续」，或降低并发与读取线程数后再试。"
                                )
                            consecutive_rate_limit = 0
                            set_status(action, f"已跳过：{friendly}")
                            return False
                        if control and control.paused:
                            # Already paused for rate-limiting; stop retrying.
                            set_status(action, f"已跳过：{friendly}")
                            return False
                        if waits >= RATE_LIMIT_MAX_RETRIES:
                            set_status(action, f"已跳过：{friendly}（已多次重试仍失败）")
                            return False
                        wait = min(
                            RATE_LIMIT_BASE_WAIT_SECONDS * (2 ** waits),
                            RATE_LIMIT_MAX_WAIT_SECONDS,
                        )
                        set_status(
                            action,
                            "{}，等待 {} 秒后重试（第 {} 次）".format(friendly, wait, waits + 1),
                        )
                        if not _wait_with_control(wait, control):
                            set_status(action, f"已跳过：{friendly}（等待限流恢复期间已停止）")
                            return False
                        waits += 1
                        continue
                    raise

        def run_action(action: SyncAction) -> SyncAction:
            if not wait_for_control(action):
                return action
            try:
                set_status(action, "正在执行")
                LOGGER.debug("执行同步操作：%s %s/%s", action.action.value, action.album_name, action.media_name)
                if action.action == PlanAction.CREATE_REMOTE_ALBUM:
                    created = self.client.create_album(action.album_name)
                    remote_ids[action.album_name] = created.album_id
                elif action.action == PlanAction.CREATE_LOCAL_FOLDER:
                    (root / action.album_name).mkdir(parents=True, exist_ok=True)
                elif action.action == PlanAction.UPLOAD:
                    album_id = action.remote_album_id or remote_ids.get(action.album_name)
                    if not album_id or not action.local_path:
                        raise RuntimeError("同步计划缺少上传目标或本地文件。")
                    def upload_progress(value: int, message: str) -> None:
                        set_status(action, "正在上传并确认入册")
                        if progress:
                            fraction = max(0, min(100, value)) / 100
                            progress(int((completed + fraction) / total * 100), message)

                    self.client.upload_files(album_id, [action.local_path], upload_progress)
                elif action.action == PlanAction.DOWNLOAD:
                    album_id = action.remote_album_id or remote_ids.get(action.album_name)
                    if not album_id or not action.remote_fsid:
                        raise RuntimeError("同步计划缺少下载来源。")
                    if not run_with_rate_limit_retry(
                        lambda: self.client.download_media(album_id, action.remote_fsid, root / action.album_name),
                        action,
                    ):
                        return action
                elif action.action == PlanAction.DELETE_REMOTE:
                    if not action.remote_album_id or not action.remote_fsid:
                        raise RuntimeError("同步计划缺少云端删除目标。")
                    if not run_with_rate_limit_retry(
                        lambda: self.client.delete_media(action.remote_album_id, action.remote_fsid),
                        action,
                    ):
                        return action
                elif action.action == PlanAction.DELETE_LOCAL:
                    if not action.local_path:
                        raise RuntimeError("同步计划缺少本地删除目标。")
                    action.local_path.unlink(missing_ok=True)
                set_status(action, "已完成")
            except Exception as exc:  # noqa: BLE001 - shown in the plan table
                LOGGER.exception("同步操作失败：%s %s/%s", action.action.value, action.album_name, action.media_name)
                set_status(action, f"失败：{_friendly_error(str(exc))}")
            return action

        def run_one_file_client(action: SyncAction) -> SyncAction:
            """Execute exactly one upload+association in an isolated client."""
            if not wait_for_control(action):
                return action
            album_id = action.remote_album_id or remote_ids.get(action.album_name)
            if not album_id or not action.local_path:
                set_status(action, "失败：同步计划缺少上传目标或本地文件。")
                return action
            try:
                # A fresh context owns this one atomic file task. It reports
                # progress, then returns control to the master before another
                # file is ever dispatched.
                worker_client = self.client.create_isolated_album_client(album_id)
                set_status(action, "正在上传并确认入册")

                def upload_progress(value: int, message: str) -> None:
                    set_status(action, "正在上传并确认入册")
                    if progress:
                        fraction = max(0, min(100, value)) / 100
                        progress(int((completed + fraction) / total * 100), message)

                worker_client.upload_file_once(album_id, action.local_path, upload_progress)
                set_status(action, "已完成")
            except Exception as exc:  # noqa: BLE001 - preserved for master recovery
                LOGGER.exception("文件客户端失败：album=%s，文件=%s", action.album_name, action.media_name)
                set_status(action, f"失败：{_friendly_error(str(exc))}")
            return action

        # Setup is serial because the master must obtain stable target album
        # metadata before issuing file clients. All non-upload operations stay
        # in the master lane as well.
        setup_actions = [
            action for action in executable
            if action.action in {PlanAction.CREATE_REMOTE_ALBUM, PlanAction.CREATE_LOCAL_FOLDER}
        ]
        upload_actions = [action for action in executable if action.action == PlanAction.UPLOAD]
        trailing_actions = [
            action for action in executable
            if action.action not in {PlanAction.CREATE_REMOTE_ALBUM, PlanAction.CREATE_LOCAL_FOLDER, PlanAction.UPLOAD}
        ]
        fault_reason = ""
        for action in setup_actions:
            if control and control.stopped:
                break
            if fault_reason:
                set_status(action, "待重试：主控制器等待重新核对计划")
                report(action)
                continue
            run_action(action)
            report(action)
            if action.status.startswith("失败"):
                fault_reason = f"{action.album_name}/{action.action.value} 未确认完成"

        def timeout_for_file(action: SyncAction) -> int:
            # Conservative throughput estimate (256 KiB/s) plus request/album
            # association budget. File size is known from the master plan. The
            # single-file budget is multiplied by FILE_CLIENT_TIMEOUT_ATTEMPTS
            # so a slow large upload can exhaust its inner transport retries
            # before the master kills the process and restarts it.
            size = max(0, int(action.size or 0))
            single = FILE_CLIENT_BASE_TIMEOUT_SECONDS + int(size / FILE_CLIENT_BYTES_PER_SECOND)
            estimate = single * FILE_CLIENT_TIMEOUT_ATTEMPTS
            return min(FILE_CLIENT_MAX_TIMEOUT_SECONDS, max(FILE_CLIENT_BASE_TIMEOUT_SECONDS, estimate))

        # The master owns the queue. Each submitted client receives one exact
        # file action; a failed/timed-out client is discarded and never receives
        # another action. The master alone creates a replacement client for the
        # same file, up to FILE_CLIENT_MAX_ATTEMPTS.
        if not fault_reason and upload_actions and isinstance(self.client, YikeRemoteClient):
            # Album gate: the master works through albums in plan order. It uploads
            # at most one 50-item group from the current album, confirms that group
            # in the target album, and only then starts the next group or album.
            # Therefore no later album can receive payload uploads while the
            # current album has unconfirmed FSIDs.
            attempts = {action.sequence: 0 for action in upload_actions}
            reported_sequences = set()
            album_groups = []
            grouped_actions = {}
            for upload_action in upload_actions:
                upload_album_id = upload_action.remote_album_id or remote_ids.get(upload_action.album_name)
                if not upload_album_id or not upload_action.local_path:
                    set_status(upload_action, "错误：同步计划缺少上传目标或本地文件")
                    report(upload_action)
                    reported_sequences.add(upload_action.sequence)
                    continue
                if upload_album_id not in grouped_actions:
                    grouped_actions[upload_album_id] = []
                    album_groups.append((upload_album_id, grouped_actions[upload_album_id]))
                grouped_actions[upload_album_id].append(upload_action)
            process_context = mp.get_context("spawn")

            def close_client(process, client_queue) -> None:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=2)
                if process.is_alive():
                    process.kill()
                    process.join(timeout=2)
                client_queue.close()

            def run_album_upload_group(album_id: str, group_actions: list[SyncAction], batch_number: int) -> bool:
                nonlocal consecutive_rate_limit
                """Upload one group, then synchronously confirm its FSIDs in the album.

                A file whose client explicitly reports an upload failure is
                skipped for good; only ambiguous outcomes (no result at all)
                may spawn a replacement client.  Skipped files never block the
                remaining batches or albums.
                """
                pending = list(group_actions)
                active = {}
                uploaded_fsids = {}
                rate_limit_waits = {}

                def skip_upload(action: SyncAction, reason: str) -> None:
                    """Give up on one file and move on; see error.log for detail."""
                    set_status(action, f"已跳过：{_friendly_error(reason)}")
                    report(action)
                    reported_sequences.add(action.sequence)

                def finalize_group() -> None:
                    """Commit every uploaded FSID to the album and close its rows.

                    Safe to call repeatedly: it clears uploaded_fsids afterwards so
                    a later call only handles FSIDs collected since the last commit.
                    """
                    pending_fsids = set(uploaded_fsids.values())
                    confirmed = set()
                    if pending_fsids:
                        for association_attempt in range(1, FILE_CLIENT_MAX_ATTEMPTS + 1):
                            if control and control.stopped:
                                break
                            if control and control.paused and not control.wait_until_runnable():
                                break
                            for action in group_actions:
                                if uploaded_fsids.get(action.sequence) in pending_fsids:
                                    set_status(
                                        action,
                                        "当前相册第 {} 批统一加入相册（{} 项，尝试 {}/{}）".format(
                                            batch_number,
                                            len(pending_fsids),
                                            association_attempt,
                                            FILE_CLIENT_MAX_ATTEMPTS,
                                        ),
                                    )
                            try:
                                confirmed_now = self.client.associate_uploaded_fsids_once(
                                    album_id, sorted(pending_fsids)
                                )
                                confirmed.update(confirmed_now)
                                pending_fsids -= confirmed_now
                            except Exception:  # noqa: BLE001
                                LOGGER.exception(
                                    "当前相册批量关联失败：album_id=%s，批次=%s，尝试=%s/%s，FSID数=%s",
                                    album_id,
                                    batch_number,
                                    association_attempt,
                                    FILE_CLIENT_MAX_ATTEMPTS,
                                    len(pending_fsids),
                                )
                            if not pending_fsids:
                                break
                            if association_attempt < FILE_CLIENT_MAX_ATTEMPTS:
                                time.sleep(ASSOCIATION_MASTER_RETRY_DELAYS_SECONDS[association_attempt - 1])
                    for action in group_actions:
                        if action.sequence in reported_sequences:
                            continue
                        fsid = uploaded_fsids.get(action.sequence)
                        if not fsid:
                            continue
                        if fsid in confirmed:
                            set_status(action, "已完成")
                        else:
                            set_status(action, "错误：当前相册批次未确认加入，请查看日志")
                        report(action)
                        reported_sequences.add(action.sequence)
                    uploaded_fsids.clear()

                def retry_or_skip(action: SyncAction, attempt: int, reason: str) -> None:
                    if attempt < FILE_CLIENT_MAX_ATTEMPTS:
                        set_status(
                            action,
                            "{}，主控制器将新建客户端重试（第 {}/{} 次）".format(
                                reason, attempt + 1, FILE_CLIENT_MAX_ATTEMPTS
                            ),
                        )
                        pending.append(action)
                    else:
                        skip_upload(action, f"{reason}（已尝试 {attempt} 次，详见 error.log）")

                while pending or active:
                    if control and control.stopped:
                        # Kill in-flight file clients immediately so the sync
                        # stops now instead of letting orphaned uploads finish.
                        for process, state in list(active.items()):
                            close_client(process, state["queue"])
                        active.clear()
                        break
                    if control and control.paused and not active:
                        # No uploads in flight: block until the user resumes (or
                        # stops) the sync instead of starting the next batch.
                        if not control.wait_until_runnable():
                            break
                        continue
                    while pending and len(active) < self.max_workers and not (control and control.paused):
                        next_action = pending[0]
                        next_is_large = int(next_action.size or 0) >= LARGE_FILE_SERIAL_UPLOAD_BYTES
                        large_transfer_active = any(
                            int(state["action"].size or 0) >= LARGE_FILE_SERIAL_UPLOAD_BYTES
                            for state in active.values()
                        )
                        # A large multipart upload gets the uplink to itself.
                        # This is intentionally conservative: it prevents four
                        # 20–30 MiB videos from starving each other's TLS socket
                        # writes, but preserves parallelism for normal photos.
                        if large_transfer_active or (next_is_large and active):
                            break
                        action = pending.pop(0)
                        attempts[action.sequence] += 1
                        attempt = attempts[action.sequence]
                        try:
                            cookie_text, album_info = self.client.export_file_client_context(album_id)
                        except Exception:  # noqa: BLE001
                            LOGGER.exception("无法创建文件客户端上下文：序号=%s，文件=%s", action.sequence, action.media_name)
                            retry_or_skip(action, attempt, "无法创建上传客户端")
                            continue
                        client_queue = process_context.Queue()
                        process = process_context.Process(
                            target=run_file_client,
                            args=(
                                client_queue,
                                cookie_text,
                                album_id,
                                album_info,
                                str(action.local_path),
                                self.compression_options.to_worker_dict(),
                            ),
                            name="yike-file-client-{}-{}".format(action.sequence, attempt),
                        )
                        process.start()
                        active[process] = {
                            "action": action,
                            "queue": client_queue,
                            "attempt": attempt,
                            "started_at": time.monotonic(),
                            "result": None,
                        }
                        set_status(
                            action,
                            "当前相册第 {} 批：已下发文件客户端（第 {}/{} 次）".format(
                                batch_number, attempt, FILE_CLIENT_MAX_ATTEMPTS
                            ),
                        )
                        LOGGER.debug(
                            "主控制器下发当前相册文件客户端：相册=%s，批次=%s，序号=%s，文件=%s，尝试=%s/%s",
                            action.album_name,
                            batch_number,
                            action.sequence,
                            action.media_name,
                            attempt,
                            FILE_CLIENT_MAX_ATTEMPTS,
                        )

                    now = time.monotonic()
                    for process, state in list(active.items()):
                        action = state["action"]
                        client_queue = state["queue"]
                        while True:
                            try:
                                event = client_queue.get_nowait()
                            except queue.Empty:
                                break
                            if event.get("kind") == "progress":
                                event_message = str(event.get("message", "正在上传"))
                                phase = "正在压缩视频" if "压缩" in event_message else "正在上传"
                                set_status(action, "当前相册第 {} 批：{}".format(batch_number, phase))
                                if progress:
                                    fraction = max(0, min(100, int(event.get("value", 0)))) / 100
                                    progress(
                                        int((completed + fraction) / total * 100),
                                        event_message,
                                    )
                            elif event.get("kind") == "result":
                                state["result"] = event

                        timeout = timeout_for_file(action)
                        if state["result"] is not None:
                            event = state["result"]
                            close_client(process, client_queue)
                            active.pop(process)
                            if event.get("ok"):
                                fsid = str(event.get("fsid", ""))
                                if not fsid:
                                    retry_or_skip(action, state["attempt"], "客户端未回报 FSID")
                                else:
                                    consecutive_rate_limit = 0
                                    uploaded_fsids[action.sequence] = fsid
                                    set_status(action, "上传完成，等待当前相册批次统一加入")
                            else:
                                error_text = str(event.get("error") or "未知错误")
                                LOGGER.error(
                                    "文件客户端上传失败：序号=%s，相册=%s，文件=%s，尝试=%s/%s，错误=%s\n%s",
                                    action.sequence,
                                    action.album_name,
                                    action.media_name,
                                    state["attempt"],
                                    FILE_CLIENT_MAX_ATTEMPTS,
                                    error_text,
                                    event.get("debug_error", ""),
                                )
                                if _is_rate_limit_error(error_text):
                                    # Rate-limited: commit what we already uploaded,
                                    # then back off (growing wait, capped at 30 min)
                                    # and retry this file instead of giving up.
                                    consecutive_rate_limit += 1
                                    friendly = _friendly_error(error_text)
                                    if consecutive_rate_limit >= RATE_LIMIT_CONSECUTIVE_PAUSE_THRESHOLD and not (
                                        control and control.paused
                                    ):
                                        # Too many rate-limit hits in a row: stop
                                        # hammering the API and let the user decide.
                                        if control is not None:
                                            control.pause()
                                        if alert_callback is not None:
                                            alert_callback(
                                                "连续多次触发「操作过于频繁」（errno 50005）。已自动暂停同步，"
                                                "请稍候点击「继续」，或降低并发与读取线程数后再试。"
                                            )
                                        consecutive_rate_limit = 0
                                        finalize_group()
                                        skip_upload(action, friendly)
                                    elif control and control.paused:
                                        # Already paused for rate-limiting; stop retrying.
                                        finalize_group()
                                        skip_upload(action, friendly)
                                    else:
                                        finalize_group()
                                        waits = rate_limit_waits.get(action.sequence, 0)
                                        if waits >= RATE_LIMIT_MAX_RETRIES:
                                            skip_upload(action, "{}（已多次重试仍失败）".format(friendly))
                                        else:
                                            wait = min(
                                                RATE_LIMIT_BASE_WAIT_SECONDS * (2 ** waits),
                                                RATE_LIMIT_MAX_WAIT_SECONDS,
                                            )
                                            if _wait_with_control(wait, control):
                                                rate_limit_waits[action.sequence] = waits + 1
                                                set_status(
                                                    action,
                                                    "{}，等待 {} 秒后重试（第 {} 次）".format(friendly, wait, waits + 1),
                                                )
                                                pending.append(action)
                                            else:
                                                skip_upload(action, "{}（等待限流恢复期间已停止）".format(friendly))
                                else:
                                    skip_upload(action, error_text)
                            continue

                        if not process.is_alive():
                            close_client(process, client_queue)
                            active.pop(process)
                            retry_or_skip(action, state["attempt"], "客户端异常退出且未报告结果")
                            continue
                        if now - state["started_at"] > timeout:
                            close_client(process, client_queue)
                            active.pop(process)
                            retry_or_skip(action, state["attempt"], "客户端超时（{} 秒）".format(timeout))

                    if not active and not pending:
                        break
                    time.sleep(0.08)

                if control and control.stopped:
                    for process, state in list(active.items()):
                        close_client(process, state["queue"])
                    for action in group_actions:
                        if action.sequence not in reported_sequences:
                            set_status(action, "已停止")
                            report(action)
                            reported_sequences.add(action.sequence)
                    return False

                # Commit whatever uploaded FSIDs we collected (idempotent: an
                # earlier rate-limit already flushed the prior batch).
                finalize_group()
                # Skipped files do not hold the album gate. Only uploaded FSIDs
                # that are not yet visible in the album keep the gate closed.
                return all(
                    action.status == "已完成" or action.status.startswith("已跳过")
                    for action in group_actions
                )

            blocked = False
            for album_id, album_actions in album_groups:
                batch_number = 0
                for start in range(0, len(album_actions), ALBUM_ASSOCIATION_BATCH_SIZE):
                    batch_number += 1
                    current_group = album_actions[start:start + ALBUM_ASSOCIATION_BATCH_SIZE]
                    if not run_album_upload_group(album_id, current_group, batch_number):
                        blocked = True
                        break
                if blocked:
                    break

            if control and control.stopped:
                for action in upload_actions:
                    if action.sequence not in reported_sequences:
                        set_status(action, "已停止")
                        report(action)
                        reported_sequences.add(action.sequence)
            elif blocked:
                for action in upload_actions:
                    if action.sequence not in reported_sequences:
                        set_status(action, "待重试：当前相册批次未确认入册，未启动后续文件或相册")
                        report(action)
                        reported_sequences.add(action.sequence)

        elif not fault_reason and upload_actions:
            # Deterministic in-process path used only by lightweight fake
            # clients in the regression suite. Production always takes the
            # process-client branch above, which permits hard timeout closure.
            for action in upload_actions:
                if control and control.stopped:
                    set_status(action, "已停止")
                    report(action)
                    continue
                set_status(action, "已下发给文件客户端")
                run_one_file_client(action)
                if action.status.startswith("失败："):
                    set_status(action, "已跳过：" + action.status[len("失败："):])
                report(action)
        elif fault_reason:
            for action in upload_actions:
                set_status(action, "错误：前序创建任务未完成")
                report(action)

        # Downloads/deletes are dispatched by the master after all upload file
        # clients finish; an error is recorded but does not erase the remaining
        # independently planned operations.
        for action in trailing_actions:
            if control and control.stopped:
                break
            run_action(action)
            report(action)

        failures = sum(action.status.startswith(("失败", "错误")) for action in executable)
        retry_pending = sum(action.status.startswith("待重试") for action in executable)
        skipped = sum(action.status.startswith("已跳过") for action in executable)
        if progress:
            if control and control.stopped:
                progress(100, "同步已安全停止")
            else:
                parts = []
                if failures:
                    parts.append(f"{failures} 项失败")
                if retry_pending:
                    parts.append(f"{retry_pending} 项待重试")
                if skipped:
                    parts.append(f"{skipped} 项已跳过")
                if parts:
                    progress(100, "同步执行结束：" + "；".join(parts))
                else:
                    progress(100, "同步执行完成")
        return actions
