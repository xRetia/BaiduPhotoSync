"use strict";

/**
 * HTTP 请求层 — 移植自 vendor/pybaiduphoto/Requests.py
 * 封装 cookie 传递、bdstoken 探测、自动注入、超时重试。
 * Node 用内置 fetch (Node 18+) 实现，无需外部依赖。
 */

const https = require("https");
const http = require("http");
const crypto = require("crypto");

const FIXED_HEADERS = {
  "Connection": "keep-alive",
  "sec-ch-ua": '" Not A;Brand";v="99", "Chromium";v="99", "Google Chrome";v="99"',
  "Accept": "application/json, text/plain, */*",
  "X-Requested-With": "XMLHttpRequest",
  "sec-ch-ua-mobile": "?0",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36",
  "sec-ch-ua-platform": '"macOS"',
  "Sec-Fetch-Site": "same-origin",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Dest": "empty",
  "Referer": "https://photo.baidu.com/photo/web/home",
  "Accept-Language": "zh-CN,zh;q=0.9,zh-TW;q=0.8,en;q=0.7",
};

const TRANSPORT_RETRY_DELAYS = [1, 2, 4]; // seconds
const CONNECT_TIMEOUT_MS = 10000;
const READ_TIMEOUT_MS = 30000;

class Requests {
  constructor(cookies) {
    this.cookies = cookies; // { name: value }
    this.bdstoken = null;
  }

  /** Build Cookie header string from cookies dict */
  _cookieHeader() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join("; ");
  }

  /** Build URL with query params */
  _buildURL(url, params) {
    if (!params) return url;
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        u.searchParams.set(k, String(v));
      }
    }
    return u.toString();
  }

  /** GET bdstoken from photo.baidu.com home page */
  async get_bdstoken() {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const resp = await fetch("https://photo.baidu.com/photo/web/home", {
        headers: { ...FIXED_HEADERS, Cookie: this._cookieHeader() },
        signal: controller.signal,
      });
      clearTimeout(timeout);
      const text = await resp.text();
      let d = null;
      for (const line of text.split("\n")) {
        if (line.includes("templateData")) {
          d = line;
          break;
        }
      }
      if (!d) {
        console.error("can not get bdstoken");
        return null;
      }
      // Python: l.split("=")[1].split(";")[0].split(",")[0].split(":")[1].replace("'", "").strip()
      const token = d
        .split("=")[1]
        .split(";")[0]
        .split(",")[0]
        .split(":")[1]
        .replace(/'/g, "")
        .trim();
      return token;
    } catch (err) {
      console.warn("bdstoken login probe failed quickly:", err.name);
      return null;
    }
  }

  async get_bdstoken_Cache() {
    if (this.bdstoken === null) {
      this.bdstoken = await this.get_bdstoken();
    }
    return this.bdstoken;
  }

  /** Calculate POST socket timeout based on body size */
  _postTimeout(bodySize) {
    const bytesPerSecond = 128 * 1024;
    const uploadSeconds = Math.ceil(Math.max(0, bodySize) / bytesPerSecond);
    return Math.min(2700000, 90000 + uploadSeconds * 1000); // ms
  }

  /** Core fetch with timeout and transport-level retry */
  async _fetch(url, options, timeoutMs, noRetry = false, bodyBuffer = null) {
    let attempt = 0;
    while (true) {
      attempt++;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);
        const fetchOpts = {
 ...options,
 signal: controller.signal,
 headers: {
 ...options.headers,
 Cookie: this._cookieHeader(),
 },
        };
        const resp = await fetch(url, fetchOpts);
        clearTimeout(timeout);
        return resp;
      } catch (err) {
        if (
          noRetry ||
          attempt > TRANSPORT_RETRY_DELAYS.length ||
          err.name === "AbortError" && attempt > 1
        ) {
          throw err;
        }
        const delay = TRANSPORT_RETRY_DELAYS[attempt - 1];
        console.warn(
 `传输层错误（${err.name}），${delay}秒后重试（第 ${attempt}/${TRANSPORT_RETRY_DELAYS.length} 次）`
        );
        await new Promise((r) => setTimeout(r, delay * 1000));
      }
    }
  }

  /** GET request, auto-inject bdstoken param */
  async get(url, params = {}, options = {}) {
    const token = await this.get_bdstoken_Cache();
    const fullParams = { ...params, bdstoken: token };
    const fullURL = this._buildURL(url, fullParams);
    const timeoutMs = options.timeout || CONNECT_TIMEOUT_MS;
    return this._fetch(fullURL, {
 method: "GET",
 headers: { ...FIXED_HEADERS },
    }, timeoutMs, options._yike_no_retry);
  }

  /** POST request, auto-inject bdstoken param */
  async post(url, params = {}, data = null, options = {}) {
    const token = await this.get_bdstoken_Cache();
    const fullParams = { ...params, bdstoken: token };
    const fullURL = this._buildURL(url, fullParams);

    let body = null;
    let headers = { ...FIXED_HEADERS };
    let bodySize = 0;

    if (data) {
      if (data instanceof Buffer) {
        body = data;
        bodySize = data.length;
      } else if (typeof data === "object" && data._isFormData) {
        // Multipart form data (for file upload)
        body = data.buffer;
        bodySize = data.buffer.length;
        headers["Content-Type"] = data.contentType;
      } else {
        // URL-encoded form data
        const formBody = new URLSearchParams();
        for (const [k, v] of Object.entries(data)) {
          formBody.set(k, String(v));
        }
        body = formBody.toString();
        bodySize = Buffer.byteLength(body);
        headers["Content-Type"] = "application/x-www-form-urlencoded";
      }
    }

    const timeoutMs = options.timeout || this._postTimeout(bodySize);
    return this._fetch(fullURL, {
 method: "POST",
 headers,
 body,
    }, timeoutMs, options._yike_no_retry);
  }

  /** GET and parse JSON */
  async getReqJson(url, params = {}, options = {}) {
    const resp = await this.get(url, params, options);
    const data = await resp.json();
    if (data.errno !== 0) {
      console.error("request return error, return =", JSON.stringify(data).slice(0, 500));
    }
    return data;
  }

  /** POST and parse JSON */
  async postReqJson(url, params = {}, data = null, options = {}) {
    const resp = await this.post(url, params, data, options);
    const json = await resp.json();
    if (json.errno !== 0) {
      console.error("request return error, return =", JSON.stringify(json).slice(0, 500));
    }
    return json;
  }
}

/** Build multipart/form-data body from fields and file */
function buildMultipartFile(fileName, fileBuffer, fieldName) {
  const boundary = "----WebKitFormBoundary" + crypto.randomBytes(16).toString("hex");
  const parts = [];

  // File part
  const field = fieldName || fileName;
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`;
  parts.push(Buffer.from(header, "utf-8"));
  parts.push(fileBuffer);
  parts.push(Buffer.from("\r\n", "utf-8"));

  // Closing boundary
  parts.push(Buffer.from(`--${boundary}--\r\n`, "utf-8"));

  const buffer = Buffer.concat(parts);
  return {
    buffer,
    contentType: `multipart/form-data; boundary=${boundary}`,
    _isFormData: true,
  };
}

module.exports = { Requests, buildMultipartFile, FIXED_HEADERS };
