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
exports.TransferQueue = void 0;
const path_1 = require("path");
const fs_1 = require("fs");
const p_queue_1 = __importDefault(require("p-queue"));
const openlist_1 = require("../clients/openlist");
const mobile_1 = require("../clients/mobile");
const db_1 = require("../db");
const logger_1 = require("../logger");
const DOWNLOAD_CONCURRENCY = 3;
const DOWNLOAD_INTERVAL_MS = 2000;
function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
}
class TransferQueue {
    constructor() {
        this.running = false;
    }
    start() {
        if (this.running)
            return;
        this.running = true;
        this.loop();
    }
    async loop() {
        while (this.running) {
            const task = (0, db_1.pendingTask)();
            if (!task) {
                await sleep(1000);
                continue;
            }
            try {
                await this.executeTask(task);
            }
            catch (e) {
                logger_1.logger.error(e);
            }
        }
    }
    async executeTask(task) {
        const settings = (0, db_1.getSettings)();
        (0, db_1.updateTask)(task.id, {
            status: 'running',
            started_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            logs_json: '[]',
            message: 'Task started',
            error_message: '',
            processed_files: 0,
            processed_bytes: 0,
            total_bytes: 0,
        });
        (0, db_1.appendLog)(task.id, 'Task started');
        const openlist = new openlist_1.OpenListClient(settings.openlist_base_url, settings.openlist_token, settings.openlist_password);
        let mobile = null;
        if (task.provider === 'mobile') {
            mobile = new mobile_1.MobileCloudClient(settings.mobile_authorization, settings.mobile_uni, settings.mobile_parent_file_id, settings.mobile_cloud_host, settings.mobile_app_channel, settings.mobile_client_info);
        }
        const sourcePaths = JSON.parse(task.source_paths_json || '[]');
        const allFiles = [];
        for (const src of sourcePaths) {
            (0, db_1.appendLog)(task.id, `Resolving source: ${src}`);
            const obj = await openlist.get(src);
            if (!obj)
                throw new Error('source unavailable');
            if (!obj.is_dir) {
                const name = src.split('/').pop() || 'file';
                allFiles.push({ remote_path: src, relative_path: name });
            }
            else {
                await this.walkDir(openlist, src, '', allFiles);
            }
        }
        (0, db_1.updateTask)(task.id, { total_files: allFiles.length, updated_at: new Date().toISOString() });
        (0, db_1.appendLog)(task.id, `Collected files: ${allFiles.length}`);
        const localRoot = (0, path_1.join)(task.local_download_path || settings.download_base_path || '.', `task_${task.id}`);
        (0, fs_1.mkdirSync)(localRoot, { recursive: true });
        const queue = new p_queue_1.default({ concurrency: DOWNLOAD_CONCURRENCY, intervalCap: DOWNLOAD_CONCURRENCY, interval: DOWNLOAD_INTERVAL_MS });
        let processed = 0;
        for (const file of allFiles) {
            queue.add(async () => {
                const localPath = (0, path_1.join)(localRoot, file.relative_path);
                (0, fs_1.mkdirSync)((0, path_1.dirname)(localPath), { recursive: true });
                (0, db_1.appendLog)(task.id, `Downloading ${file.remote_path}`);
                const size = await openlist.download(file.remote_path, localPath);
                (0, db_1.appendLog)(task.id, `Downloaded ${file.remote_path}`);
                if (task.provider === 'sharepoint') {
                    const target = this.joinRemote(task.target_path, file.relative_path);
                    (0, db_1.appendLog)(task.id, `Upload to sharepoint: ${target}`);
                    await openlist.upload(localPath, target);
                }
                else if (task.provider === 'mobile' && mobile) {
                    const fakeExt = settings.mobile_fake_extension.startsWith('.')
                        ? settings.mobile_fake_extension
                        : `.${settings.mobile_fake_extension}`;
                    const originalName = localPath.split(/[/\\]/).pop() || 'file';
                    const fakeName = originalName.replace(/\.[^.]+$/, '') + fakeExt;
                    const fs = await Promise.resolve().then(() => __importStar(require('fs')));
                    const fakePath = (0, path_1.join)((0, path_1.dirname)(localPath), fakeName);
                    fs.renameSync(localPath, fakePath);
                    (0, db_1.appendLog)(task.id, `Mobile upload: rename suffix ${originalName} -> ${fakeName}`);
                    const relativeParent = (0, path_1.dirname)(file.relative_path).replace(/\\/g, '/');
                    const targetParent = await this.ensureMobileDir(mobile, settings.mobile_parent_file_id, relativeParent);
                    const res = await mobile.upload_file(fakePath, targetParent);
                    const targetOpenlistDir = this.joinRemote(settings.mobile_target_openlist_path, relativeParent === '.' ? '' : relativeParent);
                    const targetFilePath = this.joinRemote(targetOpenlistDir, res.uploaded_name);
                    await openlist.rename(targetFilePath, originalName);
                    (0, db_1.appendLog)(task.id, `OpenList rename success: ${targetFilePath} -> ${originalName}`);
                    if (settings.clean_local_after_transfer && fs.existsSync(fakePath))
                        fs.unlinkSync(fakePath);
                }
                processed += 1;
                (0, db_1.updateTask)(task.id, {
                    processed_files: processed,
                    processed_bytes: (task.processed_bytes || 0) + size,
                    total_bytes: (task.total_bytes || 0) + size,
                    updated_at: new Date().toISOString(),
                    current_item: file.remote_path,
                });
            });
        }
        await queue.onIdle();
        (0, db_1.updateTask)(task.id, {
            status: 'success',
            finished_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            current_item: '',
        });
        (0, db_1.appendLog)(task.id, 'Task completed');
        if (settings.clean_local_after_transfer && (0, fs_1.existsSync)(localRoot)) {
            try {
                (0, fs_1.rmSync)(localRoot, { recursive: true, force: true });
            }
            catch (e) {
                logger_1.logger.warn(e);
            }
        }
    }
    async walkDir(openlist, dir, prefix, out) {
        const data = await openlist.list(dir, false, 1, 0);
        const content = data.content || [];
        for (const item of content) {
            const name = item.name;
            const childPath = this.joinRemote(dir, name);
            const rel = prefix ? `${prefix}/${name}` : name;
            if (item.is_dir) {
                await this.walkDir(openlist, childPath, rel, out);
            }
            else {
                out.push({ remote_path: childPath, relative_path: rel });
            }
        }
    }
    joinRemote(base, child) {
        const a = base.endsWith('/') ? base.slice(0, -1) : base;
        const b = child.startsWith('/') ? child.slice(1) : child;
        return `${a}/${b}`.replace(/\\/g, '/');
    }
    async ensureMobileDir(mobile, root, relative) {
        const clean = (relative || '').replace(/^\//, '').replace(/\.$/, '');
        if (!clean)
            return root;
        const parts = clean.split('/').filter(Boolean);
        let current = root;
        for (const seg of parts) {
            const items = await mobile.list_dir(current);
            const found = items.find((i) => i.is_dir && i.name === seg);
            if (found) {
                current = found.file_id;
            }
            else {
                current = await mobile.create_folder(current, seg);
            }
        }
        return current;
    }
}
exports.TransferQueue = TransferQueue;
