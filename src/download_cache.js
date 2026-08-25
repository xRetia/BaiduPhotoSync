"use strict";

/**
 * 下载缓存 — 移植自 download_cache.py
 * LRU 风格磁盘缓存，按 (album_id, fsid, variant) 键。
 */
const fs = require("fs");
const path = require("path");

function _safe_component(value) {
  const cleaned = String(value)
    .split("")
    .filter((c) => /[a-zA-Z0-9\-_.]/.test(c))
    .join("")
    .slice(0, 160);
  return cleaned || "item";
}

class DownloadCache {
  constructor(root, maxBytes) {
    this.root = root;
    this.maxBytes = Math.max(0, parseInt(maxBytes) || 0);
    this._entryLocks = new Map();
  }

  _entryDirectory(albumId, fsid, variant = "original") {
    const root = path.join(this.root, _safe_component(albumId), _safe_component(fsid));
    return variant === "original" ? root : path.join(root, _safe_component(variant));
  }

  _entryFiles(albumId, fsid, variant = "original") {
    const dir = this._entryDirectory(albumId, fsid, variant);
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir)
      .map((name) => path.join(dir, name))
      .filter((p) => fs.statSync(p).isFile() && !p.endsWith(".part"));
  }

  _matchesExpectedSize(filePath, expectedSize) {
    try {
      return expectedSize <= 0 || fs.statSync(filePath).size === expectedSize;
    } catch {
      return false;
    }
  }

  lookup(albumId, fsid, expectedSize = 0, variant = "original") {
    for (const p of this._entryFiles(albumId, fsid, variant)) {
      if (this._matchesExpectedSize(p, expectedSize)) {
        try { fs.utimesSync(p, new Date(), new Date()); } catch {}
        return p;
      }
    }
    return null;
  }

  async get_or_download(albumId, fsid, expectedSize, downloader, variant = "original") {
    const key = `${albumId}|${fsid}|${variant}`;
    if (!this._entryLocks.has(key)) this._entryLocks.set(key, Promise.resolve());
    const prev = this._entryLocks.get(key);
    let result;
    await prev.then(async () => {
      const hit = this.lookup(albumId, fsid, expectedSize, variant);
      if (hit) {
        result = { path: hit, hit: true };
        return;
      }
      const entryDir = this._entryDirectory(albumId, fsid, variant);
      try { fs.rmSync(entryDir, { recursive: true, force: true }); } catch {}
      fs.mkdirSync(entryDir, { recursive: true });
      try {
        const downloaded = await downloader(entryDir);
        if (!fs.existsSync(downloaded) || !fs.statSync(downloaded).isFile()) {
          throw new Error("下载客户端没有生成缓存文件。");
        }
        if (!this._matchesExpectedSize(downloaded, expectedSize)) {
          throw new Error("下载文件大小与云端媒体信息不一致。");
        }
        try { fs.utimesSync(downloaded, new Date(), new Date()); } catch {}
        this.enforce_limit(undefined, downloaded);
        result = { path: downloaded, hit: false };
      } catch (err) {
        try { fs.rmSync(entryDir, { recursive: true, force: true }); } catch {}
        throw err;
      }
    });
    this._entryLocks.set(key, Promise.resolve());
    return result;
  }

  size_bytes() {
    if (!fs.existsSync(this.root)) return 0;
    let total = 0;
    const walk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        try {
          const stat = fs.statSync(p);
          if (stat.isFile() && !name.endsWith(".part")) {
            total += stat.size;
          } else if (stat.isDirectory()) {
            walk(p);
          }
        } catch {}
      }
    };
    walk(this.root);
    return total;
  }

  enforce_limit(maxBytes, protectedPath) {
    if (maxBytes != null) this.maxBytes = Math.max(0, parseInt(maxBytes) || 0);
    if (this.maxBytes <= 0) return this.clear();
    const entries = [];
    let total = 0;
    if (fs.existsSync(this.root)) {
      const walk = (dir) => {
        for (const name of fs.readdirSync(dir)) {
          const p = path.join(dir, name);
          try {
            const stat = fs.statSync(p);
            if (stat.isFile() && !name.endsWith(".part")) {
              total += stat.size;
              entries.push({ mtime: stat.mtimeMs, size: stat.size, path: p });
            } else if (stat.isDirectory()) {
              walk(p);
            }
          } catch {}
        }
      };
      walk(this.root);
    }
    entries.sort((a, b) => a.mtime - b.mtime);
    let removed = 0;
    for (const entry of entries) {
      if (total <= this.maxBytes) break;
      if (protectedPath && path.resolve(entry.path) === path.resolve(protectedPath)) continue;
      try {
        fs.unlinkSync(entry.path);
        total -= entry.size;
        removed += entry.size;
        // Clean empty parent dirs
        let parent = path.dirname(entry.path);
        while (parent !== this.root && fs.existsSync(parent)) {
          if (fs.readdirSync(parent).length > 0) break;
          fs.rmdirSync(parent);
          parent = path.dirname(parent);
        }
      } catch {}
    }
    return removed;
  }

  clear() {
    const removed = this.size_bytes();
    try { fs.rmSync(this.root, { recursive: true, force: true }); } catch {}
    return removed;
  }
}

module.exports = { DownloadCache };
