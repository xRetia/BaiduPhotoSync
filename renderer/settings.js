"use strict";

// === 设置窗口逻辑 ===

const SYNC_DIRECTIONS = [
  "本地 → 云端",
  "云端 → 本地",
  "双向",
];

const SORT_FIELDS = [
  "按文件夹名称",
  "按文件夹修改日期",
  "按文件夹创建日期",
];

const COMPARE_MODES = [
  "智能（推荐：同名视频压缩版 + 内容去重）",
  "仅按文件名（同名即视为已同步）",
  "内容优先（同名非视频内容不同标记冲突）",
];

// --- Helpers ---
const $ = (id) => document.getElementById(id);

// 应用主题到设置窗口（读取保存的 theme_pref）
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
}

async function initTheme() {
  try {
    const settings = await bridge("get_settings");
    const pref = settings.theme_pref || "auto";
    let theme = pref;
    if (pref === "auto") {
      theme = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
    }
    applyTheme(theme);
    // 系统主题变化时自动跟随
    if (window.matchMedia) {
      const mq = window.matchMedia("(prefers-color-scheme: light)");
      const onChange = () => {
        if (pref === "auto") {
          applyTheme(mq.matches ? "light" : "dark");
        }
      };
      if (mq.addEventListener) mq.addEventListener("change", onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  } catch (err) {
    // 读取失败时保持默认（暗色）
    console.error("Init theme failed:", err);
  }
}

async function bridge(method, params = {}) {
  return await window.api.call(method, params);
}

function formatSize(bytes) {
  let size = parseFloat(bytes);
  for (const unit of ["B", "KB", "MB", "GB"]) {
    if (size < 1024 || unit === "GB") return unit === "B" ? `${Math.round(size)} B` : `${size.toFixed(1)} ${unit}`;
    size /= 1024;
  }
  return String(bytes);
}

// --- Navigation ---
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((n) => n.classList.remove("active"));
    document.querySelectorAll(".page").forEach((p) => p.classList.remove("active"));
    item.classList.add("active");
    $("page-" + item.dataset.page).classList.add("active");
  });
});

// --- Populate dropdowns ---
function populateSelect(selectEl, options, currentValue) {
  selectEl.innerHTML = "";
  options.forEach((opt) => {
    const option = document.createElement("option");
    option.value = opt;
    option.textContent = opt;
    selectEl.appendChild(option);
  });
  // Match current value or default to first
  const found = options.includes(currentValue);
  if (found) selectEl.value = currentValue;
  else if (options.length > 0) selectEl.value = options[0];
}

// --- Load settings ---
async function loadSettings() {
  let settings = {};
  try {
    settings = await bridge("get_settings");
  } catch (err) {
    console.error("Failed to load settings:", err);
  }

  // Sync page
  populateSelect($("direction"), SYNC_DIRECTIONS, settings.direction || SYNC_DIRECTIONS[0]);
  populateSelect($("sort_field"), SORT_FIELDS, settings.sort_field || SORT_FIELDS[0]);
  $("reverse").value = String(settings.reverse === true || settings.reverse === "true");
  populateSelect($("file_compare_mode"), COMPARE_MODES, settings.file_compare_mode || COMPARE_MODES[0]);
  $("deletion").checked = settings.deletion === true || settings.deletion === "true";

  // Transfer page
  $("skip_oversize").checked = settings.skip_oversize !== false;
  $("file_client_workers").value = parseInt(settings.file_client_workers) || 4;
  $("download_client_workers").value = parseInt(settings.download_client_workers) || 4;
  $("list_threads").value = parseInt(settings.list_threads) || 8;
  $("download_cache_mib").value = parseInt(settings.download_cache_mib) || 1024;

  // Video page
  $("compress_oversize_videos").checked = settings.compress_oversize_videos === true || settings.compress_oversize_videos === "true";

  // Advanced page
  $("debug_logging").checked = settings.debug_logging !== false;
  $("enhanced_keepalive").checked = settings.enhanced_keepalive === true || settings.enhanced_keepalive === "true";
}

// --- Save settings ---
async function saveSettings() {
  const savedSettings = {
    direction: $("direction").value,
    sort_field: $("sort_field").value,
    reverse: $("reverse").value === "true",
    file_compare_mode: $("file_compare_mode").value,
    deletion: $("deletion").checked,
    skip_oversize: $("skip_oversize").checked,
    file_client_workers: parseInt($("file_client_workers").value) || 4,
    download_client_workers: parseInt($("download_client_workers").value) || 4,
    list_threads: parseInt($("list_threads").value) || 8,
    download_cache_mib: parseInt($("download_cache_mib").value) || 1024,
    compress_oversize_videos: $("compress_oversize_videos").checked,
    debug_logging: $("debug_logging").checked,
    enhanced_keepalive: $("enhanced_keepalive").checked,
  };

  try {
    await bridge("save_settings", savedSettings);
    // 通知主窗口设置已保存
    window.api.notifySettingsSaved(savedSettings);
  } catch (err) {
    alert("保存设置失败：" + (err.message || err));
  }
}

// --- Cache info ---
async function refreshCacheUsage() {
  try {
    const info = await bridge("get_cache_info");
    const used = formatSize(info.size_bytes);
    const max = formatSize(info.max_bytes);
    $("cacheUsage").textContent = `当前占用：${used} / ${max}`;
  } catch (err) {
    $("cacheUsage").textContent = "无法读取缓存信息";
  }
}

// --- Clear cache ---
$("btnClearCache").addEventListener("click", async () => {
  if (!confirm("确认清理下载缓存？\n这将删除本地缓存文件，不影响云端文件或本地同步目录。")) return;
  try {
    const result = await bridge("clear_download_cache");
    alert(`已清理 ${formatSize(result.reclaimed)} 缓存空间。`);
    refreshCacheUsage();
  } catch (err) {
    alert("清理缓存失败：" + (err.message || err));
  }
});

// --- 极光视频压制引擎 (FFmpeg) ---
// 引擎可用时启用压缩复选框；不可用时禁用并提示
function setEngineReady(ready) {
  $("compress_oversize_videos").disabled = !ready;
}

async function checkFFmpeg() {
  try {
    const result = await bridge("check_ffmpeg");
    if (result.available) {
      $("ffmpegStatus").textContent = "极光视频压制引擎已就绪，可启用视频压缩。";
      $("ffmpegDownloadRow").style.display = "none";
      setEngineReady(true);
    } else {
      $("ffmpegStatus").textContent = "未检测到极光视频压制引擎。如需要视频压缩，请选择下载来源后点击按钮下载并安装。";
      $("ffmpegDownloadRow").style.display = "flex";
      setEngineReady(false);
      $("compress_oversize_videos").checked = false;
    }
  } catch (err) {
    $("ffmpegStatus").textContent = "检测极光视频压制引擎失败：" + (err.message || err);
    setEngineReady(false);
    $("compress_oversize_videos").checked = false;
  }
}

// 下载进度更新（main.js 通过 bridge:progress 发送）
window.api.onProgress((value, text) => {
  if (document.visibilityState === "hidden") return;
  if (!$("ffmpegProgressRow") || $("ffmpegProgressRow").style.display === "none") return;
  const pct = Math.max(0, Math.min(100, Math.round(value)));
  $("ffmpegProgressBar").style.width = pct + "%";
  // 界面统一使用"极光视频压制引擎"名称，隐藏底层 FFmpeg 术语
  let label = (text || (pct + "%")).replace(/FFmpeg/g, "极光视频压制引擎");
  $("ffmpegProgressText").textContent = label;
  if (pct >= 100) {
    $("ffmpegProgressText").textContent = "校验完成，正在完成安装…";
  }
});

// Download 极光视频压制引擎（FFmpeg）—— 同一按钮兼作下载/取消
let ffmpegDownloading = false;
$("btnDownloadFFmpeg").addEventListener("click", async () => {
  // 下载中点击则取消
  if (ffmpegDownloading) {
    try { await bridge("cancel_ffmpeg"); } catch {}
    return;
  }
  const source = $("ffmpegSource") ? $("ffmpegSource").value : "official";
  const sourceLabel = source === "mirror" ? "国内镜像" : "官方源";
  ffmpegDownloading = true;
  $("btnDownloadFFmpeg").disabled = false;
  $("btnDownloadFFmpeg").textContent = "取消下载";
  $("ffmpegProgressRow").style.display = "flex";
  setEngineReady(false);
  try {
    const result = await bridge("download_ffmpeg", { source });
    $("ffmpegProgressRow").style.display = "none";
    if (result.cancelled) {
      $("ffmpegStatus").textContent = "已取消下载极光视频压制引擎。";
      $("btnDownloadFFmpeg").textContent = "下载极光视频压制引擎";
    } else if (result.downloaded) {
      $("ffmpegStatus").textContent = `极光视频压制引擎（${sourceLabel}）下载完成，已可使用视频压缩。`;
      $("ffmpegDownloadRow").style.display = "none";
      setEngineReady(true);
    } else {
      $("ffmpegStatus").textContent = "极光视频压制引擎已就绪，可直接使用。";
      $("ffmpegDownloadRow").style.display = "none";
      setEngineReady(true);
    }
  } catch (err) {
    $("ffmpegStatus").textContent = `下载极光视频压制引擎（${sourceLabel}）失败：${err.message || err}`;
    $("btnDownloadFFmpeg").textContent = "下载极光视频压制引擎";
    $("ffmpegProgressRow").style.display = "none";
  } finally {
    ffmpegDownloading = false;
  }
});

// --- Reset application ---
$("btnResetApp").addEventListener("click", async () => {
  if (!confirm(
    "重置应用\n\n" +
    "此操作将删除本程序在当前系统用户下留下的全部本地数据，且无法撤销：\n" +
    "• 应用设置与登录会话\n" +
    "• 应用数据目录下的全部缓存与 FFmpeg\n" +
    "• 程序目录下的 error.log\n\n" +
    "完成后需要重新扫码登录，正在进行的同步会被中断。确定继续吗？"
  )) return;

  try {
    await bridge("reset_application");
    alert("应用已重置。程序将退出，请重新启动。");
    window.api.quit();
  } catch (err) {
    alert("重置失败：" + (err.message || err));
  }
});

// --- Footer buttons ---
$("btnSave").addEventListener("click", () => saveSettings());
$("btnCancel").addEventListener("click", () => window.close());

// --- Init ---
(async function init() {
  await loadSettings();
  await initTheme();
  await refreshCacheUsage();
  // 极光视频压制引擎（FFmpeg）状态检查：决定压缩复选框是否可勾选
  checkFFmpeg();
})();
