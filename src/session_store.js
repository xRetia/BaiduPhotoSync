"use strict";

/**
 * 会话安全存储 — 移植自 session_store.py
 * Windows: 使用 Electron safeStorage (DPAPI) 加密
 * macOS/Linux: 使用 keytar/keychain
 * 在 Electron 主进程中使用 safeStorage API。
 */
const fs = require("fs");
const path = require("path");
const { app_data_directory } = require("./platform_services");

const SESSION_FILE = "session.enc";

class SessionStore {
  constructor(safeStorage) {
    this.safeStorage = safeStorage;
    this.dataDir = app_data_directory();
    this.sessionPath = path.join(this.dataDir, SESSION_FILE);
  }

  /** Load saved session. Returns cookie text or empty string. */
  load() {
    try {
      if (!fs.existsSync(this.sessionPath)) return "";
      const encrypted = fs.readFileSync(this.sessionPath);
      if (!encrypted || encrypted.length === 0) return "";
      if (!this.safeStorage.isEncryptionAvailable()) return "";
      const plain = this.safeStorage.decryptString(encrypted);
      return plain || "";
    } catch (err) {
      // Decryption failed (maybe different user or corrupted)
      this.clear();
      return "";
    }
  }

  /** Save cookie text encrypted. */
  save(cookieText) {
    if (!cookieText || !cookieText.trim()) {
      throw new Error("不能保存空的登录会话。");
    }
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error("系统安全存储不可用，登录会话仅在本次运行有效。");
    }
    const encrypted = this.safeStorage.encryptString(cookieText);
    fs.mkdirSync(this.dataDir, { recursive: true });
    fs.writeFileSync(this.sessionPath, encrypted);
  }

  /** Clear saved session. */
  clear() {
    try {
      if (fs.existsSync(this.sessionPath)) fs.unlinkSync(this.sessionPath);
    } catch (e) {
      // ignore
    }
  }
}

module.exports = { SessionStore };
