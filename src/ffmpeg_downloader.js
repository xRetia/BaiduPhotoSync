"use strict";

/**
 *“极光引擎”下载器 — 移植自 ffmpeg_downloader.py
 *
 * 安全的按需 Windows“极光引擎”下载器，用于可选的视频压缩功能。
 * 从 GitHub BtbN/FFmpeg-Builds 下载最新 Windows GPL 静态构建，
 * 下载后进行 SHA-256 校验，然后解压安装 ffmpeg.exe 和 ffprobe.exe。
 *
 * 提供两种下载源：
 *  - official：官方源（GitHub 直连）
 *  - mirror：  国内镜像源（在官方地址前加 https://ghproxy.net/ 前缀）
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { exec } = require("child_process");
const { app_data_directory } = require("./platform_services");

const RELEASE_BASE = "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download";
const MIRROR_PREFIX = "https://gh-proxy.com/";
const ARCHIVE_NAME = "ffmpeg-master-latest-win64-gpl.zip";
const CHECKSUM_NAME = "checksums.sha256";
const CHUNK_SIZE = 512 * 1024;

// 下载源标识：official=官方源，mirror=国内镜像
const SOURCES = { OFFICIAL: "official", MIRROR: "mirror" };

function _baseUrl(source) {
  return source === SOURCES.MIRROR ? `${MIRROR_PREFIX}${RELEASE_BASE}` : RELEASE_BASE;
}

class FFmpegDownloadError extends Error {
  constructor(message, cancelled = false) {
    super(message);
    this.name = "FFmpegDownloadError";
    this.cancelled = cancelled;
  }
}

function download_directory() {
  return path.join(app_data_directory(), "ffmpeg");
}

async function _readChecksum(source = SOURCES.OFFICIAL) {
  const url = `${_baseUrl(source)}/${CHECKSUM_NAME}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const content = await resp.text();
    for (const line of content.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[parts.length - 1].replace(/^\*/, "") === ARCHIVE_NAME) {
        const digest = parts[0].toLowerCase();
        if (digest.length === 64 && /^[0-9a-f]+$/.test(digest)) {
          return digest;
        }
      }
    }
    throw new FFmpegDownloadError("发布页校验文件中未找到目标“极光引擎”的 SHA-256。");
  } catch (err) {
    if (err instanceof FFmpegDownloadError) throw err;
    throw new FFmpegDownloadError(`无法读取“极光引擎”校验文件：${err.name}`);
  }
}

const CONNECTIONS = 16; // 并行下载连接数

function _formatMib(value) {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function _formatSpeed(value) {
  return `${(value / 1024 / 1024).toFixed(1)} MB/秒`;
}

/**
 * 单连接下载一个字节段，写入 fd 的指定偏移位置。
 * 每连接独立停滞超时（30s 无数据则中止），响应外部取消信号。
 */
async function _downloadRange(url, destFd, start, end, externalSignal, onProgress) {
  const controller = new AbortController();
  let stallTimer = setTimeout(() => controller.abort(), 30000);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) { clearTimeout(stallTimer); throw new FFmpegDownloadError("下载已取消。", true); }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  try {
    const resp = await fetch(url, {
      signal: controller.signal,
      headers: { Range: `bytes=${start}-${end}` },
    });
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    let offset = start;

    while (true) {
      const { done, value } = await reader.read();
      clearTimeout(stallTimer);
      if (done) break;
      stallTimer = setTimeout(() => controller.abort(), 30000);

      // 同步写入文件指定位置
      const buf = value instanceof Buffer ? value : Buffer.from(value);
      fs.writeSync(destFd, buf, 0, buf.length, offset);
      offset += buf.length;
      onProgress(buf.length);
    }

    if (offset !== end + 1) {
      throw new Error(`段不完整: ${start}-${end}, 实际 ${offset - start} 字节`);
    }
  } catch (err) {
    clearTimeout(stallTimer);
    if (externalSignal?.aborted || err.name === "AbortError") {
      throw new FFmpegDownloadError("下载已取消。", true);
    }
    throw err;
  } finally {
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * 多连接并行下载：先用 HEAD 获取文件大小并探测 Range 支持，
 * 支持则分 16 段并行下载，不支持则回退单连接。
 */
async function _downloadArchive(targetPath, progress, source = SOURCES.OFFICIAL, externalSignal = null) {
  const url = `${_baseUrl(source)}/${ARCHIVE_NAME}`;
  const sourceLabel = source === SOURCES.MIRROR ? "国内镜像" : "官方";
  const tempPath = targetPath + ".part";

  if (externalSignal?.aborted) throw new FFmpegDownloadError("下载已取消。", true);

  // 探测文件大小和 Range 支持
  let totalSize = 0;
  let supportsRange = false;
  try {
    const headResp = await fetch(url, {
      method: "HEAD",
      signal: externalSignal ? externalSignal : undefined,
      headers: { Range: "bytes=0-0" },
    });
    if (headResp.status === 206) {
      supportsRange = true;
      const cr = headResp.headers.get("content-range");
      if (cr) {
        const m = cr.match(/\/(\d+)/);
        if (m) totalSize = parseInt(m[1], 10);
      }
    }
    if (!totalSize) {
      const cl = headResp.headers.get("content-length");
      if (cl) totalSize = parseInt(cl, 10);
    }
  } catch (err) {
    if (externalSignal?.aborted) throw new FFmpegDownloadError("下载已取消。", true);
    throw new FFmpegDownloadError(`“极光引擎”（${sourceLabel}源）连接失败：${err.name}`);
  }

  if (externalSignal?.aborted) throw new FFmpegDownloadError("下载已取消。", true);

  // 不支持 Range 或文件太小则单连接回退
  if (!supportsRange || totalSize < CONNECTIONS * 256 * 1024) {
    return _downloadArchiveSingle(tempPath, url, sourceLabel, progress, externalSignal);
  }

  // 多连接并行下载
  const fd = fs.openSync(tempPath, "w");
  try {
    // 预分配文件大小
    fs.ftruncateSync(fd, totalSize);

    const segmentSize = Math.ceil(totalSize / CONNECTIONS);
    const ranges = [];
    for (let i = 0; i < CONNECTIONS; i++) {
      const start = i * segmentSize;
      const end = Math.min(start + segmentSize - 1, totalSize - 1);
      if (start <= end) ranges.push({ start, end, index: i });
    }

    let downloaded = 0;
    const started = performance.now();
    let lastProgressTime = 0;

    const updateProgress = (delta) => {
      downloaded += delta;
      const now = performance.now();
      if (progress && now - lastProgressTime > 200) {
        lastProgressTime = now;
        const elapsed = Math.max(50, (now - started) / 1000);
        const speed = downloaded / elapsed;
        const percentage = 5 + Math.floor((downloaded / totalSize) * 80);
        const text = `正在下载极光视频压制引擎（${sourceLabel}）：${_formatMib(downloaded)} / ${_formatMib(totalSize)} · ${_formatSpeed(speed)}`;
        progress(Math.max(0, Math.min(100, percentage)), text);
      }
    };

    // 每个连接返回该段的 SHA-256，最终合并
    const tasks = ranges.map((r) =>
      _downloadRange(url, fd, r.start, r.end, externalSignal, updateProgress)
    );
    await Promise.all(tasks);

    if (progress) progress(85, `下载完成，正在校验完整性…`);

    // 读取整个文件计算 SHA-256
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(tempPath);
    for await (const chunk of stream) {
      hash.update(chunk);
    }
    const sha = hash.digest("hex").toLowerCase();
    fs.closeSync(fd);
    fs.renameSync(tempPath, targetPath);
    return sha;
  } catch (err) {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(tempPath); } catch {}
    if (err instanceof FFmpegDownloadError) throw err;
    if (externalSignal?.aborted || err.name === "AbortError") {
      throw new FFmpegDownloadError("下载已取消。", true);
    }
    throw new FFmpegDownloadError(`“极光引擎”（${sourceLabel}源）下载失败：${err.name}`);
  }
}

/** 单连接下载回退路径 */
async function _downloadArchiveSingle(tempPath, url, sourceLabel, progress, externalSignal = null) {
  const CONNECT_TIMEOUT = 90000;
  const STALL_TIMEOUT = 60000;
  const controller = new AbortController();
  let stallTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) { clearTimeout(stallTimer); throw new FFmpegDownloadError("下载已取消。", true); }
    externalSignal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let writer = null;
  try {
    const resp = await fetch(url, { signal: controller.signal });
    const total = parseInt(resp.headers.get("content-length") || "0", 10);
    writer = fs.createWriteStream(tempPath);
    const reader = resp.body.getReader();
    const hash = crypto.createHash("sha256");
    let downloaded = 0;
    const started = performance.now();

    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT);

    while (true) {
      const { done, value } = await reader.read();
      clearTimeout(stallTimer);
      if (done) break;
      stallTimer = setTimeout(() => controller.abort(), STALL_TIMEOUT);

      writer.write(value);
      hash.update(value);
      downloaded += value.length;
      const elapsed = Math.max(50, (performance.now() - started) / 1000);
      const speed = downloaded / elapsed;
      if (total > 0) {
        const percentage = 5 + Math.floor((downloaded / total) * 80);
        const text = `正在下载极光视频压制引擎（${sourceLabel}）：${_formatMib(downloaded)} / ${_formatMib(total)} · ${_formatSpeed(speed)}`;
        if (progress) progress(Math.max(0, Math.min(100, percentage)), text);
      } else {
        if (progress) progress(5, `正在下载极光视频压制引擎（${sourceLabel}）：${_formatMib(downloaded)} · ${_formatSpeed(speed)}`);
      }
    }
    writer.end();
    await new Promise((resolve) => writer.on("finish", resolve));
    fs.renameSync(tempPath, tempPath.replace(/\.part$/, ""));
    return hash.digest("hex").toLowerCase();
  } catch (err) {
    clearTimeout(stallTimer);
    if (writer) {
      try { writer.destroy(); } catch {}
      await new Promise((r) => writer.on("close", r)).catch(() => {});
    }
    try { fs.unlinkSync(tempPath); } catch {}
    if (externalSignal?.aborted || err.name === "AbortError") {
      throw new FFmpegDownloadError("下载已取消。", true);
    }
    throw new FFmpegDownloadError(`“极光引擎”（${sourceLabel}源）下载失败：${err.name}`);
  } finally {
    if (externalSignal) externalSignal.removeEventListener("abort", onExternalAbort);
  }
}

async function _extractTools(archivePath, destination) {
  // Node.js 没有内置 zip 解压，使用系统工具或第三方库
  // 优先尝试 PowerShell 的 Expand-Archive（Windows 自带）
  const nonce = `${process.pid}-${Date.now()}`;
  const stageDir = path.join(path.dirname(destination), `.ffmpeg_extracting-${nonce}`);
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });

    // 使用 PowerShell 解压
    const { execSync } = require("child_process");
    const psCommand = `Expand-Archive -Path '${archivePath}' -DestinationPath '${stageDir}' -Force`;
    execSync(psCommand, { stdio: "pipe", shell: "powershell.exe" });

    // 查找 ffmpeg.exe 和 ffprobe.exe
    function findInDir(dir, name) {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        const fullPath = path.join(dir, item.name);
        if (item.isDirectory()) {
          const found = findInDir(fullPath, name);
          if (found) return found;
        } else if (item.name === name) {
          return fullPath;
        }
      }
      return null;
    }

    const stagedFfmpeg = findInDir(stageDir, "ffmpeg.exe");
    const stagedFfprobe = findInDir(stageDir, "ffprobe.exe");
    if (!stagedFfmpeg || !stagedFfprobe) {
      throw new FFmpegDownloadError("下载包中缺少 ffmpeg.exe 或 ffprobe.exe。");
    }

    // 安装到目标目录
    fs.mkdirSync(destination, { recursive: true });
    const targetFfmpeg = path.join(destination, "ffmpeg.exe");
    const targetFfprobe = path.join(destination, "ffprobe.exe");
    fs.copyFileSync(stagedFfmpeg, targetFfmpeg);
    fs.copyFileSync(stagedFfprobe, targetFfprobe);

    return { ffmpegPath: targetFfmpeg, ffprobePath: targetFfprobe };
  } catch (err) {
    if (err instanceof FFmpegDownloadError) throw err;
    throw new FFmpegDownloadError(`“极光引擎”解压或安装失败：${err.name}`);
  } finally {
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 确保 Windows“极光引擎”可用，如需则下载安装。
 * @param {function|null} progress - 进度回调 (percent, message)
 * @param {string} [source] - 下载源：official（官方）或 mirror（国内镜像），默认 official
 * @param {AbortSignal|null} [abortSignal] - 外部取消信号，abort 时中止下载
 * @returns {Promise<{ffmpegPath, ffprobePath, downloaded, archiveSha256}>}
 */
async function ensure_windows_ffmpeg(progress = null, source = SOURCES.OFFICIAL, abortSignal = null) {
  if (process.platform !== "win32") {
    throw new FFmpegDownloadError("按需下载仅支持 Windows；请在 Windows 程序中启用视频压缩。");
  }
  if (source !== SOURCES.OFFICIAL && source !== SOURCES.MIRROR) {
    source = SOURCES.OFFICIAL;
  }
  const sourceLabel = source === SOURCES.MIRROR ? "国内镜像" : "官方";
  const destination = download_directory();
  const ffmpegPath = path.join(destination, "ffmpeg.exe");
  const ffprobePath = path.join(destination, "ffprobe.exe");

  if (fs.existsSync(ffmpegPath) && fs.existsSync(ffprobePath)) {
    if (progress) progress(100, "已检测到极光视频压制引擎，视频压缩可以使用。");
    return { ffmpegPath, ffprobePath, downloaded: false, archiveSha256: "" };
  }

  const archivePath = path.join(path.dirname(destination), ARCHIVE_NAME);
  if (abortSignal?.aborted) throw new FFmpegDownloadError("下载已取消。", true);
  if (progress) progress(2, `正在读取极光视频压制引擎（${sourceLabel}源）发布校验信息…`);
  const expectedSha256 = await _readChecksum(source);
  if (abortSignal?.aborted) throw new FFmpegDownloadError("下载已取消。", true);
  if (progress) progress(5, `已获取校验信息，开始从${sourceLabel}源下载极光视频压制引擎…`);
  const actualSha256 = await _downloadArchive(archivePath, progress, source, abortSignal);
  if (progress) progress(87, "正在校验极光视频压制引擎下载完整性…");
  if (actualSha256 !== expectedSha256) {
    try { fs.unlinkSync(archivePath); } catch {}
    throw new FFmpegDownloadError("极光视频压制引擎 SHA-256 校验失败，已删除下载文件。");
  }
  if (progress) progress(93, "校验通过，正在安装极光视频压制引擎…");
  const { ffmpegPath: ff, ffprobePath: fp } = await _extractTools(archivePath, destination);
  try { fs.unlinkSync(archivePath); } catch {}
  if (progress) progress(100, "极光视频压制引擎已下载并校验完成。");
  return { ffmpegPath: ff, ffprobePath: fp, downloaded: true, archiveSha256: actualSha256 };
}

module.exports = {
  FFmpegDownloadError,
  SOURCES,
  download_directory,
  ensure_windows_ffmpeg,
};
