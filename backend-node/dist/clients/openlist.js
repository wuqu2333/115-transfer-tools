"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenListClient = exports.OpenListError = void 0;
const axios_1 = __importDefault(require("axios"));
const fs_1 = require("fs");
const fs_2 = require("fs");
const path_1 = require("path");
class OpenListError extends Error {
}
exports.OpenListError = OpenListError;
class OpenListClient {
    constructor(base_url, token, password = '') {
        this.baseUrl = base_url.replace(/\/$/, '');
        this.token = token.trim();
        this.password = password || '';
        this.session = axios_1.default.create({
            baseURL: this.baseUrl,
            headers: {
                Authorization: this.token,
                'Content-Type': 'application/json',
            },
            timeout: 20000,
        });
    }
    parse(resp) {
        if (!resp || typeof resp !== 'object')
            throw new OpenListError('invalid response');
        if (resp.code !== 200)
            throw new OpenListError(resp.message || 'OpenList error');
        return resp.data;
    }
    async login(username, password) {
        const url = `${this.baseUrl}/api/auth/login`;
        const resp = await axios_1.default.post(url, { username, password }, { timeout: 20000 });
        if (resp.data?.code !== 200)
            throw new OpenListError('login failed');
        return resp.data.data.token;
    }
    async list(path, refresh = false, page = 1, per_page = 0) {
        const resp = await this.session.post('/api/fs/list', {
            path: this.normalize(path),
            password: this.password,
            refresh,
            page,
            per_page,
        });
        return this.parse(resp.data);
    }
    async get(path) {
        const resp = await this.session.post('/api/fs/get', {
            path: this.normalize(path),
            password: this.password,
        });
        return this.parse(resp.data);
    }
    async mkdir(path) {
        await this.session.post('/api/fs/mkdir', { path: this.normalize(path) });
    }
    async ensureDir(path) {
        const parts = this.normalize(path).split('/').filter(Boolean);
        let cur = '/';
        for (const p of parts) {
            cur = cur === '/' ? `/${p}` : `${cur}/${p}`;
            try {
                await this.mkdir(cur);
            }
            catch (_e) {
                // ignore exists
            }
        }
    }
    buildDownloadUrl(remote_path) {
        return `${this.baseUrl}/d${this.normalize(remote_path)}`;
    }
    normalize(p) {
        if (!p)
            return '/';
        if (!p.startsWith('/'))
            return '/' + p;
        return p;
    }
    async download(remote_path, local_path) {
        const url = this.buildDownloadUrl(remote_path);
        (0, fs_2.mkdirSync)((0, path_1.dirname)(local_path), { recursive: true });
        const writer = (0, fs_1.createWriteStream)(local_path + '.part');
        const resp = await this.session.get(url, { responseType: 'stream', timeout: 120000 });
        let size = 0;
        await new Promise((resolve, reject) => {
            resp.data.on('data', (chunk) => {
                size += chunk.length;
            });
            resp.data.pipe(writer);
            resp.data.on('end', resolve);
            resp.data.on('error', reject);
        });
        writer.close();
        (0, fs_1.renameSync)(local_path + '.part', local_path);
        return size;
    }
    async upload(local_path, remote_path) {
        await this.ensureDir((0, path_1.dirname)(this.normalize(remote_path)));
        const fs = await Promise.resolve().then(() => __importStar(require('fs')));
        const stream = fs.createReadStream(local_path);
        const headers = {
            Authorization: this.token,
            'File-Path': encodeURI(this.normalize(remote_path)),
            Password: this.password,
            'Content-Type': 'application/octet-stream',
        };
        const resp = await axios_1.default.put(`${this.baseUrl}/api/fs/put`, stream, { headers, timeout: 600000 });
        const data = resp.data;
        if (!data || data.code !== 200)
            throw new OpenListError(data?.message || 'upload failed');
    }
    async rename(path, new_name) {
        const resp = await this.session.post('/api/fs/rename', {
            path: this.normalize(path),
            name: new_name,
        });
        const data = resp.data;
        if (data.code !== 200)
            throw new OpenListError(data.message || 'rename failed');
    }
    async listStorages(page = 1, per_page = 200) {
        const resp = await this.session.get(`/api/admin/storage/list?page=${page}&per_page=${per_page}`);
        return this.parse(resp.data);
    }
}
exports.OpenListClient = OpenListClient;
