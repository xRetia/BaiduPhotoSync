from __future__ import annotations

import json
import logging
import re
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable

import requests

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "vendor"))

from pybaiduphoto.API import API  # noqa: E402
from media_validation import validate_media_file  # noqa: E402


LOGGER = logging.getLogger(__name__)
ALBUM_CACHE_TTL_SECONDS = 180
MEDIA_CACHE_TTL_SECONDS = 180
# A payload upload may be accepted before the album service can associate it.
# Submit through one slow lane, then verify the exact FSIDs after propagation.
# The extra readbacks are deliberately cheaper than issuing repeated addfile.
ALBUM_ASSOCIATION_SETTLE_SECONDS = 5
ALBUM_ASSOCIATION_VISIBILITY_DELAYS_SECONDS = (10, 20)
ALBUM_ASSOCIATION_RETRY_DELAYS_SECONDS = (15, 30, 60)
ASSOCIATION_50000_VISIBILITY_DELAYS_SECONDS = (5, 12, 24)
# Upload payloads may overlap. addfile is deliberately serialized and kept at
# least 12 seconds apart across all albums to avoid an API write burst.
ALBUM_ASSOCIATION_MIN_INTERVAL_SECONDS = 12.0
_GLOBAL_ASSOCIATION_REQUEST_LOCK = threading.Lock()
_GLOBAL_NEXT_ASSOCIATION_AT = 0.0
# Read-only list endpoints (listfile / album list) are retried only for truly
# transient failures: an API rate-limit (errno 50000), the generic server-side
# "unknown error" envelope (errno 1, e.g. {'errno': 1, 'request_id': ...}),
# or a dropped connection.  errno 50801 (file too large / VIP required) is
# permanent and is NOT retried; these endpoints never mutate state, so
# re-issuing them is safe.
LIST_TRANSIENT_RETRY_DELAYS_SECONDS = (5, 12, 20)
LIST_MAX_ATTEMPTS = 1 + len(LIST_TRANSIENT_RETRY_DELAYS_SECONDS)
LIST_TRANSIENT_ERRNOS = {1, 50000}
_ERRNO_RE = re.compile(r"errno['\"]?\s*[:=]\s*(-?\d+)", re.IGNORECASE)
# The album directory is read once per snapshot.  Give it a larger retry budget
# (up to 5 attempts) so a transient rate-limit rejection does not abort the
# whole plan build.
ALBUM_LIST_RETRY_DELAYS_SECONDS = (5, 12, 20, 40)
ALBUM_LIST_MAX_ATTEMPTS = 1 + len(ALBUM_LIST_RETRY_DELAYS_SECONDS)


ProgressCallback = Callable[[int, str], None]


class RemoteClientError(RuntimeError):
    """The remote API rejected an operation or the current login is invalid."""


class UnsupportedRemoteFeature(RuntimeError):
    """The bundled API does not expose this remote feature safely."""


@dataclass(frozen=True)
class RemoteAlbum:
    album_id: str
    title: str
    created_at: int | None
    modified_at: int | None
    amount: int | None


@dataclass(frozen=True)
class RemoteMedia:
    fsid: str
    name: str
    size: int
    modified_at: int | None
    created_at: int | None
    md5: str | None
    album_id: str
    thumbnail_url: str | None
    preview_url: str | None


def parse_cookie_text(text: str) -> dict[str, str]:
    """Accept copied DevTools TSV rows or a JSON array of cookie objects."""
    text = text.strip()
    if not text:
        raise RemoteClientError("尚未导入登录 Cookie。")

    cookies: dict[str, tuple[str, str]] = {}
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            for item in parsed:
                if isinstance(item, dict) and item.get("name") and item.get("value"):
                    domain = str(item.get("domain", ""))
                    if "baidu.com" in domain:
                        name = str(item["name"])
                        value = str(item["value"])
                        # Prefer a domain-scoped cookie (domain starts with ".")
                        # over a host-only one, so the value sent to
                        # photo.baidu.com is the universal session cookie.
                        existing = cookies.get(name)
                        if existing is None or (not existing[0].startswith(".") and domain.startswith(".")):
                            cookies[name] = (domain, value)
    except json.JSONDecodeError:
        for line in text.splitlines():
            columns = line.split("\t")
            if len(columns) < 3:
                continue
            name, value, domain = columns[0].strip(), columns[1].strip(), columns[2].strip()
            if name and value and "baidu.com" in domain:
                existing = cookies.get(name)
                if existing is None or (not existing[0].startswith(".") and domain.startswith(".")):
                    cookies[name] = (domain, value)
    cookies = {name: value for name, (_, value) in cookies.items()}

    missing = {"BAIDUID", "BDUSS"} - cookies.keys()
    if missing:
        raise RemoteClientError(
            "Cookie 内容不完整，缺少：" + "、".join(sorted(missing)) + "。请导出 photo.baidu.com 与 .baidu.com 的全部 Cookie。"
        )
    return cookies


class YikeRemoteClient:
    """Small, GUI-safe wrapper around the audited pybaiduphoto API.

    Cookies are kept only in this Python object. This class never writes them to
    disk or logs them.
    """

    def __init__(self, cookie_text: str):
        # Retained in memory only so isolated album workers can construct their
        # own request contexts; it is never logged or written to disk.
        self._cookie_text = cookie_text
        self._cookies = parse_cookie_text(cookie_text)
        self._install_request_timeouts()
        logging.getLogger("urllib3").setLevel(logging.WARNING)
        self._api = API(cookies=self._cookies)
        LOGGER.debug("已初始化一刻相册客户端；已解析 %s 个 Cookie 字段", len(self._cookies))
        self._albums: dict[str, object] = {}
        self._media: dict[tuple[str, str], object] = {}
        self._album_cache: list[RemoteAlbum] = []
        self._album_cache_at = 0.0
        self._media_cache: dict[str, tuple[float, list[RemoteMedia]]] = {}
        self._cache_lock = threading.RLock()
        self._media_locks: dict[str, threading.Lock] = {}
        self._album_write_locks: dict[str, threading.Lock] = {}
        # The vendor API object and addfile endpoint are not safe under
        # overlapping writes. One global lane serializes all uploads and album
        # associations; the per-album lock remains as a defensive guard.
        self._upload_association_lock = threading.RLock()

    @staticmethod
    def _install_request_timeouts() -> None:
        # The third-party library calls requests.get/post directly without a
        # timeout. Add a conservative default so the GUI worker cannot hang
        # forever on a stalled connection, and replay a request over a fresh
        # connection when the TLS layer aborts a transfer mid-flight.  Older
        # CPython ssl implementations can raise SSLWantWriteError from
        # sendall() when the write buffer cannot drain in one go; giving one
        # whole request up (and letting the server keep half a body) is what
        # produced the spurious upload failures in error.log.
        if getattr(requests, "_yike_timeout_wrapped", False):
            return
        original_get = requests.get
        original_post = requests.post
        transport_retry_delays = (1, 2, 4)

        def body_handles(args: tuple, kwargs: dict) -> list:
            handles: list = []
            body = kwargs.get("data")
            if body is None and len(args) > 1:
                body = args[1]
            if hasattr(body, "read"):
                handles.append(body)
            files = kwargs.get("files")
            values: list = []
            if isinstance(files, dict):
                values = list(files.values())
            elif isinstance(files, (list, tuple)):
                values = list(files)
            for value in values:
                if isinstance(value, (tuple, list)) and len(value) > 1:
                    handles.append(value[1])
                elif not isinstance(value, (tuple, list)):
                    handles.append(value)
            return handles

        def rewind_body(args: tuple, kwargs: dict) -> bool:
            """Reset streamed bodies so the same request can be sent again."""
            for handle in body_handles(args, kwargs):
                read = getattr(handle, "read", None)
                if not callable(read):
                    continue
                seek = getattr(handle, "seek", None)
                if not callable(seek):
                    return False
                try:
                    seek(0)
                except (OSError, ValueError):
                    return False
            return True

        def _count_body_bytes(body: object) -> int:
            if isinstance(body, (bytes, bytearray)):
                return len(body)
            if isinstance(body, str):
                return len(body.encode("utf-8", "ignore"))
            getvalue = getattr(body, "getvalue", None)
            if callable(getvalue):
                try:
                    return len(getvalue())
                except (TypeError, ValueError):
                    return 0
            if callable(getattr(body, "seek", None)) and callable(getattr(body, "tell", None)):
                try:
                    pos = body.tell()
                    body.seek(0, 2)
                    remaining = max(0, body.tell() - pos)
                    body.seek(pos)
                    return remaining
                except (OSError, ValueError):
                    return 0
            return 0

        def body_size(args: tuple, kwargs: dict) -> int:
            """Total bytes in the request body.

            Media payloads are sent as a multipart "files" upload, not "data".
            Measuring only "data" gave every large upload a flat 30s budget, so
            big files always timed out mid-send. Count both so the timeout can
            scale with the real size.
            """
            size = 0
            body = kwargs.get("data")
            if body is None and len(args) > 1:
                body = args[1]
            if body is not None:
                size += _count_body_bytes(body)
            files = kwargs.get("files")
            values: list = []
            if isinstance(files, dict):
                values = list(files.values())
            elif isinstance(files, (list, tuple)):
                values = list(files)
            for value in values:
                if isinstance(value, (tuple, list)):
                    value = value[1] if len(value) > 1 else None
                if value is not None:
                    size += _count_body_bytes(value)
            return size

        def post_socket_timeout(args: tuple, kwargs: dict) -> int:
            # requests applies this socket timeout while a streamed multipart
            # request is being written as well as while its response is read.
            # Budget slow uplinks at 128 KiB/s with a 90s protocol margin: this
            # avoids turning ordinary 20–30 MiB videos into write timeouts when
            # Wi-Fi is busy, while the master still owns the hard upper bound.
            size = body_size(args, kwargs)
            bytes_per_second = 128 * 1024
            upload_seconds = (max(0, size) + bytes_per_second - 1) // bytes_per_second
            return min(2700, 90 + upload_seconds)

        def send_with_retry(original, args: tuple, kwargs: dict):
            attempt = 0
            while True:
                attempt += 1
                try:
                    return original(*args, **kwargs)
                except (
                    requests.exceptions.SSLError,
                    requests.exceptions.ConnectionError,
                    requests.exceptions.ChunkedEncodingError,
                    requests.exceptions.Timeout,
                ) as exc:
                    if attempt > len(transport_retry_delays) or not rewind_body(args, kwargs):
                        raise
                    delay = transport_retry_delays[attempt - 1]
                    LOGGER.warning(
                        "检测到瞬时 TLS/连接/超时错误（%s），%s 秒后以新连接自动重发（第 %s/%s 次）",
                        type(exc).__name__,
                        delay,
                        attempt,
                        len(transport_retry_delays),
                    )
                    time.sleep(delay)

        def timed_get(*args, **kwargs):
            kwargs.setdefault("timeout", (10, 30))
            return send_with_retry(original_get, args, kwargs)

        def timed_post(*args, **kwargs):
            kwargs.setdefault("timeout", (10, post_socket_timeout(args, kwargs)))
            return send_with_retry(original_post, args, kwargs)

        requests.get = timed_get
        requests.post = timed_post
        requests._yike_timeout_wrapped = True  # type: ignore[attr-defined]
        LOGGER.debug("已为网络请求配置默认超时，并为瞬时 TLS/连接错误启用自动重发")

    @staticmethod
    def _api_error(response: object, action: str) -> None:
        if not isinstance(response, dict) or response.get("errno") not in {0, "0", None}:
            raise RemoteClientError(f"{action}失败，远端接口未返回成功状态。")

    @classmethod
    def _confirm_album_append(cls, response: object, file_name: str) -> None:
        cls._api_error(response, f"将媒体加入相册：{file_name}")
        assert isinstance(response, dict)
        try:
            success_count = int(response.get("succ_cnt", 0))
            failure_count = int(response.get("fail_cnt", 0))
        except (TypeError, ValueError) as exc:
            raise RemoteClientError(f"将媒体加入相册：{file_name} 未返回可验证的结果。") from exc
        if success_count < 1 or failure_count != 0:
            raise RemoteClientError(
                f"将媒体加入相册：{file_name} 未被服务端确认（成功 {success_count}，失败 {failure_count}）。"
            )

    def _lock_for_album(self, album_id: str, *, write: bool = False) -> threading.Lock:
        with self._cache_lock:
            locks = self._album_write_locks if write else self._media_locks
            return locks.setdefault(album_id, threading.Lock())

    def _invalidate_album_cache(self) -> None:
        with self._cache_lock:
            self._album_cache = []
            self._album_cache_at = 0.0

    def _invalidate_media_cache(self, album_id: str) -> None:
        with self._cache_lock:
            self._media_cache.pop(album_id, None)
            for key in [key for key in self._media if key[0] == album_id]:
                self._media.pop(key, None)

    @staticmethod
    def _as_int(value: object) -> int | None:
        try:
            return int(value) if value is not None else None
        except (ValueError, TypeError):
            return None

    def verify_login(self) -> str:
        albums = self.list_albums()
        return f"已连接，当前读取到 {len(albums)} 个相册。"

    def export_cookie_json(self) -> str:
        """Return the current in-memory Baidu session in WebEngine seed format.

        The value is intended only for the temporary in-process logout webview.
        It is never logged and must not be written to a file by callers.
        """
        records = [
            {"name": name, "value": value, "domain": ".baidu.com"}
            for name, value in self._cookies.items()
        ]
        return json.dumps(records, ensure_ascii=False)

    def export_file_client_context(self, album_id: str) -> tuple[str, dict]:
        """Return the minimum in-memory context for one assigned file client."""
        try:
            source_album = self._album_object(album_id)
        except RemoteClientError:
            # A known action target does not need a full album-directory refresh.
            # Read only its detail so a temporary list endpoint failure cannot
            # prevent the master from starting the current guarded album group.
            source_album = self._refresh_album_for_association(album_id)
        info = dict(getattr(source_album, "info", {}))
        if not info:
            raise RemoteClientError("无法为文件客户端导出相册元数据。")
        return self._cookie_text, info

    @classmethod
    def create_file_client(cls, cookie_text: str, album_id: str, album_info: dict) -> "YikeRemoteClient":
        """Create one isolated client pre-bound to a master-specified album."""
        client = cls(cookie_text)
        client._albums[album_id] = client._api.getAlbum_ByInfo(dict(album_info))
        return client

    def create_isolated_album_client(self, album_id: str) -> "YikeRemoteClient":
        """Return a fresh API/request context pre-bound to one known album.

        The source client supplies only the target album metadata. The new
        client owns a separate vendor API, request wrapper and token cache, so
        concurrent album workers never share mutable request state.
        """
        cookie_text, info = self.export_file_client_context(album_id)
        return self.create_file_client(cookie_text, album_id, info)

    def list_albums(self, force_refresh: bool = False) -> list[RemoteAlbum]:
        now = time.monotonic()
        with self._cache_lock:
            if not force_refresh and self._album_cache and now - self._album_cache_at < ALBUM_CACHE_TTL_SECONDS:
                LOGGER.debug("命中相册目录缓存：%s 个相册，缓存年龄 %.1f 秒", len(self._album_cache), now - self._album_cache_at)
                return list(self._album_cache)
        objects = None
        last_exc: Exception | None = None
        for attempt in range(1, ALBUM_LIST_MAX_ATTEMPTS + 1):
            try:
                objects = self._api.getAlbumList_All()
                last_exc = None
                break
            except Exception as exc:  # noqa: BLE001
                last_exc = exc
                if attempt < ALBUM_LIST_MAX_ATTEMPTS and self._is_transient_list_error(exc):
                    delay = ALBUM_LIST_RETRY_DELAYS_SECONDS[attempt - 1]
                    LOGGER.warning(
                        "相册目录读取被临时拒绝，等待 %s 秒后重试（第 %s/%s 次）：%s",
                        delay,
                        attempt,
                        ALBUM_LIST_MAX_ATTEMPTS,
                        type(exc).__name__,
                    )
                    time.sleep(delay)
                    continue
                break
        if objects is None:
            with self._cache_lock:
                stale_cache = list(self._album_cache)
            if stale_cache:
                LOGGER.warning("相册目录刷新失败，回退使用过期缓存（%s 个相册）：%s", len(stale_cache), type(last_exc).__name__)
                return stale_cache
            if "errno=50801" in str(last_exc):
                raise RemoteClientError("无法读取相册列表：文件过大或需要开通会员（errno=50801）。") from last_exc
            raise RemoteClientError("无法读取相册列表，请检查网络和登录 Cookie 是否仍有效。") from last_exc
        result: list[RemoteAlbum] = []
        with self._cache_lock:
            self._albums.clear()
            for album in objects:
                info = getattr(album, "info", {})
                album_id = str(album.getID())
                self._albums[album_id] = album
                result.append(
                    RemoteAlbum(
                        album_id=album_id,
                        title=album.getName(),
                        created_at=self._as_int(info.get("ctime")),
                        modified_at=self._as_int(info.get("mtime")),
                        amount=self._as_int(info.get("amount")),
                    )
                )
            self._album_cache = sorted(result, key=lambda row: row.title.casefold())
            self._album_cache_at = now
            result = list(self._album_cache)
        LOGGER.debug("云端相册目录从服务器读取完成：%s 个相册", len(result))
        return result

    def _album_object(self, album_id: str):
        if album_id not in self._albums:
            self.list_albums()
        try:
            return self._albums[album_id]
        except KeyError as exc:
            raise RemoteClientError("目标相册已不存在或相册列表已过期。") from exc

    def _refresh_album_for_association(self, album_id: str):
        """Prefer fresh album detail, with a deliberately limited cache fallback.

        addfile requires the album object's TID. The detail endpoint is preferred
        because it returns a fresh TID. If that endpoint is temporarily rejected
        (for example errno 50801), reuse only the matching album object already
        held by this master-client session; never invent a TID or issue a write
        when neither detail nor a known target object is available.
        """
        cached_album = self._albums.get(str(album_id))
        try:
            album = self._api.getAlbum_ByID(str(album_id))
        except Exception as exc:  # noqa: BLE001
            if cached_album is not None:
                LOGGER.warning(
                    "相册详情刷新失败，低频入册仅本次回退已有缓存对象：album_id=%s，错误=%s",
                    album_id,
                    type(exc).__name__,
                )
                return cached_album
            raise RemoteClientError("读取目标相册详情失败，未提交入册请求。") from exc
        if album is not None and str(album.getID()) == str(album_id):
            self._albums[str(album_id)] = album
            return album
        if cached_album is not None:
            LOGGER.warning(
                "相册详情未返回有效对象，低频入册仅本次回退已有缓存对象：album_id=%s",
                album_id,
            )
            return cached_album
        raise RemoteClientError("目标相册详情无效，未提交入册请求。")

    def create_album(self, title: str) -> RemoteAlbum:
        title = title.strip()
        if not title:
            raise RemoteClientError("相册名称不能为空。")
        try:
            album = self._api.createNewAlbum(Name=title)
        except Exception as exc:
            raise RemoteClientError("创建相册失败。") from exc
        if album.getName() != title:
            raise RemoteClientError("创建相册后返回的名称与输入名称不一致。")
        self._albums[str(album.getID())] = album
        self._invalidate_album_cache()
        info = getattr(album, "info", {})
        return RemoteAlbum(
            album_id=str(album.getID()),
            title=album.getName(),
            created_at=self._as_int(info.get("ctime")),
            modified_at=self._as_int(info.get("mtime")),
            amount=self._as_int(info.get("amount")),
        )

    def rename_album(self, album_id: str, title: str) -> None:
        album = self._album_object(album_id)
        title = title.strip()
        if not title:
            raise RemoteClientError("相册名称不能为空。")
        try:
            album.rename(title)
        except Exception as exc:
            raise RemoteClientError("重命名相册失败。") from exc
        if album.getName() != title:
            raise RemoteClientError("远端未确认相册重命名。")
        self._invalidate_album_cache()

    def delete_album(self, album_id: str, delete_items: bool = False) -> None:
        album = self._album_object(album_id)
        try:
            response = album.delete(isWithItems=delete_items)
        except Exception as exc:
            raise RemoteClientError("删除相册失败。") from exc
        self._api_error(response, "删除相册")
        self._albums.pop(album_id, None)
        self._invalidate_album_cache()
        self._invalidate_media_cache(album_id)

    def list_media(self, album_id: str, force_refresh: bool = False) -> list[RemoteMedia]:
        now = time.monotonic()
        with self._cache_lock:
            cached = self._media_cache.get(album_id)
            if not force_refresh and cached and now - cached[0] < MEDIA_CACHE_TTL_SECONDS:
                LOGGER.debug("命中相册媒体缓存：album_id=%s，媒体数=%s，缓存年龄 %.1f 秒", album_id, len(cached[1]), now - cached[0])
                return list(cached[1])

        # The lock prevents concurrent plan workers from requesting the same
        # album's full media list more than once when the cache is cold.
        with self._lock_for_album(album_id):
            now = time.monotonic()
            with self._cache_lock:
                cached = self._media_cache.get(album_id)
                if not force_refresh and cached and now - cached[0] < MEDIA_CACHE_TTL_SECONDS:
                    return list(cached[1])
            album = self._album_object(album_id)
            objects = None
            last_exc: Exception | None = None
            for attempt in range(1, LIST_MAX_ATTEMPTS + 1):
                try:
                    objects = album.get_sub_All()
                    last_exc = None
                    break
                except Exception as exc:  # noqa: BLE001
                    last_exc = exc
                    if attempt < LIST_MAX_ATTEMPTS and self._is_transient_list_error(exc):
                        delay = LIST_TRANSIENT_RETRY_DELAYS_SECONDS[attempt - 1]
                        LOGGER.warning(
                            "相册媒体列表读取被临时拒绝，等待 %s 秒后重试（第 %s/%s 次）：album_id=%s，错误=%s",
                            delay,
                            attempt,
                            LIST_MAX_ATTEMPTS,
                            album_id,
                            type(exc).__name__,
                        )
                        time.sleep(delay)
                        continue
                    break
            if objects is None:
                with self._cache_lock:
                    stale_cached = self._media_cache.get(album_id)
                if stale_cached:
                    LOGGER.warning("相册媒体刷新失败，回退使用过期缓存：album_id=%s，媒体数=%s，错误=%s", album_id, len(stale_cached[1]), type(last_exc).__name__)
                    return list(stale_cached[1])
                if "errno=50801" in str(last_exc):
                    raise RemoteClientError("无法读取相册媒体列表：文件过大或需要开通会员（errno=50801）。") from last_exc
                raise RemoteClientError("无法读取相册媒体列表。") from last_exc
            result: list[RemoteMedia] = []
            with self._cache_lock:
                for item in objects:
                    info = getattr(item, "info", {})
                    fsid = str(item.getID())
                    thumbnail_urls = info.get("thumburl") if isinstance(info, dict) else None
                    if isinstance(thumbnail_urls, (list, tuple)):
                        valid_thumbnail_urls = [str(url) for url in thumbnail_urls if isinstance(url, str) and url]
                    elif isinstance(thumbnail_urls, str) and thumbnail_urls:
                        valid_thumbnail_urls = [thumbnail_urls]
                    else:
                        valid_thumbnail_urls = []
                    # The service returns compact and larger signed thumbnail URLs
                    # in order.  Keep both roles separate: the compact image feeds
                    # the gallery, while the largest supplied thumbnail is used for
                    # system-viewer preview.  Original downloads still go through
                    # the authenticated OnlineItem download flow below.
                    thumbnail_url = valid_thumbnail_urls[0] if valid_thumbnail_urls else None
                    preview_url = valid_thumbnail_urls[-1] if valid_thumbnail_urls else None
                    self._media[(album_id, fsid)] = item
                    result.append(
                        RemoteMedia(
                            fsid=fsid,
                            name=item.getName(),
                            size=int(item.getSize() or 0),
                            modified_at=self._as_int(info.get("mtime")),
                            created_at=self._as_int(info.get("ctime")),
                            md5=info.get("md5"),
                            album_id=album_id,
                            thumbnail_url=thumbnail_url,
                            preview_url=preview_url,
                        )
                    )
                result = sorted(result, key=lambda row: row.name.casefold())
                self._media_cache[album_id] = (now, result)
        LOGGER.debug("相册媒体列表从服务器读取完成：album_id=%s，媒体数=%s", album_id, len(result))
        return list(result)

    def _media_object(self, album_id: str, fsid: str):
        key = (album_id, fsid)
        if key not in self._media:
            self.list_media(album_id)
        try:
            return self._media[key]
        except KeyError as exc:
            raise RemoteClientError("目标媒体已不存在或媒体列表已过期。") from exc

    @staticmethod
    def _append_response_summary(response: object) -> str:
        """Return a compact diagnostic without exposing request or cookie data."""
        if not isinstance(response, dict):
            return f"响应类型 {type(response).__name__}"
        return (
            f"errno={response.get('errno')!r}，"
            f"成功={response.get('succ_cnt')!r}，失败={response.get('fail_cnt')!r}"
        )

    @staticmethod
    def _errno_value(exc: Exception) -> int | None:
        """Extract a numeric errno from an exception message, if present.

        Handles both the ``errno=1`` text form raised by the bundled API layer
        and the JSON ``'errno': 1`` / ``"errno": 1`` form found in raw payloads.
        """
        match = _ERRNO_RE.search(str(exc))
        if not match:
            return None
        try:
            return int(match.group(1))
        except (TypeError, ValueError):
            return None

    @classmethod
    def _is_transient_list_error(cls, exc: Exception) -> bool:
        """A read-only list call may be safely retried for these failures.

        errno 50000 is the API rate-limit rejection and errno 1 is the
        server-side "unknown/internal error" envelope; both are transient, so
        backing off and retrying is the correct response.  errno 50801 (file
        too large / VIP required) is permanent and must NOT be retried here.
        """
        if cls._errno_value(exc) in LIST_TRANSIENT_ERRNOS:
            return True
        return isinstance(
            exc,
            (
                requests.exceptions.ConnectionError,
                requests.exceptions.Timeout,
                requests.exceptions.ChunkedEncodingError,
            ),
        )

    def _is_fsid_visible_in_album(self, album_id: str, fsid: str) -> bool:
        """Read the target album before repeating an ambiguous addfile request."""
        try:
            self._invalidate_media_cache(album_id)
            return fsid in {item.fsid for item in self.list_media(album_id, force_refresh=True)}
        except Exception as exc:  # noqa: BLE001 - visibility remains unknown
            LOGGER.warning("入册结果回读失败：album_id=%s，fsid=%s，错误=%s", album_id, fsid, type(exc).__name__)
            return False

    def _wait_for_50000_visibility(self, album_id: str, fsid: str, file_name: str) -> bool:
        """Treat errno 50000 as an ambiguous, potentially already-applied addfile.

        The service can apply the association while returning a generic 50000.
        Never issue another addfile until the FSID has had time to propagate and
        has been checked through the album list.
        """
        for delay in ASSOCIATION_50000_VISIBILITY_DELAYS_SECONDS:
            LOGGER.warning(
                "addfile 返回 50000，等待 %s 秒确认是否已入册：album_id=%s，fsid=%s，文件=%s",
                delay,
                album_id,
                fsid,
                file_name,
            )
            time.sleep(delay)
            if self._is_fsid_visible_in_album(album_id, fsid):
                LOGGER.info("50000 后已确认媒体实际在相册中：album_id=%s，fsid=%s，文件=%s", album_id, fsid, file_name)
                return True
        return False

    @staticmethod
    def _append_with_process_pacing(album: object, item: object) -> object:
        """Issue addfile through one process-wide paced lane.

        Isolated album workers use separate API clients, but the server's
        addfile endpoint still needs one shared cadence across those clients.
        """
        global _GLOBAL_NEXT_ASSOCIATION_AT
        with _GLOBAL_ASSOCIATION_REQUEST_LOCK:
            wait_seconds = max(0.0, _GLOBAL_NEXT_ASSOCIATION_AT - time.monotonic())
            if wait_seconds:
                time.sleep(wait_seconds)
            response = album.append(item)
            _GLOBAL_NEXT_ASSOCIATION_AT = time.monotonic() + ALBUM_ASSOCIATION_MIN_INTERVAL_SECONDS
            return response

    def _append_uploaded_item_in_order(self, album_id: str, initial_album: object, item: object, path: Path) -> None:
        """Associate one uploaded FSID before the next file is allowed to start.

        The upload is not repeated.  Retrying always uses the same FSID and
        first checks whether a transiently-failed reply was already applied.
        A refreshed album object obtains a fresh TID when possible.
        """
        fsid = str(item.getID())
        current_album = initial_album
        last_error: RemoteClientError | None = None
        attempts = 1 + len(ALBUM_ASSOCIATION_RETRY_DELAYS_SECONDS)
        for attempt in range(1, attempts + 1):
            if attempt > 1:
                delay = ALBUM_ASSOCIATION_RETRY_DELAYS_SECONDS[attempt - 2]
                LOGGER.warning(
                    "相册关联未确认，按原顺序等待 %s 秒后重试：album_id=%s，fsid=%s，文件=%s，第 %s/%s 次",
                    delay,
                    album_id,
                    fsid,
                    path.name,
                    attempt,
                    attempts,
                )
                time.sleep(delay)
                if self._is_fsid_visible_in_album(album_id, fsid):
                    LOGGER.info("回读确认媒体已进入相册，无需重复 addfile：album_id=%s，fsid=%s", album_id, fsid)
                    return
            response: object = None
            try:
                # Independent album workers may upload concurrently, but every
                # addfile call uses the one process-wide paced request lane.
                response = self._append_with_process_pacing(current_album, item)
                self._confirm_album_append(response, path.name)
                LOGGER.debug(
                    "媒体已确认加入相册：album_id=%s，fsid=%s，文件=%s，尝试=%s/%s",
                    album_id,
                    fsid,
                    path.name,
                    attempt,
                    attempts,
                )
                return
            except RemoteClientError as exc:
                last_error = exc
                summary = self._append_response_summary(response)
                LOGGER.warning(
                    "相册关联未确认：album_id=%s，fsid=%s，文件=%s，尝试=%s/%s，%s",
                    album_id,
                    fsid,
                    path.name,
                    attempt,
                    attempts,
                    summary,
                )
                if isinstance(response, dict) and str(response.get("errno")) == "50000":
                    if self._wait_for_50000_visibility(album_id, fsid, path.name):
                        return
                    # 50000 is ambiguous and may be an already-applied write.
                    # Do not multiply the request by refreshing the album
                    # directory and issuing more addfile calls.
                    break
            except Exception as exc:  # noqa: BLE001 - handled as transient association failure
                last_error = RemoteClientError(f"将媒体加入相册：{path.name} 的请求异常：{type(exc).__name__}")
                LOGGER.warning(
                    "相册关联请求异常：album_id=%s，fsid=%s，文件=%s，尝试=%s/%s，错误=%s",
                    album_id,
                    fsid,
                    path.name,
                    attempt,
                    attempts,
                    type(exc).__name__,
                )

        if self._is_fsid_visible_in_album(album_id, fsid):
            LOGGER.info("最终回读确认媒体已进入相册：album_id=%s，fsid=%s", album_id, fsid)
            return
        raise RemoteClientError(
            f"将媒体加入相册：{path.name} 未能在传播窗口内确认。"
            "若刚才收到 errno 50000，服务端可能已接受关联；程序不会重复 addfile，"
            "该文件保持待确认，后续同步会重新核对。"
        ) from last_error

    def _append_uploaded_item_once(self, album_id: str, album: object, item: object, path: Path) -> None:
        """Issue one addfile request for a one-shot file client.

        Retry policy belongs exclusively to the master controller. The only
        exception is a single visibility check for ambiguous errno 50000, which
        may mean the service already applied this same association.
        """
        fsid = str(item.getID())
        response = self._append_with_process_pacing(album, item)
        try:
            self._confirm_album_append(response, path.name)
            return
        except RemoteClientError as exc:
            if isinstance(response, dict) and str(response.get("errno")) == "50000":
                if self._is_fsid_visible_in_album(album_id, fsid):
                    LOGGER.info("单文件客户端确认 50000 对应 FSID 已在相册中：album_id=%s，fsid=%s", album_id, fsid)
                    return
            raise RemoteClientError(
                f"单文件客户端未确认入册：{path.name}（{self._append_response_summary(response)}）。"
                "已回报主控制器决定是否新建客户端重试。"
            ) from exc

    def upload_file_payload_once(self, path: Path, progress: ProgressCallback | None = None) -> str:
        """Upload only one master-assigned file and return its FSID.

        This method intentionally does not call album/addfile. It is the sole
        operation performed by a concurrent file client in the two-stage sync
        model; the master batches associations after an album finishes upload.
        """
        if progress:
            progress(0, f"正在上传 {path.name}")
        try:
            is_media, validation_message = validate_media_file(path)
            if not is_media:
                raise RemoteClientError(f"拒绝上传非有效照片/视频：{path.name}（{validation_message}）")
            item = self._api.upload_1file_directly(filePath=str(path))
            if item is None:
                raise RemoteClientError(f"上传未返回媒体对象：{path.name}")
            fsid = str(item.getID())
            if not fsid:
                raise RemoteClientError(f"上传未返回有效 FSID：{path.name}")
            if progress:
                progress(100, f"上传完成，等待主控制器统一加入相册 {path.name}")
            return fsid
        except RemoteClientError:
            raise
        except KeyError as exc:
            raise RemoteClientError(
                f"上传接口响应异常（缺少字段 {exc}），详见 error.log"
            ) from exc
        except Exception as exc:
            raise RemoteClientError(f"上传失败：{path.name}：{exc}") from exc

    def associate_uploaded_fsids_once(self, album_id: str, fsids: Iterable[str]) -> set[str]:
        """Submit one low-frequency batch and return only visible FSIDs.

        Each batch refreshes album detail immediately before addfile so a current
        TID is used.  The same request is never treated as successful from errno
        alone: the target album is checked after a conservative propagation
        window, and an ambiguous response receives extra readbacks before the
        master is allowed to retry just the missing FSIDs.
        """
        requested = list(dict.fromkeys(str(fsid) for fsid in fsids if str(fsid)))
        if not requested:
            return set()
        with self._lock_for_album(album_id, write=True):
            album = self._refresh_album_for_association(album_id)
            items = [self._api.getOnlineItem_ByInfo({"fsid": fsid}) for fsid in requested]
            response = self._append_with_process_pacing(album, items)
            errno = str(response.get("errno")) if isinstance(response, dict) else "unknown"
            LOGGER.info(
                "主控制器低频批量入册已提交：album_id=%s，数量=%s，errno=%s",
                album_id,
                len(items),
                errno,
            )
            delays = [ALBUM_ASSOCIATION_SETTLE_SECONDS]
            if errno == "50000":
                delays.extend(ASSOCIATION_50000_VISIBILITY_DELAYS_SECONDS)
            else:
                delays.extend(ALBUM_ASSOCIATION_VISIBILITY_DELAYS_SECONDS)
            confirmed: set[str] = set()
            for delay in delays:
                time.sleep(delay)
                try:
                    self._invalidate_media_cache(album_id)
                    visible = {
                        media.fsid for media in self.list_media(album_id, force_refresh=True)
                    }
                except Exception as exc:  # noqa: BLE001
                    raise RemoteClientError(f"批量关联后读取目标相册失败：{exc}") from exc
                confirmed = set(requested) & visible
                LOGGER.info(
                    "批量入册可见性核对：album_id=%s，提交=%s，已可见=%s，等待=%s秒",
                    album_id,
                    len(requested),
                    len(confirmed),
                    delay,
                )
                if len(confirmed) == len(requested):
                    break
            if confirmed:
                self._invalidate_media_cache(album_id)
            return confirmed

    def upload_file_once(self, album_id: str, path: Path, progress: ProgressCallback | None = None) -> None:
        """Compatibility helper for manual upload; sync uses the two-stage API."""
        fsid = self.upload_file_payload_once(path, progress=None)
        confirmed = self.associate_uploaded_fsids_once(album_id, [fsid])
        if fsid not in confirmed:
            raise RemoteClientError(f"单文件关联未确认：{path.name}")
        if progress:
            progress(100, f"已上传并确认入册 {path.name}")

    def upload_files(self, album_id: str, paths: Iterable[Path], progress: ProgressCallback | None = None) -> None:
        """Compatibility wrapper for manual multi-select upload.

        Synchronization uses :meth:`upload_file_once`; this wrapper deliberately
        calls it one item at a time and never creates a queue of its own.
        """
        paths = list(paths)
        for index, path in enumerate(paths, start=1):
            if progress:
                progress(int((index - 1) / max(1, len(paths)) * 100), f"正在上传并确认入册 {path.name}")
            self.upload_file_once(album_id, path, progress=None)
            if progress:
                progress(int(index / max(1, len(paths)) * 100), f"已上传并确认入册 {path.name}")

    def download_media(self, album_id: str, fsid: str, target_directory: Path) -> Path:
        item = self._media_object(album_id, fsid)
        target_directory.mkdir(parents=True, exist_ok=True)
        LOGGER.debug("开始下载：album_id=%s，fsid=%s，目标目录=%s", album_id, fsid, target_directory)
        try:
            item.download(DirPath=str(target_directory), fileName=item.getName(), isCheckMd5=True)
        except Exception as exc:
            raise RemoteClientError(f"下载失败：{item.getName()}") from exc
        return target_directory / item.getName()

    def delete_media(self, album_id: str, fsid: str) -> None:
        item = self._media_object(album_id, fsid)
        try:
            response = item.delete()
        except Exception as exc:
            raise RemoteClientError("删除媒体失败。") from exc
        self._api_error(response, "删除媒体")
        self._invalidate_media_cache(album_id)

    def rename_media(self, album_id: str, fsid: str, new_name: str) -> None:
        raise UnsupportedRemoteFeature(
            "当前接口库未提供已验证的远端媒体重命名接口。为避免以重新上传和删除替代重命名，本程序不会执行该操作。"
        )
