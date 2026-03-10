import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { router as settingsRouter } from './routes/settings';
import { router as openlistRouter } from './routes/openlist';
import { router as mobileRouter } from './routes/mobile';
import { router as tasksRouter } from './routes/tasks';
import { router as healthRouter } from './routes/health';
import { TransferQueue } from './services/transferQueue';
import { logger } from './logger';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

const STATIC_DIR = process.env.STATIC_DIR || path.join(process.cwd(), '..', 'app', 'static');
const assetsPath = path.join(STATIC_DIR, 'assets');

app.use('/api', settingsRouter);
app.use('/api', openlistRouter);
app.use('/api', mobileRouter);
app.use('/api', tasksRouter);
app.use('/api', healthRouter);

// 静态资源
app.use('/assets', express.static(assetsPath));
app.get('/vite.svg', (_, res) => res.sendFile(path.join(STATIC_DIR, 'vite.svg')));
app.use('/', express.static(STATIC_DIR));

const port = Number(process.env.PORT || 8000);
app.listen(port, () => {
  logger.info(`Node backend listening on http://0.0.0.0:${port}`);
});

// 启动任务队列
const queue = new TransferQueue();
queue.start();
