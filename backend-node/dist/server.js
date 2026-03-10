"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const body_parser_1 = __importDefault(require("body-parser"));
const path_1 = __importDefault(require("path"));
const settings_1 = require("./routes/settings");
const openlist_1 = require("./routes/openlist");
const mobile_1 = require("./routes/mobile");
const tasks_1 = require("./routes/tasks");
const health_1 = require("./routes/health");
const transferQueue_1 = require("./services/transferQueue");
const logger_1 = require("./logger");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(body_parser_1.default.json({ limit: '10mb' }));
const STATIC_DIR = process.env.STATIC_DIR || path_1.default.join(process.cwd(), '..', 'app', 'static');
const assetsPath = path_1.default.join(STATIC_DIR, 'assets');
app.use('/api', settings_1.router);
app.use('/api', openlist_1.router);
app.use('/api', mobile_1.router);
app.use('/api', tasks_1.router);
app.use('/api', health_1.router);
// 静态资源
app.use('/assets', express_1.default.static(assetsPath));
app.get('/vite.svg', (_, res) => res.sendFile(path_1.default.join(STATIC_DIR, 'vite.svg')));
app.use('/', express_1.default.static(STATIC_DIR));
const port = Number(process.env.PORT || 8000);
app.listen(port, () => {
    logger_1.logger.info(`Node backend listening on http://0.0.0.0:${port}`);
});
// 启动任务队列
const queue = new transferQueue_1.TransferQueue();
queue.start();
