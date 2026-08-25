"use strict";

// === 一刻相册同步助手 - Electron 渲染进程逻辑（全新 UI） ===

const PHOTO_EXTS = [".jpg",".jpeg",".png",".gif",".webp",".heic",".bmp",".tif",".tiff"];
const VIDEO_EXTS = [".mp4",".mov",".avi",".mkv",".wmv",".flv",".webm",".3gp"];

// --- State ---
const state = {
  connected: false,
  albums: [],
  currentAlbum: null,
  currentMedia: [],
  syncActions: [],
  syncMode: "idle",
  syncFinishedSequences: new Set(),
  syncExecutableTotal: 0,
  syncStartedAt: null,
  ignoredAlbumNames: new Set(),
  settings: {},
  thumbnailLoadInProgress: false,
  thumbnailRequestGeneration: 0,
  thumbnailLoadedFsids: new Set(),
  thumbnailFailedFsids: new Set(),
  ffmpegDownloading: false,
  previewPending: false,
  currentSyncSequence: null,
  syncRowsBySequence: {},
  loginFromSplash: false,
  loggingOut: false,
};

// --- DOM helpers ---
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

// --- Toast ---
function toast(message, type = "info", duration = 3000) {
  const t = el("div", `toast ${type}`, message);
  $("toastContainer").appendChild(t);
  setTimeout(() => {
    t.style.opacity = "0";
    setTimeout(() => t.remove(), 300);
  }, duration);
}

// --- Status & Progress ---
function setStatus(text) { $("statusText").textContent = text; }

function setProgress(value, text) {
  const v = Math.max(0, Math.min(100, value));
  $("progressFill").style.width = v + "%";
  $("progressText").textContent = text || "";
  if (text === "就绪" && v === 0) $("progressFill").style.width = "0%";
}

// --- Bridge call ---
async function bridge(method, params = {}) {
  try {
    return await window.api.call(method, params);
  } catch (err) {
    console.error("Bridge error:", method, err);
    throw err;
  }
}

// --- Timing helpers ---
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// 启动 splash 最短展示时长：即便登录瞬间完成也要显示满 1500ms，避免闪烁。
const SPLASH_MIN_MS = 1500;
let splashShownAt = 0;

// --- Format helpers ---
function formatSize(value) {
  let size = parseFloat(value);
  for (const unit of ["B","KB","MB","GB","TB"]) {
    if (size < 1024 || unit === "TB") return unit === "B" ? `${Math.round(size)} B` : `${size.toFixed(1)} ${unit}`;
    size /= 1024;
  }
  return String(value);
}

function formatTime(value) {
  if (!value) return "—";
  return new Date(value * 1000).toLocaleString("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit"
  }).replace(/\//g, "-");
}

function formatDuration(seconds) {
  seconds = Math.max(0, parseFloat(seconds));
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const [m, s] = [Math.floor(Math.round(seconds) / 60), Math.round(seconds) % 60];
  if (m < 60) return `${m} 分 ${String(s).padStart(2, "0")} 秒`;
  const [h, mm] = [Math.floor(m / 60), m % 60];
  return `${h} 小时 ${String(mm).padStart(2, "0")} 分 ${String(s).padStart(2, "0")} 秒`;
}

function mediaType(name) {
  const ext = name.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  if (VIDEO_EXTS.includes("." + ext)) return "视频";
  if (PHOTO_EXTS.includes("." + ext)) return "照片";
  return ext || "文件";
}

// --- File type icon SVG ---
function fileTypeIcon(name) {
  const type = mediaType(name);
  if (type === "视频") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3V9z" fill="currentColor" stroke="none"/></svg>';
  if (type === "照片") return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10" r="1.5"/><path d="M3 17l5-5 4 4 3-3 6 6"/></svg>';
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M6 2h8l6 6v14H6V2z"/><path d="M14 2v6h6"/></svg>';
}

// === Page title mapping ===
const PAGE_TITLES = { browser: "相册浏览", sync: "同步中心", help: "帮助" };

// === Sidebar navigation ===
document.querySelectorAll(".nav-item").forEach(item => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    item.classList.add("active");
    $("tab-" + item.dataset.tab).classList.add("active");
    $("pageTitle").textContent = PAGE_TITLES[item.dataset.tab] || "";
  });
});

// === Connection state ===
function setConnected(connected) {
  state.connected = connected;
  const btn = $("btnConnect");
  btn.querySelector("span").textContent = connected ? "已登录" : "登录";
  btn.classList.toggle("connected", connected);

  const enableIfConnected = [
    "btnRefresh","btnAlbumRefresh","btnAlbumCreate","btnAlbumRename","btnAlbumDelete",
    "btnMediaUpload","btnMediaDownload","btnMediaPreview","btnMediaDelete",
    "btnBuildPlan","btnClearIgnored",
  ];
  enableIfConnected.forEach(id => { const e = $(id); if (e) e.disabled = !connected; });
  if (!connected || state.syncMode === "idle") setSyncControls("idle");
}

// === Sync controls ===
function setSyncControls(mode) {
  state.syncMode = mode;
  const connected = state.connected;
  const idle = mode === "idle";
  const paused = mode === "paused";
  const active = ["running","paused","stopping"].includes(mode);

  $("btnBuildPlan").disabled = !(connected && idle);
  $("btnExecutePlan").disabled = !(connected && idle && state.syncActions.length > 0);
  $("btnClearIgnored").disabled = !(connected && idle);
  $("btnPauseSync").disabled = !(connected && mode === "running");
  $("btnResumeSync").disabled = !(connected && paused);
  $("btnStopSync").disabled = !(connected && active && mode !== "stopping");
  $("btnAlbumRefresh").disabled = !(connected && !active);
  $("btnRefresh").disabled = !(connected && !active);

  const label = $("syncLiveLabel");
  if (mode === "running") label.textContent = "同步进行中";
  else if (mode === "paused") label.textContent = "同步已暂停";
  else if (mode === "stopping") label.textContent = "正在安全停止";
  else if (!connected) label.textContent = "同步未运行";
  else label.textContent = "同步待命";
}

// === Login ===
async function startLogin() {
  // 本函数仅在启动时（splash loading 期间）调用，标记登录窗口来源为 splash，
  // 用于决定关闭登录窗口时是否退出程序。
  state.loginFromSplash = true;
  try {
    const result = await bridge("get_session");
    if (result && result.cookie) {
      setStatus("正在校验本机保存的登录会话…");
      showLoading("正在检查账号权限…");
      setLoadingStage(50, "正在验证登录会话…");
      try {
        await bridge("connect", { cookie_text: result.cookie, save: false });
        onConnected(result.cookie, false);
        return;
      } catch (err) {
        console.log("Saved session invalid:", err.message);
        await bridge("clear_session");
      }
    }
  } catch (err) { console.error("Session check failed:", err); }
  setLoadingStage(50, "请扫码登录");
  openQRLogin();
}

function openQRLogin() {
  // 等启动 splash 展示满最短时长后再打开登录窗口：splash 单独显示 1500ms，
  // 到点恰好隐藏并弹出登录窗口，避免两种 loading 同时存在。
  const remaining = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  delay(remaining).then(() => {
    hideLoading();
    setStatus("请扫描二维码登录。");
    window.api.openQRLogin();
  });
}

window.api.onQRLoginCookie(async (cookieJson) => {
  setStatus("正在验证一刻相册登录会话…");
  showLoginLoading();
  try {
    await bridge("connect", { cookie_text: cookieJson, save: true });
    hideLoginLoading();
    window.api.closeQRLogin();
    onConnected(cookieJson, true);
  } catch (err) {
    hideLoginLoading();
    setStatus("登录会话验证失败，正在等待重试…");
    toast("登录验证失败，正在自动重试…", "error", 5000);
    window.api.retryQRLogin();
  }
});

window.api.onQRLoginLoading(() => {
  showLoginLoading();
});

window.api.onQRLoginLoadingHide(() => {
  hideLoginLoading();
});

window.api.onQRLoginClosed(() => {
  hideLoginLoading();
  // 登录成功后的程序化关闭（验证通过后主进程销毁窗口）：保持已连接状态，不做处理
  if (state.connected) return;
  setStatus("登录已取消。");
  setProgress(0, "就绪");
  if (state.loginFromSplash) {
    // 由启动 splash 弹出的登录窗口被关闭：无会话可继续，退出程序
    window.api.quit();
  }
  // 否则（如运行期手动点击登录/退出后重登）：仅关闭登录窗口，不退出程序
});

// === Login loading overlay (样式对齐退出登录) ===
function showLoginLoading() {
  let overlay = document.getElementById("login-loading-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "login-loading-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,255,255,0.95);z-index:999999;display:flex;align-items:center;justify-content:center;flex-direction:column;font-family:Microsoft YaHei,sans-serif;";
    const title = document.createElement("div");
    title.textContent = "正在登录，请稍候";
    title.style.cssText = "font-size:22px;font-weight:700;color:#1d63bf;margin-bottom:12px;";
    const hint = document.createElement("div");
    hint.textContent = "正在验证一刻相册访问权限，请勿关闭窗口。";
    hint.style.cssText = "font-size:14px;color:#718096;margin-bottom:24px;";
    const spinner = document.createElement("div");
    spinner.style.cssText = "width:36px;height:36px;border:3px solid #e0e8f5;border-top-color:#2577d9;border-radius:50%;animation:yike-spin 0.8s linear infinite;";
    const style = document.createElement("style");
    style.textContent = "@keyframes yike-spin{to{transform:rotate(360deg)}}";
    overlay.appendChild(style);
    overlay.appendChild(title);
    overlay.appendChild(hint);
    overlay.appendChild(spinner);
    document.body.appendChild(overlay);
  }
  overlay.style.display = "flex";
}

function hideLoginLoading() {
  const overlay = document.getElementById("login-loading-overlay");
  if (overlay) overlay.style.display = "none";
}

function onConnected(cookieText, saved) {
  state.connected = true;
  setConnected(true);
  hideLoading();
  setStatus(saved ? "账户已连接；扫码会话已使用系统安全凭据存储保存。" : "账户已连接。");
  toast("登录成功", "info", 2000);
  refreshAlbums();
}

// === Loading overlay ===
function showLoading(text) {
  $("loadingOverlay").style.display = "flex";
  if (text) $("loadingStatus").textContent = text;
  $("loadingFill").style.width = "30%";
}
let hideLoadingTimer = null;
function hideLoading() {
  const remaining = SPLASH_MIN_MS - (Date.now() - splashShownAt);
  if (remaining > 0) {
    // 未达最短展示时长：延迟到满 1500ms 再真正隐藏
    if (hideLoadingTimer) return;
    hideLoadingTimer = setTimeout(() => {
      hideLoadingTimer = null;
      const ov = $("loadingOverlay");
      if (ov) ov.style.display = "none";
    }, remaining);
    return;
  }
  if (hideLoadingTimer) { clearTimeout(hideLoadingTimer); hideLoadingTimer = null; }
  const ov = $("loadingOverlay");
  if (ov) ov.style.display = "none";
}
function setLoadingStage(percent, text) {
  $("loadingFill").style.width = percent + "%";
  if (text) $("loadingStatus").textContent = text;
}

// === Album operations ===
async function refreshAlbums() {
  if (!state.connected) return;
  setProgress(0, "正在读取相册列表");
  try {
    const albums = await bridge("list_albums", { force_refresh: false });
    state.albums = albums;
    renderAlbumTree();
    setStatus(`已加载 ${albums.length} 个云端相册。`);
    setProgress(100, "操作完成");
    setTimeout(() => setProgress(0, "就绪"), 2000);
  } catch (err) {
    setProgress(0, "操作失败");
    setStatus("读取相册列表失败: " + err.message);
    toast("读取相册列表失败: " + err.message, "error", 5000);
  }
}

function renderAlbumTree() {
  const tree = $("albumTree");
  tree.innerHTML = "";
  state.albums.forEach(album => {
    const item = el("div", "tree-item");
    item.dataset.albumId = album.album_id;
    item.appendChild(el("span", "tree-icon", "\u{1F4C1}"));
    item.appendChild(el("span", "tree-label", album.title));
    if (album.amount != null) item.appendChild(el("span", "tree-count", `${album.amount}`));
    item.addEventListener("click", () => {
      document.querySelectorAll("#albumTree .tree-item").forEach(i => i.classList.remove("selected"));
      item.classList.add("selected");
      selectAlbum(album);
    });
    tree.appendChild(item);
  });
}

async function selectAlbum(album) {
  state.currentAlbum = album;
  $("mediaTitle").textContent = album.title;
  setProgress(0, `正在读取 ${album.title}`);
  try {
    const media = await bridge("list_media", { album_id: album.album_id });
    state.currentMedia = media;
    state.thumbnailRequestGeneration++;
    state.thumbnailLoadedFsids.clear();
    state.thumbnailFailedFsids.clear();
    renderMediaTable();
    renderThumbnailGrid();
    setProgress(100, `已读取 ${media.length} 个媒体`);
    setTimeout(() => setProgress(0, "就绪"), 2000);
  } catch (err) {
    setProgress(0, "操作失败");
    toast("读取相册媒体失败: " + err.message, "error", 5000);
  }
}

// === Media table ===
function renderMediaTable() {
  const body = $("mediaTableBody");
  body.innerHTML = "";
  state.currentMedia.forEach(item => {
    const tr = el("tr");
    tr.dataset.fsid = item.fsid;
    tr.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) tr.classList.toggle("selected");
      else { body.querySelectorAll("tr").forEach(r => r.classList.remove("selected")); tr.classList.add("selected"); }
      updateMediaSelectionName();
    });
    tr.addEventListener("dblclick", () => previewByFsid(item.fsid));
    // Name cell with file type icon
    const nameCell = el("td", "col-name-cell");
    const iconWrap = el("span", "file-type-icon");
    iconWrap.innerHTML = fileTypeIcon(item.name);
    nameCell.appendChild(iconWrap);
    const nameText = el("span", "file-name-text", item.name); nameText.title = item.name;
    nameCell.appendChild(nameText);
    tr.appendChild(nameCell);
    tr.appendChild(el("td", "", mediaType(item.name)));
    tr.appendChild(el("td", "", formatSize(item.size)));
    tr.appendChild(el("td", "", formatTime(item.modified_at)));
    tr.appendChild(el("td", "", "云端媒体"));
    body.appendChild(tr);
  });
}

// === Thumbnail grid ===
function renderThumbnailGrid() {
  const grid = $("thumbnailGrid");
  grid.innerHTML = "";
  state.currentMedia.forEach(item => {
    const tile = el("div", "thumb-tile");
    tile.dataset.fsid = item.fsid;
    tile.addEventListener("click", (e) => {
      if (e.ctrlKey || e.metaKey) tile.classList.toggle("selected");
      else { grid.querySelectorAll(".thumb-tile").forEach(t => t.classList.remove("selected")); tile.classList.add("selected"); }
      updateMediaSelectionName();
    });
    tile.addEventListener("dblclick", () => previewByFsid(item.fsid));
    const placeholder = el("div", "thumb-placeholder");
    placeholder.innerHTML = fileTypeIcon(item.name);
    const name = el("div", "thumb-name", item.name); name.title = item.name;
    tile.appendChild(placeholder);
    tile.appendChild(name);
    grid.appendChild(tile);
  });
  scheduleVisibleThumbnailLoad();
}

function updateMediaSelectionName() {
  const viewMode = $("mediaViewMode").value;
  let selectedNames = [];
  if (viewMode === "thumbnails") {
    document.querySelectorAll("#thumbnailGrid .thumb-tile.selected").forEach(t => {
      const item = state.currentMedia.find(m => m.fsid === t.dataset.fsid);
      if (item) selectedNames.push(item.name);
    });
  } else {
    document.querySelectorAll("#mediaTableBody tr.selected").forEach(tr => {
      const item = state.currentMedia.find(m => m.fsid === tr.dataset.fsid);
      if (item) selectedNames.push(item.name);
    });
  }
  const label = $("mediaSelectedName");
  if (selectedNames.length === 1) { label.textContent = `已选择：${selectedNames[0]}`; label.title = selectedNames[0]; label.style.display = "block"; }
  else if (selectedNames.length > 1) { label.textContent = `已选择 ${selectedNames.length} 个媒体`; label.style.display = "block"; }
  else { label.textContent = ""; label.style.display = "none"; }
}

// === Lazy thumbnails ===
let scrollThrottleTimer = null;

function scheduleVisibleThumbnailLoad() {
  if ($("mediaViewMode").value !== "thumbnails" || state.thumbnailLoadInProgress) return;
  setTimeout(loadVisibleThumbnails, 120);
}

async function loadVisibleThumbnails() {
  if (state.thumbnailLoadInProgress || $("mediaViewMode").value !== "thumbnails") return;
  const grid = $("thumbnailGrid");
  const container = $("mediaThumbnailView");
  const containerRect = container.getBoundingClientRect();
  const visibleTiles = [];
  grid.querySelectorAll(".thumb-tile").forEach(tile => {
    const r = tile.getBoundingClientRect();
    if (r.bottom > containerRect.top && r.top < containerRect.bottom) {
      const fsid = tile.dataset.fsid;
      if (!state.thumbnailLoadedFsids.has(fsid) && !state.thumbnailFailedFsids.has(fsid)) {
        const item = state.currentMedia.find(m => m.fsid === fsid);
        if (item && item.thumbnail_url) visibleTiles.push(item);
      }
    }
  });
  if (visibleTiles.length === 0) return;
  state.thumbnailLoadInProgress = true;
  const generation = state.thumbnailRequestGeneration;
  try {
    const total = visibleTiles.length;
    for (let i = 0; i < visibleTiles.length; i++) {
      const item = visibleTiles[i];
      try {
        const result = await bridge("download_media_cached", {
          album_id: item.album_id, fsid: item.fsid, expected_size: 0, variant: "thumbnail", url: item.thumbnail_url,
        });
        if (result && result.path) {
          state.thumbnailLoadedFsids.add(item.fsid);
          const tile = grid.querySelector(`.thumb-tile[data-fsid="${item.fsid}"]`);
          if (tile) {
            const ph = tile.querySelector(".thumb-placeholder");
            if (ph) { const img = document.createElement("img"); img.className = "thumb-image"; img.src = "file://" + result.path.replace(/\\\\/g, "/"); ph.replaceWith(img); }
          }
        }
      } catch (err) { state.thumbnailFailedFsids.add(item.fsid); }
      setProgress(Math.round((i + 1) / total * 100), `缩略图 ${i + 1}/${total}`);
    }
  } finally {
    state.thumbnailLoadInProgress = false;
    if (generation === state.thumbnailRequestGeneration) setStatus(`已加载 ${state.thumbnailLoadedFsids.size} 张缩略图。`);
    setProgress(0, "就绪");
    scheduleVisibleThumbnailLoad();
  }
}

// Scroll listener for lazy loading on scroll
$("mediaThumbnailView").addEventListener("scroll", () => {
  if (scrollThrottleTimer) return;
  scrollThrottleTimer = setTimeout(() => {
    scrollThrottleTimer = null;
    scheduleVisibleThumbnailLoad();
  }, 200);
});

async function loadVisibleThumbnails() {
  if (state.thumbnailLoadInProgress || $("mediaViewMode").value !== "thumbnails") return;
  const grid = $("thumbnailGrid");
  const container = $("mediaThumbnailView");
  const containerRect = container.getBoundingClientRect();
  const visibleTiles = [];
  grid.querySelectorAll(".thumb-tile").forEach(tile => {
    const r = tile.getBoundingClientRect();
    if (r.bottom > containerRect.top && r.top < containerRect.bottom) {
      const fsid = tile.dataset.fsid;
      if (!state.thumbnailLoadedFsids.has(fsid) && !state.thumbnailFailedFsids.has(fsid)) {
        const item = state.currentMedia.find(m => m.fsid === fsid);
        if (item && item.thumbnail_url) visibleTiles.push(item);
      }
    }
    if (visibleTiles.length >= 18) return;
  });
  if (visibleTiles.length === 0) return;
  state.thumbnailLoadInProgress = true;
  const generation = state.thumbnailRequestGeneration;
  try {
    const total = Math.max(1, visibleTiles.length);
    for (let i = 0; i < visibleTiles.length; i++) {
      const item = visibleTiles[i];
      try {
        const result = await bridge("download_media_cached", {
          album_id: item.album_id, fsid: item.fsid, expected_size: 0, variant: "thumbnail", url: item.thumbnail_url,
        });
        if (result && result.path) {
          state.thumbnailLoadedFsids.add(item.fsid);
          const tile = grid.querySelector(`.thumb-tile[data-fsid="${item.fsid}"]`);
          if (tile) {
            const ph = tile.querySelector(".thumb-placeholder");
            if (ph) { const img = document.createElement("img"); img.className = "thumb-image"; img.src = "file://" + result.path.replace(/\\/g, "/"); ph.replaceWith(img); }
          }
        }
      } catch (err) { state.thumbnailFailedFsids.add(item.fsid); }
      setProgress(Math.round((i + 1) / total * 100), `缩略图 ${i + 1}/${total}`);
    }
  } finally {
    state.thumbnailLoadInProgress = false;
    if (generation === state.thumbnailRequestGeneration) setStatus(`已加载 ${state.thumbnailLoadedFsids.size} 张缩略图。`);
    setProgress(0, "就绪");
    scheduleVisibleThumbnailLoad();
  }
}

// === View mode ===
$("mediaViewMode").addEventListener("change", () => {
  const mode = $("mediaViewMode").value;
  $("mediaDetailView").classList.toggle("active", mode === "details");
  $("mediaThumbnailView").classList.toggle("active", mode === "thumbnails");
  if (mode === "thumbnails") scheduleVisibleThumbnailLoad();
  updateMediaSelectionName();
  // Persist to settings
  bridge("save_settings", { media_browser_view_mode: mode }).catch(() => {});
});

function getSelectedMedia() {
  const viewMode = $("mediaViewMode").value;
  let fsids = [];
  if (viewMode === "thumbnails") document.querySelectorAll("#thumbnailGrid .thumb-tile.selected").forEach(t => fsids.push(t.dataset.fsid));
  else document.querySelectorAll("#mediaTableBody tr.selected").forEach(tr => fsids.push(tr.dataset.fsid));
  return state.currentMedia.filter(m => fsids.includes(m.fsid));
}

// === Album CRUD ===
$("btnAlbumCreate").addEventListener("click", async () => {
  const title = prompt("新建相册\n相册名称：");
  if (!title || !title.trim()) return;
  setProgress(0, "正在创建相册");
  try { await bridge("create_album", { title: title.trim() }); setProgress(100, "相册创建成功"); refreshAlbums(); }
  catch (err) { setProgress(0, "操作失败"); toast("创建相册失败: " + err.message, "error"); }
});

$("btnAlbumRename").addEventListener("click", async () => {
  if (!state.currentAlbum) { toast("请先在左侧选中要重命名的相册。", "info"); return; }
  const title = prompt("重命名相册\n新名称：", state.currentAlbum.title);
  if (!title || !title.trim() || title.trim() === state.currentAlbum.title) return;
  setProgress(0, "正在重命名相册");
  try { await bridge("rename_album", { album_id: state.currentAlbum.album_id, title: title.trim() }); setProgress(100, "重命名成功"); refreshAlbums(); }
  catch (err) { setProgress(0, "操作失败"); toast("重命名相册失败: " + err.message, "error"); }
});

$("btnAlbumDelete").addEventListener("click", async () => {
  if (!state.currentAlbum) { toast("请先选中要删除的相册。", "info"); return; }
  if (!confirm(`确认删除\n确定删除相册"${state.currentAlbum.title}"吗？\n\n默认只删除相册关系，保留其中已上传的云端媒体。`)) return;
  setProgress(0, "正在删除相册");
  try {
    await bridge("delete_album", { album_id: state.currentAlbum.album_id, delete_items: false });
    setProgress(100, "删除成功");
    state.currentAlbum = null; state.currentMedia = [];
    $("mediaTableBody").innerHTML = ""; $("thumbnailGrid").innerHTML = "";
    $("mediaTitle").textContent = "选择一个相册以浏览媒体";
    $("mediaSelectedName").style.display = "none";
    refreshAlbums();
  } catch (err) { setProgress(0, "操作失败"); toast("删除相册失败: " + err.message, "error"); }
});

// === Media actions ===
$("btnMediaUpload").addEventListener("click", async () => {
  if (!state.currentAlbum) { toast("请先选择上传目标相册。", "info"); return; }
  const paths = await window.api.openFiles();
  if (!paths || paths.length === 0) return;
  setProgress(0, "准备上传媒体");
  try { await bridge("upload_media", { album_id: state.currentAlbum.album_id, paths }); setProgress(100, "上传完成"); toast("上传完成", "info"); selectAlbum(state.currentAlbum); }
  catch (err) { setProgress(0, "操作失败"); toast("上传失败: " + err.message, "error"); }
});

$("btnMediaDownload").addEventListener("click", async () => {
  if (!state.currentAlbum) return;
  const selected = getSelectedMedia();
  if (selected.length === 0) { toast("请选择至少一个要下载的媒体。", "info"); return; }
  const directory = await window.api.openDirectory();
  if (!directory) return;
  setProgress(0, "正在下载媒体");
  let completed = 0;
  for (const item of selected) {
    try { await bridge("download_media", { album_id: state.currentAlbum.album_id, fsid: item.fsid, target_directory: directory }); completed++; setProgress(Math.round(completed / selected.length * 100), `已下载 ${completed}/${selected.length}`); }
    catch (err) { toast(`下载失败：${item.name}: ${err.message}`, "error"); }
  }
  setProgress(100, "下载完成"); toast("下载完成", "info");
  setTimeout(() => setProgress(0, "就绪"), 2000);
});

$("btnMediaPreview").addEventListener("click", () => {
  const selected = getSelectedMedia();
  if (selected.length !== 1) { toast("请选择一张照片后再预览。", "info"); return; }
  startPhotoPreview(selected[0]);
});

async function previewByFsid(fsid) {
  const item = state.currentMedia.find(m => m.fsid === fsid);
  if (item) startPhotoPreview(item);
}

async function startPhotoPreview(item) {
  if (!state.currentAlbum) return;
  const ext = item.name.toLowerCase().match(/\.([^.]+)$/)?.[1] || "";
  if (!PHOTO_EXTS.includes("." + ext)) { toast("当前预览仅支持照片，请使用下载保存视频。", "info"); return; }
  if (!item.preview_url) { toast("未返回可用缩略图，请使用下载保存原图后查看。", "info"); return; }
  if (state.previewPending) { setStatus("正在准备当前照片预览，请稍候。"); return; }
  state.previewPending = true; $("btnMediaPreview").disabled = true;
  setProgress(0, `正在读取预览：${item.name}`);
  try {
    const result = await bridge("download_media_cached", { album_id: item.album_id, fsid: item.fsid, expected_size: 0, variant: "thumbnail", url: item.preview_url });
    if (result && result.path) { setProgress(100, `预览已准备：${item.name}`); window.api.openPath(result.path); setStatus(`已打开：${item.name}`); }
  } catch (err) { setProgress(0, "就绪"); toast("照片缩略图预览失败。", "error"); }
  finally { state.previewPending = false; $("btnMediaPreview").disabled = !state.connected; }
}

$("btnMediaDelete").addEventListener("click", async () => {
  if (!state.currentAlbum) return;
  const selected = getSelectedMedia();
  if (selected.length === 0) { toast("请选择至少一个要删除的媒体。", "info"); return; }
  if (!confirm(`确认删除\n确定删除所选 ${selected.length} 个远端媒体吗？此操作会影响云端文件。`)) return;
  setProgress(0, "正在删除媒体");
  for (let i = 0; i < selected.length; i++) {
    try { await bridge("delete_media", { album_id: state.currentAlbum.album_id, fsid: selected[i].fsid }); setProgress(Math.round((i + 1) / selected.length * 100), `正在删除 ${selected[i].name}`); }
    catch (err) { toast(`删除失败：${selected[i].name}: ${err.message}`, "error"); }
  }
  setProgress(100, "删除完成"); selectAlbum(state.currentAlbum);
});

// === Browse root ===
$("btnBrowse").addEventListener("click", async () => {
  const dir = await window.api.openDirectory();
  if (dir) { $("localRoot").value = dir; state.settings.local_root = dir; await bridge("save_settings", { local_root: dir }); }
});

// === Advanced settings (opens as separate window) ===
$("btnAdvanced").addEventListener("click", () => {
  window.api.openSettings();
});

// === Sync plan ===
$("btnBuildPlan").addEventListener("click", async () => {
  if (state.syncMode !== "idle") return;
  const root = $("localRoot").value.trim();
  if (!root) { toast("请选择一个有效的同步根目录。", "warning"); return; }
  const settings = state.settings;
  setSyncControls("planning");
  setProgress(0, "正在比较本地与云端");
  try {
    const actions = await bridge("build_plan", {
      root, direction: settings.direction || "本地 → 云端",
      sort_field: settings.sort_field || "按文件夹名称",
      reverse: settings.reverse === true || settings.reverse === "true",
      enable_deletions: settings.deletion === true || settings.deletion === "true",
      ignored_album_names: Array.from(state.ignoredAlbumNames),
      skip_oversize: settings.skip_oversize !== false,
      compare_mode: settings.file_compare_mode || "智能（推荐：同名视频压缩版 + 内容去重）",
      compress_oversize_videos: settings.compress_oversize_videos === true || settings.compress_oversize_videos === "true",
      max_workers: parseInt(settings.file_client_workers) || 4,
      download_workers: parseInt(settings.download_client_workers) || 4,
      list_threads: parseInt(settings.list_threads) || 8,
    });
    state.syncActions = actions;
    populatePlanTable(actions);
    populateSyncAlbumQueue(actions);
    const count = actions.length;
    const conflicts = actions.filter(a => a.action === "冲突").length;
    const executable = actions.filter(a => a.can_execute).length;
    const ignored = actions.filter(a => a.action === "跳过" && a.detail && a.detail.includes("忽略")).length;
    $("planSummary").textContent = `共 ${count} 项；可执行 ${executable} 项；冲突 ${conflicts} 项；已忽略 ${ignored} 项`;
    setProgress(100, `计划已生成：${executable} 项待执行`);
    setSyncControls("idle");
  } catch (err) { setProgress(0, "操作失败"); setSyncControls("idle"); toast("生成同步计划失败: " + err.message, "error", 5000); }
});

function populatePlanTable(actions) {
  const body = $("planTableBody");
  body.innerHTML = "";
  state.syncRowsBySequence = {};
  const visibleActions = actions.filter(a => a.action !== "跳过" || (a.detail && a.detail.includes("非有效照片/视频")));
  visibleActions.forEach(action => {
    const row = body.insertRow();
    state.syncRowsBySequence[action.sequence] = row.rowIndex - 1;
    const target = action.local_path ? action.local_path.split(/[\\/]/).pop() : (action.remote_album_id ? "云端" : "—");
    [String(action.sequence), action.action, action.album_name || "—", action.media_name || "—", target, action.detail, action.status].forEach((text, i) => {
      const cell = row.insertCell(i); cell.textContent = text; cell.title = text;
    });
    if (action.action === "冲突") row.classList.add("plan-row-conflict");
    else if (action.action === "删除本地文件" || action.action === "删除云端媒体") row.classList.add("plan-row-delete");
    else if (action.action === "跳过") row.classList.add("plan-row-skip");
    applyActionRowStyle(row, action.status);
  });
}

function applyActionRowStyle(row, status) {
  const styles = [
    { prefix: "正在执行", cls: "plan-row-executing" },
    { prefix: "正在上传并确认入册", cls: "plan-row-executing" },
    { prefix: "等待上传并确认入册", cls: "plan-row-pending" },
    { prefix: "已暂停，等待继续", cls: "plan-row-paused" },
    { prefix: "已完成", cls: "plan-row-completed" },
    { prefix: "已跳过", cls: "plan-row-skipped" },
    { prefix: "已停止", cls: "plan-row-stopped" },
  ];
  for (const s of styles) { if (status.startsWith(s.prefix)) { row.classList.add(s.cls); return; } }
  if (status.startsWith("失败") || status.startsWith("错误")) row.classList.add("plan-row-failed");
}

function populateSyncAlbumQueue(actions) {
  const tree = $("syncAlbumTree");
  tree.innerHTML = "";
  const byAlbum = {};
  actions.forEach(a => { if (a.album_name) { if (!byAlbum[a.album_name]) byAlbum[a.album_name] = []; byAlbum[a.album_name].push(a); } });
  Object.keys(byAlbum).sort((a, b) => a.localeCompare(b)).forEach(name => {
    const albumActions = byAlbum[name];
    const executable = albumActions.filter(a => a.can_execute).length;
    const ignored = albumActions.some(a => a.action === "跳过" && a.detail && a.detail.includes("忽略"));
    let stateText = ignored ? "已忽略" : executable ? `${executable} 项` : "无需操作";
    const item = el("div", "tree-item");
    if (ignored) item.classList.add("ignored");
    item.appendChild(el("span", "tree-icon", "\u{1F4C1}"));
    item.appendChild(el("span", "tree-label", name));
    item.appendChild(el("span", "tree-count", stateText));
    item.dataset.albumName = name;
    item.addEventListener("contextmenu", (e) => { e.preventDefault(); showSyncAlbumContextMenu(e.pageX, e.pageY, name); });
    tree.appendChild(item);
  });
}

function showSyncAlbumContextMenu(x, y, albumName) {
  document.querySelectorAll(".context-menu").forEach(m => m.remove());
  const menu = el("div", "context-menu");
  const isIgnored = isIgnoredAlbum(albumName);
  const item = el("div", "context-menu-item", isIgnored ? "从忽略列表移除" : "加入忽略列表");
  item.addEventListener("click", () => { toggleIgnoreAlbum(albumName); menu.remove(); });
  menu.appendChild(item);
  menu.style.left = x + "px"; menu.style.top = y + "px";
  document.body.appendChild(menu);
  setTimeout(() => { document.addEventListener("click", function closeMenu() { menu.remove(); document.removeEventListener("click", closeMenu); }); }, 0);
}

function isIgnoredAlbum(albumName) {
  const target = albumName.toLowerCase().replace(/\s+/g, "");
  for (const name of state.ignoredAlbumNames) if (name.toLowerCase().replace(/\s+/g, "") === target) return true;
  return false;
}

async function toggleIgnoreAlbum(albumName) {
  if (isIgnoredAlbum(albumName)) {
    state.ignoredAlbumNames.delete(Array.from(state.ignoredAlbumNames).find(n => n.toLowerCase().replace(/\s+/g, "") === albumName.toLowerCase().replace(/\s+/g, "")));
    setStatus(`已取消忽略相册：${albumName}`);
  } else {
    state.ignoredAlbumNames.add(albumName);
    setStatus(`已加入忽略列表：${albumName}`);
  }
  if (state.syncActions.length > 0) $("btnBuildPlan").click();
}

$("btnClearIgnored").addEventListener("click", async () => {
  if (state.ignoredAlbumNames.size === 0) { setStatus("忽略列表为空。"); return; }
  state.ignoredAlbumNames.clear();
  setStatus("已清空忽略列表。");
  if (state.syncActions.length > 0) $("btnBuildPlan").click();
});

// === Sync execution ===
$("btnExecutePlan").addEventListener("click", async () => {
  if (state.syncMode !== "idle") return;
  if (!state.syncActions.length) { toast("请先生成同步计划。", "info"); return; }
  const executable = state.syncActions.filter(a => a.can_execute && (a.status === "待执行" || a.status === "已停止" || a.status.startsWith("失败") || a.status.startsWith("错误") || a.status.startsWith("待重试")));
  if (executable.length === 0) { toast("当前计划没有可执行的项目。", "info"); return; }
  const deletes = executable.filter(a => a.action === "删除本地文件" || a.action === "删除云端媒体");
  let message = `确定执行 ${executable.length} 项同步操作吗？\n忽略与冲突项目不会执行。`;
  if (deletes.length > 0) message += `\n\n其中包含 ${deletes.length} 项删除操作，请确认已检查计划。`;
  if (!confirm("确认执行同步\n" + message)) return;
  const root = $("localRoot").value.trim();
  const settings = state.settings;
  state.syncFinishedSequences = new Set(state.syncActions.filter(a => a.can_execute && (a.status === "已完成" || a.status === "已停止" || a.status.startsWith("失败") || a.status.startsWith("错误") || a.status.startsWith("已跳过"))).map(a => a.sequence));
  state.syncExecutableTotal = state.syncActions.filter(a => a.can_execute).length;
  state.syncStartedAt = Date.now();
  setSyncControls("running");
  setProgress(0, "正在执行同步计划");
  try {
    const result = await bridge("execute_plan", {
      root, max_workers: parseInt(settings.file_client_workers) || 4,
      download_workers: parseInt(settings.download_client_workers) || 4,
      list_threads: parseInt(settings.list_threads) || 8,
      compare_mode: settings.file_compare_mode || "智能（推荐：同名视频压缩版 + 内容去重）",
      compress_oversize_videos: settings.compress_oversize_videos === true || settings.compress_oversize_videos === "true",
    });
    if (!result || !result.started) throw new Error("无法启动同步执行。");
  } catch (err) {
    setProgress(0, "同步执行失败");
    $("syncLiveLabel").textContent = "同步失败：请查看 error.log";
    setSyncControls("idle");
    toast("同步执行失败: " + err.message, "error", 5000);
  }
});

window.api.onExecuteComplete((actions) => { onSyncComplete(actions); });

window.api.onExecuteError((message) => {
  setProgress(0, "同步执行失败");
  $("syncLiveLabel").textContent = "同步失败：请查看 error.log";
  setSyncControls("idle");
  toast("同步执行失败: " + message, "error", 5000);
});

// === Sync control buttons ===
$("btnPauseSync").addEventListener("click", async () => {
  try { await bridge("pause_sync"); setSyncControls("paused"); setStatus("已请求暂停。"); if (state.currentSyncSequence != null) updateSyncActionStatus(state.currentSyncSequence, "已暂停，等待当前请求完成"); }
  catch (err) { toast("暂停失败: " + err.message, "error"); }
});

$("btnResumeSync").addEventListener("click", async () => {
  try { await bridge("resume_sync"); setSyncControls("running"); setStatus("同步已继续。"); }
  catch (err) { toast("继续失败: " + err.message, "error"); }
});

$("btnStopSync").addEventListener("click", async () => {
  try { await bridge("stop_sync"); setSyncControls("stopping"); setStatus("已请求安全停止。"); }
  catch (err) { toast("停止失败: " + err.message, "error"); }
});

// === Progress/status/alert listeners ===
window.api.onProgress((value, text) => { setProgress(value, text); });
window.api.onStatus((sequence, text) => { updateSyncActionStatus(sequence, text); });
window.api.onAlert((message) => { if (state.syncMode !== "running") return; setSyncControls("paused"); alert("同步已暂停\n" + message); });

function updateSyncActionStatus(sequence, status) {
  state.currentSyncSequence = sequence;
  const action = state.syncActions.find(a => a.sequence === sequence);
  if (!action) return;
  action.status = status;
  const rowIndex = state.syncRowsBySequence[sequence];
  if (rowIndex == null) { populatePlanTable(state.syncActions); }
  else {
    const row = $("planTableBody").rows[rowIndex];
    if (row) {
      const statusCell = row.cells[6];
      if (statusCell) { statusCell.textContent = status; statusCell.title = status; }
      ["plan-row-executing","plan-row-pending","plan-row-paused","plan-row-completed","plan-row-skipped","plan-row-stopped","plan-row-failed"].forEach(c => row.classList.remove(c));
      applyActionRowStyle(row, status);
    }
  }
  if (["已完成","已停止"].includes(status) || status.startsWith("失败") || status.startsWith("错误") || status.startsWith("已跳过")) state.syncFinishedSequences.add(sequence);
  else state.syncFinishedSequences.delete(sequence);
  $("planSummary").textContent = `同步中：已处理 ${state.syncFinishedSequences.size}/${state.syncExecutableTotal} 项`;
  $("syncLiveLabel").textContent = `当前：${action.album_name} / ${action.media_name || action.action}`;
}

function onSyncComplete(actions) {
  state.syncActions = actions;
  populatePlanTable(actions);
  populateSyncAlbumQueue(actions);
  const failures = actions.filter(a => a.status.startsWith("失败") || a.status.startsWith("错误")).length;
  const skipped = actions.filter(a => a.status.startsWith("已跳过")).length;
  const stopped = actions.filter(a => a.status === "已停止").length;
  let parts = [];
  if (failures) parts.push(`${failures} 项失败`);
  if (skipped) parts.push(`${skipped} 项已跳过`);
  if (stopped) parts.push(`${stopped} 项已停止`);
  $("planSummary").textContent = parts.length > 0 ? "同步结束：" + parts.join("；") : "同步执行完成";
  setProgress(100, "同步执行完成");
  setSyncControls("idle");
  showSyncResult(actions);
  refreshAlbums();
}

function showSyncResult(actions) {
  const total = actions.length;
  const success = actions.filter(a => a.status === "已完成").length;
  const failed = actions.filter(a => a.status.startsWith("失败") || a.status.startsWith("错误"));
  const skipped = actions.filter(a => a.status.startsWith("已跳过"));
  const pending = total - success - failed.length - skipped.length;
  let summary = `总项数：${total}  成功：${success}  失败：${failed.length}  已跳过：${skipped.length}`;
  if (pending) summary += `  未执行：${pending}`;
  if (state.syncStartedAt) {
    const elapsed = (Date.now() - state.syncStartedAt) / 1000;
    summary += `  总用时：${formatDuration(elapsed)}`;
    if (success) summary += `  平均：${formatDuration(elapsed / success)}`;
  }
  let detail = [];
  failed.forEach(a => detail.push(`[失败] ${a.album_name} / ${a.media_name || a.action} — ${a.status.split("：").pop()}`));
  skipped.forEach(a => detail.push(`[跳过] ${a.album_name} / ${a.media_name || a.action} — ${a.status.split("：").pop()}`));
  // Open as separate window
  window.api.openSyncResult({ summary, detail: detail.join("\n"), detailCount: detail.length });
}

// === Other buttons ===
$("btnConnect").addEventListener("click", () => {
  if (state.connected) {
    logout();
    return;
  }
  state.loginFromSplash = false;
  openQRLogin();
});

async function logout() {
  if (state.loggingOut) return;
  if (state.syncMode !== "idle") { toast("请先暂停或停止同步再退出登录。", "warning"); return; }
  // 不再先显示 loading——让用户看到登出窗口的自定义退出页面
  state.loggingOut = true;
  try {
    const result = await window.api.startLogout();
    if (!result.success) {
      if (result.reason !== "cancelled") {
        const msgs = { timeout: "登出超时，未检测到会话失效。", no_bduss: "无法注入登录凭证，登出失败。", no_client: "未找到活跃会话。" };
        toast((result.reason && msgs[result.reason]) || "登出失败，本机登录信息仍保留。", "warning");
      }
      return;
    }
    // 登出成功，显示 loading 等待清理完成
    showLogoutLoading();
    await bridge("clear_session");
    await bridge("disconnect");
    state.connected = false;
    state.albums = []; state.currentAlbum = null; state.currentMedia = []; state.syncActions = [];
    setConnected(false);
    $("albumTree").innerHTML = ""; $("mediaTableBody").innerHTML = ""; $("thumbnailGrid").innerHTML = "";
    $("planTableBody").innerHTML = ""; $("syncAlbumTree").innerHTML = "";
    $("mediaTitle").textContent = "选择一个相册以浏览媒体";
    $("planSummary").textContent = "尚未比较";
    hideLogoutLoading();
    setStatus("已退出登录，请重新扫码登录。");
    state.loginFromSplash = false;
    openQRLogin();
  } catch (err) {
    hideLogoutLoading();
    toast("退出登录失败: " + err.message, "error");
  } finally {
    state.loggingOut = false;
  }
}

function showLogoutLoading() {
  let overlay = document.getElementById("logout-loading-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "logout-loading-overlay";
    overlay.style.cssText = "position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(255,255,255,0.95);z-index:999999;display:flex;align-items:center;justify-content:center;flex-direction:column;font-family:Microsoft YaHei,sans-serif;";
    const title = document.createElement("div");
    title.textContent = "正在退出登录";
    title.style.cssText = "font-size:22px;font-weight:700;color:#1d63bf;margin-bottom:12px;";
    const hint = document.createElement("div");
    hint.textContent = "正在清除百度账户会话，请勿关闭窗口。";
    hint.style.cssText = "font-size:14px;color:#718096;margin-bottom:24px;";
    const spinner = document.createElement("div");
    spinner.style.cssText = "width:36px;height:36px;border:3px solid #e0e8f5;border-top-color:#2577d9;border-radius:50%;animation:yike-spin 0.8s linear infinite;";
    const style = document.createElement("style");
    style.textContent = "@keyframes yike-spin{to{transform:rotate(360deg)}}";
    overlay.appendChild(style);
    overlay.appendChild(title);
    overlay.appendChild(hint);
    overlay.appendChild(spinner);
    document.body.appendChild(overlay);
  }
  overlay.style.display = "flex";
}

function hideLogoutLoading() {
  const overlay = document.getElementById("logout-loading-overlay");
  if (overlay) overlay.style.display = "none";
}

$("btnRefresh").addEventListener("click", () => refreshAlbums());
$("btnAlbumRefresh").addEventListener("click", () => refreshAlbums());

$("btnLimits").addEventListener("click", () => {
  alert("接口限制\n相册浏览、创建、删除、重命名，以及媒体浏览、上传、下载、删除已纳入程序。\n\n当前项目没有已验证的远端媒体重命名接口，因此该操作不会执行。为避免重复传输，双向同步中两端已有同名媒体会跳过，不会自动覆盖。");
});

// === Listen for settings saved from settings window ===
window.api.onSettingsSaved((newSettings) => {
  state.settings = { ...state.settings, ...newSettings };
  toast("设置已保存", "info");
});

// === Window close ===
window.api.onCloseRequested(async () => {
  if (state.syncMode !== "idle") {
    try { await bridge("stop_sync"); } catch (err) { /* ignore */ }
  }
  window.api.quit();
});

// === Init ===
async function init() {
  try { $("logoIcon").src = "../assets/yike_sync_256.png"; $("loadingIcon").src = "../assets/yike_sync_256.png"; } catch (err) {}
  splashShownAt = Date.now();
  showLoading("正在准备应用…");
  setLoadingStage(10, "正在准备应用…");
  try {
    const settings = await bridge("get_settings");
    state.settings = settings;
    if (settings.local_root) $("localRoot").value = settings.local_root;
    if (settings.media_browser_view_mode) $("mediaViewMode").value = settings.media_browser_view_mode;
    // Apply view mode from saved setting
    const savedMode = $("mediaViewMode").value;
    $("mediaDetailView").classList.toggle("active", savedMode === "details");
    $("mediaThumbnailView").classList.toggle("active", savedMode === "thumbnails");
  } catch (err) { console.error("Init settings failed:", err); }
  setLoadingStage(30, "正在检查账号权限…");
  await startLogin();
}

init();
