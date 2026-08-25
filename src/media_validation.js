"use strict";

/**
 * 媒体文件验证 — 移植自 media_validation.py
 * 按扩展名判断照片/视频，不读文件头（避免 MPO 误判）。
 */
const fs = require("fs");
const path = require("path");

const PHOTO_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".heif",
  ".bmp", ".tif", ".tiff",
]);
const VIDEO_EXTENSIONS = new Set([
  ".mp4", ".mov", ".m4v", ".avi", ".mkv", ".wmv", ".flv",
  ".webm", ".3gp", ".3g2", ".mpg", ".mpeg", ".ts", ".mts", ".m2ts",
]);
const MEDIA_EXTENSIONS = new Set([...PHOTO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

const FREE_USER_PHOTO_MAX_BYTES = 30 * 1024 * 1024;
const FREE_USER_VIDEO_MAX_BYTES = 30 * 1024 * 1024;

function media_kind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (PHOTO_EXTENSIONS.has(ext)) return "photo";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  return null;
}

function formatSize(numBytes) {
  if (numBytes < 1024 * 1024) return `${(numBytes / 1024).toFixed(0)} KB`;
  const mb = numBytes / (1024 * 1024);
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  return `${mb.toFixed(0)} MB`;
}

function validate_media_file(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (!MEDIA_EXTENSIONS.has(ext)) {
    return [false, `扩展名 ${ext || "无"} 不属于支持的照片或视频格式`];
  }
  try {
    if (fs.statSync(filePath).size === 0) return [false, "文件为空"];
  } catch (err) {
    return [false, `无法读取文件：${err.name}`];
  }
  return [true, PHOTO_EXTENSIONS.has(ext) ? "有效照片" : "有效视频"];
}

function free_user_size_message(filePath, size) {
  const kind = media_kind(filePath);
  if (!kind) return null;
  if (size == null) {
    try { size = fs.statSync(filePath).size; } catch { return null; }
  }
  if (size == null) return null;
  if (kind === "video" && size > FREE_USER_VIDEO_MAX_BYTES) {
    return `视频大小 ${formatSize(size)} 超过普通用户 30MB 上限，普通账号无法上传，需开通超级会员或压缩后上传`;
  }
  if (kind === "photo" && size > FREE_USER_PHOTO_MAX_BYTES) {
    return `照片大小 ${formatSize(size)} 超过普通用户 30MB 上限，普通账号无法上传，需开通超级会员或压缩后上传`;
  }
  return null;
}

module.exports = {
  PHOTO_EXTENSIONS,
  VIDEO_EXTENSIONS,
  MEDIA_EXTENSIONS,
  FREE_USER_PHOTO_MAX_BYTES,
  FREE_USER_VIDEO_MAX_BYTES,
  media_kind,
  formatSize,
  validate_media_file,
  free_user_size_message,
};
