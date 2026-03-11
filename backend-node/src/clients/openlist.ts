import axios, { AxiosInstance } from 'axios';
import { createWriteStream, renameSync, statSync } from 'fs';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

export class OpenListError extends Error {}

export class OpenListClient {
  private baseUrl: string;
  private token: string;
  private password: string;
  private session: AxiosInstance;

  constructor(base_url: string, token: string, password = '') {
    this.baseUrl = base_url.replace(/\/$/, '');
    this.token = token.trim();
    this.password = password || '';
    this.session = axios.create({
      baseURL: this.baseUrl,
      headers: {
        Authorization: this.token,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });
  }

  private parse(resp: any) {
    if (!resp || typeof resp !== 'object') throw new OpenListError('invalid response');
    if (resp.code !== 200) throw new OpenListError(resp.message || 'OpenList error');
    return resp.data;
  }

  async login(username: string, password: string) {
    const url = `${this.baseUrl}/api/auth/login`;
    const resp = await axios.post(url, { username, password }, { timeout: 20000 });
    if (resp.data?.code !== 200) throw new OpenListError('login failed');
    return resp.data.data.token as string;
  }

  async list(path: string, refresh = false, page = 1, per_page = 0) {
    const resp = await this.session.post('/api/fs/list', {
      path: this.normalize(path),
      password: this.password,
      refresh,
      page,
      per_page,
    });
    return this.parse(resp.data);
  }

  async get(path: string) {
    const resp = await this.session.post('/api/fs/get', {
      path: this.normalize(path),
      password: this.password,
    });
    return this.parse(resp.data);
  }

  async mkdir(path: string) {
    await this.session.post('/api/fs/mkdir', { path: this.normalize(path) });
  }

  async ensureDir(path: string) {
    const parts = this.normalize(path).split('/').filter(Boolean);
    let cur = '/';
    for (const p of parts) {
      cur = cur === '/' ? `/${p}` : `${cur}/${p}`;
      try {
        await this.mkdir(cur);
      } catch (_e) {
        // ignore exists
      }
    }
  }

  buildDownloadUrl(remote_path: string) {
    return `${this.baseUrl}/d${this.normalize(remote_path)}`;
  }

  normalize(p: string) {
    if (!p) return '/';
    let s = String(p).trim();
    if (!s) return '/';
    s = s.replace(/\\/g, '/');
    if (!s.startsWith('/')) s = '/' + s;
    s = s.replace(/\/+/g, '/');
    if (s.length > 1) s = s.replace(/\/+$/, '');
    return s;
  }

  async download(
    remote_path: string,
    local_path: string,
    onProgress?: (delta: number, loaded: number, total?: number) => void,
    expectedTotal?: number,
  ): Promise<number> {
    const url = this.buildDownloadUrl(remote_path);
    mkdirSync(dirname(local_path), { recursive: true });
    const writer = createWriteStream(local_path + '.part');
    const resp = await this.session.get(url, { responseType: 'stream', timeout: 120000 });
    const headerTotal = Number(resp.headers?.['content-length'] || 0);
    const total = headerTotal > 0 ? headerTotal : expectedTotal || 0;
    let size = 0;
    await new Promise<void>((resolve, reject) => {
      resp.data.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (onProgress) onProgress(chunk.length, size, total || undefined);
      });
      resp.data.pipe(writer);
      resp.data.on('end', resolve);
      resp.data.on('error', reject);
    });
    writer.close();
    renameSync(local_path + '.part', local_path);
    return size;
  }

  async upload(
    local_path: string,
    remote_path: string,
    onProgress?: (delta: number, loaded: number, total?: number) => void,
  ) {
    await this.ensureDir(dirname(this.normalize(remote_path)));
    const fs = await import('fs');
    const stream = fs.createReadStream(local_path);
    let sent = 0;
    let total = 0;
    try {
      total = statSync(local_path).size;
    } catch {
      total = 0;
    }
    if (onProgress) {
      stream.on('data', (chunk: Buffer) => {
        sent += chunk.length;
        onProgress(chunk.length, sent, total || undefined);
      });
    }
    const headers = {
      Authorization: this.token,
      'File-Path': encodeURI(this.normalize(remote_path)),
      Password: this.password,
      'Content-Type': 'application/octet-stream',
    } as any;
    const resp = await axios.put(`${this.baseUrl}/api/fs/put`, stream, { headers, timeout: 600000 });
    const data = resp.data;
    if (!data || data.code !== 200) throw new OpenListError(data?.message || 'upload failed');
  }

  async rename(path: string, new_name: string) {
    const resp = await this.session.post('/api/fs/rename', {
      path: this.normalize(path),
      name: new_name,
    });
    const data = resp.data;
    if (data.code !== 200) throw new OpenListError(data.message || 'rename failed');
  }

  async listStorages(page = 1, per_page = 200) {
    const resp = await this.session.get(`/api/admin/storage/list?page=${page}&per_page=${per_page}`);
    return this.parse(resp.data);
  }
}
