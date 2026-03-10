"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const path_1 = __importDefault(require("path"));
const db_1 = require("../db");
const db_2 = require("../db");
exports.router = (0, express_1.Router)();
exports.router.post('/tasks', async (req, res) => {
    try {
        const settings = (0, db_1.getSettings)();
        const payload = req.body || {};
        const provider = payload.provider;
        const source_paths = (payload.source_paths || []).filter((p) => !!p);
        if (!source_paths.length)
            return res.status(400).json({ detail: 'source_paths 不能为空' });
        const target_path = payload.target_path || (provider === 'sharepoint' ? settings.sharepoint_target_path : settings.mobile_target_openlist_path) || '/';
        const source_base = payload.source_base_path || settings.source_115_root_path || '/';
        const download_base = (payload.download_base_path || settings.download_base_path || '').trim();
        if (!download_base)
            return res.status(400).json({ detail: '请先配置本地下载目录或在任务中填写' });
        const created_at = new Date().toISOString();
        const local_root = path_1.default.resolve(download_base, `task_temp`);
        const id = (0, db_1.insertTask)({
            provider,
            status: 'pending',
            source_paths_json: JSON.stringify(source_paths),
            source_base_path: source_base,
            target_path,
            local_download_path: local_root,
            total_files: 0,
            processed_files: 0,
            total_bytes: 0,
            processed_bytes: 0,
            current_item: '',
            message: '',
            error_message: '',
            logs_json: '[]',
            created_at,
            updated_at: created_at,
            started_at: null,
            finished_at: null,
        });
        const final_local = path_1.default.resolve(download_base, `task_${id}`);
        (0, db_1.updateTask)(id, { local_download_path: final_local });
        const row = (0, db_1.getTask)(id);
        res.json({ ...row, local_download_path: final_local });
    }
    catch (e) {
        res.status(400).json({ detail: e.message });
    }
});
exports.router.post('/tasks/:id/retry', (req, res) => {
    const id = Number(req.params.id);
    const task = (0, db_1.getTask)(id);
    if (!task)
        return res.status(404).json({ detail: 'task not found' });
    if (task.status === 'running')
        return res.status(400).json({ detail: '任务运行中，不能重试' });
    (0, db_1.updateTask)(id, { status: 'pending', updated_at: new Date().toISOString() });
    (0, db_2.appendLog)(id, 'Task retried');
    res.json((0, db_1.getTask)(id));
});
exports.router.get('/tasks', (req, res) => {
    const limit = Number(req.query.limit || 100);
    res.json((0, db_1.listTasks)(limit));
});
exports.router.get('/tasks/:id', (req, res) => {
    const id = Number(req.params.id);
    const task = (0, db_1.getTask)(id);
    if (!task)
        return res.status(404).json({ detail: 'task not found' });
    res.json(task);
});
