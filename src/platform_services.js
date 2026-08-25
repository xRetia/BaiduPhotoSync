"use strict";

/**
 * 平台服务 — 移植自 platform_services.py
 * 用纯 Node.js 实现，无 PySide6/Qt 依赖。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");

const APPLICATION_DIRECTORY_NAME = "BaiduPhotoSync";

function app_data_directory() {
  let base;
  if (process.platform === "win32") {
    base = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"));
  } else if (process.platform === "darwin") {
    base = path.join(os.homedir(), "Library", "Application Support");
  } else {
    base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  }
  const d = path.join(base, APPLICATION_DIRECTORY_NAME);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function open_system_viewer(filePath) {
  try {
    const { exec } = require("child_process");
    if (process.platform === "win32") {
      exec(`start "" "${filePath}"`);
    } else if (process.platform === "darwin") {
      exec(`open "${filePath}"`);
    } else {
      exec(`xdg-open "${filePath}"`);
    }
    return true;
  } catch (err) {
    return false;
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
  const current = app_data_directory();
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
