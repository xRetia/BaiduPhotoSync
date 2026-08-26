"use strict";

/**
 * 同步引擎 — 移植自 sync_engine.py (1363 行)
 *
 * 保守的基于文件名存在性的同步计划生成器与执行器。
 * 两端有同名媒体即视为已存在，不进行重复上传/下载。
 *
 * 架构：
 *  - build_plan: 扫描本地 + 远程快照，生成 SyncAction 列表
 *  - execute_plan: 串行 setup → 并发上传（按相册分组，每批 ≤50，大文件独占通道）
 *    → 并发下载 → 串行收尾
 *  - SyncControl: 暂停/恢复/停止/故障控制
 *  - Worker: 使用 child_process.fork 创建隔离的文件客户端子进程
 */

const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { fork } = require("child_process");
const { LocalScanCache, CACHE_DIRECTORY_NAME } = require("./local_scan_cache");
const { validate_media_file, free_user_size_message, media_kind } = require("./media_validation");
const { VideoCompressionOptions, prepared_video_upload } = require("./video_compression");
const { RemoteClientError } = require("./remote_client");

// ========== 常量 ==========

const FILE_CLIENT_MAX_ATTEMPTS = 3;
const FILE_CLIENT_BASE_TIMEOUT_SECONDS = 120;
const FILE_CLIENT_BYTES_PER_SECOND = 128 * 1024;
const FILE_CLIENT_MAX_TIMEOUT_SECONDS = 2 * 60 * 60;
const FILE_CLIENT_TIMEOUT_ATTEMPTS = 4;
const LARGE_FILE_SERIAL_UPLOAD_BYTES = 16 * 1024 * 1024;
const ALBUM_ASSOCIATION_BATCH_SIZE = 50;
const ASSOCIATION_MASTER_RETRY_DELAYS_SECONDS = [15, 30];
const RATE_LIMIT_ERRNOS = new Set(["50000", "50005"]);
const RATE_LIMIT_BASE_WAIT_SECONDS = 30;
const RATE_LIMIT_MAX_WAIT_SECONDS = 30 * 60;
const RATE_LIMIT_MAX_RETRIES = 6;
const RATE_LIMIT_CONSECUTIVE_PAUSE_THRESHOLD = 3;

// ========== 辅助函数 ==========

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function isRateLimitError(text) {
  if (!text) return false;
  if (text.includes("操作过于频繁") || text.includes("请求过于频繁") || text.includes("过于频繁")) return true;
  if (text.includes("'errno': 50005") || text.includes("'errno': 50000")) return true;
  if (text.includes("errno=50005") || text.includes("errno=50000")) return true;
  return false;
}

const ERRMSG_RE = /errmsg['"]?\s*:\s*['"]([^'"]+)['"]/;

function extractErrmsg(text) {
  if (!text) return "";
  const match = ERRMSG_RE.exec(text);
  return match ? match[1].trim() : "";
}

function friendlyError(text) {
  if (!text) return "操作失败，请查看日志";
  const errmsg = extractErrmsg(text);
  if (errmsg) return errmsg;
  if (isRateLimitError(text)) return "接口请求过于频繁（限流）";
  if (text.includes("50801")) return "文件过大或需要开通会员";
  if (text.includes("errno=2") || text.includes("超过普通用户")) return "文件超过普通用户大小上限（照片/视频均 30MB），请开通超级会员或压缩后再试";
  if (text.includes("网络") || text.includes("ConnectionError") || text.includes("连接中断")) return "网络连接中断";
  if (text.includes("SSL") || text.includes("TLS") || text.includes("证书")) return "安全连接中断，已自动换新连接";
  if (text.includes("超时") || text.includes("Timeout")) return "请求超时";
  return "上传或接口调用失败，请查看日志";
}

async function waitWithControl(seconds, control) {
  if (seconds <= 0) return true;
  const end = performance.now() / 1000 + seconds;
  while (performance.now() / 1000 < end) {
    if (control) {
      if (control.stopped) return false;
      if (control.paused) {
        if (!(await control.waitUntilRunnable())) return false;
      }
    }
    await sleep(1);
  }
  return true;
}

function nameKey(name) {
  return path.basename(name).trim().normalize("NFC").toLowerCase();
}

// ========== 枚举 ==========

const SyncDirection = {
  LOCAL_TO_REMOTE: "本地 → 云端",
  REMOTE_TO_LOCAL: "云端 → 本地",
  BIDIRECTIONAL: "双向",
};

const SortField = {
  NAME: "按文件夹名称",
  MODIFIED: "按文件夹修改日期",
  CREATED: "按文件夹创建日期",
};

const FileCompareMode = {
  SMART: "智能（推荐：同名视频压缩版 + 内容去重）",
  NAME_ONLY: "仅按文件名（同名即视为已同步）",
  CONTENT_FIRST: "内容优先（同名非视频内容不同标记冲突）",
};

const PlanAction = {
  CREATE_REMOTE_ALBUM: "创建云端相册",
  CREATE_LOCAL_FOLDER: "创建本地文件夹",
  UPLOAD: "上传到云端",
  DOWNLOAD: "下载到本地",
  DELETE_REMOTE: "删除云端媒体",
  DELETE_LOCAL: "删除本地媒体",
  CONFLICT: "需要处理冲突",
  SKIP: "无需操作",
};

// ========== 数据类 ==========

class LocalFile {
  constructor({ filePath, name, size, modified_at, created_at }) {
    this.path = filePath;
    this.name = name;
    this.size = size;
    this.modified_at = modified_at;
    this.created_at = created_at;
  }

  md5() {
    const buf = fs.readFileSync(this.path);
    return crypto.createHash("md5").update(buf).digest("hex");
  }
}

class LocalFolder {
  constructor({ filePath, name, modified_at, created_at, files, skipped_files = [] }) {
    this.path = filePath;
    this.name = name;
    this.modified_at = modified_at;
    this.created_at = created_at;
    this.files = files;
    this.skipped_files = skipped_files;
  }
}

class SyncAction {
  constructor({ sequence, action, album_name, media_name = "", source = "", detail = "", local_path = null, remote_album_id = null, remote_fsid = null, size = 0, status = "待执行" }) {
    this.sequence = sequence;
    this.action = action;
    this.album_name = album_name;
    this.media_name = media_name;
    this.source = source;
    this.detail = detail;
    this.local_path = local_path;
    this.remote_album_id = remote_album_id;
    this.remote_fsid = remote_fsid;
    this.size = size;
    this.status = status;
  }

  get can_execute() {
    return this.action !== PlanAction.CONFLICT && this.action !== PlanAction.SKIP;
  }
}

// ========== SyncControl ==========

class SyncControl {
  constructor() {
    this._paused = false;
    this._stopped = false;
    this._faultReason = "";
    this._resumeResolvers = [];
  }

  pause() {
    this._paused = true;
  }

  resume() {
    this._paused = false;
    this._resumeResolvers.forEach((resolve) => resolve(true));
    this._resumeResolvers = [];
  }

  stop() {
    this._stopped = true;
    this._paused = false;
    this._resumeResolvers.forEach((resolve) => resolve(false));
    this._resumeResolvers = [];
  }

  failAll(reason) {
    if (!this._faultReason) this._faultReason = reason;
    this._stopped = true;
    this._paused = false;
    this._resumeResolvers.forEach((resolve) => resolve(false));
    this._resumeResolvers = [];
  }

  get faultReason() { return this._faultReason; }
  get faulted() { return Boolean(this._faultReason); }
  get stopped() { return this._stopped; }
  get paused() { return this._paused; }

  waitUntilRunnable() {
    if (!this._paused || this._stopped) return Promise.resolve(!this._stopped);
    return new Promise((resolve) => {
      this._resumeResolvers.push(resolve);
    });
  }
}

// ========== SyncEngine ==========

class SyncEngine {
  constructor(client, {
    max_workers = 4,
    download_workers = 4,
    list_threads = 8,
    compare_mode = FileCompareMode.SMART,
    compression_options = null,
  } = {}) {
    this.client = client;
    this.max_workers = Math.max(1, Math.min(max_workers, 10));
    this.download_workers = Math.max(1, Math.min(download_workers, 10));
    this.list_threads = Math.max(1, Math.min(list_threads, 16));
    this.compare_mode = compare_mode;
    this.compression_options = compression_options || new VideoCompressionOptions();
  }

  // ========== 本地扫描 ==========

  scanLocal(root) {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error("请选择有效的本地根目录。");
    }
    const folders = [];
    const cache = new LocalScanCache(root);
    const liveCacheKeys = new Set();
    let cacheHits = 0;
    let cacheMisses = 0;

    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === CACHE_DIRECTORY_NAME) continue;
      const folderPath = path.join(root, entry.name);
      const stat = fs.statSync(folderPath);
      const files = [];
      const skippedFiles = [];

      for (const child of fs.readdirSync(folderPath, { withFileTypes: true })) {
        if (!child.isFile() || child.name.startsWith(".")) continue;
        const childPath = path.join(folderPath, child.name);
        const relPath = path.relative(root, childPath).replace(/\\/g, "/");
        liveCacheKeys.add(relPath);

        const cachedVerdict = cache.lookup(childPath);
        let isMedia, reason;
        if (cachedVerdict === null) {
          cacheMisses++;
          [isMedia, reason] = validate_media_file(childPath);
          cache.record(childPath, isMedia, reason);
        } else {
          cacheHits++;
          [isMedia, reason] = cachedVerdict;
        }
        if (!isMedia) {
          skippedFiles.push([child.name, reason]);
          continue;
        }
        const itemStat = fs.statSync(childPath);
        files.push(
          new LocalFile({
            filePath: childPath,
            name: child.name,
            size: itemStat.size,
            modified_at: Math.floor(itemStat.mtimeMs / 1000),
            created_at: Math.floor(itemStat.ctimeMs / 1000),
          })
        );
      }
      files.sort((a, b) => nameKey(a.name).localeCompare(nameKey(b.name)));
      skippedFiles.sort((a, b) => nameKey(a[0]).localeCompare(nameKey(b[0])));
      folders.push(
        new LocalFolder({
          filePath: folderPath,
          name: entry.name,
          modified_at: Math.floor(stat.mtimeMs / 1000),
          created_at: Math.floor(stat.ctimeMs / 1000),
          files,
          skipped_files: skippedFiles,
        })
      );
    }
    cache.prune(liveCacheKeys);
    cache.save();
    console.debug(`本地媒体校验缓存：命中 ${cacheHits}，重新校验 ${cacheMisses}`);
    return folders;
  }

  _sortedFolders(folders, field, reverse) {
    let key;
    if (field === SortField.MODIFIED) {
      key = (item) => [item.modified_at, nameKey(item.name)];
    } else if (field === SortField.CREATED) {
      key = (item) => [item.created_at, nameKey(item.name)];
    } else {
      key = (item) => [nameKey(item.name)];
    }
    return [...folders].sort((a, b) => {
      const ka = key(a), kb = key(b);
      for (let i = 0; i < ka.length; i++) {
        const cmp = ka[i] < kb[i] ? -1 : ka[i] > kb[i] ? 1 : 0;
        if (cmp !== 0) return reverse ? -cmp : cmp;
      }
      return 0;
    });
  }

  // ========== 远程快照 ==========

  async _remoteSnapshot(progress = null) {
    const albums = await this.client.listAlbums();
    const mediaByAlbum = {};
    const total = albums.length;
    if (total === 0) return { albums, mediaByAlbum };

    console.debug(`并行读取 ${total} 个云端相册的媒体列表（${this.list_threads} 线程）`);
    if (progress) progress(5, `正在并行读取 ${total} 个云端相册（${this.list_threads} 线程）`);

    // 并发读取，限制并发数
    const concurrency = Math.min(this.list_threads, total);
    let index = 0;
    let completed = 0;

    async function fetchOne() {
      while (index < albums.length) {
        const i = index++;
        const album = albums[i];
        try {
          mediaByAlbum[album.album_id] = await this.client.listMedia(album.album_id);
          completed++;
          if (progress) {
            progress(5 + Math.floor((completed / total) * 25), `正在读取云端相册：${album.title}（${completed}/${total}）`);
          }
          console.debug(`已读取相册 ${album.title}：${mediaByAlbum[album.album_id].length} 个媒体`);
        } catch (err) {
          console.error(`读取相册媒体失败：${album.title}，错误=${err.name}`);
          throw err;
        }
      }
    }

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(fetchOne.call(this));
    }
    await Promise.all(workers);
    return { albums, mediaByAlbum };
  }

  // ========== 同一文件判定 ==========

  _sameFile(local, remote) {
    if (local.size !== remote.size) return false;
    if (remote.md5) return local.md5().toLowerCase() === remote.md5.toLowerCase();
    return true;
  }

  // ========== build_plan ==========

  async buildPlan(root, direction, sortField, reverse, enableDeletions, progress = null, ignoredAlbumNames = [], skipOversize = false) {
    if (progress) progress(0, "正在扫描本地文件夹");
    const localFolders = this._sortedFolders(this.scanLocal(root), sortField, reverse);
    const localByKey = {};
    for (const folder of localFolders) {
      localByKey[nameKey(folder.name)] = folder;
    }

    const { albums: remoteAlbums, mediaByAlbum: remoteMedia } = await this._remoteSnapshot(progress);

    const remoteByKey = {};
    for (const album of remoteAlbums) {
      const key = nameKey(album.title);
      if (key in remoteByKey) {
        console.warn(`云端存在归一化名称重复的相册：${remoteByKey[key].title} / ${album.title}；同步使用第一个相册`);
        continue;
      }
      remoteByKey[key] = album;
    }

    const ignoredKeys = new Set(
      ignoredAlbumNames.filter((n) => n.trim()).map((n) => nameKey(n))
    );

    const actions = [];
    let sequence = 1;

    function add(action, albumName, mediaName = "", extra = {}) {
      actions.push(
        new SyncAction({
          sequence: sequence++,
          action,
          album_name: albumName,
          media_name: mediaName,
          ...extra,
        })
      );
    }

    const self = this;
    function addUpload(localFile, albumName, remoteAlbumId, detail) {
      const oversize = free_user_size_message(localFile.path, localFile.size);
      if (oversize && self.compression_options.enabled && media_kind(localFile.path) === "video") {
        add(PlanAction.UPLOAD, albumName, localFile.name, {
          local_path: localFile.path,
          remote_album_id: remoteAlbumId,
          size: localFile.size,
          detail: "视频超过普通用户 30MB 限制：将临时压缩至不超过 28MB 后以原文件名上传（本地高清原件保留）",
        });
        console.info(`计划压缩后上传超限视频：${albumName}/${localFile.name}`);
        return;
      }
      if (oversize && skipOversize) {
        add(PlanAction.SKIP, albumName, localFile.name, {
          local_path: localFile.path,
          size: localFile.size,
          detail: `已跳过：${oversize}`,
        });
        console.info(`计划跳过超大小限制文件：${albumName}/${localFile.name}（${oversize}）`);
        return;
      }
      add(PlanAction.UPLOAD, albumName, localFile.name, {
        local_path: localFile.path,
        remote_album_id: remoteAlbumId,
        size: localFile.size,
        detail,
      });
    }

    // 确定候选 key 集合
    let candidateKeys;
    if (direction === SyncDirection.LOCAL_TO_REMOTE) {
      candidateKeys = Object.keys(localByKey);
    } else if (direction === SyncDirection.REMOTE_TO_LOCAL) {
      candidateKeys = Object.keys(remoteByKey);
    } else {
      candidateKeys = [...new Set([...Object.keys(localByKey), ...Object.keys(remoteByKey)])];
    }

    function orderKey(nameKeyVal) {
      const localFolder = localByKey[nameKeyVal];
      const remoteAlbum = remoteByKey[nameKeyVal];
      const label = localFolder ? localFolder.name : remoteAlbum ? remoteAlbum.title : nameKeyVal;
      if (sortField === SortField.MODIFIED) {
        const ts = localFolder ? localFolder.modified_at : remoteAlbum ? remoteAlbum.modified_at : 0;
        return [ts || 0, nameKey(label)];
      }
      if (sortField === SortField.CREATED) {
        const ts = localFolder ? localFolder.created_at : remoteAlbum ? remoteAlbum.created_at : 0;
        return [ts || 0, nameKey(label)];
      }
      return [nameKey(label)];
    }

    const totalAlbums = candidateKeys.length;
    const sortedKeys = candidateKeys.sort((a, b) => {
      const ka = orderKey(a), kb = orderKey(b);
      for (let i = 0; i < ka.length; i++) {
        const cmp = ka[i] < kb[i] ? -1 : ka[i] > kb[i] ? 1 : 0;
        if (cmp !== 0) return reverse ? -cmp : cmp;
      }
      return 0;
    });

    for (let i = 0; i < sortedKeys.length; i++) {
      const albumKey = sortedKeys[i];
      const localFolder = localByKey[albumKey];
      const remoteAlbum = remoteByKey[albumKey];
      const albumName = localFolder ? localFolder.name : remoteAlbum ? remoteAlbum.title : albumKey;

      if (progress) {
        progress(30 + Math.floor(((i + 1) / totalAlbums) * 60), `正在比较：${albumName}（${i + 1}/${totalAlbums}）`);
      }

      if (ignoredKeys.has(albumKey)) {
        add(PlanAction.SKIP, albumName, "", { detail: "已加入忽略列表" });
        console.debug(`跳过已忽略相册：${albumName}`);
        continue;
      }

      // 跳过非媒体文件
      if (localFolder) {
        for (const [mediaName, reason] of localFolder.skipped_files) {
          add(PlanAction.SKIP, albumName, mediaName, {
            local_path: path.join(localFolder.path, mediaName),
            detail: `跳过：非有效照片/视频（${reason}）`,
          });
        }
      }

      // 仅云端
      if (!localFolder && remoteAlbum) {
        if (direction === SyncDirection.REMOTE_TO_LOCAL || direction === SyncDirection.BIDIRECTIONAL) {
          add(PlanAction.CREATE_LOCAL_FOLDER, albumName, "", {
            remote_album_id: remoteAlbum.album_id,
            detail: "云端相册仅存在于云端",
          });
          for (const media of (remoteMedia[remoteAlbum.album_id] || [])) {
            add(PlanAction.DOWNLOAD, albumName, media.name, {
              remote_album_id: remoteAlbum.album_id,
              remote_fsid: media.fsid,
              size: media.size,
              detail: "下载云端新增媒体",
            });
          }
        } else {
          add(PlanAction.SKIP, albumName, "", { detail: "仅存在于云端；本地→云端模式不处理" });
        }
        continue;
      }

      // 仅本地
      if (localFolder && !remoteAlbum) {
        if (direction === SyncDirection.LOCAL_TO_REMOTE || direction === SyncDirection.BIDIRECTIONAL) {
          add(PlanAction.CREATE_REMOTE_ALBUM, albumName, "", {
            local_path: localFolder.path,
            detail: "本地文件夹仅存在于本地",
          });
          for (const media of localFolder.files) {
            addUpload(media, albumName, null, "上传本地新增媒体");
          }
        } else {
          add(PlanAction.SKIP, albumName, "", { detail: "仅存在于本地；云端→本地模式不处理" });
        }
        continue;
      }

      if (!localFolder || !remoteAlbum) continue;

      const before = actions.length;
      const localFiles = {};
      for (const item of localFolder.files) {
        const key = nameKey(item.name);
        if (!(key in localFiles)) localFiles[key] = item;
      }
      const remoteFiles = {};
      for (const item of (remoteMedia[remoteAlbum.album_id] || [])) {
        const key = nameKey(item.name);
        if (key in remoteFiles) {
          console.warn(`相册 ${albumName} 有同名云端媒体：${item.name}；同步按首个条目判断`);
          continue;
        }
        remoteFiles[key] = item;
      }

      // 同名匹配快速路径
      const matchedLocalKeys = new Set();
      const matchedRemoteKeys = new Set();
      const commonKeys = [...new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)])].sort();
      for (const mediaKey of commonKeys) {
        if (!(mediaKey in localFiles) || !(mediaKey in remoteFiles)) continue;
        const localFile = localFiles[mediaKey];
        const remoteFile = remoteFiles[mediaKey];
        if (this._sameFile(localFile, remoteFile)) {
          matchedLocalKeys.add(mediaKey);
          matchedRemoteKeys.add(mediaKey);
        } else if (media_kind(localFile.path) === "video") {
          matchedLocalKeys.add(mediaKey);
          matchedRemoteKeys.add(mediaKey);
          console.info(
            `同名视频的云端内容与本地不同；按云端压缩替代版本视为已同步：${albumName}/${localFile.name}（本地 ${localFile.size} bytes，云端 ${remoteFile.size} bytes）`
          );
        } else if (this.compare_mode === FileCompareMode.SMART || this.compare_mode === FileCompareMode.NAME_ONLY) {
          matchedLocalKeys.add(mediaKey);
          matchedRemoteKeys.add(mediaKey);
        } else {
          // CONTENT_FIRST
          matchedLocalKeys.add(mediaKey);
          matchedRemoteKeys.add(mediaKey);
          add(PlanAction.CONFLICT, albumName, localFile.name, {
            local_path: localFile.path,
            remote_album_id: remoteAlbum.album_id,
            remote_fsid: remoteFile.fsid,
            size: localFile.size,
            detail: "同名非视频媒体的大小或 MD5 不同；内容优先模式要求人工确认",
          });
        }
      }

      // 内容签名去重
      if (this.compare_mode !== FileCompareMode.NAME_ONLY) {
        const remoteBySignature = {};
        for (const [mediaKey, remoteFile] of Object.entries(remoteFiles)) {
          if (!remoteFile.md5) continue;
          const sig = `${remoteFile.size}:${remoteFile.md5.toLowerCase()}`;
          if (!remoteBySignature[sig]) remoteBySignature[sig] = [];
          remoteBySignature[sig].push([mediaKey, remoteFile]);
        }
        const remoteCandidateSizes = new Set(Object.values(remoteBySignature).map((list) => list[0][1].size));
        for (const [mediaKey, localFile] of Object.entries(localFiles)) {
          if (matchedLocalKeys.has(mediaKey) || !remoteCandidateSizes.has(localFile.size)) continue;
          const sig = `${localFile.size}:${localFile.md5().toLowerCase()}`;
          const candidates = remoteBySignature[sig] || [];
          if (candidates.length === 0) continue;
          const [remoteKey, remoteFile] = candidates[0];
          matchedLocalKeys.add(mediaKey);
          matchedRemoteKeys.add(remoteKey);
          console.debug(`检测到目标相册已有相同内容（含服务端自动改名或本地重复副本），跳过重复同步：${albumName}/${localFile.name} -> ${remoteFile.name}`);
        }
      }

      // 未匹配的本地文件
      for (const mediaKey of Object.keys(localFiles).sort().filter((k) => !matchedLocalKeys.has(k))) {
        const localFile = localFiles[mediaKey];
        if (direction === SyncDirection.LOCAL_TO_REMOTE || direction === SyncDirection.BIDIRECTIONAL) {
          addUpload(localFile, albumName, remoteAlbum.album_id, "上传本地新增媒体");
        } else if (enableDeletions) {
          add(PlanAction.DELETE_LOCAL, albumName, localFile.name, {
            local_path: localFile.path,
            size: localFile.size,
            detail: "按云端→本地删除策略移除本地多余媒体",
          });
        }
      }

      // 未匹配的远程文件
      for (const mediaKey of Object.keys(remoteFiles).sort().filter((k) => !matchedRemoteKeys.has(k))) {
        const remoteFile = remoteFiles[mediaKey];
        if (direction === SyncDirection.REMOTE_TO_LOCAL || direction === SyncDirection.BIDIRECTIONAL) {
          add(PlanAction.DOWNLOAD, albumName, remoteFile.name, {
            remote_album_id: remoteAlbum.album_id,
            remote_fsid: remoteFile.fsid,
            size: remoteFile.size,
            detail: "下载云端新增媒体",
          });
        } else if (enableDeletions) {
          add(PlanAction.DELETE_REMOTE, albumName, remoteFile.name, {
            remote_album_id: remoteAlbum.album_id,
            remote_fsid: remoteFile.fsid,
            size: remoteFile.size,
            detail: "按本地→云端删除策略移除云端多余媒体",
          });
        }
      }

      if (actions.length === before) {
        add(PlanAction.SKIP, albumName, "", { detail: "两端已存在同名媒体，无需同步" });
      }
    }

    if (direction === SyncDirection.BIDIRECTIONAL && enableDeletions) {
      add(PlanAction.CONFLICT, "", "", { detail: "双向模式不自动推断删除意图；已忽略删除策略。" });
    }

    if (progress) progress(100, `已生成 ${actions.length} 项同步计划`);
    return actions;
  }

  // ========== execute_plan ==========

  async executePlan(root, actions, progress = null, control = null, statusCallback = null, alertCallback = null) {
    const executable = actions.filter(
      (a) =>
        a.can_execute &&
        (a.status === "待执行" || a.status === "已停止" || a.status.startsWith("失败") || a.status.startsWith("错误") || a.status.startsWith("待重试"))
    );

    const requiresRemoteLookup = executable.some(
      (a) =>
        a.action === PlanAction.CREATE_REMOTE_ALBUM ||
        ((a.action === PlanAction.UPLOAD || a.action === PlanAction.DOWNLOAD || a.action === PlanAction.DELETE_REMOTE) && !a.remote_album_id)
    );

    const remoteIds = requiresRemoteLookup
      ? Object.fromEntries((await this.client.listAlbums()).map((a) => [a.title, a.album_id]))
      : {};

    const total = Math.max(1, executable.length);
    let completed = 0;
    let consecutiveRateLimit = 0;

    function setStatus(action, status) {
      action.status = status;
      if (statusCallback) statusCallback(action.sequence, status);
    }

    function report(action) {
      completed++;
      if (progress) {
        progress(
          Math.floor((completed / total) * 100),
          `${completed}/${total} ${action.action}：${action.album_name} ${action.media_name}（${action.status}）`.trim()
        );
      }
    }

    function waitForControl(action) {
      if (!control) return true;
      if (control.paused) setStatus(action, "已暂停，等待继续");
      if (!control.waitUntilRunnable()) {
        setStatus(action, "已停止");
        return false;
      }
      return true;
    }

    async function runWithRateLimitRetry(fn, action) {
      let waits = 0;
      while (true) {
        try {
          await fn();
          consecutiveRateLimit = 0;
          return true;
        } catch (err) {
          const errorText = String(err.message || err);
          if (isRateLimitError(errorText)) {
            consecutiveRateLimit++;
            const friendly = friendlyError(errorText);
            if (consecutiveRateLimit >= RATE_LIMIT_CONSECUTIVE_PAUSE_THRESHOLD && !(control && control.paused)) {
              if (control) control.pause();
              if (alertCallback) {
                alertCallback("连续多次触发「操作过于频繁」（errno 50005）。已自动暂停同步，请稍候点击「继续」，或降低并发与读取线程数后再试。");
              }
              consecutiveRateLimit = 0;
              setStatus(action, `已跳过：${friendly}`);
              return false;
            }
            if (control && control.paused) {
              setStatus(action, `已跳过：${friendly}`);
              return false;
            }
            if (waits >= RATE_LIMIT_MAX_RETRIES) {
              setStatus(action, `已跳过：${friendly}（已多次重试仍失败）`);
              return false;
            }
            const wait = Math.min(RATE_LIMIT_BASE_WAIT_SECONDS * Math.pow(2, waits), RATE_LIMIT_MAX_WAIT_SECONDS);
            setStatus(action, `${friendly}，等待 ${wait} 秒后重试（第 ${waits + 1} 次）`);
            if (!(await waitWithControl(wait, control))) {
              setStatus(action, `已跳过：${friendly}（等待限流恢复期间已停止）`);
              return false;
            }
            waits++;
            continue;
          }
          throw err;
        }
      }
    }

    async function runAction(action) {
      if (!waitForControl(action)) return action;
      try {
        setStatus(action, "正在执行");
        console.debug(`执行同步操作：${action.action} ${action.album_name}/${action.media_name}`);

        if (action.action === PlanAction.CREATE_REMOTE_ALBUM) {
          const created = await this.client.createAlbum(action.album_name);
          remoteIds[action.album_name] = created.album_id;
        } else if (action.action === PlanAction.CREATE_LOCAL_FOLDER) {
          fs.mkdirSync(path.join(root, action.album_name), { recursive: true });
        } else if (action.action === PlanAction.UPLOAD) {
          const albumId = action.remote_album_id || remoteIds[action.album_name];
          if (!albumId || !action.local_path) throw new Error("同步计划缺少上传目标或本地文件。");
          await this.client.uploadFileOnce(albumId, action.local_path, (value, message) => {
            setStatus(action, "正在上传并确认入册");
            if (progress) {
              const fraction = Math.max(0, Math.min(100, value)) / 100;
              progress(Math.floor(((completed + fraction) / total) * 100), message);
            }
          });
        } else if (action.action === PlanAction.DOWNLOAD) {
          const albumId = action.remote_album_id || remoteIds[action.album_name];
          if (!albumId || !action.remote_fsid) throw new Error("同步计划缺少下载来源。");
          if (!(await runWithRateLimitRetry(async () => {
            await this.client.downloadMedia(albumId, action.remote_fsid, path.join(root, action.album_name));
          }, action))) {
            return action;
          }
        } else if (action.action === PlanAction.DELETE_REMOTE) {
          if (!action.remote_album_id || !action.remote_fsid) throw new Error("同步计划缺少云端删除目标。");
          if (!(await runWithRateLimitRetry(async () => {
            await this.client.deleteMedia(action.remote_album_id, action.remote_fsid);
          }, action))) {
            return action;
          }
        } else if (action.action === PlanAction.DELETE_LOCAL) {
          if (!action.local_path) throw new Error("同步计划缺少本地删除目标。");
          try { fs.unlinkSync(action.local_path); } catch {}
        }
        setStatus(action, "已完成");
      } catch (err) {
        console.error(`同步操作失败：${action.action} ${action.album_name}/${action.media_name}：${err.message}`);
        setStatus(action, `失败：${friendlyError(String(err.message || err))}`);
      }
      return action;
    }

    // 分组
    const setupActions = executable.filter((a) => a.action === PlanAction.CREATE_REMOTE_ALBUM || a.action === PlanAction.CREATE_LOCAL_FOLDER);
    const uploadActions = executable.filter((a) => a.action === PlanAction.UPLOAD);
    const trailingActions = executable.filter((a) => a.action !== PlanAction.CREATE_REMOTE_ALBUM && a.action !== PlanAction.CREATE_LOCAL_FOLDER && a.action !== PlanAction.UPLOAD);

    // 串行执行 setup
    let faultReason = "";
    for (const action of setupActions) {
      if (control && control.stopped) break;
      if (faultReason) {
        setStatus(action, "待重试：主控制器等待重新核对计划");
        report(action);
        continue;
      }
      await runAction.call(this, action);
      report(action);
      if (action.status.startsWith("失败")) {
        faultReason = `${action.album_name}/${action.action} 未确认完成`;
      }
    }

    // 上传阶段
    if (!faultReason && uploadActions.length > 0) {
      const attempts = {};
      for (const a of uploadActions) attempts[a.sequence] = 0;
      const reportedSequences = new Set();
      const albumGroups = [];
      const groupedActions = {};

      for (const uploadAction of uploadActions) {
        const uploadAlbumId = uploadAction.remote_album_id || remoteIds[uploadAction.album_name];
        if (!uploadAlbumId || !uploadAction.local_path) {
          setStatus(uploadAction, "错误：同步计划缺少上传目标或本地文件");
          report(uploadAction);
          reportedSequences.add(uploadAction.sequence);
          continue;
        }
        if (!(uploadAlbumId in groupedActions)) {
          groupedActions[uploadAlbumId] = [];
          albumGroups.push([uploadAlbumId, groupedActions[uploadAlbumId]]);
        }
        groupedActions[uploadAlbumId].push(uploadAction);
      }

      let blocked = false;
      for (const [albumId, albumActions] of albumGroups) {
        let batchNumber = 0;
        for (let start = 0; start < albumActions.length; start += ALBUM_ASSOCIATION_BATCH_SIZE) {
          batchNumber++;
          const currentGroup = albumActions.slice(start, start + ALBUM_ASSOCIATION_BATCH_SIZE);
          const result = await this._runAlbumUploadGroup(
            albumId, currentGroup, batchNumber, attempts, reportedSequences,
            control, progress, statusCallback, alertCallback,
            total, completed, (v) => { completed = v; },
            () => consecutiveRateLimit,
            (v) => { consecutiveRateLimit = v; },
            root
          );
          if (!result) {
            blocked = true;
            break;
          }
        }
        if (blocked) break;
      }

      if (control && control.stopped) {
        for (const action of uploadActions) {
          if (!reportedSequences.has(action.sequence)) {
            setStatus(action, "已停止");
            report(action);
            reportedSequences.add(action.sequence);
          }
        }
      } else if (blocked) {
        for (const action of uploadActions) {
          if (!reportedSequences.has(action.sequence)) {
            setStatus(action, "待重试：当前相册批次未确认入册，未启动后续文件或相册");
            report(action);
            reportedSequences.add(action.sequence);
          }
        }
      }
    } else if (faultReason) {
      for (const action of uploadActions) {
        setStatus(action, "错误：前序创建任务未完成");
        report(action);
      }
    }

    // 下载阶段
    const downloadActions = trailingActions.filter((a) => a.action === PlanAction.DOWNLOAD);
    const serialTrailingActions = trailingActions.filter((a) => a.action !== PlanAction.DOWNLOAD);

    if (downloadActions.length > 0 && !(control && control.stopped)) {
      console.debug(`并发下载 ${downloadActions.length} 个同步文件（${this.download_workers} 客户端）`);
      const concurrency = Math.min(this.download_workers, downloadActions.length);
      let downloadIndex = 0;

      const runDownload = async () => {
        while (downloadIndex < downloadActions.length) {
          const action = downloadActions[downloadIndex++];
          if (!waitForControl(action)) {
            report(action);
            continue;
          }
          const albumId = action.remote_album_id || remoteIds[action.album_name];
          if (!albumId || !action.remote_fsid) {
            setStatus(action, "失败：同步计划缺少下载来源。");
            report(action);
            continue;
          }
          let dlAttempts = 0;
          while (true) {
            try {
              setStatus(action, "正在下载");
              const workerClient = await this.client.createIsolatedAlbumClient(albumId);
              await workerClient.downloadMedia(albumId, action.remote_fsid, path.join(root, action.album_name));
              setStatus(action, "已完成");
              report(action);
              break;
            } catch (err) {
              const errorText = String(err.message || err);
              if (isRateLimitError(errorText) && dlAttempts < RATE_LIMIT_MAX_RETRIES) {
                const waitSeconds = Math.min(RATE_LIMIT_BASE_WAIT_SECONDS * Math.pow(2, dlAttempts), RATE_LIMIT_MAX_WAIT_SECONDS);
                dlAttempts++;
                setStatus(action, `操作过于频繁，等待 ${waitSeconds} 秒后重试（第 ${dlAttempts} 次）`);
                if (await waitWithControl(waitSeconds, control)) continue;
                setStatus(action, "已停止");
                report(action);
                break;
              }
              console.error(`并发下载失败：${action.album_name}/${action.media_name}：${err.message}`);
              setStatus(action, `失败：${friendlyError(errorText)}`);
              report(action);
              break;
            }
          }
        }
      };

      const downloadWorkers = [];
      for (let i = 0; i < concurrency; i++) {
        downloadWorkers.push(runDownload());
      }
      await Promise.all(downloadWorkers);
    }

    // 串行收尾
    for (const action of serialTrailingActions) {
      if (control && control.stopped) break;
      await runAction.call(this, action);
      report(action);
    }

    // 总结
    const failures = executable.filter((a) => a.status.startsWith("失败") || a.status.startsWith("错误")).length;
    const retryPending = executable.filter((a) => a.status.startsWith("待重试")).length;
    const skipped = executable.filter((a) => a.status.startsWith("已跳过")).length;
    if (progress) {
      if (control && control.stopped) {
        progress(100, "同步已安全停止");
      } else {
        const parts = [];
        if (failures) parts.push(`${failures} 项失败`);
        if (retryPending) parts.push(`${retryPending} 项待重试`);
        if (skipped) parts.push(`${skipped} 项已跳过`);
        if (parts.length > 0) {
          progress(100, "同步执行结束：" + parts.join("；"));
        } else {
          progress(100, "同步执行完成");
        }
      }
    }
    return actions;
  }

  // ========== 上传分组执行 ==========

  async _runAlbumUploadGroup(
    albumId, groupActions, batchNumber, attempts, reportedSequences,
    control, progress, statusCallback, alertCallback,
    total, completedRef, setCompleted,
    getConsecutiveRateLimit, setConsecutiveRateLimit,
    root
  ) {
    const pending = [...groupActions];
    const active = new Map(); // child -> { action, attempt, startedAt, result }
    const uploadedFsids = {}; // sequence -> fsid
    const rateLimitWaits = {};
    let completed = completedRef;

    function setStatus(action, status) {
      action.status = status;
      if (statusCallback) statusCallback(action.sequence, status);
    }

    function report(action) {
      completed++;
      setCompleted(completed);
      if (progress) {
        progress(
          Math.floor((completed / total) * 100),
          `${completed}/${total} ${action.action}：${action.album_name} ${action.media_name}（${action.status}）`.trim()
        );
      }
    }

    function skipUpload(action, reason) {
      setStatus(action, `已跳过：${friendlyError(reason)}`);
      report(action);
      reportedSequences.add(action.sequence);
    }

    function timeoutForFile(action) {
      const size = Math.max(0, parseInt(action.size || 0));
      const single = FILE_CLIENT_BASE_TIMEOUT_SECONDS + Math.floor(size / FILE_CLIENT_BYTES_PER_SECOND);
      const estimate = single * FILE_CLIENT_TIMEOUT_ATTEMPTS;
      return Math.min(FILE_CLIENT_MAX_TIMEOUT_SECONDS, Math.max(FILE_CLIENT_BASE_TIMEOUT_SECONDS, estimate));
    }

    // 批量入册确认
    async function finalizeGroup() {
      const pendingFsids = new Set(Object.values(uploadedFsids));
      const confirmed = new Set();
      if (pendingFsids.size > 0) {
        for (let associationAttempt = 1; associationAttempt <= FILE_CLIENT_MAX_ATTEMPTS; associationAttempt++) {
          if (control && control.stopped) break;
          if (control && control.paused && !(await control.waitUntilRunnable())) break;

          for (const action of groupActions) {
            if (Object.values(uploadedFsids).includes(uploadedFsids[action.sequence]) && pendingFsids.has(uploadedFsids[action.sequence])) {
              setStatus(action, `当前相册第 ${batchNumber} 批统一加入相册（${pendingFsids.size} 项，尝试 ${associationAttempt}/${FILE_CLIENT_MAX_ATTEMPTS}）`);
            }
          }
          try {
            const confirmedNow = await this.client.associateUploadedFsidsOnce(albumId, [...pendingFsids].sort());
            for (const f of confirmedNow) confirmed.add(f);
            for (const f of confirmedNow) pendingFsids.delete(f);
          } catch (err) {
            console.error(`当前相册批量关联失败：album_id=${albumId}，批次=${batchNumber}，尝试=${associationAttempt}/${FILE_CLIENT_MAX_ATTEMPTS}，FSID数=${pendingFsids.size}：${err.message}`);
          }
          if (pendingFsids.size === 0) break;
          if (associationAttempt < FILE_CLIENT_MAX_ATTEMPTS) {
            await sleep(ASSOCIATION_MASTER_RETRY_DELAYS_SECONDS[associationAttempt - 1]);
          }
        }
      }
      for (const action of groupActions) {
        if (reportedSequences.has(action.sequence)) continue;
        const fsid = uploadedFsids[action.sequence];
        if (!fsid) continue;
        if (confirmed.has(fsid)) {
          setStatus(action, "已完成");
        } else {
          setStatus(action, "错误：当前相册批次未确认加入，请查看日志");
        }
        report(action);
        reportedSequences.add(action.sequence);
      }
      // 清空已处理的 uploadedFsids
      for (const seq of Object.keys(uploadedFsids)) {
        if (reportedSequences.has(parseInt(seq))) delete uploadedFsids[seq];
      }
    }

    function retryOrSkip(action, attempt, reason) {
      if (attempt < FILE_CLIENT_MAX_ATTEMPTS) {
        setStatus(action, `${reason}，主控制器将新建客户端重试（第 ${attempt + 1}/${FILE_CLIENT_MAX_ATTEMPTS} 次）`);
        pending.push(action);
      } else {
        skipUpload(action, `${reason}（已尝试 ${attempt} 次，详见 error.log）`);
      }
    }

    // 主循环
    while (pending.length > 0 || active.size > 0) {
      if (control && control.stopped) {
        for (const [child, state] of active) {
          try { child.kill(); } catch {}
        }
        active.clear();
        break;
      }
      if (control && control.paused && active.size === 0) {
        if (!(await control.waitUntilRunnable())) break;
        continue;
      }

      // 分发新任务
      while (pending.length > 0 && active.size < this.max_workers && !(control && control.paused)) {
        const nextAction = pending[0];
        const nextIsLarge = parseInt(nextAction.size || 0) >= LARGE_FILE_SERIAL_UPLOAD_BYTES;
        let largeTransferActive = false;
        for (const state of active.values()) {
          if (parseInt(state.action.size || 0) >= LARGE_FILE_SERIAL_UPLOAD_BYTES) {
            largeTransferActive = true;
            break;
          }
        }
        if (largeTransferActive || (nextIsLarge && active.size > 0)) break;

        const action = pending.shift();
        attempts[action.sequence]++;
        const attempt = attempts[action.sequence];

        // 创建子进程 worker
        let context;
        try {
          context = await this.client.exportFileClientContext(albumId);
        } catch (err) {
          console.error(`无法创建文件客户端上下文：序号=${action.sequence}，文件=${action.media_name}`);
          retryOrSkip(action, attempt, "无法创建上传客户端");
          continue;
        }

        const workerScript = path.join(__dirname, "file_client_worker.js");
        const child = fork(workerScript, [], {
          stdio: ["pipe", "pipe", "pipe", "ipc"],
          env: {
            ...process.env,
            YIKE_WORKER_COOKIE: context.cookieText,
            YIKE_WORKER_ALBUM_ID: albumId,
            YIKE_WORKER_ALBUM_INFO: JSON.stringify(context.info),
            YIKE_WORKER_FILE_PATH: action.local_path,
            YIKE_WORKER_COMPRESSION: JSON.stringify(this.compression_options.toWorkerDict()),
          },
        });

        active.set(child, {
          action,
          attempt,
          startedAt: performance.now() / 1000,
          result: null,
        });
        setStatus(action, `当前相册第 ${batchNumber} 批：已下发文件客户端（第 ${attempt}/${FILE_CLIENT_MAX_ATTEMPTS} 次）`);
        console.debug(`主控制器下发当前相册文件客户端：相册=${action.album_name}，批次=${batchNumber}，序号=${action.sequence}，文件=${action.media_name}，尝试=${attempt}/${FILE_CLIENT_MAX_ATTEMPTS}`);

        child.on("message", (msg) => {
          if (msg.kind === "progress") {
            const state = active.get(child);
            if (state) {
              const eventMessage = String(msg.message || "正在上传");
              const phase = eventMessage.includes("压缩") ? "正在压缩视频" : "正在上传";
              setStatus(state.action, `当前相册第 ${batchNumber} 批：${phase}`);
              if (progress) {
                const fraction = Math.max(0, Math.min(100, parseInt(msg.value || 0))) / 100;
                progress(Math.floor(((completed + fraction) / total) * 100), eventMessage);
              }
            }
          } else if (msg.kind === "result") {
            const state = active.get(child);
            if (state) state.result = msg;
          }
        });

        child.on("exit", () => {
          const state = active.get(child);
          if (!state || state.result !== null) return;
          // 进程退出但没有结果
          active.delete(child);
          retryOrSkip(state.action, state.attempt, "客户端异常退出且未报告结果");
        });
      }

      // 检查活跃子进程
      const now = performance.now() / 1000;
      for (const [child, state] of [...active]) {
        if (state.result !== null) {
          const event = state.result;
          try { child.kill(); } catch {}
          active.delete(child);
          if (event.ok) {
            const fsid = String(event.fsid || "");
            if (!fsid) {
              retryOrSkip(state.action, state.attempt, "客户端未回报 FSID");
            } else {
              setConsecutiveRateLimit(0);
              uploadedFsids[state.action.sequence] = fsid;
              setStatus(state.action, "上传完成，等待当前相册批次统一加入");
            }
          } else {
            const errorText = String(event.error || "未知错误");
            console.error(`文件客户端上传失败：序号=${state.action.sequence}，相册=${state.action.album_name}，文件=${state.action.media_name}，尝试=${state.attempt}/${FILE_CLIENT_MAX_ATTEMPTS}，错误=${errorText}\n${event.debug_error || ""}`);
            if (isRateLimitError(errorText)) {
              let consecutiveRateLimit = getConsecutiveRateLimit();
              consecutiveRateLimit++;
              setConsecutiveRateLimit(consecutiveRateLimit);
              const friendly = friendlyError(errorText);
              if (consecutiveRateLimit >= RATE_LIMIT_CONSECUTIVE_PAUSE_THRESHOLD && !(control && control.paused)) {
                if (control) control.pause();
                if (alertCallback) {
                  alertCallback("连续多次触发「操作过于频繁」（errno 50005）。已自动暂停同步，请稍候点击「继续」，或降低并发与读取线程数后再试。");
                }
                setConsecutiveRateLimit(0);
                await finalizeGroup.call(this);
                skipUpload(state.action, friendly);
              } else if (control && control.paused) {
                await finalizeGroup.call(this);
                skipUpload(state.action, friendly);
              } else {
                await finalizeGroup.call(this);
                const waits = rateLimitWaits[state.action.sequence] || 0;
                if (waits >= RATE_LIMIT_MAX_RETRIES) {
                  skipUpload(state.action, `${friendly}（已多次重试仍失败）`);
                } else {
                  const wait = Math.min(RATE_LIMIT_BASE_WAIT_SECONDS * Math.pow(2, waits), RATE_LIMIT_MAX_WAIT_SECONDS);
                  if (await waitWithControl(wait, control)) {
                    rateLimitWaits[state.action.sequence] = waits + 1;
                    setStatus(state.action, `${friendly}，等待 ${wait} 秒后重试（第 ${waits + 1} 次）`);
                    pending.push(state.action);
                  } else {
                    skipUpload(state.action, `${friendly}（等待限流恢复期间已停止）`);
                  }
                }
              }
            } else {
              skipUpload(state.action, errorText);
            }
          }
          continue;
        }

        const timeout = timeoutForFile(state.action);
        if (now - state.startedAt > timeout) {
          try { child.kill(); } catch {}
          active.delete(child);
          retryOrSkip(state.action, state.attempt, `客户端超时（${timeout} 秒）`);
        }
      }

      if (active.size === 0 && pending.length === 0) break;
      await sleep(0.08);
    }

    if (control && control.stopped) {
      for (const action of groupActions) {
        if (!reportedSequences.has(action.sequence)) {
          setStatus(action, "已停止");
          report(action);
          reportedSequences.add(action.sequence);
        }
      }
      return false;
    }

    await finalizeGroup.call(this);
    return groupActions.every((a) => a.status === "已完成" || a.status.startsWith("已跳过"));
  }
}

module.exports = {
  SyncEngine,
  SyncControl,
  SyncDirection,
  SortField,
  FileCompareMode,
  PlanAction,
  LocalFile,
  LocalFolder,
  SyncAction,
  isRateLimitError,
  friendlyError,
};
