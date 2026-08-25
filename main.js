"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell, session } = require("electron");
const path = require("path");
const fs = require("fs");
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
const { FFmpegDownloadError, ensure_windows_ffmpeg } = require("./src/ffmpeg_downloader");
const { app_data_directory, clear_windows_registry_settings, remove_application_data } = require("./src/platform_services");
const { validate_media_file, free_user_size_message } = require("./src/media_validation");

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

async function startKeepalive(cookieJson, enhanced) {
  stopKeepalive();
  if (!cookieJson) return;

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
    console.debug("会话保活页面加载完成，正在检查 Cookie 更新。");
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
    console.warn(`会话保活页面加载失败: ${errorCode} ${errorDescription}`);
  });

  // cookie 注入完成后立即加载页面
  keepaliveRefreshInFlight = true;
  keepaliveWindow.loadURL(KEEPALIVE_URL);

  // 增强模式：每 3 分钟刷新页面
  if (keepaliveEnhanced) {
    keepaliveTimer = setInterval(() => {
      if (keepaliveWindow && !keepaliveWindow.isDestroyed() && !keepaliveRefreshInFlight) {
        console.debug("会话保活：正在刷新隐藏页面（增强模式）");
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

  console.debug(`会话保活已启动：隐藏页面=${KEEPALIVE_URL}，增强定时刷新=${keepaliveEnhanced ? "启用（每3分钟）" : "关闭"}`);
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
      // 用刷新后的 cookie 重建活跃 client，确保后续 API 调用使用最新会话
      if (client) {
        try {
          const newClient = new YikeRemoteClient(cookieJson);
          client = newClient;
          console.debug("会话保活检测到 Cookie 更新，已重建活跃 client 实例");
        } catch (err) {
          console.warn("会话保活 cookie 刷新后重建 client 失败:", err.message || err);
        }
      } else {
        console.debug("会话保活检测到 Cookie 更新，已保存刷新后的会话");
      }
    }
  }).catch(() => {});
}

function stopKeepalive() {
  keepaliveActive = false;
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
        console.debug("会话保活：正在刷新隐藏页面（增强模式）");
        keepaliveRefreshInFlight = true;
        keepaliveWindow.loadURL(KEEPALIVE_URL);
      }
    }, KEEPALIVE_INTERVAL_MS);
    console.debug("账号增强防掉线已启用：每 3 分钟刷新隐藏页面。");
  } else {
    console.debug("账号增强防掉线已关闭：隐藏页面仅由自身 JavaScript 维持会话。");
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
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 880,
    minWidth: 880,
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
  });

  mainWindow.loadFile(path.join(RENDERER, "index.html"));

  // 主窗口在 ready-to-show 时显示，但 loading overlay 会覆盖整个窗口
  // 直到登录完成才隐藏 overlay
  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("close", (e) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
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
    width: 370,
    height: 520,
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

  // 注入 CSS：隐藏百度页面多余内容，只显示登录弹窗
  const LOGIN_HIDE_CSS = `
    .header, .flastupload-guide, .box, .features, .box-mark1, .box-mark2, .box-desc1, .box-desc2 { display: none !important; }
    .main { background: #ffffff !important; height: 100% !important; padding: 0 !important; margin: 0 !important; }
    .login-pop {
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      right: 0 !important;
      bottom: 0 !important;
      width: 100% !important;
      height: 100% !important;
      transform: none !important;
      margin: 0 !important;
      padding: 0 !important;
      border-radius: 0 !important;
      box-shadow: none !important;
      border: none !important;
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
    console.debug(`登录：页面即将跳转 → ${url}`);
    if (!url.includes("/login")) onLoginNavigated();
  });
  qrWindow.webContents.on("did-navigate", (_e, url) => {
    console.debug(`登录：页面已跳转 → ${url}`);
    if (!url.includes("/login")) onLoginNavigated();
  });
  qrWindow.webContents.on("did-navigate-in-page", (_e, url) => {
    // SPA 内部跳转也可能是登录成功后的路由变化
    if (url.includes("photo.baidu.com/photo/web/") && !url.includes("/login")) {
      console.debug(`登录：SPA 内部跳转 → ${url}`);
      onLoginNavigated();
    }
  });

  const ses = qrWindow.webContents.session;
  const REQUIRED_COOKIES = ["BAIDUID", "BDUSS"];
  const CONFIRMED_COOKIES = ["STOKEN", "PTOKEN", "PANWEB", "PANWEB.sig"];

  let bdussSeenAt = 0;        // BDUSS 首次出现的时间戳
  let candidateTimer = null;  // 延迟提交定时器
  let submitted = false;       // 是否已提交候选 cookie
  let cookieCheckTimer = null; // cookie 轮询定时器

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

      const hasConfirmed = CONFIRMED_COOKIES.some((n) => cookieMap[n]);
      const now = Date.now();
      const bdussAge = bdussSeenAt ? (now - bdussSeenAt) / 1000 : 0;

      if (hasConfirmed) {
        // 确认态 cookie 出现，延迟 1200ms 提交（等 cookie 完全传播）
        if (!candidateTimer) {
          candidateTimer = setTimeout(() => {
            submitCandidateCookie();
          }, 1200);
        }
      } else if (bdussSeenAt && bdussAge > 10) {
        // BDUSS 出现超过 10 秒，安全网：即使没有确认态 cookie 也提交
        if (!candidateTimer) {
          candidateTimer = setTimeout(() => {
            submitCandidateCookie();
          }, 1200);
        }
      }
    });
  }, 1000);

  function submitCandidateCookie() {
    if (submitted || !qrWindow || qrWindow.isDestroyed()) return;
    submitted = true;
    clearInterval(cookieCheckTimer);
    cookieCheckTimer = null;

    // 确保已隐藏 qrWindow 并显示 loading
    onLoginNavigated();

    // 后台提取 cookie（qrWindow 虽隐藏但 webContents 仍在运行）
    ses.cookies.get({}).then((cookies) => {
      const cookieJson = JSON.stringify(
        cookies
          .filter((c) => c.domain && c.domain.includes("baidu.com"))
          .map((c) => ({ name: c.name, value: c.value, domain: c.domain }))
      );
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("qr-login-cookie", cookieJson);
      }
      // 不关闭 qrWindow，等渲染进程验证成功后再关闭
    }).catch(() => {
      submitted = false; // 允许重试
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
      card.style.cssText = 'background:#fff;border-radius:12px;padding:40px 48px;box-shadow:0 2px 16px rgba(0,0,0,0.08);text-align:center;';
      var icon = document.createElement('div');
      icon.style.cssText = 'width:48px;height:48px;margin:0 auto 16px;border-radius:50%;background:#fee;display:flex;align-items:center;justify-content:center;font-size:24px;color:#e53e3e;';
      icon.textContent = '\\u21A2';
      var title = document.createElement('div');
      title.textContent = '退出百度账户';
      title.style.cssText = 'font-size:18px;font-weight:700;color:#2d3748;margin-bottom:8px;';
      var hint = document.createElement('div');
      hint.textContent = '点击下方按钮退出当前登录的百度账户，退出后需重新扫码登录。';
      hint.style.cssText = 'font-size:13px;color:#718096;margin-bottom:24px;line-height:1.6;max-width:280px;';
      var btn = document.createElement('button');
      btn.id = 'yike-logout-btn';
      btn.textContent = '退出登录';
      btn.style.cssText = 'background:#e53e3e;color:#fff;border:none;border-radius:8px;padding:10px 32px;font-size:15px;font-weight:600;cursor:pointer;transition:background 0.2s;';
      btn.onmouseover = function() { btn.style.background = '#c53030'; };
      btn.onmouseout = function() { btn.style.background = '#e53e3e'; };
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
      card.appendChild(icon);
      card.appendChild(title);
      card.appendChild(hint);
      card.appendChild(btn);
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

    console.debug(`登出：准备注入 cookie，cookieJson 长度=${cookieJson ? cookieJson.length : 0}`);

    logoutWindow = new BrowserWindow({
      width: 400,
      height: 350,
      show: false,
      autoHideMenuBar: true,
      title: "退出",
      icon: path.join(__dirname, "assets", "yike_sync.ico"),
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
      console.debug(`登出：结束，结果=${JSON.stringify(result)}`);
      resolve(result);
    }

    // 检测页面跳转到登录页 = 登出成功
    logoutWindow.webContents.on("did-navigate", (_e, url) => {
      console.debug(`登出：页面导航到 ${url}`);
      if (url.includes("photo.baidu.com/photo/web/login")) {
        console.debug("登出：已跳转到登录页，登出成功");
        finish({ success: true });
      }
    });
    // SPA 内部导航也可能跳到登录页
    logoutWindow.webContents.on("did-navigate-in-page", (_e, url) => {
      console.debug(`登出：页面内导航到 ${url}`);
      if (url.includes("photo.baidu.com/photo/web/login")) {
        console.debug("登出：SPA 内导航到登录页，登出成功");
        finish({ success: true });
      }
    });
    // BDUSS cookie 被移除 = 登出成功（对齐 Python 版检测逻辑）
    ses.cookies.on("changed", (_e, cookie, cause, removed) => {
      if (cookie.name === "BDUSS" && removed) {
        console.debug("登出：BDUSS cookie 已被移除，登出成功");
        finish({ success: true });
      }
    });

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
      console.debug(`登出：页面加载完成，当前 URL=${url}`);
      if (url.includes("photo.baidu.com/photo/web/login")) {
        finish({ success: true });
        return;
      }
      injectLogoutPage();
    });

    logoutWindow.webContents.on("did-fail-load", (_e, errorCode, errorDescription) => {
      console.warn(`登出：页面加载失败 ${errorCode} ${errorDescription}`);
    });

    async function startLogout() {
      // 注入当前 cookie
      try {
        const cookies = JSON.parse(cookieJson);
        console.debug(`登出：解析到 ${cookies.length} 个 cookie`);
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
        console.debug("登出：cookie 注入完成");
      } catch (err) {
        console.warn("登出：cookie 注入失败:", err.message || err);
      }

      // 确认 BDUSS 已注入
      const injected = await ses.cookies.get({});
      const bdussInjected = injected.find(
        (c) => c.name === "BDUSS" && c.domain && c.domain.includes("baidu.com")
      );
      if (!bdussInjected) {
        console.warn("登出：BDUSS cookie 未成功注入，无法登出");
        finish({ success: false, reason: "no_bduss" });
        return;
      }
      console.debug("登出：BDUSS cookie 已确认注入");

      // 加载百度相册首页
      console.debug(`登出：加载 ${LOGOUT_HOME_URL}`);
      logoutWindow.loadURL(LOGOUT_HOME_URL);

      // 30 秒超时
      logoutTimeoutTimer = setTimeout(() => {
        console.warn("登出：超时，未跳转到登录页");
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
      try {
        const newClient = new YikeRemoteClient(ct);
        await newClient.verifyLogin();
        client = newClient;
        cookieText = ct;
        if (params.save) {
          sessionStore.save(ct);
        }
        // 启动会话保活：创建隐藏窗口加载百度相册页面
        const enhancedKeepalive = settings.enhanced_keepalive === true || settings.enhanced_keepalive === "true";
        startKeepalive(ct, enhancedKeepalive);
        return { connected: true };
      } catch (err) {
        lastErr = err;
        console.warn(`connect 第 ${attempt}/${maxRetries} 次失败：${err.message || err}`);
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
      const result = await ensure_windows_ffmpeg((value, text) => {
        if (sender && !sender.isDestroyed()) {
          sender.send("bridge:progress", value, text);
        }
      });
      return {
        downloaded: result.downloaded,
        ffmpeg_path: result.ffmpegPath,
        ffprobe_path: result.ffprobePath,
      };
    } catch (err) {
      throw new Error(err.message || String(err));
    }
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
    console.error(`[bridge:call] ${method} 失败:`, err.message || err);
    throw err;
  }
});

ipcMain.handle("qr-login:open", async () => {
  // 清除 qr-login partition 的 cookie，确保新 QR 窗口是干净的（防止登出后旧 cookie 残留）
  const qrSes = session.fromPartition("partition:qr-login");
  await qrSes.clearStorageData({ storages: ["cookies"] }).catch(() => {});
  createQRLoginWindow();
});

// ========== 登出 IPC ==========

ipcMain.handle("logout:start", async () => {
  if (!client) return { success: false, reason: "no_client" };
  // 用 client 内部最新 cookie，而非全局 cookieText（对齐 Python export_cookie_json）
  const currentCookieJson = client.exportCookieJson();
  if (!currentCookieJson) return { success: false, reason: "no_session" };
  stopKeepalive();
  const result = await createLogoutWindow(currentCookieJson);
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
