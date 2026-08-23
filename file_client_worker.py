"""One-shot worker entry point for a master-assigned media file.

This module must stay import-safe because Windows uses spawn for child processes.
The worker has no queue awareness: it receives one exact payload-upload task,
reports progress, and returns one result through its queue. Album association is
performed later by the master controller.
"""

from __future__ import annotations

from pathlib import Path
import traceback
from typing import Any

from remote_client import YikeRemoteClient


def run_file_client(
    result_queue: Any,
    cookie_text: str,
    album_id: str,
    album_info: dict,
    file_path: str,
) -> None:
    """Run one payload upload and publish structured events to the master."""
    path = Path(file_path)

    def report(value: int, message: str) -> None:
        result_queue.put({"kind": "progress", "value": int(value), "message": str(message)})

    try:
        client = YikeRemoteClient.create_file_client(cookie_text, album_id, album_info)
        fsid = client.upload_file_payload_once(path, report)
        result_queue.put({"kind": "result", "ok": True, "fsid": fsid, "message": f"已上传 {path.name}，等待主控制器统一加入相册"})
    except Exception as exc:  # noqa: BLE001 - master writes diagnostic detail to error.log
        result_queue.put(
            {
                "kind": "result",
                "ok": False,
                "error": str(exc),
                "debug_error": traceback.format_exc(),
            }
        )
