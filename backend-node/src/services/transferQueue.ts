import { join, dirname } from 'path';
import { mkdirSync, existsSync, rmSync } from 'fs';
import PQueue from 'p-queue';
import { OpenListClient } from '../clients/openlist';
import { MobileCloudClient } from '../clients/mobile';
import { appendLog, getSettings, pendingTask, updateTask } from '../db';
import { FileItem, TaskRow } from '../models';
import { logger } from '../logger';

const DOWNLOAD_CONCURRENCY = 3;
const DOWNLOAD_INTERVAL_MS = 2000;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export class TransferQueue {
  private running = false;

  start() {
    if (this.running) return;
    this.running = true;
    this.loop();
  }

  private async loop() {
    while (this.running) {
      const task = pendingTask();
      if (!task) {
        await sleep(1000);
        continue;
      }
      try {
        await this.executeTask(task as TaskRow);
      } catch (e: any) {
        logger.error(e);
      }
    }
  }

  private async executeTask(task: TaskRow) {
    const settings = getSettings();
    updateTask(task.id, {
      status: 'running',
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      logs_json: '[]',
      message: 'Task started',
      error_message: '',
      processed_files: 0,
      processed_bytes: 0,
      total_bytes: 0,
    } as any);
    appendLog(task.id, 'Task started');

    const openlist = new OpenListClient(settings.openlist_base_url, settings.openlist_token, settings.openlist_password);
    let mobile: MobileCloudClient | null = null;
    if (task.provider === 'mobile') {
      mobile = new MobileCloudClient(
        settings.mobile_authorization,
        settings.mobile_uni,
        settings.mobile_parent_file_id,
        settings.mobile_cloud_host,
        settings.mobile_app_channel,
        settings.mobile_client_info,
      );
    }

    const sourcePaths: string[] = JSON.parse(task.source_paths_json || '[]');
    const allFiles: FileItem[] = [];
    for (const src of sourcePaths) {
      appendLog(task.id, `Resolving source: ${src}`);
      const obj = await openlist.get(src);
      if (!obj) throw new Error('source unavailable');
      if (!obj.is_dir) {
        const name = src.split('/').pop() || 'file';
        allFiles.push({ remote_path: src, relative_path: name });
      } else {
        await this.walkDir(openlist, src, '', allFiles);
      }
    }

    updateTask(task.id, { total_files: allFiles.length, updated_at: new Date().toISOString() } as any);
    appendLog(task.id, `Collected files: ${allFiles.length}`);

    const localRoot = join(task.local_download_path || settings.download_base_path || '.', `task_${task.id}`);
    mkdirSync(localRoot, { recursive: true });

    const queue = new PQueue({ concurrency: DOWNLOAD_CONCURRENCY, intervalCap: DOWNLOAD_CONCURRENCY, interval: DOWNLOAD_INTERVAL_MS });

    let processed = 0;
    for (const file of allFiles) {
      queue.add(async () => {
        const localPath = join(localRoot, file.relative_path);
        mkdirSync(dirname(localPath), { recursive: true });
        appendLog(task.id, `Downloading ${file.remote_path}`);
        const size = await openlist.download(file.remote_path, localPath);
        appendLog(task.id, `Downloaded ${file.remote_path}`);

        if (task.provider === 'sharepoint') {
          const target = this.joinRemote(task.target_path, file.relative_path);
          appendLog(task.id, `Upload to sharepoint: ${target}`);
          await openlist.upload(localPath, target);
        } else if (task.provider === 'mobile' && mobile) {
          const fakeExt = settings.mobile_fake_extension.startsWith('.')
            ? settings.mobile_fake_extension
            : `.${settings.mobile_fake_extension}`;
          const originalName = localPath.split(/[/\\]/).pop() || 'file';
          const fakeName = originalName.replace(/\.[^.]+$/, '') + fakeExt;
          const fs = await import('fs');
          const fakePath = join(dirname(localPath), fakeName);
          fs.renameSync(localPath, fakePath);
          appendLog(task.id, `Mobile upload: rename suffix ${originalName} -> ${fakeName}`);

          const relativeParent = dirname(file.relative_path).replace(/\\/g, '/');
          const targetParent = await this.ensureMobileDir(mobile, settings.mobile_parent_file_id, relativeParent);
          const res = await mobile.upload_file(fakePath, targetParent);

          const targetOpenlistDir = this.joinRemote(settings.mobile_target_openlist_path, relativeParent === '.' ? '' : relativeParent);
          const targetFilePath = this.joinRemote(targetOpenlistDir, res.uploaded_name);
          await openlist.rename(targetFilePath, originalName);
          appendLog(task.id, `OpenList rename success: ${targetFilePath} -> ${originalName}`);

          if (settings.clean_local_after_transfer && fs.existsSync(fakePath)) fs.unlinkSync(fakePath);
        }

        processed += 1;
        updateTask(task.id, {
          processed_files: processed,
          processed_bytes: (task.processed_bytes || 0) + size,
          total_bytes: (task.total_bytes || 0) + size,
          updated_at: new Date().toISOString(),
          current_item: file.remote_path,
        } as any);
      });
    }

    await queue.onIdle();

    updateTask(task.id, {
      status: 'success',
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_item: '',
    } as any);
    appendLog(task.id, 'Task completed');

    if (settings.clean_local_after_transfer && existsSync(localRoot)) {
      try {
        rmSync(localRoot, { recursive: true, force: true });
      } catch (e) {
        logger.warn(e);
      }
    }
  }

  private async walkDir(openlist: OpenListClient, dir: string, prefix: string, out: FileItem[]) {
    const data = await openlist.list(dir, false, 1, 0);
    const content = data.content || [];
    for (const item of content) {
      const name = item.name;
      const childPath = this.joinRemote(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (item.is_dir) {
        await this.walkDir(openlist, childPath, rel, out);
      } else {
        out.push({ remote_path: childPath, relative_path: rel });
      }
    }
  }

  private joinRemote(base: string, child: string) {
    const a = base.endsWith('/') ? base.slice(0, -1) : base;
    const b = child.startsWith('/') ? child.slice(1) : child;
    return `${a}/${b}`.replace(/\\/g, '/');
  }

  private async ensureMobileDir(mobile: MobileCloudClient, root: string, relative: string) {
    const clean = (relative || '').replace(/^\//, '').replace(/\.$/, '');
    if (!clean) return root;
    const parts = clean.split('/').filter(Boolean);
    let current = root;
    for (const seg of parts) {
      const items = await mobile.list_dir(current);
      const found = items.find((i: any) => i.is_dir && i.name === seg);
      if (found) {
        current = found.file_id;
      } else {
        current = await mobile.create_folder(current, seg);
      }
    }
    return current;
  }
}
