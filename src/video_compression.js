"use strict";

/**
 * 视频压缩 — 移植自 video_compression.py
 *
 * 为免费用户上传限制准备的本地视频压缩功能。
 * 原始文件永不被修改：在临时目录中创建压缩副本，上传后删除临时文件。
 * FFmpeg 需要打包在 app 旁或由 ffmpeg_downloader 按需下载。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn, execSync } = require("child_process");
const { media_kind, FREE_USER_VIDEO_MAX_BYTES } = require("./media_validation");
const { download_directory } = require("./ffmpeg_downloader");

const TARGET_UPLOAD_BYTES = 28 * 1024 * 1024;
const TARGET_SAFETY_RATIO = 0.94;
const AUDIO_BITRATE_BPS = 96 * 1024;
const AMF_LOW_BITRATE_BPS = 550 * 1024;

class VideoCompressionError extends Error {
  constructor(message) {
    super(message);
    this.name = "VideoCompressionError";
  }
}

class VideoCompressionOptions {
  constructor({ enabled = false, target_bytes = TARGET_UPLOAD_BYTES } = {}) {
    this.enabled = enabled;
    this.target_bytes = target_bytes;
  }
  toWorkerDict() {
    return { enabled: Boolean(this.enabled), target_bytes: parseInt(this.target_bytes) };
  }
  static fromWorkerDict(raw = {}) {
    const target_bytes = parseInt(raw.target_bytes || TARGET_UPLOAD_BYTES);
    return new VideoCompressionOptions({
      enabled: Boolean(raw.enabled || false),
      target_bytes: isNaN(target_bytes) ? TARGET_UPLOAD_BYTES : target_bytes,
    });
  }
}

class VideoProbe {
  constructor({ duration_seconds, width, height, has_audio }) {
    this.duration_seconds = duration_seconds;
    this.width = width;
    this.height = height;
    this.has_audio = has_audio;
  }
}

class CompressionResult {
  constructor({ path, encoder, width, height, video_bitrate_bps, source_bytes, output_bytes }) {
    this.path = path;
    this.encoder = encoder;
    this.width = width;
    this.height = height;
    this.video_bitrate_bps = video_bitrate_bps;
    this.source_bytes = source_bytes;
    this.output_bytes = output_bytes;
  }
}

function _resourceBase() {
  // Electron 主进程：app.getAppPath() 或 __dirname
  return path.resolve(__dirname, "..");
}

function _findTool(name) {
  const executable = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    path.join(_resourceBase(), "ffmpeg", executable),
    path.join(path.dirname(process.execPath), "ffmpeg", executable),
    path.join(__dirname, "ffmpeg", executable),
  ];
  // 按需下载目录
  try {
    candidates.push(path.join(download_directory(), executable));
  } catch {}
  // 兼容旧版 AppData/YikeSync/ffmpeg
  if (process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, "YikeSync", "ffmpeg", executable));
  }
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // 系统 PATH
  try {
    const which = process.platform === "win32"
      ? execSync(`where ${executable} 2>nul`, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }).trim().split("\n")[0]
      : execSync(`which ${name}`, { encoding: "utf-8" }).trim();
    if (which) return which;
  } catch {}
  if (process.platform === "win32") {
    throw new VideoCompressionError(
      '未检测到 Windows FFmpeg。请在"高级设置 → 视频"启用"压缩视频到30M以内"，程序会下载并校验所需组件。'
    );
  } else if (process.platform === "darwin") {
    throw new VideoCompressionError("未检测到 macOS FFmpeg。请安装 ffmpeg 与 ffprobe，并确认它们位于 PATH 后重新启用视频压缩。");
  } else {
    throw new VideoCompressionError("未检测到 Linux FFmpeg。请安装 ffmpeg 与 ffprobe，并确认它们位于 PATH 后重新启用视频压缩。");
  }
}

function locate_ffmpeg() { return _findTool("ffmpeg"); }
function locate_ffprobe() { return _findTool("ffprobe"); }

function needs_compression(filePath, options) {
  if (!options.enabled || media_kind(filePath) !== "video") return false;
  try {
    return fs.statSync(filePath).size > FREE_USER_VIDEO_MAX_BYTES;
  } catch (err) {
    throw new VideoCompressionError(`无法读取视频大小：${path.basename(filePath)}（${err.name}）`);
  }
}

function _runCapture(args, timeout = 30) {
  return new Promise((resolve, reject) => {
    const proc = spawn(args[0], args.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    proc.stdout.on("data", (d) => (out += d.toString("utf-8")));
    proc.stderr.on("data", (d) => (err += d.toString("utf-8")));
    const timer = setTimeout(() => proc.kill(), timeout * 1000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new VideoCompressionError(`FFmpeg 命令失败：${(err || out).trim().slice(-1200)}`));
    });
    proc.on("error", (e) => {
      clearTimeout(timer);
      reject(new VideoCompressionError(`无法启动 FFmpeg：${e.name}`));
    });
  });
}

async function probe_video(filePath) {
  const ffprobe = locate_ffprobe();
  const raw = await _runCapture([
    ffprobe, "-v", "error", "-show_entries",
    "format=duration:stream=codec_type,width,height", "-of", "json", filePath,
  ]);
  try {
    const info = JSON.parse(raw);
    const duration = parseFloat((info.format && info.format.duration) || 0);
    const streams = info.streams || [];
    const videoStream = streams.find((s) => s.codec_type === "video");
    if (!videoStream) throw new Error("no video stream");
    const width = parseInt(videoStream.width || 0, 10);
    const height = parseInt(videoStream.height || 0, 10);
    const has_audio = streams.some((s) => s.codec_type === "audio");
    if (duration <= 0 || width <= 0 || height <= 0) {
      throw new VideoCompressionError(`视频元数据无效：${path.basename(filePath)}`);
    }
    return new VideoProbe({ duration_seconds: duration, width, height, has_audio });
  } catch (err) {
    if (err instanceof VideoCompressionError) throw err;
    throw new VideoCompressionError(`无法读取视频时长或分辨率：${path.basename(filePath)}`);
  }
}

let _usableEncodersCache = null;

async function available_encoders() {
  const ffmpeg = locate_ffmpeg();
  const text = await _runCapture([ffmpeg, "-hide_banner", "-encoders"]);
  const result = [];
  for (const encoder of ["h264_amf", "h264_nvenc", "h264_qsv", "libx264"]) {
    for (const line of text.split("\n")) {
      if (line.split(/\s+/).includes(encoder)) {
        result.push(encoder);
        break;
      }
    }
  }
  return result;
}

async function usable_encoders() {
  if (_usableEncodersCache !== null) return [..._usableEncodersCache];
  const ffmpeg = locate_ffmpeg();
  const working = [];
  for (const encoder of await available_encoders()) {
    try {
      const { spawnSync } = require("child_process");
      spawnSync(
        ffmpeg, ["-hide_banner", "-loglevel", "error", "-f", "lavfi",
          "-i", "color=c=black:s=64x64:r=1:d=1", "-frames:v", "1",
          "-c:v", encoder, "-f", "null", "-"],
        { stdio: "ignore", timeout: 15000 }
      );
      working.push(encoder);
    } catch {
      continue;
    }
  }
  _usableEncodersCache = working;
  console.info(`FFmpeg 可用编码器探测完成：${working.join(", ") || "无"}`);
  return [...working];
}

async function _encoderOrder(videoBitrateBps) {
  const installed = await usable_encoders();
  const ordered = ["h264_amf", "h264_nvenc", "h264_qsv"].filter((e) => installed.includes(e));
  if (ordered.includes("h264_amf") && videoBitrateBps < AMF_LOW_BITRATE_BPS) {
    ordered.splice(ordered.indexOf("h264_amf"), 1);
  }
  if (installed.includes("libx264")) ordered.push("libx264");
  if (ordered.length === 0) {
    throw new VideoCompressionError("未探测到可用的 h264_amf、h264_nvenc、h264_qsv 或 libx264 编码器。");
  }
  return ordered;
}

function _candidateSizes(probe) {
  const candidates = [];
  for (const maxHeight of [probe.height, 1080, 720, 480]) {
    let height = Math.min(probe.height, maxHeight);
    height -= height % 2;
    if (height < 2) continue;
    let width = Math.max(2, Math.round((probe.width * height) / probe.height));
    width -= width % 2;
    const pair = [width, height];
    if (!candidates.some((c) => c[0] === pair[0] && c[1] === pair[1])) {
      candidates.push(pair);
    }
  }
  return candidates;
}

function _minimumVideoBitrateBps(height) {
  if (height >= 1080) return 1800 * 1024;
  if (height >= 720) return 1050 * 1024;
  if (height >= 480) return 600 * 1024;
  return 400 * 1024;
}

function _videoBitrateBudget(probe, targetBytes) {
  const totalBps = Math.floor((Math.max(1, targetBytes) * 8 * TARGET_SAFETY_RATIO) / probe.duration_seconds);
  const audioBps = probe.has_audio ? AUDIO_BITRATE_BPS : 0;
  return Math.max(160 * 1024, totalBps - audioBps);
}

function _ffmpegCommand(source, output, encoder, width, height, videoBitrateBps, hasAudio) {
  const ffmpeg = locate_ffmpeg();
  const bitrate = String(Math.max(1, Math.floor(videoBitrateBps)));
  const command = [
    ffmpeg, "-y", "-hide_banner", "-loglevel", "error", "-nostdin",
    "-progress", "pipe:1", "-i", source, "-map", "0:v:0", "-map", "0:a?",
    "-vf", `scale=${width}:${height}`, "-c:v", encoder,
    "-b:v", bitrate, "-maxrate", bitrate, "-bufsize", String(Math.max(1, Math.floor(videoBitrateBps) * 2)),
    "-pix_fmt", "yuv420p",
  ];
  if (encoder === "h264_amf") {
    command.push("-usage", "transcoding", "-quality", "quality", "-rc", "vbr_peak", "-vbaq", "true");
  } else if (encoder === "h264_nvenc") {
    command.push("-preset", "p6", "-rc", "vbr");
  } else if (encoder === "h264_qsv") {
    command.push("-preset", "medium");
  } else {
    command.push("-preset", "medium");
  }
  if (hasAudio) {
    command.push("-c:a", "aac", "-b:a", String(AUDIO_BITRATE_BPS));
  } else {
    command.push("-an");
  }
  if (output.toLowerCase().endsWith(".mp4")) {
    command.push("-movflags", "+faststart");
  }
  command.push(output);
  return command;
}

function _runEncode(command, durationSeconds, progress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command[0], command.slice(1), {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let tail = [];
    proc.stdout.on("data", (data) => {
      const lines = data.toString("utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          tail.push(trimmed);
          if (tail.length > 30) tail.shift();
          if (progress && trimmed.startsWith("out_time_ms=")) {
            try {
              const elapsed = parseInt(trimmed.split("=")[1], 10) / 1000000;
              const percentage = Math.min(96, Math.max(1, Math.floor((elapsed / durationSeconds) * 96)));
              progress(percentage, `正在压缩视频（${percentage}%）`);
            } catch {}
          }
        }
      }
    });
    proc.stderr.on("data", (data) => {
      const lines = data.toString("utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          tail.push(trimmed);
          if (tail.length > 30) tail.shift();
        }
      }
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        const detail = tail.join("\n").slice(-1500) || `退出码 ${code}`;
        reject(new VideoCompressionError(`FFmpeg 压缩失败：${detail}`));
      } else {
        resolve();
      }
    });
    proc.on("error", (err) => {
      reject(new VideoCompressionError(`无法启动 FFmpeg：${err.name}`));
    });
  });
}

async function compress_video(source, output, options, progress = null) {
  const probe = await probe_video(source);
  const sourceBytes = fs.statSync(source).size;
  const baseBudget = _videoBitrateBudget(probe, options.target_bytes);
  let lastError = null;

  for (const [width, height] of _candidateSizes(probe)) {
    let budget = baseBudget;
    if (budget < _minimumVideoBitrateBps(height)) continue;

    for (let attempt = 0; attempt < 3; attempt++) {
      for (const encoder of await _encoderOrder(budget)) {
        try {
          if (fs.existsSync(output)) fs.unlinkSync(output);
          if (progress) progress(1, `使用 ${encoder} 压缩为 ${width}×${height}`);
          await _runEncode(
            _ffmpegCommand(source, output, encoder, width, height, budget, probe.has_audio),
            probe.duration_seconds,
            progress
          );
          const outputBytes = fs.statSync(output).size;
          if (outputBytes <= options.target_bytes) {
            if (progress) progress(100, `压缩完成：${(outputBytes / 1024 / 1024).toFixed(1)} MB，准备上传`);
            return new CompressionResult({
              path: output,
              encoder,
              width,
              height,
              video_bitrate_bps: budget,
              source_bytes: sourceBytes,
              output_bytes: outputBytes,
            });
          }
          const observedRatio = options.target_bytes / Math.max(1, outputBytes);
          budget = Math.max(160 * 1024, Math.floor((budget * observedRatio * 0.94)));
          lastError = new VideoCompressionError(`压缩后仍为 ${(outputBytes / 1024 / 1024).toFixed(1)} MB，继续降低码率`);
          break;
        } catch (err) {
          if (err instanceof VideoCompressionError) {
            lastError = err;
            console.warn(`视频压缩尝试失败：编码器=${encoder}，分辨率=${width}x${height}，错误=${err.message}`);
            continue;
          }
          throw err;
        }
      }
      if (budget < _minimumVideoBitrateBps(height)) break;
    }
  }
  throw new VideoCompressionError(
    `无法在 ${(options.target_bytes / 1024 / 1024).toFixed(0)} MB 内以可接受画质压缩：${path.basename(source)}`
  );
}

/**
 * 异步上下文管理器：如果需要压缩，在临时目录中创建压缩副本，完成后清理。
 *
 * 采用 use 回调模式：临时文件在 use 回调返回后才被清理，
 * 避免调用方在上传完成前临时文件就被删除的 bug（JS try…finally + return 语义）。
 *
 * @param {string} source - 源文件路径
 * @param {VideoCompressionOptions} options - 压缩选项
 * @param {function|null} progress - 进度回调
 * @param {function|null} use - 异步回调 (prepared: CompressionResult|null) => any
 * @returns {Promise<any>} use 回调的返回值
 */
async function prepared_video_upload(source, options, progress = null, use = null) {
  if (!needs_compression(source, options)) {
    return use ? await use(null) : null;
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "yike-video-upload-"));
  const output = path.join(tempDir, path.basename(source));
  try {
    const result = await compress_video(source, output, options, progress);
    if (use) return await use(result);
    return result;
  } finally {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
  }
}

module.exports = {
  VideoCompressionError,
  VideoCompressionOptions,
  VideoProbe,
  CompressionResult,
  locate_ffmpeg,
  locate_ffprobe,
  needs_compression,
  probe_video,
  compress_video,
  prepared_video_upload,
};
