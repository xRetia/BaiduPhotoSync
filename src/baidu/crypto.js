"use strict";

/**
 * RC4 + Base64 加密 — 移植自 vendor/pybaiduphoto/cooperation/muyangren907_shoot_time.py
 * 用于上传时 media_info 字段的加密。
 */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";

/** G(e): string → byte array (charCodeAt) */
function G(e) {
  const t = [];
  for (let n = 0, i = e.length; n < i; ++n) t.push(e.charCodeAt(n) & 0xff);
  return t;
}

/** Q(e): RC4 KSA — produces permutation array from key */
function Q(e) {
  const H = [];
  for (let i = 0; i < 256; i++) H.push(i);
  let t = 0;
  const n = H;
  const i = e.length;
  for (let o = 0; o < 256; ++o) {
    t = (t + n[o] + e[o % i]) % 256;
    const tmp = n[t];
    n[t] = n[o];
    n[o] = tmp;
  }
  return n;
}

/** Vchange(e): key string → ksa array */
function Vchange(e) {
  const t = G(e);
  return Q(t);
}

/** q(e, t, n, i): RC4 PRGA — XOR e with ksa(t), output into n, length i */
function q(e, t, n, i) {
  let o = 0, r = 0;
  const a = n;
  const s = t.slice(); // copy ksa state
  for (let c = 0; c < i; ++c) {
    o = (o + 1) % 256;
    r = (r + s[o]) % 256;
    const tmp = s[r];
    s[r] = s[o];
    s[o] = tmp;
    a[c] = e[c] ^ s[(s[o] + s[r]) % 256];
  }
  return a;
}

/** Rencode(e): byte array → Base64 string */
function Rencode(e) {
  return Buffer.from(e).toString("base64");
}

/**
 * JencodeString(strin): 加密字符串，密钥固定 7FED2719FC7E4D5602FB1D9D11AFA01B
 * 对应 Python: JencodeString(strin)
 */
function JencodeString(strin) {
  const e = "7FED2719FC7E4D5602FB1D9D11AFA01B";
  const t = G(strin);
  const n = t.length;
  const ksa = Vchange(e);
  const i = q(t, ksa, new Array(n), n);
  return Rencode(i);
}

/**
 * timestamp_to_strtime2(timestamp): 转 UTC ISO 格式 (用于 media_info)
 * 对应 Python: timestamp_to_strtime2(timestamp)
 */
function timestamp_to_strtime2(timestamp) {
  const d = new Date(timestamp * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const h = String(d.getUTCHours()).padStart(2, "0");
  const min = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  return `${y}-${m}-${day}T${h}:${min}:${s}.000Z`;
}

/**
 * getCreateTime(path): 获取文件最早的三个时间戳中的最小值（秒）
 * 对应 Python: getCreateTime(media_path)
 */
function getCreateTime(fs, stat) {
  return Math.min(stat.ctimeMs / 1000, stat.mtimeMs / 1000, stat.atimeMs / 1000);
}

/**
 * getMediaInfo_interface(filePath): 生成加密后的 media_info 字段
 * 对应 Python: getMediaInfo_interface(media_path)
 */
function getMediaInfo_interface(filePath, fs) {
  const stat = fs.statSync(filePath);
  const shoot_time = getCreateTime(fs, stat);
  const fileSize = stat.size;
  const media_info_str = `{"file":{"creation_time":"${timestamp_to_strtime2(shoot_time)}","file_size":${fileSize}}}`;
  return JencodeString(media_info_str);
}

/**
 * funcS(j, r): RC4 签名算法（用于批量下载签名）
 * 对应 Python: General.funcS(j, r)
 * 注意：Python chr(ord(r[q]) ^ k) 会产生 Unicode 码点，JS 用 String.fromCharCode 等价。
 */
function funcS(j, r) {
  const a = [];
  const p = [];
  const v = j.length;
  for (let q = 0; q < 256; q++) {
    a.push(j.charCodeAt(q % v));
    p.push(q);
  }
  let u = 0;
  for (let q = 0; q < 256; q++) {
    u = (u + p[q] + a[q]) % 256;
    const t = p[q];
    p[q] = p[u];
    p[u] = t;
  }
  let i = 0, o = 0;
  let result = "";
  for (let q = 0; q < r.length; q++) {
    i = (i + 1) % 256;
    u = (u + p[i]) % 256;
    const t = p[i];
    p[i] = p[u];
    p[u] = t;
    const k = p[(p[i] + p[u]) % 256];
    o += String.fromCharCode(r.charCodeAt(q) ^ k);
  }
  return o;
}

/**
 * get_sign_by_sign1sign2sign3(sign1, sign2, sign3): 批量下载签名
 * 对应 Python: General.get_sign_by_sign1sign2sign3(sign1, sign2, sign3)
 * sign = base64encode(funcS(sign3, sign1).encode("latin1"))
 */
function get_sign_by_sign1sign2sign3(sign1, sign2, sign3) {
  const encrypted = funcS(sign3, sign1);
  // Python .encode("latin1") → 每个字符转成其 Unicode 码点对应的字节
  const bytes = Buffer.alloc(encrypted.length);
  for (let i = 0; i < encrypted.length; i++) {
    bytes[i] = encrypted.charCodeAt(i) & 0xff;
  }
  return bytes.toString("base64");
}

module.exports = {
  JencodeString,
  getMediaInfo_interface,
  funcS,
  get_sign_by_sign1sign2sign3,
};
