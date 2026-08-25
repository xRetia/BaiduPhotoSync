"use strict";

/**
 * 百度相册 API 库 — 移植自 vendor/pybaiduphoto/API.py + General.py + Album.py + OnlineItem.py
 * 提供相册列表、媒体列表、上传三段式、下载、删除、创建/重命名/删除相册等接口。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Requests, buildMultipartFile } = require("./requests");
const { getMediaInfo_interface, get_sign_by_sign1sign2sign3 } = require("./crypto");

const BASE = "https://photo.baidu.com";

// ========== General (上传/下载核心算法) ==========

class General {
  constructor(req) {
    this.req = req;
  }

  /** 读取文件完整信息：二进制、MD5、时间戳、media_info */
  get_file_fullContent(filePath) {
    const bin = fs.readFileSync(filePath);
    const md5 = crypto.createHash("md5").update(bin).digest("hex");
    const stat = fs.statSync(filePath);
    return {
      fileName: path.basename(filePath),
      localFilePath: filePath,
      size: stat.size,
      ctime: Math.floor(stat.ctimeMs / 1000),
      mtime: Math.floor(stat.mtimeMs / 1000),
      md5,
      bin,
      media_info: getMediaInfo_interface(filePath, fs),
    };
  }

  /** 上传步骤1: precreate */
  async upload_step1_preCreate(fileFull) {
    const postdata = {
      autoinit: "1",
      block_list: `["${fileFull.md5}"]`,
      isdir: "0",
      rtype: "1",
      ctype: "11",
      path: "/" + fileFull.fileName,
      size: fileFull.size,
      "slice-md5": fileFull.md5,
      "content-md5": fileFull.md5,
      local_ctime: fileFull.ctime,
      local_mtime: fileFull.mtime,
      media_info: fileFull.media_info,
    };
    const params = { clienttype: "70" };
    return this.req.postReqJson(`${BASE}/youai/file/v1/precreate`, params, postdata);
  }

  /** 上传步骤2: superfile2 (实际上传文件二进制) */
  async upload_step2_superfile2(preCreateInfo, fileFull) {
    const params = {
      method: "upload",
      app_id: "16051585",
      channel: "chunlei",
      clienttype: "70",
      web: "1",
      path: "/" + fileFull.fileName,
      uploadid: preCreateInfo.uploadid,
      partseq: "0",
    };
    const formData = buildMultipartFile(fileFull.fileName, fileFull.bin, fileFull.fileName);
    const resp = await this.req.post(
      "https://c3.pcs.baidu.com/rest/2.0/pcs/superfile2",
      params,
      formData
    );
    return resp.json();
  }

  /** 上传步骤3: create (确认上传) */
  async upload_step3_create(preCreateInfo, fileFull) {
    const params = { clienttype: "70" };
    const data = {
      path: "/" + fileFull.fileName,
      size: fileFull.size,
      uploadid: preCreateInfo.uploadid,
      block_list: `["${fileFull.md5}"]`,
      isdir: "0",
      rtype: "1",
      "content-md5": fileFull.md5,
      ctype: "11",
      media_info: fileFull.media_info,
    };
    return this.req.postReqJson(`${BASE}/youai/file/v1/create`, params, data);
  }

  /** 完整上传一个文件（三步走） */
  async upload_1file(filePath) {
    const fobj = this.get_file_fullContent(filePath);
    const preC = await this.upload_step1_preCreate(fobj);
    if (preC && preC.uploadid) {
      const reqJson1 = await this.upload_step2_superfile2(preC, fobj);
      const reqJson2 = await this.upload_step3_create(preC, fobj);
      return { preC, reqJson1, reqJson2 };
    }
    // File already exists on remote
    return { preC, reqJson1: null, reqJson2: null };
  }

  /** 创建新相册 */
  async createNewAlbum(name, tid) {
    if (!tid) {
      tid = String(Math.floor(Math.random() * 9e17) + 1e17);
    }
    const params = { title: name, source: "0", tid };
    return this.req.getReqJson(`${BASE}/youai/album/v1/create`, params);
  }

  /** 批量下载前提条件：获取签名 */
  async batchDownload_precondition() {
    const params = {
      fields: '["sign1","sign2","sign3","timestamp"]',
      clienttype: "70",
    };
    const rdata = await this.req.getReqJson(`${BASE}/youai/file/v1/batchdownloadvariable`, params);
    const sign = get_sign_by_sign1sign2sign3(rdata.sign1, rdata.sign2, rdata.sign3);
    return { sign, timestamp: rdata.timestamp };
  }
}

// ========== OnlineItem (媒体对象辅助方法) ==========

function get_fsid(info) {
  if (info.fsid !== undefined) return String(info.fsid);
  if (info.fs_id !== undefined) return String(info.fs_id);
  return null;
}

function get_file_name(info) {
  return info.path.split("/").pop();
}

// ========== Album (相册对象辅助方法) ==========

function get_album_id(info) {
  return info.album_id;
}

function get_album_name(info) {
  return info.title;
}

function get_album_tid(info) {
  return info.tid;
}

// ========== API (门面) ==========

class API {
  constructor(cookies) {
    this.req = new Requests(cookies);
    this.g = new General(this.req);
  }

  /** 获取相册列表（单页） */
  async getAlbumList(limit = 30, cursor = null) {
    const params = {
      clienttype: "70",
      limit: String(limit),
      need_amount: "1",
      need_member: "1",
      field: "mtime",
    };
    if (cursor != null) params.cursor = cursor;
    const pageInfo = await this.req.getReqJson(`${BASE}/youai/album/v1/list`, params);
    if (!pageInfo || typeof pageInfo !== "object") {
      throw new Error("album list 接口未返回 JSON 对象");
    }
    if (pageInfo.errno && pageInfo.errno !== 0) {
      throw new Error(
        `album list 接口返回错误：errno=${pageInfo.errno}，request_id=${pageInfo.request_id}`
      );
    }
    if (!pageInfo.list) {
      return { items: [], has_more: false, cursor: null };
    }
    return {
      items: pageInfo.list,
      has_more: pageInfo.has_more === 1,
      cursor: pageInfo.cursor,
    };
  }

  /** 获取全部相册（分页循环） */
  async getAlbumList_All() {
    const r = [];
    let cursor = null;
    while (true) {
      const page = await this.getAlbumList(30, cursor);
      r.push(...page.items);
      if (page.has_more) {
        cursor = page.cursor;
      } else {
        break;
      }
    }
    return r;
  }

  /** 获取相册内文件列表（单页） */
  async getAlbumFiles(album_id, cursor = null) {
    const data = { cursor: cursor || "", album_id };
    const res = await this.req.postReqJson(`${BASE}/youai/album/v1/listfile`, {}, data);
    if (res && typeof res === "object" && res.errno && res.errno !== 0) {
      throw new Error(
        `listfile 接口返回错误：errno=${res.errno}，request_id=${res.request_id}`
      );
    }
    if (!res || !res.list) {
      throw new Error(`listfile 接口响应缺少 list 字段：${JSON.stringify(res).slice(0, 500)}`);
    }
    return {
      items: res.list,
      has_more: res.has_more === 1,
      cursor: res.cursor,
    };
  }

  /** 获取相册内全部文件（分页循环） */
  async getAlbumFiles_All(album_id) {
    const r = [];
    let cursor = null;
    while (true) {
      const page = await this.getAlbumFiles(album_id, cursor);
      r.push(...page.items);
      if (page.has_more) {
        cursor = page.cursor;
      } else {
        break;
      }
    }
    return r;
  }

  /** 获取相册详情 */
  async getAlbum_ByID(album_id) {
    const params = { album_id: String(album_id) };
    const data = await this.req.getReqJson(`${BASE}/youai/album/v1/detail`, params);
    if (data && data.errno === 0) {
      return data;
    }
    throw new Error("return error in getAlbum_ByID");
  }

  /** 上传单个文件（不加入相册） */
  async upload_1file_directly(filePath) {
    const { preC, reqJson1, reqJson2 } = await this.g.upload_1file(filePath);
    const return_type = preC ? preC.return_type : undefined;

    if (return_type === undefined) {
      const errno = preC ? preC.errno : null;
      const errmsg = preC ? preC.errmsg : null;
      console.error(
        `precreate 响应缺少 return_type，errno=[${errno}]，errmsg=[${errmsg}]`
      );
      if (String(errno) === "50801") throw new Error("文件过大或需要开通会员（errno=50801）");
      if (String(errno) === "50000") throw new Error("请求过于频繁，请稍后重试（errno=50000）");
      if (String(errno) === "2") throw new Error("文件超过普通用户大小上限（errno=2，照片与视频均 30MB）");
      throw new Error(`precreate 响应缺少 return_type${errno != null ? `：errno=${errno}` : ""}${errmsg ? `，errmsg: "${errmsg}"` : ""}`);
    }

    if (return_type === 1) {
      // New upload
      if (!reqJson2 || !reqJson2.data) {
        const errno = reqJson2 ? reqJson2.errno : null;
        const errmsg = reqJson2 ? reqJson2.errmsg : null;
        console.error(`upload create 响应缺少 data，return_type=[1]，errno=[${errno}]`);
        if (String(errno) === "50801") throw new Error("文件过大或需要开通会员（errno=50801）");
        if (String(errno) === "50000") throw new Error("请求过于频繁，请稍后重试（errno=50000）");
        if (String(errno) === "2") throw new Error("文件超过普通用户大小上限（errno=2）");
        throw new Error(`upload create 响应缺少 data${errno != null ? `：errno=${errno}` : ""}`);
      }
      const info = reqJson2.data;
      if (!info.fsid && info.fs_id) info.fsid = info.fs_id;
      return info;
    } else if (return_type === 3) {
      // Already exists
      console.warn("upload item already exist on remote");
      if (!preC || !preC.data) {
        throw new Error("文件已存在但响应缺少 data");
      }
      return preC.data;
    } else {
      console.error(`unknown return_type = ${return_type} @upload_1file_directly`);
      return null;
    }
  }

  /** 创建相册 */
  async createNewAlbum(name, tid) {
    const res = await this.g.createNewAlbum(name, tid);
    return res.info || res;
  }

  /** 将文件加入相册 (addfile) */
  async addfile(album_id, tid, fsid_list) {
    const listStr = `[${fsid_list.map((f) => `{"fsid":${f}}`).join(",")}]`;
    const params = {
      clienttype: "70",
      album_id: String(album_id),
      tid: String(tid),
      list: listStr,
    };
    return this.req.getReqJson(`${BASE}/youai/album/v1/addfile`, params);
  }

  /** 从相册删除文件 */
  async delfile(album_id, tid, items, uk, isOrigin = false) {
    const listStr = `[${items.map((f) => `{"fsid":${f},"uk":${uk}}`).join(",")}]`;
    const data = {
      album_id: String(album_id),
      tid: String(tid),
      list: listStr,
      del_origin: isOrigin ? "1" : "0",
    };
    return this.req.postReqJson(`${BASE}/youai/album/v1/delfile`, {}, data);
  }

  /** 删除相册 */
  async delete_album(album_id, tid, delete_origin_image = false) {
    const data = {
      album_id: String(album_id),
      delete_origin_image: delete_origin_image ? "1" : "0",
      tid: String(tid),
    };
    return this.req.postReqJson(`${BASE}/youai/album/v1/delete`, {}, data);
  }

  /** 重命名相册 */
  async rename_album(album_id, tid, title) {
    const data = { album_id: String(album_id), tid: String(tid), title };
    return this.req.postReqJson(`${BASE}/youai/album/v1/settitle`, {}, data);
  }

  /** 删除云端媒体文件 */
  async delete_media(fsid_list) {
    const params = {
      clienttype: "70",
      fsid_list: `[${fsid_list.map(String).join(",")}]`,
    };
    return this.req.getReqJson(`${BASE}/youai/file/v1/delete`, params);
  }

  /** 获取下载链接 */
  async getDownloadLink(fsid) {
    const params = { clienttype: "70", fsid: String(fsid) };
    const res = await this.req.getReqJson(`${BASE}/youai/file/v2/download`, params);
    return res.dlink;
  }

  /** 下载文件二进制内容 */
  async downloadContent(info) {
    let dlink = info.dlink;
    if (!dlink) {
      dlink = await this.getDownloadLink(info.fsid || info.fs_id);
      if (!dlink) throw new Error(`cannot find 'dlink' of ${info.path}`);
    }
    const token = await this.req.get_bdstoken_Cache();
    const url = new URL(dlink);
    url.searchParams.set("bdstoken", token);
    const resp = await this.req.get(url.toString(), {});
    const buffer = Buffer.from(await resp.arrayBuffer());
    return buffer;
  }

  /** 下载文件到指定目录 */
  async downloadFile(info, dirPath, fileName, checkMd5 = true) {
    if (!fileName) fileName = get_file_name(info);
    const filePath = path.join(dirPath, fileName);
    const content = await this.downloadContent(info);
    fs.writeFileSync(filePath, content);
    // Reset timestamps
    const atime = info.mtime || Date.now() / 1000;
    const mtime = info.ctime || Date.now() / 1000;
    try {
      fs.utimesSync(filePath, atime, mtime);
    } catch (e) {
      // ignore
    }
    if (checkMd5 && info.md5) {
      const localMd5 = crypto.createHash("md5").update(content).digest("hex");
      if (info.md5 !== localMd5) {
        console.error(`MD5 check error, file=[${filePath}]`);
      }
    }
    return filePath;
  }
}

module.exports = {
  API,
  General,
  get_fsid,
  get_file_name,
  get_album_id,
  get_album_name,
  get_album_tid,
};
