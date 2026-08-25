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

// --- FFmpeg ---
async function checkFFmpeg() {
  try {
    const result = await bridge("check_ffmpeg");
    if (result.available) {
      $("ffmpegStatus").textContent = "FFmpeg 已安装，可直接使用视频压缩功能。";
      $("ffmpegSection").style.display = "block";
      $("btnDownloadFFmpeg").style.display = "none";
    } else {
      $("ffmpegStatus").textContent = "未检测到 FFmpeg，需要下载后才能压缩视频。";
      $("ffmpegSection").style.display = "block";
      $("btnDownloadFFmpeg").style.display = "inline-block";
    }
  } catch (err) {
    $("ffmpegStatus").textContent = "检测 FFmpeg 失败：" + (err.message || err);
    $("ffmpegSection").style.display = "block";
  }
}

// Show FFmpeg section when compress checkbox is toggled
$("compress_oversize_videos").addEventListener("change", () => {
  if ($("compress_oversize_videos").checked) {
    $("ffmpegSection").style.display = "block";
    checkFFmpeg();
  } else {
    $("ffmpegSection").style.display = "none";
  }
});

// Download FFmpeg
$("btnDownloadFFmpeg").addEventListener("click", async () => {
  $("btnDownloadFFmpeg").disabled = true;
  $("ffmpegStatus").textContent = "正在下载 FFmpeg…";
  try {
    const result = await bridge("download_ffmpeg");
    if (result.downloaded) {
      $("ffmpegStatus").textContent = "FFmpeg 下载完成，已可使用视频压缩功能。";
      $("btnDownloadFFmpeg").style.display = "none";
    } else {
      $("ffmpegStatus").textContent = "FFmpeg 已存在，无需下载。";
      $("btnDownloadFFmpeg").style.display = "none";
    }
  } catch (err) {
    $("ffmpegStatus").textContent = "下载 FFmpeg 失败：" + (err.message || err);
    $("btnDownloadFFmpeg").disabled = false;
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
  await refreshCacheUsage();
  // If compress is already enabled, check FFmpeg on load
  if ($("compress_oversize_videos").checked) {
    checkFFmpeg();
  }
})();
