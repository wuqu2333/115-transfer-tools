import axios, { AxiosInstance } from 'axios';
import { createWriteStream, mkdirSync, renameSync, statSync, unlinkSync } from 'fs';
import { dirname } from 'path';
import { pipeline } from 'stream/promises';

export class OpenListError extends Error {}

function abortMessage(reason: unknown) {
  return typeof reason === 'string' && reason ? reason : 'operation aborted';
}

function createAbortError(reason?: unknown) {
  const err: any = new Error(abortMessage(reason));
  err.name = 'AbortError';
  err.code = 'ERR_CANCELED';
  return err;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw createAbortError(signal.reason);
}

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

  async login(username: string, password: string, signal?: AbortSignal) {
    const url = `${this.baseUrl}/api/auth/login`;
    throwIfAborted(signal);
    const resp = await axios.post(url, { username, password }, { timeout: 20000, signal });
    if (resp.data?.code !== 200) throw new OpenListError('login failed');
    return resp.data.data.token as string;
  }

  async list(path: string, refresh = false, page = 1, per_page = 0, signal?: AbortSignal) {
    throwIfAborted(signal);
    const resp = await this.session.post('/api/fs/list', {
      path: this.normalize(path),
      password: this.password,
      refresh,
      page,
      per_page,
    }, { signal });
    return this.parse(resp.data);
  }

  async get(path: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const resp = await this.session.post('/api/fs/get', {
      path: this.normalize(path),
      password: this.password,
    }, { signal });
    return this.parse(resp.data);
  }

  async mkdir(path: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    await this.session.post('/api/fs/mkdir', { path: this.normalize(path) }, { signal });
  }

  async ensureDir(path: string, signal?: AbortSignal) {
    const parts = this.normalize(path).split('/').filter(Boolean);
    let cur = '/';
    for (const p of parts) {
      throwIfAborted(signal);
      cur = cur === '/' ? `/${p}` : `${cur}/${p}`;
      try {
        await this.mkdir(cur, signal);
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
    signal?: AbortSignal,
  ): Promise<number> {
    throwIfAborted(signal);
    const url = this.buildDownloadUrl(remote_path);
    mkdirSync(dirname(local_path), { recursive: true });
    const tempPath = `${local_path}.part`;
    let size = 0;
    let writer: ReturnType<typeof createWriteStream> | null = null;
    let responseStream: any = null;
    const onAbort = () => {
      const err = createAbortError(signal?.reason);
      responseStream?.destroy(err);
      writer?.destroy(err);
    };
    try {
      writer = createWriteStream(tempPath);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      const resp = await this.session.get(url, { responseType: 'stream', timeout: 120000, signal });
      responseStream = resp.data;
      const headerTotal = Number(resp.headers?.['content-length'] || 0);
      const total = headerTotal > 0 ? headerTotal : expectedTotal || 0;
      resp.data.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (onProgress) onProgress(chunk.length, size, total || undefined);
      });
      await pipeline(resp.data, writer);
      renameSync(tempPath, local_path);
      return statSync(local_path).size || size;
    } catch (err) {
      try {
        unlinkSync(tempPath);
      } catch {
        // ignore temp cleanup errors
      }
      throw err;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async upload(
    local_path: string,
    remote_path: string,
    onProgress?: (delta: number, loaded: number, total?: number) => void,
    signal?: AbortSignal,
  ) {
    throwIfAborted(signal);
    await this.ensureDir(dirname(this.normalize(remote_path)), signal);
    const fs = await import('fs');
    const stream = fs.createReadStream(local_path);
    let sent = 0;
    let total = 0;
    const onAbort = () => {
      stream.destroy(createAbortError(signal?.reason));
    };
    try {
      total = statSync(local_path).size;
    } catch {
      total = 0;
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
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
    try {
      const resp = await axios.put(`${this.baseUrl}/api/fs/put`, stream, {
        headers,
        timeout: 3600000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        signal,
      });
      const data = resp.data;
      if (!data || data.code !== 200) throw new OpenListError(data?.message || 'upload failed');
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }

  async rename(path: string, new_name: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const resp = await this.session.post('/api/fs/rename', {
      path: this.normalize(path),
      name: new_name,
    }, { signal });
    const data = resp.data;
    if (data.code !== 200) throw new OpenListError(data.message || 'rename failed');
  }

  async remove(path: string, signal?: AbortSignal) {
    throwIfAborted(signal);
    const resp = await this.session.post('/api/fs/remove', {
      path: this.normalize(path),
    }, { signal });
    const data = resp.data;
    if (data.code !== 200) throw new OpenListError(data.message || 'remove failed');
  }

  async listStorages(page = 1, per_page = 200, signal?: AbortSignal) {
    throwIfAborted(signal);
    const resp = await this.session.get(`/api/admin/storage/list?page=${page}&per_page=${per_page}`, { signal });
    return this.parse(resp.data);
  }
}
