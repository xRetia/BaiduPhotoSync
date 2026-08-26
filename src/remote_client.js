"use strict";

/**
 * YikeRemoteClient — 移植自 remote_client.py (964 行)
 *
 * 百度相册客户端封装层。在 API.js 之上提供：
 *  - Cookie 解析（JSON 数组 / TSV 两格式）
 *  - 相册列表缓存 + 媒体列表缓存（TTL 180 秒）
 *  - 两阶段上传模型：upload_file_payload_once + associate_uploaded_fsids_once
 *  - 入册回读确认（visibility check + 50000 歧义处理）
 *  - 全局 addfile 节流（12 秒间隔）
 *  - 限流重试（errno 1/50000 可重试，50801 永久错误）
 *  - create_isolated_album_client（为同步引擎子进程提供隔离的请求上下文）
 */

const fs = require("fs");
const log = require("./logger");
const path = require("path");
const { API } = require("./baidu/api");
const { validate_media_file } = require("./media_validation");

// ========== 常量 ==========

const ALBUM_CACHE_TTL_SECONDS = 180;
const MEDIA_CACHE_TTL_SECONDS = 180;

// 入册传播等待
const ALBUM_ASSOCIATION_SETTLE_SECONDS = 5;
const ALBUM_ASSOCIATION_VISIBILITY_DELAYS_SECONDS = [10, 20];
const ALBUM_ASSOCIATION_RETRY_DELAYS_SECONDS = [15, 30, 60];
const ASSOCIATION_50000_VISIBILITY_DELAYS_SECONDS = [5, 12, 24];
// addfile 全局节流
const ALBUM_ASSOCIATION_MIN_INTERVAL_SECONDS = 12.0;

// 只读列表端点重试
const LIST_TRANSIENT_RETRY_DELAYS_SECONDS = [5, 12, 20];
const LIST_MAX_ATTEMPTS = 1 + LIST_TRANSIENT_RETRY_DELAYS_SECONDS.length;
const LIST_TRANSIENT_ERRNOS = new Set([1, 50000]);
const ALBUM_LIST_RETRY_DELAYS_SECONDS = [5, 12, 20, 40];
const ALBUM_LIST_MAX_ATTEMPTS = 1 + ALBUM_LIST_RETRY_DELAYS_SECONDS.length;

const ERRNO_RE = /errno['"]?\s*[:=]\s*(-?\d+)/i;

// ========== 全局节流状态（跨所有 YikeRemoteClient 实例共享） ==========

let _globalNextAssociationAt = 0;
// Node.js 是单线程的，不需要物理锁；用一个 Promise 链来串行化 addfile 调用
let _associationChain = Promise.resolve();

// ========== 错误类型 ==========

class RemoteClientError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoteClientError";
  }
}

class UnsupportedRemoteFeature extends Error {
  constructor(message) {
    super(message);
    this.name = "UnsupportedRemoteFeature";
  }
}

// ========== 数据类 ==========

class RemoteAlbum {
  constructor({ album_id, title, created_at, modified_at, amount }) {
    this.album_id = album_id;
    this.title = title;
    this.created_at = created_at;
    this.modified_at = modified_at;
    this.amount = amount;
  }
}

class RemoteMedia {
  constructor({ fsid, name, size, modified_at, created_at, md5, album_id, thumbnail_url, preview_url }) {
    this.fsid = fsid;
    this.name = name;
    this.size = size;
    this.modified_at = modified_at;
    this.created_at = created_at;
    this.md5 = md5;
    this.album_id = album_id;
    this.thumbnail_url = thumbnail_url;
    this.preview_url = preview_url;
  }
}

// ========== Cookie 解析 ==========

/**
 * 解析 Cookie 文本：支持 JSON 数组格式（DevTools 导出）和 TSV 格式（逐行复制）。
 * 保留 .baidu.com 域的 cookie，优先选择以 "." 开头的域-scoped cookie。
 * 必须包含 BAIDUID 和 BDUSS。
 */
function parseCookieText(text) {
  text = (text || "").trim();
  if (!text) {
    throw new RemoteClientError("尚未导入登录 Cookie。");
  }

  // cookies: Map<name, [domain, value]>
  const cookies = new Map();

  let parsedAsJson = false;
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      parsedAsJson = true;
      for (const item of parsed) {
        if (item && typeof item === "object" && item.name && item.value) {
          const domain = String(item.domain || "");
          if (domain.includes("baidu.com")) {
            const name = String(item.name);
            const value = String(item.value);
            const existing = cookies.get(name);
            if (
              existing === undefined ||
              (!existing[0].startsWith(".") && domain.startsWith("."))
            ) {
              cookies.set(name, [domain, value]);
            }
          }
        }
      }
    }
  } catch {
    // Not JSON, fall through to TSV
  }

  if (!parsedAsJson) {
    for (const line of text.split("\n")) {
      const columns = line.split("\t");
      if (columns.length < 3) continue;
      const name = columns[0].trim();
      const value = columns[1].trim();
      const domain = columns[2].trim();
      if (name && value && domain.includes("baidu.com")) {
        const existing = cookies.get(name);
        if (
          existing === undefined ||
          (!existing[0].startsWith(".") && domain.startsWith("."))
        ) {
          cookies.set(name, [domain, value]);
        }
      }
    }
  }

  const result = {};
  for (const [name, [, value]] of cookies) {
    result[name] = value;
  }

  const missing = [];
  if (!("BAIDUID" in result)) missing.push("BAIDUID");
  if (!("BDUSS" in result)) missing.push("BDUSS");
  if (missing.length > 0) {
    throw new RemoteClientError(
      `Cookie 内容不完整，缺少：${missing.sort().join("、")}。请导出 photo.baidu.com 与 .baidu.com 的全部 Cookie。`
    );
  }
  return result;
}

// ========== 辅助函数 ==========

function sleep(seconds) {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

function asInt(value) {
  if (value === null || value === undefined) return null;
  try {
    return parseInt(value, 10);
  } catch {
    return null;
  }
}

function errnoValue(error) {
  if (!error) return null;
  const match = ERRNO_RE.exec(String(error.message || error));
  if (!match) return null;
  return parseInt(match[1], 10);
}

function isTransientListError(error) {
  const errno = errnoValue(error);
  if (errno !== null && LIST_TRANSIENT_ERRNOS.has(errno)) return true;
  // Node.js fetch 网络错误
  const name = error && error.name;
  return name === "AbortError" || name === "TypeError" || name === "FetchError";
}

// ========== YikeRemoteClient ==========

class YikeRemoteClient {
  /**
   * @param {string} cookieText - 原始 cookie 文本（JSON 数组或 TSV）
   */
  constructor(cookieText) {
    this._cookieText = cookieText;
    this._cookies = parseCookieText(cookieText);
    this._api = new API(this._cookies);

    // 相册对象缓存: Map<album_id, albumInfo>
    this._albums = new Map();
    // 媒体对象缓存: Map<"album_id:fsid", mediaInfo>
    this._media = new Map();
    // 相册列表缓存
    this._albumCache = [];
    this._albumCacheAt = 0;
    // 媒体列表缓存: Map<album_id, [timestamp, RemoteMedia[]]>
    this._mediaCache = new Map();

    log.debug("client", 
      `已初始化一刻相册客户端；已解析 ${Object.keys(this._cookies).length} 个 Cookie 字段`
    );
  }

  // ========== 缓存失效 ==========

  _invalidateAlbumCache() {
    this._albumCache = [];
    this._albumCacheAt = 0;
  }

  _invalidateMediaCache(albumId) {
    this._mediaCache.delete(albumId);
    // 也清除单个媒体对象缓存
    const prefix = albumId + ":";
    for (const key of this._media.keys()) {
      if (key.startsWith(prefix)) this._media.delete(key);
    }
  }

  // ========== 相册对象获取 ==========

  /**
   * 获取相册对象 info dict，如果缓存中没有则先 list_albums()。
   */
  _albumObject(albumId) {
    if (!this._albums.has(albumId)) {
      // 需要同步获取 — 但 Node.js 是异步的，调用方需保证已 list 过
      // 这里做 best-effort：如果缓存中没有就抛错
      throw new RemoteClientError("目标相册不在缓存中，请先调用 list_albums()。");
    }
    return this._albums.get(albumId);
  }

  /**
   * 刷新相册详情以获取最新 TID（用于 addfile）。
   * 如果详情获取失败，回退使用已缓存的相册对象。
   */
  async _refreshAlbumForAssociation(albumId) {
    const cachedAlbum = this._albums.get(String(albumId));
    try {
      const detail = await this._api.getAlbum_ByID(String(albumId));
      if (detail && String(detail.album_id) === String(albumId)) {
        this._albums.set(String(albumId), detail);
        return detail;
      }
    } catch (err) {
      if (cachedAlbum) {
        log.warn("album", 
          `相册详情刷新失败，低频入册仅本次回退已有缓存对象：album_id=${albumId}，错误=${err.name}`
        );
        return cachedAlbum;
      }
      throw new RemoteClientError("读取目标相册详情失败，未提交入册请求。");
    }
    if (cachedAlbum) {
      log.warn("album", 
        `相册详情未返回有效对象，低频入册仅本次回退已有缓存对象：album_id=${albumId}`
      );
      return cachedAlbum;
    }
    throw new RemoteClientError("目标相册详情无效，未提交入册请求。");
  }

  // ========== API 错误检查 ==========

  _apiError(response, action) {
    if (
      !response ||
      typeof response !== "object" ||
      (response.errno !== 0 && response.errno !== "0" && response.errno !== undefined && response.errno !== null)
    ) {
      throw new RemoteClientError(`${action}失败，远端接口未返回成功状态。`);
    }
  }

  _confirmAlbumAppend(response, fileName) {
    this._apiError(response, `将媒体加入相册：${fileName}`);
    const successCount = parseInt(response.succ_cnt || 0, 10);
    const failureCount = parseInt(response.fail_cnt || 0, 10);
    if (successCount < 1 || failureCount !== 0) {
      throw new RemoteClientError(
        `将媒体加入相册：${fileName} 未被服务端确认（成功 ${successCount}，失败 ${failureCount}）。`
      );
    }
  }

  _appendResponseSummary(response) {
    if (!response || typeof response !== "object") {
      return `响应类型 ${response ? typeof response : "null"}`;
    }
    return `errno=${JSON.stringify(response.errno)}，成功=${JSON.stringify(response.succ_cnt)}，失败=${JSON.stringify(response.fail_cnt)}`;
  }

  // ========== 全局节流 addfile ==========

  /**
   * 通过全局 Promise 链串行化所有 addfile 调用，保证至少 12 秒间隔。
   * 返回 addfile 的响应。
   */
  _appendWithProcessPacing(albumInfo, itemInfos) {
    const run = async () => {
      const now = performance.now() / 1000;
      const waitSeconds = Math.max(0, _globalNextAssociationAt - now);
      if (waitSeconds > 0) await sleep(waitSeconds);

      // 调用 API.addfile
      const albumId = String(albumInfo.album_id);
      const tid = String(albumInfo.tid || "");
      const fsidList = itemInfos.map((item) => String(item.fsid || item.fs_id));
      const response = await this._api.addfile(albumId, tid, fsidList);

      _globalNextAssociationAt = performance.now() / 1000 + ALBUM_ASSOCIATION_MIN_INTERVAL_SECONDS;
      return response;
    };

    // 串行化：每个 addfile 排队等待前一个完成
    const result = _associationChain.then(run);
    // 更新链：即使 run 抛错也继续
    _associationChain = result.then(() => {}, () => {});
    return result;
  }

  // ========== 入册回读 ==========

  async _isFsidVisibleInAlbum(albumId, fsid) {
    try {
      this._invalidateMediaCache(albumId);
      const media = await this.listMedia(albumId, true);
      return media.some((m) => m.fsid === fsid);
    } catch (err) {
      log.warn("album", `入册结果回读失败：album_id=${albumId}，fsid=${fsid}，错误=${err.name}`);
      return false;
    }
  }

  async _waitFor50000Visibility(albumId, fsid, fileName) {
    for (const delay of ASSOCIATION_50000_VISIBILITY_DELAYS_SECONDS) {
      log.warn("album", 
        `addfile 返回 50000，等待 ${delay} 秒确认是否已入册：album_id=${albumId}，fsid=${fsid}，文件=${fileName}`
      );
      await sleep(delay);
      if (await this._isFsidVisibleInAlbum(albumId, fsid)) {
        log.info("album", `50000 后已确认媒体实际在相册中：album_id=${albumId}，fsid=${fsid}，文件=${fileName}`);
        return true;
      }
    }
    return false;
  }

  // ========== 顺序入册（用于 upload_file_once 兼容路径） ==========

  async _appendUploadedItemInOrder(albumId, initialAlbum, itemInfo, filePath) {
    const fsid = String(itemInfo.fsid || itemInfo.fs_id);
    let currentAlbum = initialAlbum;
    let lastError = null;
    const maxAttempts = 1 + ALBUM_ASSOCIATION_RETRY_DELAYS_SECONDS.length;
    const fileName = path.basename(filePath);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (attempt > 1) {
        const delay = ALBUM_ASSOCIATION_RETRY_DELAYS_SECONDS[attempt - 2];
        log.warn("album", 
          `相册关联未确认，按原顺序等待 ${delay} 秒后重试：album_id=${albumId}，fsid=${fsid}，文件=${fileName}，第 ${attempt}/${maxAttempts} 次`
        );
        await sleep(delay);
        if (await this._isFsidVisibleInAlbum(albumId, fsid)) {
          log.info("album", `回读确认媒体已进入相册，无需重复 addfile：album_id=${albumId}，fsid=${fsid}`);
          return;
        }
      }

      let response = null;
      try {
        response = await this._appendWithProcessPacing(currentAlbum, [itemInfo]);
        this._confirmAlbumAppend(response, fileName);
        log.debug("album", 
          `媒体已确认加入相册：album_id=${albumId}，fsid=${fsid}，文件=${fileName}，尝试=${attempt}/${maxAttempts}`
        );
        return;
      } catch (err) {
        if (err instanceof RemoteClientError) {
          lastError = err;
          const summary = this._appendResponseSummary(response);
          log.warn("album", 
            `相册关联未确认：album_id=${albumId}，fsid=${fsid}，文件=${fileName}，尝试=${attempt}/${maxAttempts}，${summary}`
          );
          if (response && typeof response === "object" && String(response.errno) === "50000") {
            if (await this._waitFor50000Visibility(albumId, fsid, fileName)) {
              return;
            }
            // 50000 歧义：不刷新相册目录重试，直接跳出
            break;
          }
        } else {
          lastError = new RemoteClientError(
            `将媒体加入相册：${fileName} 的请求异常：${err.name}`
          );
          log.warn("album", 
            `相册关联请求异常：album_id=${albumId}，fsid=${fsid}，文件=${fileName}，尝试=${attempt}/${maxAttempts}，错误=${err.name}`
          );
        }
      }
    }

    // 最终回读
    if (await this._isFsidVisibleInAlbum(albumId, fsid)) {
      log.info("album", `最终回读确认媒体已进入相册：album_id=${albumId}，fsid=${fsid}`);
      return;
    }
    throw new RemoteClientError(
      `将媒体加入相册：${fileName} 未能在传播窗口内确认。` +
        "若刚才收到 errno 50000，服务端可能已接受关联；程序不会重复 addfile，" +
        "该文件保持待确认，后续同步会重新核对。"
    );
  }

  // ========== 单次入册（用于隔离文件客户端） ==========

  async _appendUploadedItemOnce(albumId, albumInfo, itemInfo, filePath) {
    const fsid = String(itemInfo.fsid || itemInfo.fs_id);
    const fileName = path.basename(filePath);
    const response = await this._appendWithProcessPacing(albumInfo, [itemInfo]);
    try {
      this._confirmAlbumAppend(response, fileName);
      return;
    } catch (err) {
      if (response && typeof response === "object" && String(response.errno) === "50000") {
        if (await this._isFsidVisibleInAlbum(albumId, fsid)) {
          log.info("album", `单文件客户端确认 50000 对应 FSID 已在相册中：album_id=${albumId}，fsid=${fsid}`);
          return;
        }
      }
      throw new RemoteClientError(
        `单文件客户端未确认入册：${fileName}（${this._appendResponseSummary(response)}）。已回报主控制器决定是否新建客户端重试。`
      );
    }
  }

  // ========== 公开 API ==========

  /**
   * 验证登录：读取相册列表，返回连接状态消息。
   * 同时也会预热相册缓存。
   */
  async verifyLogin() {
    const albums = await this.listAlbums();
    return `已连接，当前读取到 ${albums.length} 个相册。`;
  }

  /**
   * 原地更新 Cookie（保留所有缓存，避免重建实例导致相册/媒体缓存丢失）。
   * @param {string} newCookieText - 新的 cookie 文本（JSON 数组或 TSV）
   */
  updateCookie(newCookieText) {
    this._cookieText = newCookieText;
    this._cookies = parseCookieText(newCookieText);
    // 原地更新 API 层的 cookie 引用，不创建新 API 实例
    this._api.req.cookies = this._cookies;
    this._api.req.bdstoken = null; // bdstoken 需要用新 cookie 重新获取
    log.debug("client", 
      `已原地更新客户端 Cookie；已解析 ${Object.keys(this._cookies).length} 个 Cookie 字段`
    );
  }

  /**
   * 导出 cookie 为 JSON 数组（WebEngine seed 格式）。
   * 仅用于临时登出 webview，不应写入文件。
   */
  exportCookieJson() {
    const records = [];
    for (const [name, value] of Object.entries(this._cookies)) {
      records.push({ name, value, domain: ".baidu.com" });
    }
    return JSON.stringify(records);
  }

  /**
   * 导出文件客户端所需的最小上下文：cookie 文本 + 相册 info。
   */
  async exportFileClientContext(albumId) {
    let sourceAlbum;
    try {
      sourceAlbum = this._albumObject(albumId);
    } catch {
      sourceAlbum = await this._refreshAlbumForAssociation(albumId);
    }
    const info = { ...sourceAlbum };
    if (!info) {
      throw new RemoteClientError("无法为文件客户端导出相册元数据。");
    }
    return { cookieText: this._cookieText, info };
  }

  /**
   * 创建隔离的相册客户端（用于同步引擎子进程）。
   * 新客户端拥有独立的 API/Requests/token 缓存。
   */
  async createIsolatedAlbumClient(albumId) {
    const { cookieText, info } = await this.exportFileClientContext(albumId);
    const client = new YikeRemoteClient(cookieText);
    client._albums.set(String(albumId), info);
    return client;
  }

  /**
   * 获取相册列表（带缓存，TTL 180 秒）。
   * @param {boolean} forceRefresh - 强制刷新
   * @returns {Promise<RemoteAlbum[]>}
   */
  async listAlbums(forceRefresh = false) {
    const now = performance.now() / 1000;
    if (
      !forceRefresh &&
      this._albumCache.length > 0 &&
      now - this._albumCacheAt < ALBUM_CACHE_TTL_SECONDS
    ) {
      return [...this._albumCache];
    }

    let objects = null;
    let lastError = null;

    for (let attempt = 1; attempt <= ALBUM_LIST_MAX_ATTEMPTS; attempt++) {
      try {
        objects = await this._api.getAlbumList_All();
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < ALBUM_LIST_MAX_ATTEMPTS && isTransientListError(err)) {
          const delay = ALBUM_LIST_RETRY_DELAYS_SECONDS[attempt - 1];
          log.warn("album", 
            `相册目录读取被临时拒绝，等待 ${delay} 秒后重试（第 ${attempt}/${ALBUM_LIST_MAX_ATTEMPTS} 次）：${err.name}`
          );
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    if (objects === null) {
      if (this._albumCache.length > 0) {
        log.warn("album", 
          `相册目录刷新失败，回退使用过期缓存（${this._albumCache.length} 个相册）：${lastError ? lastError.name : "unknown"}`
        );
        return [...this._albumCache];
      }
      if (lastError && String(lastError.message || "").includes("errno=50801")) {
        throw new RemoteClientError("无法读取相册列表：文件过大或需要开通会员（errno=50801）。");
      }
      throw new RemoteClientError("无法读取相册列表，请检查网络和登录 Cookie 是否仍有效。");
    }

    const result = [];
    this._albums.clear();
    for (const albumInfo of objects) {
      const albumId = String(albumInfo.album_id);
      this._albums.set(albumId, albumInfo);
      result.push(
        new RemoteAlbum({
          album_id: albumId,
          title: albumInfo.title,
          created_at: asInt(albumInfo.ctime),
          modified_at: asInt(albumInfo.mtime),
          amount: asInt(albumInfo.amount),
        })
      );
    }
    result.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
    this._albumCache = result;
    this._albumCacheAt = now;

    log.debug("album", `云端相册目录从服务器读取完成：${result.length} 个相册`);
    return [...result];
  }

  /**
   * 获取相册内媒体列表（带缓存，TTL 180 秒）。
   * @param {string} albumId
   * @param {boolean} forceRefresh
   * @returns {Promise<RemoteMedia[]>}
   */
  async listMedia(albumId, forceRefresh = false) {
    const now = performance.now() / 1000;
    const cached = this._mediaCache.get(albumId);
    if (
      !forceRefresh &&
      cached &&
      now - cached[0] < MEDIA_CACHE_TTL_SECONDS
    ) {
      return [...cached[1]];
    }

    const albumInfo = this._albumObject(albumId);

    let objects = null;
    let lastError = null;
    for (let attempt = 1; attempt <= LIST_MAX_ATTEMPTS; attempt++) {
      try {
        objects = await this._api.getAlbumFiles_All(albumId);
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < LIST_MAX_ATTEMPTS && isTransientListError(err)) {
          const delay = LIST_TRANSIENT_RETRY_DELAYS_SECONDS[attempt - 1];
          log.warn("album", 
            `相册媒体列表读取被临时拒绝，等待 ${delay} 秒后重试（第 ${attempt}/${LIST_MAX_ATTEMPTS} 次）：album_id=${albumId}，错误=${err.name}`
          );
          await sleep(delay);
          continue;
        }
        break;
      }
    }

    if (objects === null) {
      const staleCached = this._mediaCache.get(albumId);
      if (staleCached) {
        log.warn("album", 
          `相册媒体刷新失败，回退使用过期缓存：album_id=${albumId}，媒体数=${staleCached[1].length}，错误=${lastError ? lastError.name : "unknown"}`
        );
        return [...staleCached[1]];
      }
      if (lastError && String(lastError.message || "").includes("errno=50801")) {
        throw new RemoteClientError("无法读取相册媒体列表：文件过大或需要开通会员（errno=50801）。");
      }
      throw new RemoteClientError("无法读取相册媒体列表。");
    }

    const result = [];
    for (const itemInfo of objects) {
      const fsid = String(itemInfo.fsid || itemInfo.fs_id);
      const thumbUrls = itemInfo.thumburl;
      let validThumbUrls = [];
      if (Array.isArray(thumbUrls)) {
        validThumbUrls = thumbUrls.filter((u) => typeof u === "string" && u);
      } else if (typeof thumbUrls === "string" && thumbUrls) {
        validThumbUrls = [thumbUrls];
      }
      const thumbnailUrl = validThumbUrls.length > 0 ? validThumbUrls[0] : null;
      const previewUrl = validThumbUrls.length > 0 ? validThumbUrls[validThumbUrls.length - 1] : null;

      this._media.set(`${albumId}:${fsid}`, itemInfo);
      result.push(
        new RemoteMedia({
          fsid,
          name: (itemInfo.path || "").split("/").pop() || "",
          size: parseInt(itemInfo.size || 0, 10),
          modified_at: asInt(itemInfo.mtime),
          created_at: asInt(itemInfo.ctime),
          md5: itemInfo.md5 || null,
          album_id: albumId,
          thumbnail_url: thumbnailUrl,
          preview_url: previewUrl,
        })
      );
    }
    result.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
    this._mediaCache.set(albumId, [now, result]);

    log.debug("album", `相册媒体列表从服务器读取完成：album_id=${albumId}，媒体数=${result.length}`);
    return [...result];
  }

  /**
   * 获取单个媒体对象 info（内部使用）。
   */
  _mediaObject(albumId, fsid) {
    const key = `${albumId}:${fsid}`;
    if (!this._media.has(key)) {
      throw new RemoteClientError("目标媒体已不存在或媒体列表已过期。");
    }
    return this._media.get(key);
  }

  /**
   * 创建相册。
   * @returns {Promise<RemoteAlbum>}
   */
  async createAlbum(title) {
    title = (title || "").trim();
    if (!title) throw new RemoteClientError("相册名称不能为空。");
    let albumInfo;
    try {
      albumInfo = await this._api.createNewAlbum(title);
    } catch (err) {
      throw new RemoteClientError("创建相册失败。");
    }
    if (!albumInfo || albumInfo.title !== title) {
      throw new RemoteClientError("创建相册后返回的名称与输入名称不一致。");
    }
    const albumId = String(albumInfo.album_id);
    this._albums.set(albumId, albumInfo);
    this._invalidateAlbumCache();
    return new RemoteAlbum({
      album_id: albumId,
      title: albumInfo.title,
      created_at: asInt(albumInfo.ctime),
      modified_at: asInt(albumInfo.mtime),
      amount: asInt(albumInfo.amount),
    });
  }

  /**
   * 重命名相册。
   */
  async renameAlbum(albumId, title) {
    const albumInfo = this._albumObject(albumId);
    title = (title || "").trim();
    if (!title) throw new RemoteClientError("相册名称不能为空。");
    try {
      await this._api.rename_album(albumId, albumInfo.tid, title);
    } catch (err) {
      throw new RemoteClientError("重命名相册失败。");
    }
    // 就地更新缓存
    albumInfo.title = title;
    this._invalidateAlbumCache();
  }

  /**
   * 删除相册。
   * @param {boolean} deleteItems - 是否同时删除相册内文件
   */
  async deleteAlbum(albumId, deleteItems = false) {
    const albumInfo = this._albumObject(albumId);
    try {
      const response = await this._api.delete_album(albumId, albumInfo.tid, deleteItems);
      this._apiError(response, "删除相册");
    } catch (err) {
      if (err instanceof RemoteClientError) throw err;
      throw new RemoteClientError("删除相册失败。");
    }
    this._albums.delete(albumId);
    this._invalidateAlbumCache();
    this._invalidateMediaCache(albumId);
  }

  /**
   * 上传文件载荷（仅上传，不调用 addfile）。
   * 这是两阶段上传模型的第一阶段：上传文件到百度 PCS 并返回 FSID。
   * @param {string} filePath - 本地文件路径
   * @param {function|null} progress - 进度回调 (percent, message)
   * @returns {Promise<string>} FSID
   */
  async uploadFilePayloadOnce(filePath, progress = null) {
    if (progress) progress(0, `正在上传 ${path.basename(filePath)}`);
    try {
      const [isMedia, validationMessage] = validate_media_file(filePath);
      if (!isMedia) {
        throw new RemoteClientError(
          `拒绝上传非有效照片/视频：${path.basename(filePath)}（${validationMessage}）`
        );
      }
      const itemInfo = await this._api.upload_1file_directly(filePath);
      if (!itemInfo) {
        throw new RemoteClientError(`上传未返回媒体对象：${path.basename(filePath)}`);
      }
      const fsid = String(itemInfo.fsid || itemInfo.fs_id || "");
      if (!fsid) {
        throw new RemoteClientError(`上传未返回有效 FSID：${path.basename(filePath)}`);
      }
      if (progress) progress(100, `上传完成，等待主控制器统一加入相册 ${path.basename(filePath)}`);
      return fsid;
    } catch (err) {
      if (err instanceof RemoteClientError) throw err;
      if (err instanceof TypeError || err instanceof ReferenceError) {
        throw new RemoteClientError(`上传接口响应异常（缺少字段 ${err.message}），详见 error.log`);
      }
      throw new RemoteClientError(`上传失败：${path.basename(filePath)}：${err.message || err.name}`);
    }
  }

  /**
   * 批量关联已上传的 FSID 到相册（两阶段上传第二阶段）。
   * 刷新相册详情 → addfile（≤50 个/批，全局节流） → 回读确认可见性。
   * @param {string} albumId
   * @param {string[]} fsids
   * @returns {Promise<Set<string>>} 已确认可见的 FSID 集合
   */
  async associateUploadedFsidsOnce(albumId, fsids) {
    // 去重
    const requested = [...new Set(fsids.filter((f) => String(f)).map(String))];
    if (requested.length === 0) return new Set();

    const albumInfo = await this._refreshAlbumForAssociation(albumId);

    // 构造 OnlineItem info 对象
    const itemInfos = requested.map((fsid) => ({ fsid: parseInt(fsid, 10) }));

    const response = await this._appendWithProcessPacing(albumInfo, itemInfos);
    const errno = response && typeof response === "object" ? String(response.errno) : "unknown";
    log.info("album", 
      `主控制器低频批量入册已提交：album_id=${albumId}，数量=${itemInfos.length}，errno=${errno}`
    );

    // 等待传播后回读
    const delays = [ALBUM_ASSOCIATION_SETTLE_SECONDS];
    if (errno === "50000") {
      delays.push(...ASSOCIATION_50000_VISIBILITY_DELAYS_SECONDS);
    } else {
      delays.push(...ALBUM_ASSOCIATION_VISIBILITY_DELAYS_SECONDS);
    }

    let confirmed = new Set();
    for (const delay of delays) {
      await sleep(delay);
      try {
        this._invalidateMediaCache(albumId);
        const media = await this.listMedia(albumId, true);
        const visible = new Set(media.map((m) => m.fsid));
        confirmed = new Set(requested.filter((f) => visible.has(f)));
        log.info("album", 
          `批量入册可见性核对：album_id=${albumId}，提交=${requested.length}，已可见=${confirmed.size}，等待=${delay}秒`
        );
        if (confirmed.size === requested.length) break;
      } catch (err) {
        throw new RemoteClientError(`批量关联后读取目标相册失败：${err.message || err.name}`);
      }
    }
    if (confirmed.size > 0) {
      this._invalidateMediaCache(albumId);
    }
    return confirmed;
  }

  /**
   * 单文件上传 + 关联（兼容路径，用于手动上传）。
   */
  async uploadFileOnce(albumId, filePath, progress = null) {
    const fsid = await this.uploadFilePayloadOnce(filePath, null);
    const confirmed = await this.associateUploadedFsidsOnce(albumId, [fsid]);
    if (!confirmed.has(fsid)) {
      throw new RemoteClientError(`单文件关联未确认：${path.basename(filePath)}`);
    }
    if (progress) progress(100, `已上传并确认入册 ${path.basename(filePath)}`);
  }

  /**
   * 多文件上传（兼容路径，逐个上传）。
   */
  async uploadFiles(albumId, filePaths, progress = null) {
    const paths = [...filePaths];
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      if (progress) {
        progress(Math.floor((i / Math.max(1, paths.length)) * 100), `正在上传并确认入册 ${path.basename(p)}`);
      }
      await this.uploadFileOnce(albumId, p, null);
      if (progress) {
        progress(Math.floor(((i + 1) / Math.max(1, paths.length)) * 100), `已上传并确认入册 ${path.basename(p)}`);
      }
    }
  }

  /**
   * 下载媒体到目标目录。
   * @returns {Promise<string>} 下载后的文件路径
   */
  async downloadMedia(albumId, fsid, targetDirectory) {
    let itemInfo;
    try {
      itemInfo = this._mediaObject(albumId, fsid);
    } catch {
      // 缓存未命中（如隔离客户端），自动从服务器获取
      await this.listMedia(albumId, true);
      itemInfo = this._mediaObject(albumId, fsid);
    }
    const fileName = (itemInfo.path || "").split("/").pop() || `${fsid}`;
    fs.mkdirSync(targetDirectory, { recursive: true });
    log.debug("media", `开始下载：album_id=${albumId}，fsid=${fsid}，目标目录=${targetDirectory}`);
    try {
      await this._api.downloadFile(itemInfo, targetDirectory, fileName, true);
    } catch (err) {
      throw new RemoteClientError(`下载失败：${fileName}`);
    }
    return path.join(targetDirectory, fileName);
  }

  /**
   * 下载媒体到指定目录（供拖拽下载使用，文件名冲突时自动追加序号）。
   * @returns {Promise<string>} 下载后的文件路径
   */
  async downloadMediaTo(albumId, fsid, targetDirectory) {
    let itemInfo;
    try {
      itemInfo = this._mediaObject(albumId, fsid);
    } catch {
      await this.listMedia(albumId, true);
      itemInfo = this._mediaObject(albumId, fsid);
    }
    const baseName = (itemInfo.path || "").split("/").pop() || `${fsid}`;
    fs.mkdirSync(targetDirectory, { recursive: true });
    let fileName = baseName;
    const ext = path.extname(baseName);
    const stem = baseName.slice(0, baseName.length - ext.length);
    let counter = 1;
    while (fs.existsSync(path.join(targetDirectory, fileName))) {
      fileName = `${stem} (${counter})${ext}`;
      counter++;
    }
    log.debug("media", `拖拽下载：album_id=${albumId}，fsid=${fsid}，目标=${targetDirectory}，文件名=${fileName}`);
    try {
      await this._api.downloadFile(itemInfo, targetDirectory, fileName, true);
    } catch (err) {
      throw new RemoteClientError(`下载失败：${fileName}`);
    }
    return path.join(targetDirectory, fileName);
  }

  /**
   * 删除云端媒体。
   */
  async deleteMedia(albumId, fsid) {
    let itemInfo;
    try {
      itemInfo = this._mediaObject(albumId, fsid);
    } catch {
      // 缓存未命中，自动从服务器获取
      await this.listMedia(albumId, true);
      itemInfo = this._mediaObject(albumId, fsid);
    }
    try {
      const response = await this._api.delete_media([String(fsid)]);
      this._apiError(response, "删除媒体");
    } catch (err) {
      if (err instanceof RemoteClientError) throw err;
      throw new RemoteClientError("删除媒体失败。");
    }
    this._invalidateMediaCache(albumId);
  }

  /**
   * 重命名云端媒体 — 不支持。
   */
  async renameMedia() {
    throw new UnsupportedRemoteFeature(
      "当前接口库未提供已验证的远端媒体重命名接口。为避免以重新上传和删除替代重命名，本程序不会执行该操作。"
    );
  }
}

// 导出全局节流状态重置函数（用于测试）
function resetGlobalAssociationPacing() {
  _globalNextAssociationAt = 0;
  _associationChain = Promise.resolve();
}

module.exports = {
  YikeRemoteClient,
  RemoteClientError,
  UnsupportedRemoteFeature,
  RemoteAlbum,
  RemoteMedia,
  parseCookieText,
  resetGlobalAssociationPacing,
};
