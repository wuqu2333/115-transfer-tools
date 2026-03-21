import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import path from 'path';
import { existsSync } from 'fs';
import { router as settingsRouter } from './routes/settings';
import { router as openlistRouter } from './routes/openlist';
import { router as mobileRouter } from './routes/mobile';
import { router as tasksRouter } from './routes/tasks';
import { router as healthRouter } from './routes/health';
import { router as systemRouter } from './routes/system';
import { router as uiRouter } from './routes/ui';
import { router as treeRouter } from './routes/tree';
import { transferQueue } from './services/transferQueue';
import { logger } from './logger';

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '10mb' }));

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'UnhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'UncaughtException');
});

const envStaticDir = process.env.STATIC_DIR;
const defaultStaticDir = path.join(process.cwd(), '..', 'frontend', 'dist');
const legacyStaticDir = path.join(process.cwd(), '..', 'app', 'static');
const STATIC_DIR = envStaticDir || (existsSync(defaultStaticDir) ? defaultStaticDir : legacyStaticDir);
const assetsPath = path.join(STATIC_DIR, 'assets');

app.use('/api', settingsRouter);
app.use('/api', openlistRouter);
app.use('/api', mobileRouter);
app.use('/api', tasksRouter);
app.use('/api', healthRouter);
app.use('/api', systemRouter);
app.use('/api', uiRouter);
app.use('/api', treeRouter);

// 静态资源
if (!existsSync(STATIC_DIR)) {
  logger.warn(`Static directory not found: ${STATIC_DIR}`);
}
if (existsSync(assetsPath)) {
  app.use(
    '/assets',
    express.static(assetsPath, {
      maxAge: '365d',
      immutable: true,
    }),
  );
}
app.get('/vite.svg', (_, res) => {
  const vitePath = path.join(STATIC_DIR, 'vite.svg');
  if (existsSync(vitePath)) return res.sendFile(vitePath);
  return res.status(404).end();
});
if (existsSync(STATIC_DIR)) {
  app.use(
    '/',
    express.static(STATIC_DIR, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('index.html')) {
          res.setHeader('Cache-Control', 'no-cache');
        }
      },
    }),
  );
}
app.get(/.*/, (req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const indexPath = path.join(STATIC_DIR, 'index.html');
  if (existsSync(indexPath)) {
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(indexPath);
  }
  return res.status(404).end();
});

const port = Number(process.env.PORT || 8000);
app.listen(port, () => {
  logger.info(`Node backend listening on http://0.0.0.0:${port}`);
});

// 启动任务队列
transferQueue.start();
