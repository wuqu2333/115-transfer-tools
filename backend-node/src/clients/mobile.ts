import axios from "axios";
import crypto from "crypto";
import { createReadStream, statSync } from "fs";
import { logger } from "../logger";

export class MobileCloudError extends Error {}

const DEFAULT_PART_SIZE = 100 * 1024 * 1024;
const LARGE_FILE_PART_SIZE = 512 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 30 * 1024 * 1024 * 1024;
const MAX_PART_INFOS_PER_REQUEST = 100;

type PartSpec = { partNumber: number; partSize: number; offset: number };

async function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function getPartSize(size: number) {
  return size > LARGE_FILE_THRESHOLD ? LARGE_FILE_PART_SIZE : DEFAULT_PART_SIZE;
}

function buildPartSpecs(size: number): PartSpec[] {
  const partSize = getPartSize(size);
  const specs: PartSpec[] = [];
  if (size <= 0) {
    specs.push({ partNumber: 1, partSize: 0, offset: 0 });
    return specs;
  }
  let offset = 0;
  let part = 1;
  while (offset < size) {
    const cur = Math.min(partSize, size - offset);
    specs.push({ partNumber: part, partSize: cur, offset });
    offset += cur;
    part += 1;
  }
  return specs;
}

function extractUploadUrls(raw: any): Record<number, string> {
  const urls: Record<number, string> = {};
  if (!Array.isArray(raw)) return urls;
  raw.forEach((p) => {
    if (p && typeof p === "object" && p.partNumber && p.uploadUrl) {
      urls[Number(p.partNumber)] = String(p.uploadUrl);
    }
  });
  return urls;
}

export class MobileCloudClient {
  constructor(
    private authorization: string,
    private uni: string,
    private parent_file_id: string,
    private cloud_host = "https://personal-kd-njs.yun.139.com/hcy",
    private app_channel = "10000023",
    private client_info =
      "1|127.0.0.1|1|12.5.3|nubia|NX729J|E78EFE74714DADB70377C93EEDFDA909|02-00-00-00-00-00|android 14|1116X2480|zh||||021|0|",
  ) {
    if (!authorization || !uni || !parent_file_id) throw new MobileCloudError("missing params");
    this.cloud_host = this.cloud_host.replace(/\/$/, "");
  }

  private headers() {
    return {
      Authorization: this.authorization,
      "x-yun-uni": this.uni,
      "x-yun-api-version": "v1",
      "x-yun-url-type": "1",
      "x-yun-op-type": "1",
      "x-yun-sub-op-type": "100",
      "x-yun-client-info": this.client_info,
      "x-yun-app-channel": this.app_channel,
      "x-huawei-channelSrc": this.app_channel,
      "Accept-Language": "zh-CN",
      "User-Agent": "okhttp/4.12.0",
      "Content-Type": "application/json; charset=UTF-8",
    } as any;
  }

  private async request(method: string, endpoint: string, payload?: any, timeout = 30000) {
    const url = `${this.cloud_host}${endpoint}`;
    const resp = await axios.request({ method, url, data: payload, headers: this.headers(), timeout });
    const data = resp.data;
    if (resp.status >= 400) throw new MobileCloudError(`request failed: ${url}, http=${resp.status}`);
    if (!data?.success) throw new MobileCloudError(`接口返回失败: ${url}, 响应=${JSON.stringify(data)}`);
    return data.data || {};
  }

  async list_dir(parent_file_id: string) {
    const payload = {
      imageThumbnailStyleList: ["Small", "Large"],
      orderBy: "updated_at",
      orderDirection: "DESC",
      pageInfo: { pageCursor: "", pageSize: 100 },
      parentFileId: parent_file_id,
    };
    const data = await this.request("POST", "/file/list", payload);
    const items = data.items || [];
    const isFolder = (it: any) => {
      const t = String(it.type || it.fileType || it.kind || "").toLowerCase();
      if (t === "folder" || t === "dir" || t === "directory") return true;
      if (it.isFolder === true || it.folder === true || it.is_dir === true) return true;
      return false;
    };
    return items.map((it: any) => ({
      name: it.name,
      file_id: it.fileId,
      is_dir: isFolder(it),
      size: Number(it.size || 0),
      updated_at: it.updatedAt,
      created_at: it.createdAt,
      content_hash:
        it.contentHash ||
        it.content_hash ||
        it.sha256 ||
        it.sha_256 ||
        it.hash?.sha256 ||
        "",
    }));
  }

  async create_folder(parent_file_id: string, name: string) {
    const payload = {
      parentFileId: parent_file_id,
      name,
      description: "",
      type: "folder",
      fileRenameMode: "force_rename",
    };
    const data = await this.request("POST", "/file/create", payload);
    const fileId = data.fileId;
    if (!fileId) throw new MobileCloudError("create folder missing fileId");
    return String(fileId);
  }

  private async createUpload(opts: {
    file_name: string;
    file_size: number;
    content_hash: string;
    parent_file_id: string;
    part_specs: PartSpec[];
  }) {
    const partInfos = opts.part_specs.slice(0, MAX_PART_INFOS_PER_REQUEST).map((p) => ({
      partNumber: p.partNumber,
      partSize: p.partSize,
      parallelHashCtx: { partOffset: p.offset },
    }));
    const payload = {
      contentHash: opts.content_hash,
      contentHashAlgorithm: "SHA256",
      contentType: "application/octet-stream",
      fileRenameMode: "force_rename",
      localCreatedAt: new Date().toISOString().replace("Z", "+08:00"),
      name: opts.file_name,
      parallelUpload: false,
      parentFileId: opts.parent_file_id.trim(),
      partInfos,
      size: opts.file_size,
      storyVideoFile: false,
      type: "file",
      userRegion: { cityCode: "731", provinceCode: "731" },
    };
    const data = await this.request("POST", "/file/create", payload);
    const upload_id = String(data.uploadId || "");
    const file_id = String(data.fileId || "");
    const upload_urls = extractUploadUrls(data.partInfos);
    const rapid_upload = !!(data.rapidUpload || data.exist || (!data.uploadId && !data.partInfos));
    if (!file_id) throw new MobileCloudError(`file/create missing fileId: ${JSON.stringify(data)}`);
    if (!rapid_upload && !upload_id) throw new MobileCloudError(`file/create missing uploadId: ${JSON.stringify(data)}`);
    const uploaded_name = String(data.name || data.fileName || opts.file_name);
    return { upload_id, file_id, upload_urls, rapid_upload, uploaded_name };
  }

  private async getUploadUrls(file_id: string, upload_id: string, part_specs: PartSpec[]) {
    const payload = {
      fileId: file_id,
      uploadId: upload_id,
      partInfos: part_specs.map((p) => ({
        partNumber: p.partNumber,
        partSize: p.partSize,
        parallelHashCtx: { partOffset: p.offset },
      })),
    };
    const data = await this.request("POST", "/file/getUploadUrl", payload);
    const urls = extractUploadUrls(data.partInfos);
    if (!Object.keys(urls).length) throw new MobileCloudError(`file/getUploadUrl missing upload urls: ${JSON.stringify(data)}`);
    return urls;
  }

  private async uploadParts(
    file_path: string,
    specs: PartSpec[],
    upload_urls: Record<number, string>,
    onProgress?: (delta: number) => void,
  ) {
    if (!specs.length) return;
    for (const part of specs) {
      const uploadUrl = upload_urls[part.partNumber];
      if (!uploadUrl) throw new MobileCloudError(`missing upload url for part ${part.partNumber}`);
      if (part.partSize === 0) {
        await axios.put(uploadUrl, Buffer.alloc(0), {
          headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": "0",
            Origin: "https://yun.139.com",
            Referer: "https://yun.139.com/",
          },
          timeout: 600000,
        });
        continue;
      }
      const stream = createReadStream(file_path, { start: part.offset, end: part.offset + part.partSize - 1 });
      if (onProgress) {
        stream.on("data", (chunk: Buffer) => {
          onProgress(chunk.length);
        });
      }
      const resp = await axios.put(uploadUrl, stream, {
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(part.partSize),
          Origin: "https://yun.139.com",
          Referer: "https://yun.139.com/",
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 600000,
      });
      if (![200, 201].includes(resp.status)) {
        throw new MobileCloudError(`part upload failed: part=${part.partNumber}, http=${resp.status}, body=${resp.data}`);
      }
    }
  }

  private async completeUpload(upload_id: string, file_id: string, content_hash: string) {
    const payload = {
      contentHash: content_hash,
      contentHashAlgorithm: "SHA256",
      fileId: file_id,
      uploadId: upload_id,
    };
    await this.request("POST", "/file/complete", payload);
  }

  async rapid_upload_only(opts: { file_name: string; file_size: number; content_hash: string; parent_file_id?: string }) {
    const parent = (opts.parent_file_id || this.parent_file_id).trim();
    if (!parent) throw new MobileCloudError("upload missing parentFileId");
    const part_specs = buildPartSpecs(opts.file_size);
    const { upload_id, file_id, rapid_upload, uploaded_name } = await this.createUpload({
      file_name: opts.file_name,
      file_size: opts.file_size,
      content_hash: opts.content_hash,
      parent_file_id: parent,
      part_specs,
    });
    if (!rapid_upload) throw new MobileCloudError("秒传未命中，需要真实上传");
    return { file_id, upload_id, uploaded_name, file_size: opts.file_size, content_hash: opts.content_hash };
  }

  async upload_file(
    file_path: string,
    parent_file_id?: string,
    onProgress?: (delta: number, loaded: number, total?: number) => void,
  ) {
    const size = statSync(file_path).size;
    const hash = await sha256(file_path);
    const parent = (parent_file_id || this.parent_file_id).trim();
    if (!parent) throw new MobileCloudError("upload missing parentFileId");
    const part_specs = buildPartSpecs(size);
    const { upload_id, file_id, upload_urls, rapid_upload, uploaded_name } = await this.createUpload({
      file_name: file_path.split(/[/\\]/).pop() || "file",
      file_size: size,
      content_hash: hash,
      parent_file_id: parent,
      part_specs,
    });

    if (!rapid_upload) {
      let uploaded = 0;
      const notify = (delta: number) => {
        uploaded += delta;
        if (onProgress) onProgress(delta, uploaded, size);
      };
      const firstBatch = part_specs.slice(0, MAX_PART_INFOS_PER_REQUEST);
      if (firstBatch.length) {
        const urls = Object.keys(upload_urls).length ? upload_urls : await this.getUploadUrls(file_id, upload_id, firstBatch);
        await this.uploadParts(file_path, firstBatch, urls, notify);
      }
      for (let start = MAX_PART_INFOS_PER_REQUEST; start < part_specs.length; start += MAX_PART_INFOS_PER_REQUEST) {
        const batch = part_specs.slice(start, start + MAX_PART_INFOS_PER_REQUEST);
        const urls = await this.getUploadUrls(file_id, upload_id, batch);
        await this.uploadParts(file_path, batch, urls, notify);
      }
      await this.completeUpload(upload_id, file_id, hash);
    }

    return { file_id, upload_id, uploaded_name, file_size: size, content_hash: hash };
  }

  async rename_file(file_id: string, new_name: string, parent_file_id?: string) {
    const payload = { fileId: file_id, name: new_name, description: "" };
    await this.request("POST", "/file/update", payload);
    if (!parent_file_id) return;
    try {
      const items = await this.list_dir(parent_file_id);
      const found = items.find((i: any) => i.file_id === file_id);
      if (found && found.name === new_name) return;
      throw new MobileCloudError("rename verify failed");
    } catch (e) {
      logger.warn(e);
    }
  }
}
