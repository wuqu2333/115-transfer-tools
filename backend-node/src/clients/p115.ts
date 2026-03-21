import axios, { AxiosInstance } from "axios";

export interface ExportDirResult {
  export_id?: string | number;
  file_id?: string | number;
  file_name?: string;
  pick_code?: string;
  pickcode?: string;
}

export class P115Client {
  private cookie: string;
  private ua: string;
  private session: AxiosInstance;

  constructor(cookie: string, ua?: string) {
    this.cookie = cookie;
    this.ua = ua || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
    this.session = axios.create({ timeout: 30000 });
  }

  private headers(extra?: Record<string, string>) {
    return {
      Cookie: this.cookie,
      "User-Agent": this.ua,
      ...(extra || {}),
    };
  }

  private check(resp: any) {
    if (!resp || typeof resp !== "object") throw new Error("115 接口返回为空");
    if (resp.state === false || resp.state === 0 || resp.state === "false") {
      throw new Error(resp.error || resp.message || resp.msg || "115 接口返回失败");
    }
    return resp;
  }

  private safeDecode(value: string) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  private normalizeName(value: any) {
    if (value === undefined || value === null) return "";
    const str = String(value).trim();
    if (!str) return "";
    return this.safeDecode(str);
  }

  async getInfoByPath(path: string) {
    const resp = await this.session.get("https://proapi.115.com/open/folder/get_info", {
      params: { path },
      headers: this.headers(),
    });
    const data = this.check(resp.data);
    return data.data || data;
  }

  async exportDir(fileIds: string, target = "U_1_0", layerLimit = 0) {
    const params = new URLSearchParams();
    params.append("file_ids", fileIds);
    params.append("target", target);
    if (layerLimit > 0) params.append("layer_limit", String(layerLimit));
    const resp = await this.session.post("https://webapi.115.com/files/export_dir", params, {
      headers: this.headers({ "Content-Type": "application/x-www-form-urlencoded" }),
    });
    return this.check(resp.data);
  }

  async exportDirStatus(exportId: string | number) {
    const resp = await this.session.get("https://webapi.115.com/files/export_dir", {
      params: { export_id: exportId },
      headers: this.headers(),
    });
    return this.check(resp.data);
  }

  async deleteFiles(fileIds: Array<string | number> | string | number) {
    const params = new URLSearchParams();
    const ids = Array.isArray(fileIds) ? fileIds : [fileIds];
    ids
      .map((id) => String(id).trim())
      .filter(Boolean)
      .forEach((id, index) => {
        if (ids.length === 1) params.append("fid", id);
        else params.append(`fid[${index}]`, id);
      });
    params.append("ignore_warn", "1");
    const resp = await this.session.post("https://webapi.115.com/rb/delete", params, {
      headers: this.headers({
        "Content-Type": "application/x-www-form-urlencoded",
        Referer: "https://115.com/",
        Accept: "application/json, text/plain, */*",
      }),
    });
    return this.check(resp.data);
  }

  async downloadUrlWeb(pickcode: string) {
    const resp = await this.session.get("https://webapi.115.com/files/download", {
      params: { pickcode },
      headers: this.headers(),
    });
    return this.check(resp.data);
  }

  async listByCid(cid: string | number) {
    const resp = await this.session.get("https://webapi.115.com/files", {
      params: {
        aid: 1,
        cid,
        limit: 1000,
        offset: 0,
        show_dir: 1,
        record_open_time: 1,
        count_folders: 1,
      },
      headers: this.headers(),
    });
    const data = this.check(resp.data);
    const body = data?.data || data;

    const isNameItem = (item: any) =>
      item &&
      typeof item === "object" &&
      (item.n || item.ns || item.name || item.file_name || item.fileName);

    const pickList = (obj: any): any[] => {
      if (Array.isArray(obj)) return obj;
      if (!obj || typeof obj !== "object") return [];
      const keys = ["data", "list", "files", "items", "folder", "folders", "dir", "dirs"];
      for (const k of keys) {
        if (Array.isArray(obj[k])) return obj[k];
      }
      // fallback: find first array with name-like items (depth 2)
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (Array.isArray(v) && v.some(isNameItem)) return v;
      }
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (v && typeof v === "object") {
          for (const kk of Object.keys(v)) {
            const vv = v[kk];
            if (Array.isArray(vv) && vv.some(isNameItem)) return vv;
          }
        }
      }
      return [];
    };

    const list = pickList(body);
    return Array.isArray(list) ? list : [];
  }

  async storageInfo() {
    const resp = await this.session.get("https://115.com/index.php", {
      params: { ct: "ajax", ac: "get_storage_info" },
      headers: this.headers({
        Referer: "https://115.com/",
        Accept: "application/json, text/plain, */*",
      }),
    });
    return resp.data;
  }

  async userSpaceInfo() {
    const resp = await this.session.get("https://proapi.115.com/android/user/space_info", {
      headers: this.headers({
        Referer: "https://115.com/",
        Accept: "application/json, text/plain, */*",
      }),
    });
    return resp.data;
  }

  async indexInfo() {
    const resp = await this.session.get("https://webapi.115.com/files/index_info", {
      headers: this.headers({
        Referer: "https://115.com/",
        Accept: "application/json, text/plain, */*",
      }),
    });
    return resp.data;
  }

  async spaceSummury() {
    const resp = await this.session.post(
      "https://webapi.115.com/user/space_summury",
      null,
      {
        headers: this.headers({
          Referer: "https://115.com/",
          Accept: "application/json, text/plain, */*",
        }),
      },
    );
    return resp.data;
  }

  async resolvePathId(path: string) {
    let s = String(path || "").trim();
    if (!s || s === "/") {
      return { id: "0", is_dir: true, parent_id: "" };
    }
    s = s.replace(/\\/g, "/");
    if (!s.startsWith("/")) s = "/" + s;
    s = s.replace(/\/+/g, "/");
    const parts = s.split("/").filter(Boolean);
    let cid: string | number = "0";
    let parent: string | number = "0";
    for (let i = 0; i < parts.length; i += 1) {
      const rawName = parts[i];
      const name = this.normalizeName(rawName);
      const list = await this.listByCid(cid);
      const found = list.find((item: any) => {
        const candidates = [
          item?.n,
          item?.ns,
          item?.file_name,
          item?.name,
          item?.fileName,
          item?.title,
        ];
        return candidates.some((val) => this.normalizeName(val) === name);
      });
      if (!found) return null;
      const hasFileId = !!(
        found?.fid ||
        found?.file_id ||
        found?.fileId ||
        found?.file_id_str ||
        found?.fileIdStr
      );
      const hasDirId = !!(found?.cid || found?.dir_id || found?.dirId);
      const isDir =
        found?.is_dir === 1 ||
        found?.is_dir === true ||
        found?.isdir === 1 ||
        found?.isdir === true ||
        found?.dir === 1 ||
        found?.dir === true ||
        found?.isfolder === 1 ||
        found?.isfolder === true ||
        found?.isFolder === 1 ||
        found?.isFolder === true ||
        (!hasFileId && hasDirId);
      const id = isDir
        ? found?.cid || found?.dir_id || found?.dirId
        : found?.fid || found?.file_id || found?.fileId || found?.file_id_str || found?.fileIdStr || found?.id;
      if (!id) return null;
      parent = cid;
      cid = id;
      if (!isDir && i < parts.length - 1) return null;
      if (i === parts.length - 1) {
        return { id: String(id), is_dir: isDir, parent_id: String(parent) };
      }
    }
    return null;
  }
}
