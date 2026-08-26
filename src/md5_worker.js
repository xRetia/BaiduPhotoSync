"use strict";

// 计算文件 MD5 的 worker（由 Md5Pool 通过 worker_threads 调用）
// 在独立线程中流式读取文件并计算 MD5，实现真正的并行计算以加快比对速度。

const { parentPort } = require("worker_threads");
const fs = require("fs");
const crypto = require("crypto");

async function computeMd5(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("md5");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

if (parentPort) {
  parentPort.on("message", async (msg) => {
    if (msg && msg.type === "md5") {
      try {
        const hash = await computeMd5(msg.path);
        parentPort.postMessage({ id: msg.id, hash });
      } catch (err) {
        parentPort.postMessage({ id: msg.id, error: String((err && err.message) || err) });
      }
    }
  });
}

module.exports = { computeMd5 };
