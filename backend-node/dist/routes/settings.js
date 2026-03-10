"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const express_1 = require("express");
const db_1 = require("../db");
exports.router = (0, express_1.Router)();
exports.router.get('/settings', (_req, res) => {
    res.json((0, db_1.getSettings)());
});
exports.router.put('/settings', (req, res) => {
    const updated = (0, db_1.updateSettings)(req.body || {});
    res.json(updated);
});
