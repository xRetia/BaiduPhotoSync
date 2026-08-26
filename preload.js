"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // Bridge RPC call
  call: (method, params) => ipcRenderer.invoke("bridge:call", method, params),

  // QR login
  openQRLogin: () => ipcRenderer.invoke("qr-login:open"),
  onQRLoginCookie: (callback) => {
    ipcRenderer.on("qr-login-cookie", (_e, cookieJson) => callback(cookieJson));
  },
  onQRLoginClosed: (callback) => {
    ipcRenderer.on("qr-login-closed", () => callback());
  },
  closeQRLogin: () => ipcRenderer.send("qr-login:close"),
  retryQRLogin: () => ipcRenderer.send("qr-login:retry"),
  onQRLoginLoading: (callback) => {
    ipcRenderer.on("qr-login-loading", () => callback());
  },
  onQRLoginLoadingHide: (callback) => {
    ipcRenderer.on("qr-login-loading-hide", () => callback());
  },

  // Logout
  startLogout: () => ipcRenderer.invoke("logout:start"),

  // Bridge event listeners (progress/status/alert)
  onProgress: (callback) => {
    ipcRenderer.on("bridge:progress", (_e, value, text) => callback(value, text));
  },
  onStatus: (callback) => {
    ipcRenderer.on("bridge:status", (_e, seq, text) => callback(seq, text));
  },
  onAlert: (callback) => {
    ipcRenderer.on("bridge:alert", (_e, message) => callback(message));
  },

  // Execute plan async completion / error
  onExecuteComplete: (callback) => {
    ipcRenderer.on("bridge:execute-complete", (_e, actions) => callback(actions));
  },
  onExecuteError: (callback) => {
    ipcRenderer.on("bridge:execute-error", (_e, message) => callback(message));
  },

  // Dialogs
  openDirectory: () => ipcRenderer.invoke("dialog:openDirectory"),
  openFiles: () => ipcRenderer.invoke("dialog:openFiles"),

  // Shell
  openPath: (filePath) => ipcRenderer.invoke("shell:openPath", filePath),

  // Clipboard
  readClipboardText: () => ipcRenderer.invoke("clipboard:readText"),

  // App
  quit: () => ipcRenderer.invoke("app:quit"),
  platform: process.platform,
  onCloseRequested: (callback) => {
    ipcRenderer.on("app-close-requested", () => callback());
  },

  // Settings window
  openSettings: () => ipcRenderer.invoke("settings:open"),
  notifySettingsSaved: (settings) => ipcRenderer.send("settings:saved-notify", settings),
  onSettingsSaved: (callback) => {
    ipcRenderer.on("settings-saved", (_e, settings) => callback(settings));
  },

  // Sync result window
  openSyncResult: (data) => ipcRenderer.invoke("sync-result:open", data),
  onSyncResultData: (callback) => {
    ipcRenderer.on("sync-result:data", (_e, data) => callback(data));
  },

  // Drag & drop
  // 拖入：获取 File 对象对应的本地真实路径
  getPathForFile: (file) => webUtils.getPathForFile(file),
  // 预下载拖出：下载到临时目录后，在渲染进程 dragstart 内同步调用
  startDrag: (paths) => ipcRenderer.sendSync("drag:start-drag", paths),
});
