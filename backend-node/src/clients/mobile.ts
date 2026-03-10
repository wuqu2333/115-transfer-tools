import axios from 'axios';
import crypto from 'crypto';
import { readFileSync, createReadStream } from 'fs';
import { logger } from '../logger';

export class MobileCloudError extends Error {}

const DEFAULT_PART_SIZE = 100 * 1024 * 1024;
const LARGE_FILE_PART_SIZE = 512 * 1024 * 1024;
const LARGE_FILE_THRESHOLD = 30 * 1024 * 1024 * 1024;
const MAX_PART_INFOS_PER_REQUEST = 100;

function sha256(path: string) {
  const hash = crypto.createHash('sha256');
  const data = readFileSync(path);
  hash.update(data);
  return hash.digest('hex');
}

function getPartSize(size: number) {
  return size > LARGE_FILE_THRESHOLD ? LARGE_FILE_PART_SIZE : DEFAULT_PART_SIZE;
}

export class MobileCloudClient {
  constructor(
    private authorization: string,
    private uni: string,
    private parent_file_id: string,
    private cloud_host = 'https://personal-kd-njs.yun.139.com/hcy',
    private app_channel = '10000023',
    private client_info =
      '1|127.0.0.1|1|12.5.3|nubia|NX729J|E78EFE74714DADB70377C93EEDFDA909|02-00-00-00-00-00|android 14|1116X2480|zh||||021|0|',
  ) {
    if (!authorization || !uni || !parent_file_id) throw new MobileCloudError('missing params');
    this.cloud_host = this.cloud_host.replace(/\/$/, '');
  }

  private headers() {
    return {
      Authorization: this.authorization,
      'x-yun-uni': this.uni,
      'x-yun-api-version': 'v1',
      'x-yun-url-type': '1',
      'x-yun-op-type': '1',
      'x-yun-sub-op-type': '100',
      'x-yun-client-info': this.client_info,
      'x-yun-app-channel': this.app_channel,
      'x-huawei-channelSrc': this.app_channel,
      'Accept-Language': 'zh-CN',
      'User-Agent': 'okhttp/4.12.0',
      'Content-Type': 'application/json; charset=UTF-8',
    } as any;
  }

  private async request(method: string, endpoint: string, payload?: any) {
    const url = `${this.cloud_host}${endpoint}`;
    const resp = await axios.request({ method, url, data: payload, headers: this.headers(), timeout: 30000 });
    const data = resp.data;
    if (resp.status >= 400 || !data?.success) {
      throw new MobileCloudError(`接口返回失败: ${url}, 响应=${JSON.stringify(data)}`);
    }
    return data.data || {};
  }

  async list_dir(parent_file_id: string) {
    const payload = {
      imageThumbnailStyleList: ['Small', 'Large'],
      orderBy: 'updated_at',
      orderDirection: 'DESC',
      pageInfo: { pageCursor: '', pageSize: 100 },
      parentFileId: parent_file_id,
    };
    const data = await this.request('POST', '/file/list', payload);
    const items = data.items || [];
    return items.map((it: any) => ({
      name: it.name,
      file_id: it.fileId,
      is_dir: it.type === 'folder',
      size: Number(it.size || 0),
      updated_at: it.updatedAt,
      created_at: it.createdAt,
    }));
  }

  async create_folder(parent_file_id: string, name: string) {
    const payload = {
      parentFileId: parent_file_id,
      name,
      description: '',
      type: 'folder',
      fileRenameMode: 'force_rename',
    };
    const data = await this.request('POST', '/file/create', payload);
    const fileId = data.fileId;
    if (!fileId) throw new MobileCloudError('create folder missing fileId');
    return fileId as string;
  }

  buildPartSpecs(size: number) {
    const partSize = getPartSize(size);
    const specs = [] as { partNumber: number; partSize: number; offset: number }[];
    let offset = 0;
    let part = 1;
    while (offset < size) {
      const cur = Math.min(partSize, size - offset);
      specs.push({ partNumber: part, partSize: cur, offset });
      offset += cur;
      part += 1;
    }
    if (!specs.length) specs.push({ partNumber: 1, partSize: 0, offset: 0 });
    return specs;
  }

  async rapid_upload_only(opts: { file_name: string; file_size: number; content_hash: string; parent_file_id?: string }) {
    const parent = (opts.parent_file_id || this.parent_file_id).trim();
    const partInfos = this.buildPartSpecs(opts.file_size).slice(0, MAX_PART_INFOS_PER_REQUEST).map((p) => ({
      partNumber: p.partNumber,
      partSize: p.partSize,
      parallelHashCtx: { partOffset: p.offset },
    }));
    const payload = {
      contentHash: opts.content_hash,
      contentHashAlgorithm: 'SHA256',
      contentType: 'application/octet-stream',
      fileRenameMode: 'force_rename',
      localCreatedAt: new Date().toISOString().replace('Z', '+08:00'),
      name: opts.file_name,
      parallelUpload: false,
      parentFileId: parent,
      partInfos,
      size: opts.file_size,
      storyVideoFile: false,
      type: 'file',
      userRegion: { cityCode: '731', provinceCode: '731' },
    };
    const data = await this.request('POST', '/file/create', payload);
    const rapid = data.rapidUpload || data.exist || (!data.uploadId && !data.partInfos);
    if (!rapid) throw new MobileCloudError('秒传未命中，需要真实上传（当前未实现完整分片上传）');
    return {
      file_id: String(data.fileId || ''),
      upload_id: String(data.uploadId || ''),
      uploaded_name: String(data.name || data.fileName || opts.file_name),
      file_size: opts.file_size,
      content_hash: opts.content_hash,
    };
  }

  async upload_file(file_path: string, parent_file_id?: string) {
    // 简化：先尝试秒传，未命中则报错
    const hash = sha256(file_path);
    const fs = await import('fs');
    const size = fs.statSync(file_path).size;
    const res = await this.rapid_upload_only({
      file_name: file_path.split(/[/\\]/).pop() || 'file',
      file_size: size,
      content_hash: hash,
      parent_file_id,
    });
    return res;
  }
}
