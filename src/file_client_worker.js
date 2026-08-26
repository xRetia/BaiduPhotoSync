"use strict";

/**
 * 文件客户端 Worker — 移植自 file_client_worker.py
 *
 * 一次性 worker 入口点，由主进程通过 child_process.fork 启动。
 * 接收一个确切的上传任务，报告进度，返回结果。
 * 不执行相册关联（addfile），由主控制器后续批量处理。
 *
 * 通信方式：process.send() 发送消息（{kind: "progress"|"result", ...}）
 * 环境变量传入：cookie、album_id、album_info、file_path、compression_options
 */

const path = require("path");
const { YikeRemoteClient } = require("./remote_client");
const { VideoCompressionOptions, prepared_video_upload } = require("./video_compression");

async function run() {
  const cookieText = process.env.YIKE_WORKER_COOKIE;
  const albumId = process.env.YIKE_WORKER_ALBUM_ID;
  const albumInfo = JSON.parse(process.env.YIKE_WORKER_ALBUM_INFO || "{}");
  const filePath = process.env.YIKE_WORKER_FILE_PATH;
  const compressionRaw = process.env.YIKE_WORKER_COMPRESSION;
  const compressionOptions = VideoCompressionOptions.fromWorkerDict(
    compressionRaw ? JSON.parse(compressionRaw) : {}
  );

  const report = (value, message) => {
    if (process.send) {
      process.send({ kind: "progress", value: parseInt(value), message: String(message) });
    }
  };

  try {
    // 创建隔离的客户端，预绑定到指定相册
    const client = new YikeRemoteClient(cookieText);
    client._albums.set(String(albumId), albumInfo);

    // 视频压缩（如果需要）—— use 回调模式：临时压缩文件在上传完成后才清理
    const { fsid, uploadPath } = await prepared_video_upload(
      filePath, compressionOptions, report,
      async (prepared) => {
        const p = prepared ? prepared.path : filePath;
        const result = await client.uploadFilePayloadOnce(p, report);
        return { fsid: result.fsid, uploadPath: p, alreadyExist: result.alreadyExist };
      }
    );
    const compressedNote = uploadPath !== filePath ? "（已上传临时压缩副本，本地高清原件未修改）" : "";

    if (process.send) {
      process.send({
        kind: "result",
        ok: true,
        fsid,
        message: `已上传 ${path.basename(filePath)}${compressedNote}，等待主控制器统一加入相册`,
      });
    }
  } catch (err) {
    if (process.send) {
      process.send({
        kind: "result",
        ok: false,
        error: String(err.message || err),
        debug_error: err.stack || "",
      });
    }
  }

  // 退出进程
  process.exit(0);
}

run();
