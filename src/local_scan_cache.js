"use strict";

/**
 * 本地扫描缓存 — 移植自 local_scan_cache.py
 *
 * 持久化保存文件元数据 + 媒体验证结果。
 * 仅当 path / size / mtime_ns / ctime_ns 全部匹配时才复用缓存判定。
 * 缓存内容不含文件内容、校验和、Cookie 或远程账户数据。
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const CACHE_DIRECTORY_NAME = ".yike_cache";
const CACHE_FILE_NAME = "local_media_validation_v2.json";
const CACHE_VERSION = 2;

class LocalScanCache {
  constructor(root) {
    this.root = root;
    this.directory = path.join(root, CACHE_DIRECTORY_NAME);
    this.cachePath = path.join(this.directory, CACHE_FILE_NAME);
    this._entries = {};
    this._dirty = false;
    this._load();
  }

  _metadata(filePath) {
    const stat = fs.statSync(filePath);
    return {
      size: stat.size,
      mtime_ns: Number(stat.mtimeNs || (stat.mtimeMs * 1e6)),
      ctime_ns: Number(stat.ctimeNs || (stat.ctimeMs * 1e6)),
    };
  }

  _key(filePath) {
    return path.relative(this.root, filePath).replace(/\\/g, "/");
  }

  _load() {
    try {
      const payload = JSON.parse(fs.readFileSync(this.cachePath, "utf-8"));
      if (payload.version !== CACHE_VERSION || typeof payload.entries !== "object") {
        return;
      }
      this._entries = payload.entries;
    } catch {
      // 缺失或损坏的缓存绝不能阻塞扫描
      this._entries = {};
    }
  }

  /**
   * 查询缓存判定。如果元数据不匹配则返回 null。
   * @returns {[boolean, string] | null}
   */
  lookup(filePath) {
    try {
      const meta = this._metadata(filePath);
      const key = this._key(filePath);
      const entry = this._entries[key];
      if (!entry || typeof entry !== "object") return null;
      if (
        entry.size !== meta.size ||
        entry.mtime_ns !== meta.mtime_ns ||
        entry.ctime_ns !== meta.ctime_ns ||
        typeof entry.is_media !== "boolean" ||
        typeof entry.message !== "string"
      ) {
        return null;
      }
      return [entry.is_media, entry.message];
    } catch {
      return null;
    }
  }

  /**
   * 记录文件判定结果。
   */
  record(filePath, isMedia, message) {
    try {
      const meta = this._metadata(filePath);
      const key = this._key(filePath);
      this._entries[key] = {
        size: meta.size,
        mtime_ns: meta.mtime_ns,
        ctime_ns: meta.ctime_ns,
        is_media: Boolean(isMedia),
        message: String(message),
      };
      this._dirty = true;
    } catch {
      // 忽略
    }
  }

  /**
   * 清除不再存在的缓存条目。
   */
  prune(liveKeys) {
    const liveSet = new Set(liveKeys);
    let changed = false;
    for (const key of Object.keys(this._entries)) {
      if (!liveSet.has(key)) {
        delete this._entries[key];
        changed = true;
      }
    }
    if (changed) this._dirty = true;
  }

  /**
   * 保存缓存到磁盘（原子写入）。
   */
  save() {
    if (!this._dirty) return;
    const payload = {
      version: CACHE_VERSION,
      entries: this._entries,
    };
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      const tmpPath = this.cachePath + ".tmp";
      fs.writeFileSync(tmpPath, JSON.stringify(payload), "utf-8");
      fs.renameSync(tmpPath, this.cachePath);
      this._dirty = false;
      // Windows: 设置缓存目录为隐藏
      if (process.platform === "win32") {
        try {
          const { execSync } = require("child_process");
          execSync(`attrib +H "${this.directory}"`, { stdio: "ignore" });
        } catch {
          // 忽略
        }
      }
    } catch {
      // 缓存写入失败绝不能导致用户同步失败
    }
  }
}

module.exports = {
  CACHE_DIRECTORY_NAME,
  LocalScanCache,
};
