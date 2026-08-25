"use strict";

/**
 * 统一日志工具。
 *
 * 输出格式：[2026-08-25 14:30:00.123] [DEBUG] [main] 消息内容
 *
 * 用法：
 *   const log = require("./src/logger");
 *   log.debug("main", "会话保活已启动");
 *   log.warn("keepalive", "页面加载失败:", err.message);
 *   log.error("bridge", "list_media 失败:", err);
 *
 * 也支持创建带固定模块名的 logger：
 *   const log = require("./src/logger").create("remote_client");
 *   log.debug("相册列表已缓存");
 *   log.error("上传失败:", err);
 */

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

function timestamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.` +
    `${String(d.getMilliseconds()).padStart(3, "0")}`
  );
}

function formatMsg(msg) {
  if (msg === null || msg === undefined) return "";
  if (typeof msg === "string") return msg;
  if (msg instanceof Error) return msg.message || String(msg);
  try {
    return JSON.stringify(msg);
  } catch {
    return String(msg);
  }
}

function emit(levelName, module, args) {
  const parts = [];
  for (const a of args) {
    if (a instanceof Error) {
      parts.push(a.message || String(a));
    } else {
      parts.push(formatMsg(a));
    }
  }
  const msg = parts.join(" ");
  const line = `[${timestamp()}] [${levelName}] [${module}] ${msg}`;
  if (levelName === "ERROR") {
    process.stderr.write(line + "\n");
  } else if (levelName === "WARN") {
    process.stderr.write(line + "\n");
  } else {
    process.stdout.write(line + "\n");
  }
}

const logger = {
  debug(module, ...args) {
    emit("DEBUG", module, args);
  },
  info(module, ...args) {
    emit("INFO", module, args);
  },
  warn(module, ...args) {
    emit("WARN", module, args);
  },
  error(module, ...args) {
    emit("ERROR", module, args);
  },
  /**
   * 创建带固定模块名的子 logger。
   * @param {string} module - 模块名
   * @returns {{debug:Function, info:Function, warn:Function, error:Function}}
   */
  create(module) {
    return {
      debug: (...args) => emit("DEBUG", module, args),
      info: (...args) => emit("INFO", module, args),
      warn: (...args) => emit("WARN", module, args),
      error: (...args) => emit("ERROR", module, args),
    };
  },
};

module.exports = logger;
