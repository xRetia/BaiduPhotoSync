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
const MIRROR_PREFIX = "https://ghproxy.net/";
const ARCHIVE_NAME = "ffmpeg-master-latest-win64-gpl.zip";
const CHECKSUM_NAME = "checksums.sha256";
const CHUNK_SIZE = 512 * 1024;

// 下载源标识：official=官方源，mirror=国内镜像
const SOURCES = { OFFICIAL: "official", MIRROR: "mirror" };

function _baseUrl(source) {
  return source === SOURCES.MIRROR ? `${MIRROR_PREFIX}${RELEASE_BASE}` : RELEASE_BASE;
}

class FFmpegDownloadError extends Error {
  constructor(message) {
    super(message);
    this.name = "FFmpegDownloadError";
  }
}

function download_directory() {
  return path.join(app_data_directory(), "ffmpeg");
}

async function _readChecksum(source = SOURCES.OFFICIAL) {
  const url = `${_baseUrl(source)}/${CHECKSUM_NAME}`;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(25000) });
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

function _formatMib(value) {
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function _formatSpeed(value) {
  return `${(value / 1024 / 1024).toFixed(1)} MB/秒`;
}

async function _downloadArchive(targetPath, progress, source = SOURCES.OFFICIAL) {
  const url = `${_baseUrl(source)}/${ARCHIVE_NAME}`;
  const sourceLabel = source === SOURCES.MIRROR ? "国内镜像" : "官方";
  const tempPath = targetPath + ".part";
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
    const total = parseInt(resp.headers.get("content-length") || "0", 10);
    const writer = fs.createWriteStream(tempPath);
    const reader = resp.body.getReader();
    const hash = crypto.createHash("sha256");
    let downloaded = 0;
    const started = performance.now();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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
    fs.renameSync(tempPath, targetPath);
    return hash.digest("hex").toLowerCase();
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw new FFmpegDownloadError(`“极光引擎”（${sourceLabel}源）下载失败：${err.name}`);
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
 * @returns {Promise<{ffmpegPath, ffprobePath, downloaded, archiveSha256}>}
 */
async function ensure_windows_ffmpeg(progress = null, source = SOURCES.OFFICIAL) {
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
  if (progress) progress(2, `正在读取极光视频压制引擎（${sourceLabel}源）发布校验信息…`);
  const expectedSha256 = await _readChecksum(source);
  if (progress) progress(5, `已获取校验信息，开始从${sourceLabel}源下载极光视频压制引擎…`);
  const actualSha256 = await _downloadArchive(archivePath, progress, source);
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
