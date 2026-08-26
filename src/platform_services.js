"use strict";

/**
 * 平台服务 — 移植自 platform_services.py
 * 用纯 Node.js 实现，无 PySide6/Qt 依赖。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync, spawn } = require("child_process");

const APPLICATION_DIRECTORY_NAME = "BaiduPhotoSync";

/**
 * 返回应用数据目录路径（不创建目录）。
 * 供 migrate 等逻辑在创建目录之前检查路径用。
 */
function _appDataPath() {
  let base;
  if (process.platform === "win32") {
    base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  } else if (process.platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support");
  } else {
    base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  }
  return path.join(base, APPLICATION_DIRECTORY_NAME);
}

function app_data_directory() {
  const d = _appDataPath();
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function open_system_viewer(filePath) {
  try {
    let proc;
    if (process.platform === "win32") {
      proc = spawn("cmd", ["/c", "start", "", filePath], { stdio: "ignore", shell: false });
    } else if (process.platform === "darwin") {
      proc = spawn("open", [filePath], { stdio: "ignore", shell: false });
    } else {
      proc = spawn("xdg-open", [filePath], { stdio: "ignore", shell: false });
    }
    // 如果进程成功启动（无 error 事件），视为成功
    return new Promise((resolve) => {
      proc.on("error", () => resolve(false));
      // 给进程 100ms 启动窗口，无 error 即认为启动成功
      setTimeout(() => resolve(true), 100);
    });
  } catch (err) {
    return Promise.resolve(false);
  }
}

function clear_windows_registry_settings() {
  if (process.platform !== "win32") return;
  try {
    execSync(
      `reg delete "HKCU\\Software\\Baidu\\BaiduPhotoSync" /f`,
      { stdio: "ignore" }
    );
  } catch (e) {
    // Key may not exist; ignore
  }
}

function remove_application_data() {
  const roots = new Set([app_data_directory()]);
  if (process.platform === "win32") {
    const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    roots.add(path.join(appdata, "BaiduPhotoSync"));
    roots.add(path.join(appdata, "YikeSync"));
  }
  for (const root of roots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (e) {
      // ignore
    }
  }
}

function migrate_legacy_windows_data() {
  if (process.platform !== "win32") return;
  const legacy = path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    APPLICATION_DIRECTORY_NAME
  );
  const current = _appDataPath();   // 不创建目录，仅取路径
  if (legacy === current || !fs.existsSync(legacy) || fs.existsSync(current)) return;
  try {
    fs.mkdirSync(path.dirname(current), { recursive: true });
    fs.renameSync(legacy, current);
  } catch (e) {
    // Failed migration must never prevent startup
  }
}

module.exports = {
  APPLICATION_DIRECTORY_NAME,
  app_data_directory,
  open_system_viewer,
  clear_windows_registry_settings,
  remove_application_data,
  migrate_legacy_windows_data,
};
