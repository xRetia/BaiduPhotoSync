"use strict";

/**
 * 同步引擎 Worker — 在 worker_threads 中运行 build_plan / execute_plan
 *
 * 主进程通过 parentPort 发送消息启动任务，本 worker 在独立线程中执行，
 * 所有进度/状态/告警通过 parentPort.postMessage 回传，不阻塞主进程事件循环。
 *
 * 消息协议：
 *   入: { type: "build_plan", id, clientCookie, options }
 *   入: { type: "execute_plan", id, clientCookie, actions, root, options }
 *   入: { type: "scan_local", id, root }
 *   入: { type: "control", command: "pause"|"resume"|"stop" }
 *   出: { type: "progress", id, value, text }
 *   出: { type: "status", id, sequence, text }
 *   出: { type: "alert", id, message }
 *   出: { type: "complete", id, actions }
 *   出: { type: "complete", id, folders }
 *   出: { type: "error", id, message }
 */

const { parentPort } = require("worker_threads");
const { YikeRemoteClient } = require("./remote_client");
const {
  SyncEngine,
  SyncControl,
  SyncDirection,
  SortField,
  FileCompareMode,
  PlanAction,
  SyncAction,
} = require("./sync_engine");
const { VideoCompressionOptions } = require("./video_compression");

// 当前活跃的 SyncControl（用于接收 pause/resume/stop）
let activeControl = null;
let activeClientId = null;

// ========== 消息处理 ==========

parentPort.on("message", (msg) => {
  if (msg.type === "control") {
    if (activeControl) {
      if (msg.command === "pause") activeControl.pause();
      else if (msg.command === "resume") activeControl.resume();
      else if (msg.command === "stop") activeControl.stop();
    }
    return;
  }

  if (msg.type === "build_plan") {
    handleBuildPlan(msg);
    return;
  }

  if (msg.type === "execute_plan") {
    handleExecutePlan(msg);
    return;
  }

  if (msg.type === "scan_local") {
    handleScanLocal(msg);
    return;
  }
});

// ========== build_plan ==========

async function handleBuildPlan(msg) {
  const { id, clientCookie, options } = msg;
  try {
    const client = new YikeRemoteClient(clientCookie);
    const compressionOptions = new VideoCompressionOptions({
      enabled: Boolean(options.compress_oversize_videos),
    });

    const engine = new SyncEngine(client, {
      max_workers: parseInt(options.max_workers || 4, 10),
      download_workers: parseInt(options.download_workers || 4, 10),
      list_threads: parseInt(options.list_threads || 8, 10),
      compare_mode: options.compare_mode || FileCompareMode.SMART,
      compression_options: compressionOptions,
    });

    const actions = await engine.buildPlan(
      options.root,
      options.direction || SyncDirection.LOCAL_TO_REMOTE,
      options.sort_field || SortField.NAME,
      Boolean(options.reverse),
      Boolean(options.enable_deletions),
      (value, text) => {
        parentPort.postMessage({ type: "progress", id, value, text });
      },
      options.ignored_album_names || [],
      Boolean(options.skip_oversize)
    );

    parentPort.postMessage({
      type: "complete",
      id,
      actions: actions.map(actionToSerializable),
    });
  } catch (err) {
    parentPort.postMessage({ type: "error", id, message: err.message || String(err) });
  }
}

// ========== execute_plan ==========

async function handleExecutePlan(msg) {
  const { id, clientCookie, actions, root, options } = msg;
  try {
    const client = new YikeRemoteClient(clientCookie);
    const compressionOptions = new VideoCompressionOptions({
      enabled: Boolean(options.compress_oversize_videos),
    });

    const engine = new SyncEngine(client, {
      max_workers: parseInt(options.max_workers || 4, 10),
      download_workers: parseInt(options.download_workers || 4, 10),
      list_threads: parseInt(options.list_threads || 8, 10),
      compare_mode: options.compare_mode || FileCompareMode.SMART,
      compression_options: compressionOptions,
    });

    // 反序列化 actions
    const syncActions = actions.map(actionFromSerializable);

    const control = new SyncControl();
    activeControl = control;
    activeClientId = id;

    const result = await engine.executePlan(
      root,
      syncActions,
      (value, text) => {
        parentPort.postMessage({ type: "progress", id, value, text });
      },
      control,
      (seq, text) => {
        parentPort.postMessage({ type: "status", id, sequence: seq, text });
      },
      (alertMsg) => {
        parentPort.postMessage({ type: "alert", id, message: alertMsg });
      }
    );

    parentPort.postMessage({
      type: "complete",
      id,
      actions: result.map(actionToSerializable),
    });
  } catch (err) {
    parentPort.postMessage({ type: "error", id, message: err.message || String(err) });
  } finally {
    activeControl = null;
    activeClientId = null;
  }
}

// ========== scan_local ==========

function handleScanLocal(msg) {
  const { id, root } = msg;
  try {
    const engine = new SyncEngine({});
    const folders = engine.scanLocal(root);
    parentPort.postMessage({
      type: "complete",
      id,
      folders: folders.map((f) => ({
        name: f.name,
        path: f.filePath || f.path || "",
        modified_at: f.modified_at,
        created_at: f.created_at,
        file_count: f.files.length,
        skipped_files: f.skipped_files.map(([n, r]) => ({ name: n, reason: r })),
      })),
    });
  } catch (err) {
    parentPort.postMessage({ type: "error", id, message: err.message || String(err) });
  }
}

// ========== 序列化辅助 ==========

function actionToSerializable(action) {
  return {
    sequence: action.sequence,
    action: action.action,
    album_name: action.album_name,
    media_name: action.media_name,
    source: action.source,
    detail: action.detail,
    local_path: action.local_path || "",
    remote_album_id: action.remote_album_id || "",
    remote_fsid: action.remote_fsid || "",
    size: action.size,
    status: action.status,
    can_execute: action.can_execute,
  };
}

function actionFromSerializable(data) {
  return new SyncAction({
    sequence: data.sequence,
    action: data.action,
    album_name: data.album_name,
    media_name: data.media_name || "",
    source: data.source || "",
    detail: data.detail || "",
    local_path: data.local_path || null,
    remote_album_id: data.remote_album_id || null,
    remote_fsid: data.remote_fsid || null,
    size: data.size || 0,
    status: data.status || "待执行",
  });
}
