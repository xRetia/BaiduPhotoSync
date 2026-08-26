"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell, session } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { Worker } = require("worker_threads");

const ROOT = path.resolve(__dirname, "..");
const RENDERER = path.join(__dirname, "renderer");
const SRC = path.join(__dirname, "src");

// ========== 后端模块加载 ==========

const { YikeRemoteClient, RemoteClientError } = require("./src/remote_client");
const { SessionStore } = require("./src/session_store");
const { DownloadCache } = require("./src/download_cache");
const {
  SyncEngine,
  SyncControl,
  SyncDirection,
  SortField,
  FileCompareMode,
} = require("./src/sync_engine");
const { VideoCompressionOptions, VideoCompressionError, locate_ffmpeg } = require("./src/video_compression");
const { FFmpegDownloadError, SOURCES, ensure_windows_ffmpeg } = require("./src/ffmpeg_downloader");
const { app_data_directory, clear_windows_registry_settings, remove_application_data } = require("./src/platform_services");
const { validate_media_file, free_user_size_message } = require("./src/media_validation");
const log = require("./src/logger");

const MIB = 1024 * 1024;
const DOWNLOAD_CACHE_DEFAULT_MIB = 1024;

// ========== 应用状态 ==========

let mainWindow = null;
let qrWindow = null;
let logoutWindow = null;
let settingsWindow = null;
let syncResultWindow = null;
let client = null; // YikeRemoteClient 实例
let cookieText = "";
let sessionStore = null;
let downloadCache = null;
let syncEngine = null;
let syncControl = null;
let syncActions = [];
let settings = {};
let syncWorker = null;
let syncTaskId = 0;

// ========== 会话保活 ==========

const KEEPALIVE_HOME_URL = "https://photo.baidu.com/";
const KEEPALIVE_URL = "https://photo.baidu.com/photo/web/home";
const KEEPALIVE_INTERVAL_MS = 3 * 60 * 1000; // 3 分钟
let keepaliveWindow = null;
let keepaliveTimer = null;
let keepaliveEnhanced = false;
let keepaliveCookieDebounceTimer = null;
let keepaliveRefreshInFlight = false;
let keepaliveActive = false;

function isBaiduDomain(domain) {
  if (!domain) return false;
  const d = domain.replace(/^\./, "").toLowerCase();
  return d === "baidu.com" || d.endsWith(".baidu.com");
}

// 清除指定 partition 的百度 Cookie（对齐 Python 版销毁整个 off-the-record profile）。
// 命名 partition 在应用会话内会驻留内存，登出/断开后必须主动清空，否则残留 BDUSS
// 可能在下次连接时污染会话、甚至被误判为已登录。
function clearPartitionCookies(partitionName) {
  return new Promise((resolve) => {
    try {
      session
        .fromPartition(partitionName)
        .clearStorageData({ storages: ["cookies"] })
        .then(() => resolve())
        .catch(() => resolve());
    } catch {
      resolve();
    }
  });
}

async function startKeepalive(cookieJson, enhanced) {
  stopKeepalive();
  if (!cookieJson) return;

  // 每次连接都重建干净的 keepalive 会话（对齐 Python 版：stop() 销毁旧 profile 后新建）
  // 避免上次会话残留的 BDUSS 滞留在同一命名 partition 中。
  await clearPartitionCookies("keepalive");

  keepaliveEnhanced = Boolean(enhanced);
  keepaliveActive = true;

  // 创建隐藏窗口加载百度相册页面，靠页面自身 JavaScript 维持会话
  keepaliveWindow = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    webPreferences: {
      partition: "keepalive",
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const ses = keepaliveWindow.webContents.session;

  // 注入 cookie（与 Python 版 _seed_cookies 对齐：使用 url 参数，不强制 secure/httpOnly）
  try {
    const cookies = JSON.parse(cookieJson);
    const setPromises = [];
    for (const c of cookies) {
      if (!c.name || !c.value) continue;
      const domain = c.domain || ".baidu.com";
      if (!isBaiduDomain(domain)) continue;
      setPromises.push(
        ses.cookies.set({
          name: c.name,
          value: c.value,
          domain: domain.startsWith(".") ? domain : "." + domain,
          path: c.path || "/",
          url: KEEPALIVE_HOME_URL,
          secure: c.secure != null ? c.secure : false,
          httpOnly: c.httpOnly != null ? c.httpOnly : false,
        }).catch(() => {})
      );
    }
    await Promise.all(setPromises);
  } catch {
    // cookie 解析失败不阻塞保活
  }

  // 监听页面加载完成事件（与 Python 版 _load_finished 对齐）
  keepaliveWindow.webContents.on("did-finish-load", () => {
    keepaliveRefreshInFlight = false;
    if (!keepaliveActive) return;
    log.debug("keepalive", "会话保活页面加载完成，正在检查 Cookie 更新。");
    // 延迟 900ms 后检查 cookie，让 Set-Cookie 响应头和 JS 重定向生效
    setTimeout(() => {
      if (keepaliveActive && keepaliveWindow && !keepaliveWindow.isDestroyed()) {
        refreshKeepaliveCookie(ses);
      }
    }, 900);
  });

  keepaliveWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription) => {
    keepaliveRefreshInFlight = false;
    if (!keepaliveActive) return;
    log.warn("keepalive", `会话保活页面加载失败: ${errorCode} ${errorDescription}`);
  });

  // cookie 注入完成后立即加载页面
  keepaliveRefreshInFlight = true;
  keepaliveWindow.loadURL(KEEPALIVE_URL);

  // 增强模式：每 3 分钟刷新页面
  if (keepaliveEnhanced) {
    keepaliveTimer = setInterval(() => {
      if (keepaliveWindow && !keepaliveWindow.isDestroyed() && !keepaliveRefreshInFlight) {
        log.debug("keepalive", "会话保活：正在刷新隐藏页面（增强模式）");
        keepaliveRefreshInFlight = true;
        keepaliveWindow.loadURL(KEEPALIVE_URL);
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  // 监听 cookie 变化，自动保存刷新后的 cookie（防抖 2 秒，避免频繁触发）
  ses.cookies.on("changed", (_e, cookie, cause) => {
    if (cause === "set-by-api" || !isBaiduDomain(cookie.domain)) return;
    // 页面加载后百度可能更新了 cookie，收集并保存
    if (keepaliveCookieDebounceTimer) clearTimeout(keepaliveCookieDebounceTimer);
    keepaliveCookieDebounceTimer = setTimeout(() => {
      keepaliveCookieDebounceTimer = null;
      refreshKeepaliveCookie(ses);
    }, 2000);
  });

  log.debug("keepalive", `会话保活已启动：隐藏页面=${KEEPALIVE_URL}，增强定时刷新=${keepaliveEnhanced ? "启用（每3分钟）" : "关闭"}`);
}

function refreshKeepaliveCookie(ses) {
  if (!ses) ses = keepaliveWindow ? keepaliveWindow.webContents.session : null;
  if (!ses) return;
  ses.cookies.get({}).then((cookies) => {
    const baiduCookies = cookies.filter((c) => c.domain && c.domain.includes("baidu.com"));
    const hasRequired = baiduCookies.some((c) => c.name === "BAIDUID") && baiduCookies.some((c) => c.name === "BDUSS");
    if (!hasRequired) return;
    const cookieJson = JSON.stringify(
      baiduCookies.map((c) => ({ name: c.name, value: c.value, domain: c.domain }))
    );
    if (cookieJson !== cookieText) {
      cookieText = cookieJson;
      sessionStore.save(cookieJson);
      // 用刷新后的 cookie 更新活跃 client（原地更新，保留相册/媒体缓存）
      if (client) {
        try {
          client.updateCookie(cookieJson);
          log.debug("keepalive", "会话保活检测到 Cookie 更新，已原地更新活跃 client 实例");
        } catch (err) {
          log.warn("keepalive", "会话保活 cookie 刷新后更新 client 失败:", err.message || err);
        }
      } else {
        log.debug("keepalive", "会话保活检测到 Cookie 更新，已保存刷新后的会话");
      }
    }
  }).catch(() => {});
}

function stopKeepalive() {
  keepaliveActive = false;
  // 清空 keepalive partition 的百度 Cookie，避免登出/断开后残留凭据
  clearPartitionCookies("keepalive");
  if (keepaliveCookieDebounceTimer) {
    clearTimeout(keepaliveCookieDebounceTimer);
    keepaliveCookieDebounceTimer = null;
  }
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (keepaliveWindow) {
    if (!keepaliveWindow.isDestroyed()) {
      keepaliveWindow.destroy();
    }
    keepaliveWindow = null;
  }
  keepaliveRefreshInFlight = false;
  keepaliveEnhanced = false;
}

function setKeepaliveEnhanced(enabled) {
  keepaliveEnhanced = Boolean(enabled);
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
  if (keepaliveEnhanced && keepaliveWindow) {
    keepaliveTimer = setInterval(() => {
      if (keepaliveWindow && !keepaliveWindow.isDestroyed() && !keepaliveRefreshInFlight) {
        log.debug("keepalive", "会话保活：正在刷新隐藏页面（增强模式）");
        keepaliveRefreshInFlight = true;
        keepaliveWindow.loadURL(KEEPALIVE_URL);
      }
    }, KEEPALIVE_INTERVAL_MS);
    log.debug("keepalive", "账号增强防掉线已启用：每 3 分钟刷新隐藏页面。");
  } else {
    log.debug("keepalive", "账号增强防掉线已关闭：隐藏页面仅由自身 JavaScript 维持会话。");
  }
}

// ========== 设置文件 ==========

function settingsFile() {
  return path.join(app_data_directory(), "settings.json");
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), "utf-8"));
  } catch {
    return {};
  }
}

function saveSettings(s) {
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), "utf-8");
}

function downloadCacheDirectory() {
  return path.join(app_data_directory(), "download-cache");
}

// ========== 序列化辅助 ==========

function albumToDict(album) {
  return {
    album_id: album.album_id,
    title: album.title,
    created_at: album.created_at,
    modified_at: album.modified_at,
    amount: album.amount,
  };
}

function mediaToDict(media) {
  return {
    fsid: media.fsid,
    name: media.name,
    size: media.size,
    modified_at: media.modified_at,
    created_at: media.created_at,
    md5: media.md5,
    album_id: media.album_id,
    thumbnail_url: media.thumbnail_url,
    preview_url: media.preview_url,
  };
}

function actionToDict(action) {
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

// ========== 窗口创建 ==========

function createMainWindow() {
  // 读取上次的窗口位置和大小
  const savedBounds = settings.windowBounds || {};
  const windowOptions = {
    width: savedBounds.width || 1400,
    height: savedBounds.height || 880,
    minWidth: 1000,
    minHeight: 520,
    title: "一刻同步",
    icon: path.join(__dirname, "assets", "yike_sync.ico"),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
  if (savedBounds.x !== undefined && savedBounds.y !== undefined) {
    windowOptions.x = savedBounds.x;
    windowOptions.y = savedBounds.y;
  }
  mainWindow = new BrowserWindow(windowOptions);

  mainWindow.loadFile(path.join(RENDERER, "index.html"));

  // 主窗口在 ready-to-show 时显示
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (e) => {
    // 保存窗口位置和大小
    if (mainWindow && !mainWindow.isDestroyed()) {
      const bounds = mainWindow.getBounds();
      settings.windowBounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      saveSettings(settings);
      e.preventDefault();
      mainWindow.webContents.send("app-close-requested");
    }
  });

  // 标记：当收到渲染进程确认后，真正退出应用
  ipcMain.handle("app:quit", () => {
    // 先停止保活和同步
    stopKeepalive();
    if (syncWorker) {
      syncWorker.postMessage({ type: "control", command: "stop" });
      syncWorker.terminate();
      syncWorker = null;
    }
    // 移除 close 事件拦截，允许窗口关闭
    mainWindow.removeAllListeners("close");
    app.quit();
  });
}

function createQRLoginWindow() {
  if (qrWindow && !qrWindow.isDestroyed()) {
    qrWindow.focus();
    return qrWindow;
  }

  qrWindow = new BrowserWindow({
    width: 730,
    height: 550,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "登录一刻同步助手",
    icon: path.join(__dirname, "assets", "yike_sync.ico"),
    parent: mainWindow,
    modal: true,
    autoHideMenuBar: true,
    webPreferences: {
      partition: "qr-login",
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  const loginUrl = "https://photo.baidu.com/photo/web/login";
  qrWindow.loadURL(loginUrl);

  // 防止页面 <title> 覆盖窗口标题
  qrWindow.on("page-title-updated", (e) => e.preventDefault());

  // 左侧 360x520 品牌图片（本地资源转 data URI，避免远程页加载 file:// 被拦截）
  let loginSplashDataUri = "";
  try {
    const splashBuf = fs.readFileSync(path.join(__dirname, "assets", "login-splash.png"));
    loginSplashDataUri = "data:image/png;base64," + splashBuf.toString("base64");
  } catch (err) {
    log.warn("login", "登录：未找到 login-splash.png，使用纯色背景:", err.message);
  }
  const splashBg = loginSplashDataUri
    ? `url("${loginSplashDataUri}") center/cover no-repeat`
    : "#1d63bf";

  // 注入 CSS：隐藏百度页面多余内容，左側固定 360x520 品牌图，右侧显示登录弹窗
  const LOGIN_HIDE_CSS = `
    body { overflow: hidden !important; }
    body::before {
      content: "";
      position: fixed;
      top: 0; left: 0;
      width: 360px; height: 520px;
      background: ${splashBg};
      z-index: 1;
    }
    .header, .flastupload-guide, .box, .features, .box-mark1, .box-mark2, .box-desc1, .box-desc2 { display: none !important; }
    .main { background: #ffffff !important; height: 100% !important; padding: 0 !important; margin: 0 !important; }
    .login-pop {
      position: fixed !important;
      top: 0 !important;
      left: 360px !important;
      right: auto !important;
      bottom: auto !important;
      width: 370px !important;
      height: 520px !important;
      transform: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      border: none !important;
      z-index: 2 !important;
    }
  `;

  let navigateHidden = false; // qrWindow 是否因页面跳转而隐藏

  // 页面跳转时立即隐藏 qrWindow，通知主窗口显示 loading，后台 webview 继续提取 cookie
  function onLoginNavigated() {
    if (navigateHidden) return;
    navigateHidden = true;
    if (qrWindow && !qrWindow.isDestroyed()) {
      qrWindow.hide();
    }
    // 通知主窗口渲染进程显示 loading overlay
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("qr-login-loading");
    }
  }

  // 每次页面 dom-ready 时都注入 CSS（页面跳转后 DOM 重建需重新注入）
  qrWindow.webContents.on("dom-ready", () => {
    qrWindow.webContents.insertCSS(LOGIN_HIDE_CSS).catch(() => {});
  });

  // 页面跳转时立即隐藏 qrWindow，显示 loading，后台继续提取 cookie
  // 只对离开登录页的跳转才触发（初始加载 loginUrl 不算）
  qrWindow.webContents.on("will-navigate", (_e, url) => {
    log.debug("login", `登录：页面即将跳转 → ${url}`);
    if (!url.includes("/login")) onLoginNavigated();
  });
  qrWindow.webContents.on("did-navigate", (_e, url) => {
    log.debug("login", `登录：页面已跳转 → ${url}`);
    if (!url.includes("/login")) {
      onLoginNavigated();
      // 到达登录后的主页（非 /login）即视为登录完成，稍后提交完整 cookie
      if (url.includes("photo.baidu.com/photo/web/")) {
        reachedHome = true;
        scheduleCandidate();
      }
    }
  });
  qrWindow.webContents.on("did-navigate-in-page", (_e, url) => {
    // SPA 内部跳转也可能是登录成功后的路由变化
    if (url.includes("photo.baidu.com/photo/web/") && !url.includes("/login")) {
      log.debug("login", `登录：SPA 内部跳转 → ${url}`);
      onLoginNavigated();
      // 登录成功跳转到主页后才提交，确保 Baidu 已下发完整会话 Cookie（避免拿到
      // 扫码时的临时 BDUSS 导致后续 API 返回 errno -6）
      reachedHome = true;
      scheduleCandidate();
    }
  });

  const ses = qrWindow.webContents.session;
  const REQUIRED_COOKIES = ["BAIDUID", "BDUSS"];
  const CONFIRMED_COOKIES = ["STOKEN", "PTOKEN", "PANWEB", "PANWEB.sig"];

  let bdussSeenAt = 0;        // BDUSS 首次出现的时间戳
  let reachedHome = false;     // 是否已跳转到登录后的主页（完整会话已下发）
  let candidateTimer = null;  // 延迟提交定时器
  let submitted = false;       // 是否已提交候选 cookie
  let cookieCheckTimer = null; // cookie 轮询定时器

  // 安排一次延迟提交（1200ms，等 cookie 完全传播）。幂等：已安排或已提交则跳过。
  function scheduleCandidate() {
    if (submitted || candidateTimer) return;
    candidateTimer = setTimeout(() => {
      submitCandidateCookie();
    }, 1200);
  }

  cookieCheckTimer = setInterval(() => {
    if (!qrWindow || qrWindow.isDestroyed()) {
      clearInterval(cookieCheckTimer);
      return;
    }
    ses.cookies.get({}).then((cookies) => {
      if (submitted) return;
      const cookieMap = {};
      for (const c of cookies) {
        if (c.domain && c.domain.includes("baidu.com")) {
          cookieMap[c.name] = c.value;
        }
      }
      const hasRequired = REQUIRED_COOKIES.every((n) => cookieMap[n]);
      if (!hasRequired) return;

      // 记录 BDUSS 首次出现时间（不显示遮罩，让用户继续看到二维码页面）
      if (cookieMap["BDUSS"] && bdussSeenAt === 0) {
        bdussSeenAt = Date.now();
      }

      const now = Date.now();
      const bdussAge = bdussSeenAt ? (now - bdussSeenAt) / 1000 : 0;

      if (reachedHome) {
        // 已到达登录后主页：Baidu 已下发完整会话 Cookie，直接提交
        scheduleCandidate();
      } else if (bdussSeenAt && bdussAge > 15) {
        // 安全网：长时间未跳转到主页（部分账号/网络），BDUSS 出现超过 15 秒后
        // 即便没有确认态 Cookie 也提交，避免卡死
        scheduleCandidate();
      }
    });
  }, 1000);

  function submitCandidateCookie() {
    if (submitted || !qrWindow || qrWindow.isDestroyed()) return;

    // 确保已隐藏 qrWindow 并显示 loading
    onLoginNavigated();

    // 后台提取 cookie（qrWindow 虽隐藏但 webContents 仍在运行）
    ses.cookies.get({}).then((cookies) => {
      const cookieJson = JSON.stringify(
        cookies
          .filter((c) => c.domain && c.domain.includes("baidu.com"))
          .map((c) => ({ name: c.name, value: c.value, domain: c.domain }))
      );
      // 防御：核心 Cookie 缺失则放弃本次提交并允许重试，
      // 避免把不完整的 Cookie 发给渲染进程反复验证失败（“获取不到 cookie”）。
      let parsed = [];
      try { parsed = JSON.parse(cookieJson); } catch { parsed = []; }
      const names = new Set(parsed.map((c) => c.name));
      if (!REQUIRED_COOKIES.every((n) => names.has(n))) {
        submitted = false;
        candidateTimer = null;
        return;
      }
      submitted = true;
      clearInterval(cookieCheckTimer);
      cookieCheckTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("qr-login-cookie", cookieJson);
      }
      // 不关闭 qrWindow，等渲染进程验证成功后再关闭
    }).catch(() => {
      submitted = false; // 允许重试
      candidateTimer = null;
    });
  }

  // 渲染进程验证成功后通知关闭 QR 窗口
  ipcMain.once("qr-login:close", () => {
    if (candidateTimer) { clearTimeout(candidateTimer); candidateTimer = null; }
    if (cookieCheckTimer) { clearInterval(cookieCheckTimer); cookieCheckTimer = null; }
    if (qrWindow && !qrWindow.isDestroyed()) {
      qrWindow.destroy();
    }
  });

  // 渲染进程验证失败后通知重置 QR 窗口（允许重新扫码）
  ipcMain.once("qr-login:retry", () => {
    if (candidateTimer) { clearTimeout(candidateTimer); candidateTimer = null; }
    submitted = false;
    bdussSeenAt = 0;
    navigateHidden = false;
    // 通知主窗口隐藏 loading overlay
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("qr-login-loading-hide");
    }
    if (qrWindow && !qrWindow.isDestroyed()) {
      qrWindow.show();
      qrWindow.focus();
      // 重新加载登录页
      qrWindow.loadURL(loginUrl);
    }
    if (!cookieCheckTimer && qrWindow && !qrWindow.isDestroyed()) {
      cookieCheckTimer = setInterval(() => {
        if (!qrWindow || qrWindow.isDestroyed()) {
          clearInterval(cookieCheckTimer);
          return;
        }
        ses.cookies.get({}).then((cookies) => {
          if (submitted) return;
          const cookieMap = {};
          for (const c of cookies) {
            if (c.domain && c.domain.includes("baidu.com")) {
              cookieMap[c.name] = c.value;
            }
          }
          const hasRequired = REQUIRED_COOKIES.every((n) => cookieMap[n]);
          if (!hasRequired) return;
          if (cookieMap["BDUSS"] && bdussSeenAt === 0) {
            bdussSeenAt = Date.now();
          }
          const hasConfirmed = CONFIRMED_COOKIES.some((n) => cookieMap[n]);
          const now = Date.now();
          const bdussAge = bdussSeenAt ? (now - bdussSeenAt) / 1000 : 0;
          if (hasConfirmed) {
            if (!candidateTimer) {
              candidateTimer = setTimeout(() => submitCandidateCookie(), 1200);
            }
          } else if (bdussSeenAt && bdussAge > 10) {
            if (!candidateTimer) {
              candidateTimer = setTimeout(() => submitCandidateCookie(), 1200);
            }
          }
        });
      }, 1000);
    }
  });

  qrWindow.on("closed", () => {
    if (cookieCheckTimer) { clearInterval(cookieCheckTimer); cookieCheckTimer = null; }
    if (candidateTimer) { clearTimeout(candidateTimer); candidateTimer = null; }
    qrWindow = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("qr-login-closed");
    }
  });

  return qrWindow;
}

// ========== 登出窗口 ==========

const LOGOUT_HOME_URL = "https://photo.baidu.com/photo/web/home";
const LOGOUT_COOKIE_URL = "https://photo.baidu.com/";
const LOGOUT_TIMEOUT_MS = 30 * 1000; // 30 秒超时

// CSS：隐藏百度相册页面所有内容
const LOGOUT_HIDE_CSS = `
  #app, #app > * { display: none !important; visibility: hidden !important; opacity: 0 !important; }
  body > *:not(#yike-logout-page) { display: none !important; }
  body { background: #f5f7fa !important; margin: 0 !important; padding: 0 !important; overflow: hidden !important; }
`;

// JS：注入自定义退出登录页面 + MutationObserver 持续维护
const LOGOUT_INJECT_JS = `
  (function() {
    function ensurePage() {
      var existing = document.getElementById('yike-logout-page');
      if (existing) return;
      var page = document.createElement('div');
      page.id = 'yike-logout-page';
      page.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#f5f7fa;font-family:"Microsoft YaHei","Segoe UI",sans-serif;z-index:999999;';
      var card = document.createElement('div');
      card.style.cssText = 'text-align:center;';
      var icon = document.createElement('div');
      icon.style.cssText = 'width:52px;height:52px;margin:0 auto 16px;border-radius:50%;background:#fee;display:flex;align-items:center;justify-content:center;font-size:28px;font-weight:700;color:#e53e3e;line-height:1;';
      icon.textContent = '!';
      var title = document.createElement('div');
      title.textContent = '退出百度账户';
      title.style.cssText = 'font-size:18px;font-weight:700;color:#2d3748;margin-bottom:8px;';
      var hint = document.createElement('div');
      hint.textContent = '点击下方按钮退出当前登录的百度账户，退出后需重新扫码登录。';
      hint.style.cssText = 'font-size:13px;color:#718096;margin-bottom:24px;line-height:1.6;max-width:280px;';
      var btnRow = document.createElement('div');
      btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';
      var btn = document.createElement('button');
      btn.id = 'yike-logout-btn';
      btn.textContent = '退出登录';
      btn.style.cssText = 'background:#e53e3e;color:#fff;border:none;border-radius:8px;padding:10px 28px;font-size:15px;font-weight:600;cursor:pointer;transition:background 0.2s;';
      btn.onmouseover = function() { btn.style.background = '#c53030'; };
      btn.onmouseout = function() { btn.style.background = '#e53e3e'; };
      var cancelBtn = document.createElement('button');
      cancelBtn.textContent = '取消';
      cancelBtn.style.cssText = 'background:#fff;color:#4a5568;border:1px solid #cbd5e0;border-radius:8px;padding:10px 28px;font-size:15px;font-weight:600;cursor:pointer;transition:all 0.2s;';
      cancelBtn.onmouseover = function() { cancelBtn.style.background = '#edf2f7'; cancelBtn.style.borderColor = '#a0aec0'; };
      cancelBtn.onmouseout = function() { cancelBtn.style.background = '#fff'; cancelBtn.style.borderColor = '#cbd5e0'; };
      cancelBtn.onclick = function() { window.close(); };
      btn.onclick = function() {
        btn.disabled = true;
        btn.textContent = '正在退出...';
        btn.style.background = '#a0aec0';
        function findLogoutItem() {
          var containers = document.querySelectorAll('.yk-header__popup--bottom');
          for (var i = 0; i < containers.length; i++) {
            var items = containers[i].querySelectorAll('.list-item');
            for (var j = 0; j < items.length; j++) {
              if (items[j].textContent.trim() === '退出登录') return items[j];
            }
          }
          var allItems = document.querySelectorAll('.list-item');
          for (var i = 0; i < allItems.length; i++) {
            if (allItems[i].textContent.trim() === '退出登录') return allItems[i];
          }
          return null;
        }
        function tryTriggerLogout() {
          var logoutItem = findLogoutItem();
          if (logoutItem) {
            var popover = logoutItem.closest('.yk-popover');
            if (popover) popover.style.setProperty('display', 'block', 'important');
            logoutItem.click();
            return true;
          }
          var selectors = ['.yk-header .user-info', '.yk-header [class*="avatar"]', '.yk-header [class*="user"]', '.yk-header__right', 'header [class*="user"]', 'header [class*="avatar"]'];
          for (var i = 0; i < selectors.length; i++) {
            var el = document.querySelector(selectors[i]);
            if (el) { el.click(); return false; }
          }
          return false;
        }
        var attempts = 0;
        function retry() {
          attempts++;
          if (attempts > 10) return;
          var ok = tryTriggerLogout();
          if (!ok) setTimeout(retry, 800);
        }
        retry();
      };
      btnRow.appendChild(btn);
      btnRow.appendChild(cancelBtn);
      card.appendChild(icon);
      card.appendChild(title);
      card.appendChild(hint);
      card.appendChild(btnRow);
      page.appendChild(card);
      document.body.appendChild(page);
    }
    // 立即注入
    ensurePage();
    // 持续监控：Vue 渲染可能移除自定义页面，每次 DOM 变化都重新确保
    var observer = new MutationObserver(function() {
      ensurePage();
      var app = document.getElementById('app');
      if (app && app.style.display !== 'none') {
        app.style.setProperty('display', 'none', 'important');
      }
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
  })();
`;

function createLogoutWindow(cookieJson) {
  return new Promise((resolve) => {
    if (logoutWindow && !logoutWindow.isDestroyed()) {
      logoutWindow.destroy();
    }

    log.debug("logout", `登出：准备注入 cookie，cookieJson 长度=${cookieJson ? cookieJson.length : 0}`);

    logoutWindow = new BrowserWindow({
      width: 400,
      height: 350,
      show: false,
      autoHideMenuBar: true,
      title: "注销",
      icon: path.join(__dirname, "assets", "yike_sync.ico"),
      resizable: false,
      minimizable: false,
      maximizable: false,
      alwaysOnTop: true,
      modal: false,
      parent: mainWindow || undefined,
      webPreferences: {
        partition: "logout",
        contextIsolation: true,
        nodeIntegration: false,
      },
    });

    // 防止页面 <title> 覆盖窗口标题
    logoutWindow.on("page-title-updated", (e) => e.preventDefault());

    const ses = logoutWindow.webContents.session;
    let logoutTimeoutTimer = null;
    let resolved = false;

    function finish(result) {
      if (resolved) return;
      resolved = true;
      if (logoutTimeoutTimer) { clearTimeout(logoutTimeoutTimer); logoutTimeoutTimer = null; }
      if (injectInterval) { clearInterval(injectInterval); injectInterval = null; }
      if (logoutWindow && !logoutWindow.isDestroyed()) {
        logoutWindow.destroy();
      }
      logoutWindow = null;
      log.debug("logout", `登出：结束，结果=${JSON.stringify(result)}`);
      resolve(result);
    }

    // 检测页面跳转到登录页 = 登出成功
    logoutWindow.webContents.on("did-navigate", (_e, url) => {
      log.debug("logout", `登出：页面导航到 ${url}`);
      if (url.includes("photo.baidu.com/photo/web/login")) {
        log.debug("login", "登出：已跳转到登录页，登出成功");
        finish({ success: true });
      }
    });
    // SPA 内部导航也可能跳到登录页
    logoutWindow.webContents.on("did-navigate-in-page", (_e, url) => {
      log.debug("logout", `登出：页面内导航到 ${url}`);
      if (url.includes("photo.baidu.com/photo/web/login")) {
        log.debug("login", "登出：SPA 内导航到登录页，登出成功");
        finish({ success: true });
      }
    });
    // 仅以“点击页面退出登录后自动跳转到登录页”作为登出成功的判定，
    // 不再监听 cookie 变化（避免 clearStorageData / 注入阶段误判 BDUSS 消失）。

    let injectInterval = null;

    function injectLogoutPage() {
      logoutWindow.webContents.insertCSS(LOGOUT_HIDE_CSS).catch(() => {});
      logoutWindow.webContents.executeJavaScript(LOGOUT_INJECT_JS).catch(() => {});
    }

    logoutWindow.webContents.on("dom-ready", () => {
      injectLogoutPage();
      // 每 200ms 重复注入，持续 5 秒，对抗 Vue 渲染
      let count = 0;
      injectInterval = setInterval(() => {
        if (!logoutWindow || logoutWindow.isDestroyed()) {
          clearInterval(injectInterval);
          return;
        }
        injectLogoutPage();
        if (++count >= 25) clearInterval(injectInterval);
      }, 200);
      if (logoutWindow && !logoutWindow.isDestroyed()) {
        logoutWindow.show();
      }
    });

    logoutWindow.webContents.on("did-finish-load", () => {
      const url = logoutWindow.webContents.getURL();
      log.debug("logout", `登出：页面加载完成，当前 URL=${url}`);
      if (url.includes("photo.baidu.com/photo/web/login")) {
        finish({ success: true });
        return;
      }
      injectLogoutPage();
    });

    logoutWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription) => {
      log.warn("logout", `登出：页面加载失败 ${errorCode} ${errorDescription}`);
    });

    // 用户主动关闭登出窗口（点 X 或取消）：必须结束流程，否则 Promise 永远不 resolve，
    // 渲染端 loggingOut 标志卡死，导致之后再也无法打开登出界面。
    logoutWindow.on("closed", () => {
      log.debug("logout", "登出：窗口被关闭（用户取消），结束流程");
      finish({ success: false, reason: "cancelled" });
    });

    async function startLogout() {
      // 先清除 logout partition 的残留存储，避免上次 cookie 干扰
      await ses.clearStorageData().catch(() => {});
      // 注入当前 cookie
      try {
        const cookies = JSON.parse(cookieJson);
        log.debug("logout", `登出：解析到 ${cookies.length} 个 cookie`);
        const setPromises = [];
        for (const c of cookies) {
          if (!c.name || !c.value) continue;
          const domain = c.domain || ".baidu.com";
          if (!isBaiduDomain(domain)) continue;
          setPromises.push(
            ses.cookies.set({
              name: c.name,
              value: c.value,
              domain: domain.startsWith(".") ? domain : "." + domain,
              path: c.path || "/",
              url: LOGOUT_COOKIE_URL,
              secure: c.secure != null ? c.secure : false,
              httpOnly: c.httpOnly != null ? c.httpOnly : false,
            }).catch(() => {})
          );
        }
        await Promise.all(setPromises);
        log.debug("logout", "登出：cookie 注入完成");
      } catch (err) {
        log.warn("logout", "登出：cookie 注入失败:", err.message || err);
      }

      // 确认 BDUSS 已注入
      const injected = await ses.cookies.get({});
      const bdussInjected = injected.find(
        (c) => c.name === "BDUSS" && c.domain && c.domain.includes("baidu.com")
      );
      if (!bdussInjected) {
        log.warn("logout", "登出：BDUSS cookie 未成功注入，无法登出");
        finish({ success: false, reason: "no_bduss" });
        return;
      }
      log.debug("logout", "登出：BDUSS cookie 已确认注入");

      // 加载百度相册首页，等待用户点击“退出登录”后页面自动跳转到登录页
      log.debug("logout", `登出：加载 ${LOGOUT_HOME_URL}`);
      logoutWindow.loadURL(LOGOUT_HOME_URL);

      // 30 秒超时（用户未点击退出或跳转未触发）
      logoutTimeoutTimer = setTimeout(() => {
        log.warn("login", "登出：超时，未跳转到登录页");
        finish({ success: false, reason: "timeout" });
      }, LOGOUT_TIMEOUT_MS);
    }

    startLogout();
  });
}

// ========== 设置窗口 ==========

function createSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }

  settingsWindow = new BrowserWindow({
    width: 840,
    height: 560,
    minWidth: 720,
    minHeight: 480,
    resizable: true,
    minimizable: false,
    maximizable: false,
    title: "高级同步设置",
    icon: path.join(__dirname, "assets", "yike_sync.ico"),
    parent: mainWindow,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWindow.loadFile(path.join(RENDERER, "settings.html"));

  settingsWindow.on("closed", () => {
    // 设置窗口关闭时自动取消正在进行的 FFmpeg 下载
    if (ffmpegDownloadController) {
      ffmpegDownloadController.abort();
      ffmpegDownloadController = null;
    }
    settingsWindow = null;
  });
}

// ========== 同步结果窗口 ==========

function createSyncResultWindow(data) {
  if (syncResultWindow && !syncResultWindow.isDestroyed()) {
    syncResultWindow.destroy();
  }

  syncResultWindow = new BrowserWindow({
    width: 680,
    height: 520,
    minWidth: 500,
    minHeight: 360,
    resizable: true,
    minimizable: false,
    title: "同步结果",
    icon: path.join(__dirname, "assets", "yike_sync.ico"),
    parent: mainWindow,
    modal: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 先存储数据，等窗口 ready 后发送
  const pendingData = data;

  syncResultWindow.webContents.on("dom-ready", () => {
    syncResultWindow.webContents.send("sync-result:data", pendingData);
  });

  syncResultWindow.loadFile(path.join(RENDERER, "sync-result.html"));

  syncResultWindow.on("closed", () => {
    syncResultWindow = null;
  });
}

// ========== IPC 方法分发器 ==========

/**
 * 统一的 bridge:call 处理器。
 * 渲染进程调用 window.api.call(method, params)，映射到这里的 Node.js 方法。
 * 返回值直接通过 Promise resolve/reject 传回。
 */
async function handleMethod(method, params, sender) {
  // ---- Session & settings ----

  if (method === "get_session") {
    return { cookie: sessionStore.load() };
  }

  if (method === "save_session") {
    sessionStore.save(params.cookie_text || "");
    return { saved: true };
  }

  if (method === "clear_session") {
    sessionStore.clear();
    return { cleared: true };
  }

  if (method === "get_settings") {
    return settings;
  }

  if (method === "save_settings") {
    const oldEnhancedKeepalive = settings.enhanced_keepalive === true || settings.enhanced_keepalive === "true";
    Object.assign(settings, params);
    saveSettings(settings);
    const cacheMib = parseInt(
      params.download_cache_mib || settings.download_cache_mib || DOWNLOAD_CACHE_DEFAULT_MIB,
      10
    );
    downloadCache.maxBytes = cacheMib * MIB;

    // 如果增强防掉线设置发生变化，实时更新保活窗口
    const newEnhancedKeepalive = params.enhanced_keepalive === true || params.enhanced_keepalive === "true";
    if (oldEnhancedKeepalive !== newEnhancedKeepalive && keepaliveWindow) {
      setKeepaliveEnhanced(newEnhancedKeepalive);
    }

    return { saved: true };
  }

  if (method === "clear_windows_registry") {
    clear_windows_registry_settings();
    return { done: true };
  }

   if (method === "reset_application") {
    stopKeepalive();
    if (syncWorker) {
      syncWorker.terminate();
      syncWorker = null;
    }
    // 清空各命名 partition 的百度 Cookie，避免重置后仍残留会话凭据
    await clearPartitionCookies("keepalive");
    await clearPartitionCookies("qr-login");
    await clearPartitionCookies("logout");
    remove_application_data();
    try { fs.unlinkSync(path.join(ROOT, "error.log")); } catch {}
    sessionStore.clear();
    client = null;
    cookieText = "";
    syncActions = [];
    syncEngine = null;
    syncControl = null;
    return { done: true };
  }

  if (method === "open_system_viewer") {
    const { open_system_viewer } = require("./src/platform_services");
    open_system_viewer(params.path || "");
    return { opened: true };
  }

  // ---- Download cache ----

  if (method === "get_cache_info") {
    return {
      size_bytes: downloadCache.size_bytes(),
      max_bytes: downloadCache.maxBytes,
    };
  }

  if (method === "clear_download_cache") {
    return { reclaimed: downloadCache.clear() };
  }

  if (method === "enforce_cache_limit") {
    const cacheMib = parseInt(params.mib || DOWNLOAD_CACHE_DEFAULT_MIB, 10);
    return { reclaimed: downloadCache.enforce_limit(cacheMib * MIB) };
  }

  // ---- Login / connection ----

  if (method === "connect") {
    const ct = params.cookie_text || "";
    const maxRetries = 8;
    let lastErr = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // 每次校验都优先使用 QR 登录窗口“活体”会话里的最新 Cookie
      // （对齐 Python：_start_qr_login_validation 每次都从 webview 重新读取 cookie_text，
      // 避免拿到扫码瞬间下发的临时 BDUSS / 不完整的 Cookie 导致 errno -6 后死循环）。
      // 仅当 QR 窗口已关闭时才退回使用最初传入的快照。
      let useCookie = ct;
      if (qrWindow && !qrWindow.isDestroyed()) {
        try {
          const live = await qrWindow.webContents.session.cookies.get({});
          const baiduCookies = live
            .filter((c) => c.domain && c.domain.includes("baidu.com"))
            .map((c) => ({ name: c.name, value: c.value, domain: c.domain }));
          const hasRequired = baiduCookies.some((c) => c.name === "BAIDUID") && baiduCookies.some((c) => c.name === "BDUSS");
          if (hasRequired) useCookie = JSON.stringify(baiduCookies);
        } catch { /* 读取失败则继续使用原始快照 */ }
      }
      try {
        const newClient = new YikeRemoteClient(useCookie);
        await newClient.verifyLogin();
        client = newClient;
        cookieText = useCookie;
        if (params.save) {
          sessionStore.save(useCookie);
        }
        // 启动会话保活：创建隐藏窗口加载百度相册页面
        const enhancedKeepalive = settings.enhanced_keepalive === true || settings.enhanced_keepalive === "true";
        startKeepalive(useCookie, enhancedKeepalive);
        return { connected: true };
      } catch (err) {
        lastErr = err;
        log.warn("connect", `connect 第 ${attempt}/${maxRetries} 次失败：${err.message || err}`);
        if (attempt < maxRetries) {
          // 递增延迟：900ms, 1550ms, 2200ms, 2850ms, 3500ms, 4150ms, 4800ms（封顶 5000ms）
          const delay = Math.min(5000, 900 + (attempt - 1) * 650);
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    throw new Error(lastErr ? lastErr.message || String(lastErr) : "连接失败");
  }

  if (method === "is_connected") {
    return { connected: client !== null };
  }

  if (method === "disconnect") {
    stopKeepalive();
    if (syncWorker) {
      syncWorker.postMessage({ type: "control", command: "stop" });
      syncWorker.terminate();
      syncWorker = null;
    }
    client = null;
    cookieText = "";
    syncActions = [];
    syncEngine = null;
    syncControl = null;
    return { disconnected: true };
  }

  // ---- Album operations ----

  if (method === "list_albums") {
    if (!client) throw new Error("未登录");
    const albums = await client.listAlbums(params.force_refresh || false);
    return albums.map(albumToDict);
  }

  if (method === "list_media") {
    if (!client) throw new Error("未登录");
    const media = await client.listMedia(params.album_id || "");
    return media.map(mediaToDict);
  }

  if (method === "create_album") {
    if (!client) throw new Error("未登录");
    const album = await client.createAlbum(params.title || "");
    return albumToDict(album);
  }

  if (method === "rename_album") {
    if (!client) throw new Error("未登录");
    await client.renameAlbum(params.album_id || "", params.title || "");
    return { done: true };
  }

  if (method === "delete_album") {
    if (!client) throw new Error("未登录");
    await client.deleteAlbum(params.album_id || "", params.delete_items || false);
    return { done: true };
  }

  if (method === "upload_media") {
    if (!client) throw new Error("未登录");
    const albumId = params.album_id || "";
    const paths = params.paths || [];
    await client.uploadFiles(albumId, paths, (value, text) => {
      if (sender && !sender.isDestroyed()) {
        sender.send("bridge:progress", value, text);
      }
    });
    return { done: true };
  }

  if (method === "download_media") {
    if (!client) throw new Error("未登录");
    const resultPath = await client.downloadMedia(
      params.album_id || "",
      params.fsid || "",
      params.target_directory || ""
    );
    return { path: resultPath };
  }

  if (method === "prepare_drag_download") {
    if (!client) throw new Error("未登录");
    const items = Array.isArray(params.items) ? params.items : [];
    if (items.length === 0) throw new Error("未选择文件");
    const paths = [];
    let done = 0;
    for (const item of items) {
      if (sender && !sender.isDestroyed()) {
        sender.send("bridge:progress", Math.round((done / items.length) * 100), `正在下载 ${done + 1}/${items.length}`);
      }
      const p = await downloadForDrag(item.album_id || "", item.fsid || "");
      paths.push({ name: item.name, path: p });
      done++;
    }
    if (sender && !sender.isDestroyed()) {
      sender.send("bridge:progress", 100, `已准备 ${paths.length} 个文件`);
    }
    return { files: paths };
  }

  if (method === "download_media_cached") {
    if (!client) throw new Error("未登录");
    const albumId = params.album_id || "";
    const fsid = params.fsid || "";
    const expectedSize = parseInt(params.expected_size || 0, 10);
    const variant = params.variant || "original";
    const url = params.url || "";

    if (variant === "thumbnail") {
      const downloader = async (cacheDir) => {
        const target = path.join(cacheDir, "thumbnail.jpg");
        const resp = await fetch(url, {
          headers: { "User-Agent": "BaiduPhotoSync/2.0" },
          signal: AbortSignal.timeout(20000),
        });
        const buffer = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(target, buffer);
        return target;
      };
      const result = await downloadCache.get_or_download(albumId, fsid, expectedSize, downloader, "thumbnail");
      return { path: result.path, hit: result.hit };
    }
    throw new Error("Not implemented");
  }

  if (method === "delete_media") {
    if (!client) throw new Error("未登录");
    await client.deleteMedia(params.album_id || "", params.fsid || "");
    return { done: true };
  }

  // ---- Sync engine ----

  if (method === "build_plan") {
    if (!client) throw new Error("未登录");
    const taskId = ++syncTaskId;
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(SRC, "sync_worker.js"), {
        workerData: null,
      });
      syncWorker = worker;

      worker.on("message", (msg) => {
        if (msg.id !== taskId) return;
        if (msg.type === "progress") {
          if (sender && !sender.isDestroyed()) {
            sender.send("bridge:progress", msg.value, msg.text);
          }
        } else if (msg.type === "complete") {
          syncActions = msg.actions;
          syncWorker = null;
          worker.terminate();
          resolve(msg.actions);
        } else if (msg.type === "error") {
          syncWorker = null;
          worker.terminate();
          reject(new Error(msg.message));
        }
      });

      worker.on("error", (err) => {
        syncWorker = null;
        reject(err);
      });

      worker.postMessage({
        type: "build_plan",
        id: taskId,
        clientCookie: cookieText,
        options: {
          root: params.root || "",
          direction: params.direction || SyncDirection.LOCAL_TO_REMOTE,
          sort_field: params.sort_field || SortField.NAME,
          reverse: Boolean(params.reverse),
          enable_deletions: Boolean(params.enable_deletions),
          ignored_album_names: params.ignored_album_names || [],
          skip_oversize: Boolean(params.skip_oversize),
          compare_mode: params.compare_mode || FileCompareMode.SMART,
          compress_oversize_videos: Boolean(params.compress_oversize_videos),
          max_workers: parseInt(params.max_workers || 4, 10),
          download_workers: parseInt(params.download_workers || 4, 10),
          list_threads: parseInt(params.list_threads || 8, 10),
        },
      });
    });
  }

  if (method === "execute_plan") {
    if (syncActions.length === 0) {
      throw new Error("尚未生成同步计划");
    }
    const root = params.root || "";
    const taskId = ++syncTaskId;
    const control = new SyncControl();
    syncControl = control;

    const worker = new Worker(path.join(SRC, "sync_worker.js"), {
      workerData: null,
    });
    syncWorker = worker;

    worker.on("message", (msg) => {
      if (msg.id !== taskId) return;
      if (msg.type === "progress") {
        if (sender && !sender.isDestroyed()) {
          sender.send("bridge:progress", msg.value, msg.text);
        }
      } else if (msg.type === "status") {
        if (sender && !sender.isDestroyed()) {
          sender.send("bridge:status", msg.sequence, msg.text);
        }
      } else if (msg.type === "alert") {
        if (sender && !sender.isDestroyed()) {
          sender.send("bridge:alert", msg.message);
        }
      } else if (msg.type === "complete") {
        syncWorker = null;
        syncControl = null;
        worker.terminate();
        if (sender && !sender.isDestroyed()) {
          sender.send("bridge:execute-complete", msg.actions);
        }
      } else if (msg.type === "error") {
        syncWorker = null;
        syncControl = null;
        worker.terminate();
        if (sender && !sender.isDestroyed()) {
          sender.send("bridge:execute-error", msg.message);
        }
      }
    });

    worker.on("error", (err) => {
      syncWorker = null;
      syncControl = null;
      if (sender && !sender.isDestroyed()) {
        sender.send("bridge:execute-error", err.message || String(err));
      }
    });

    worker.postMessage({
      type: "execute_plan",
      id: taskId,
      clientCookie: cookieText,
      actions: syncActions,
      root: root,
      options: {
        compare_mode: params.compare_mode || FileCompareMode.SMART,
        compress_oversize_videos: Boolean(params.compress_oversize_videos),
        max_workers: parseInt(params.max_workers || 4, 10),
        download_workers: parseInt(params.download_workers || 4, 10),
        list_threads: parseInt(params.list_threads || 8, 10),
      },
    });

    return { started: true };
  }

  if (method === "pause_sync") {
    if (syncControl) syncControl.pause();
    if (syncWorker) syncWorker.postMessage({ type: "control", command: "pause" });
    return { paused: true };
  }

  if (method === "resume_sync") {
    if (syncControl) syncControl.resume();
    if (syncWorker) syncWorker.postMessage({ type: "control", command: "resume" });
    return { resumed: true };
  }

  if (method === "stop_sync") {
    if (syncControl) syncControl.stop();
    if (syncWorker) syncWorker.postMessage({ type: "control", command: "stop" });
    return { stopped: true };
  }

  if (method === "sync_state") {
    if (syncControl) {
      return { stopped: syncControl.stopped, paused: syncControl.paused };
    }
    return { stopped: false, paused: false, idle: true };
  }

  // ---- FFmpeg ----

  if (method === "check_ffmpeg") {
    try {
      locate_ffmpeg();
      return { available: true };
    } catch {
      return { available: false };
    }
  }

  if (method === "download_ffmpeg") {
    try {
      // 下载源：official（官方）或 mirror（国内镜像）
      const source = params.source === SOURCES.MIRROR ? SOURCES.MIRROR : SOURCES.OFFICIAL;
      // 为本次下载创建取消控制器，保存到模块级变量以支持外部取消
      ffmpegDownloadController = new AbortController();
      const result = await ensure_windows_ffmpeg((value, text) => {
        if (sender && !sender.isDestroyed()) {
          sender.send("bridge:progress", value, text);
        }
      }, source, ffmpegDownloadController.signal);
      return {
        downloaded: result.downloaded,
        source: source === SOURCES.MIRROR ? "mirror" : "official",
        ffmpeg_path: result.ffmpegPath,
        ffprobe_path: result.ffprobePath,
      };
    } catch (err) {
      // 用户取消时不作为错误抛出，返回 cancelled 标记
      if (err.cancelled) return { cancelled: true };
      throw new Error(err.message || String(err));
    } finally {
      ffmpegDownloadController = null;
    }
  }

  if (method === "cancel_ffmpeg") {
    if (ffmpegDownloadController) {
      ffmpegDownloadController.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  }

  // ---- Misc ----

  if (method === "scan_local") {
    const root = params.root || "";
    const taskId = ++syncTaskId;
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(SRC, "sync_worker.js"), {
        workerData: null,
      });

      worker.on("message", (msg) => {
        if (msg.id !== taskId) return;
        if (msg.type === "complete") {
          worker.terminate();
          resolve(msg.folders);
        } else if (msg.type === "error") {
          worker.terminate();
          reject(new Error(msg.message));
        }
      });

      worker.on("error", (err) => {
        reject(err);
      });

      worker.postMessage({
        type: "scan_local",
        id: taskId,
        root: root,
      });
    });
  }

  if (method === "media_validate") {
    const [isMedia, message] = validate_media_file(params.path || "");
    return { is_media: isMedia, message };
  }

  if (method === "free_user_size") {
    const msg = free_user_size_message(params.path || "", parseInt(params.size || 0, 10) || null);
    return { message: msg };
  }

  if (method === "export_cookie_json") {
    if (!client) throw new Error("未登录");
    return { cookie_json: client.exportCookieJson() };
  }

  throw new Error(`未知方法: ${method}`);
}

// ========== IPC 注册 ==========

ipcMain.handle("bridge:call", async (event, method, params) => {
  try {
    return await handleMethod(method, params || {}, event.sender);
  } catch (err) {
    log.error("bridge", `[bridge:call] ${method} 失败:`, err.message || err);
    throw err;
  }
});

ipcMain.handle("qr-login:open", async () => {
  // 清除 qr-login partition 的所有存储，确保新 QR 窗口是干净的
  // 只影响 qr-login 独立 partition，不影响主应用的 cookie
  const qrSes = session.fromPartition("qr-login");
  await qrSes.clearStorageData().catch(() => {});
  createQRLoginWindow();
});

// ========== 登出 IPC ==========

ipcMain.handle("logout:start", async () => {
  if (!client) return { success: false, reason: "no_client" };
  // 用 client 内部最新 cookie，而非全局 cookieText（对齐 Python export_cookie_json）
  const currentCookieJson = client.exportCookieJson();
  if (!currentCookieJson) return { success: false, reason: "no_session" };
  // 不提前 stopKeepalive，等用户确认登出成功后才停止
  const result = await createLogoutWindow(currentCookieJson);
  if (result.success) {
    // 登出成功：彻底清理本地凭据，避免残留 Cookie 导致下次启动又被“自动登录”。
    // - 停止保活并清空 keepalive partition 的百度 Cookie
    // - 清空本次登出窗口所在 partition 的百度 Cookie
    // - 清除持久化的会话存储（对齐 Python 版：profile 销毁即 Cookie 消失）
    stopKeepalive();
    await clearPartitionCookies("logout");
    sessionStore.clear();
    client = null;
    cookieText = "";
  }
  return result;
});

// ========== 设置窗口 IPC ==========

ipcMain.handle("settings:open", () => {
  createSettingsWindow();
});

// 设置窗口保存后通知主窗口
ipcMain.on("settings:saved-notify", (event, savedSettings) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("settings-saved", savedSettings);
  }
  // 关闭设置窗口
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.close();
  }
});

// ========== 同步结果窗口 IPC ==========

ipcMain.handle("sync-result:open", (event, data) => {
  createSyncResultWindow(data);
});

ipcMain.handle("dialog:openDirectory", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle("dialog:openFiles", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: [
      {
        name: "所有支持的媒体文件",
        extensions: [
          "jpg","jpeg","png","gif","webp","heic","bmp","tif","tiff",
          "mp4","mov","avi","mkv","wmv","flv","webm","3gp",
        ],
      },
      { name: "图片文件", extensions: ["jpg","jpeg","png","gif","webp","heic","bmp","tif","tiff"] },
      { name: "视频文件", extensions: ["mp4","mov","avi","mkv","wmv","flv","webm","3gp"] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle("shell:openPath", (event, filePath) => {
  shell.openPath(filePath);
});

ipcMain.handle("clipboard:readText", async () => {
  const { clipboard } = require("electron");
  return clipboard.readText();
});

// ========== 拖拽下载 ==========

// 拖出下载的临时目录
function dragDownloadDirectory() {
  return path.join(os.tmpdir(), "yike-sync-drag");
}

/**
 * 下载媒体到拖拽临时目录（文件名冲突时自动追加序号）。
 * @returns {Promise<string>} 下载后的文件路径
 */
async function downloadForDrag(albumId, fsid) {
  if (!client) throw new Error("未登录");
  const dir = dragDownloadDirectory();
  const result = await client.downloadMediaTo(albumId, fsid, dir);
  return result;
}

// 渲染进程在 dragstart 内调用，启动系统文件拖拽（异步 send，对齐官方文档）
ipcMain.on("drag:start-drag", (event, paths) => {
  const list = Array.isArray(paths) ? paths : [];
  if (list.length === 0) return;
  const icon = path.join(__dirname, "assets", "yike_sync_256.png");
  try {
    event.sender.startDrag({
      files: list,
      icon,
    });
    // 延迟清理临时文件（拖拽会话结束后）
    setTimeout(() => {
      for (const p of list) {
        try { fs.unlinkSync(p); } catch {}
      }
    }, 5000);
  } catch (err) {
    log.warn("drag", "startDrag 失败:", err.message || err);
  }
});

// ========== App 生命周期 ==========

app.whenReady().then(() => {
  // 初始化后端状态
  sessionStore = new SessionStore(require("electron").safeStorage);
  settings = loadSettings();
  const cacheMib = parseInt(settings.download_cache_mib || DOWNLOAD_CACHE_DEFAULT_MIB, 10);
  downloadCache = new DownloadCache(downloadCacheDirectory(), cacheMib * MIB);

  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("before-quit", () => {
  stopKeepalive();
});

app.on("window-all-closed", () => {
  stopKeepalive();
  app.quit();
});
