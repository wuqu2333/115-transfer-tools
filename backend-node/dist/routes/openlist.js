"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const db_1 = require("../db");
const openlist_1 = require("../clients/openlist");
exports.router = (0, express_1.Router)();
exports.router.post('/openlist/login', async (req, res) => {
    try {
        const settings = (0, db_1.getSettings)();
        const { username, password } = req.body || {};
        if (!settings.openlist_base_url)
            return res.status(400).json({ detail: '请先配置 OpenList 地址' });
        const token = await new openlist_1.OpenListClient(settings.openlist_base_url, '', '').login(username, password);
        res.json({ token });
    }
    catch (e) {
        res.status(400).json({ detail: e.message });
    }
});
exports.router.post('/openlist/list', async (req, res) => {
    try {
        const settings = (0, db_1.getSettings)();
        const { path = '/', refresh = false, page = 1, per_page = 0, password } = req.body || {};
        if (!settings.openlist_base_url || !settings.openlist_token)
            return res.status(400).json({ detail: 'OpenList 未配置' });
        const client = new openlist_1.OpenListClient(settings.openlist_base_url, settings.openlist_token, password || settings.openlist_password);
        const data = await client.list(path, refresh, page, per_page);
        const current = client.normalize(path);
        const content = (data.content || []).map((item) => ({
            name: item.name,
            path: client.normalize(`${current}/${item.name}`),
            is_dir: !!item.is_dir,
            size: Number(item.size || 0),
            modified: item.modified,
        }));
        res.json({ path: current, items: content, raw: data });
    }
    catch (e) {
        res.status(400).json({ detail: e.message });
    }
});
exports.router.get('/openlist/storages', async (req, res) => {
    try {
        const settings = (0, db_1.getSettings)();
        const page = Number(req.query.page || 1);
        const per_page = Number(req.query.per_page || 200);
        if (!settings.openlist_base_url || !settings.openlist_token)
            return res.status(400).json({ detail: 'OpenList 未配置' });
        const client = new openlist_1.OpenListClient(settings.openlist_base_url, settings.openlist_token, settings.openlist_password);
        const data = await client.listStorages(page, per_page);
        res.json(data);
    }
    catch (e) {
        res.status(400).json({ detail: e.message });
    }
});
