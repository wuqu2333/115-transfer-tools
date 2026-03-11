import { join, dirname, resolve, posix as pathPosix } from "path";
import { mkdirSync, existsSync, rmSync, createWriteStream, renameSync, readdirSync, rmdirSync } from "fs";
import PQueue from "p-queue";
import { OpenListClient } from "../clients/openlist";
import { MobileCloudClient } from "../clients/mobile";
import { appendLog, getSettings, pendingTask, resetRunningTasks, updateTask, getTask, hasRunningTask } from "../db";
import { FileItem, TaskRow } from "../models";
import { logger } from "../logger";

const DOWNLOAD_CONCURRENCY = 3;
const DOWNLOAD_INTERVAL_MS = 2000;
const DOWNLOAD_RETRY = 3;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function isHex64(value: string) {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

function extractSha256(item: any): string {
  const candidates = [
    item?.content_hash,
    item?.contentHash,
    item?.sha256,
    item?.sha_256,
    item?.hash?.sha256,
  ];
  for (const v of candidates) {
    if (typeof v === "string" && isHex64(v.trim())) return v.trim().toLowerCase();
  }
  if (typeof item?.hash === "string") {
    const h = item.hash.trim();
    if (isHex64(h)) return h.toLowerCase();
    const match = h.match(/sha256[:=]([a-fA-F0-9]{64})/);
    if (match) return match[1].toLowerCase();
  }
  return "";
}

function normalizePrefix(p: string) {
  if (!p) return "";
  let s = String(p).trim();
  if (!s) return "";
  s = s.replace(/\\/g, "/");
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s;
}

function joinPrefix(prefix: string, name: string) {
  if (!prefix) return name;
  if (prefix === "/") return `/${name}`;
  return `${prefix}/${name}`;
}

function sanitizeFileName(name: string) {
  const cleaned = String(name || "root")
    .replace(/[\\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "root";
}

function getFolderNameFromPath(pathStr: string) {
  const norm = normalizePrefix(pathStr || "");
  if (!norm || norm === "/") return "root";
  const parts = norm.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "root";
}

function percent(done: number, total: number) {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let n = bytes;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx += 1;
  }
  return `${n.toFixed(n >= 10 || idx === 0 ? 0 : 1)}${units[idx]}`;
}

type RapidItem = {
  name: string;
  size: number;
  sha256: string;
  parent_file_id?: string;
  base_name?: string;
  relative_dir?: string;
};

function splitPathParts(input: string) {
  const clean = String(input || "").replace(/\\/g, "/");
  if (!clean) return { base: "", dir: "" };
  const parts = clean.split("/").filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : clean;
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  return { base, dir };
}

export class TransferQueue {
  private running = false;

  start() {
    if (this.running) return;
    const recovered = resetRunningTasks();
    if (recovered.length) {
      recovered.forEach((id) => appendLog(id, "检测到服务重启，任务已重新排队"));
    }
    this.running = true;
    void this.loop();
  }

  private async loop() {
    while (this.running) {
      if (hasRunningTask()) {
        await sleep(1000);
        continue;
      }
      const task = pendingTask();
      if (!task) {
        await sleep(1000);
        continue;
      }
      try {
        await this.executeTask(task as TaskRow);
      } catch (e: any) {
        logger.error(e);
        this.markFailed(task.id, e?.message || String(e));
      }
    }
  }

  private markFailed(taskId: number, message: string) {
    const current = getTask(taskId);
    if (current?.status === "stopped") return;
    updateTask(taskId, {
      status: "failed",
      error_message: message,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);
    appendLog(taskId, `失败：${message}`);
  }

  private markStopped(taskId: number, message = "任务已终止") {
    updateTask(taskId, {
      status: "stopped",
      error_message: message,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_item: "",
      message,
    } as any);
    appendLog(taskId, message);
  }

  private isStopped(taskId: number): boolean {
    const current = getTask(taskId);
    return !!current && current.status === "stopped";
  }

  private async executeTask(task: TaskRow) {
    const settings = getSettings();
    updateTask(task.id, {
      status: "running",
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      logs_json: "[]",
      message: "任务开始",
      error_message: "",
      processed_files: 0,
      processed_bytes: 0,
      total_bytes: 0,
      current_item: "",
    } as any);
    appendLog(task.id, "任务开始");

    let stopFlag = false;
    const checkStop = () => {
      if (stopFlag) return true;
      if (this.isStopped(task.id)) {
        stopFlag = true;
        appendLog(task.id, "检测到终止请求，正在停止...");
        return true;
      }
      return false;
    };

    if (task.provider === "rapid_mobile") {
      await this.executeRapidTask(task, settings);
      return;
    }
    if (checkStop()) {
      this.markStopped(task.id);
      return;
    }
    if (task.provider === "mobile_export") {
      await this.executeMobileExportTask(task, settings);
      return;
    }

    const openlist = new OpenListClient(settings.openlist_base_url, settings.openlist_token, settings.openlist_password);
    let mobile: MobileCloudClient | null = null;
    if (task.provider === "mobile") {
      mobile = new MobileCloudClient(
        settings.mobile_authorization,
        settings.mobile_uni,
        settings.mobile_parent_file_id,
        settings.mobile_cloud_host,
        settings.mobile_app_channel,
        settings.mobile_client_info,
      );
    }

    const sourcePaths: string[] = JSON.parse(task.source_paths_json || "[]");
    if (!sourcePaths.length) throw new Error("source_paths cannot be empty");

    const allFiles: FileItem[] = [];
    for (const src of sourcePaths) {
      if (checkStop()) {
        this.markStopped(task.id);
        return;
      }
      appendLog(task.id, `解析源路径：${src}`);
      const obj = await openlist.get(src);
      if (!obj) throw new Error(`source unavailable: ${src}`);
      if (!obj.is_dir) {
        const name = src.split("/").filter(Boolean).pop() || "file";
        const size = Number(obj.size ?? obj.raw_size ?? obj.length ?? 0);
        allFiles.push({ remote_path: src, relative_path: name, size });
      } else {
        const rootName = src === "/" ? "" : src.split("/").filter(Boolean).pop() || "";
        const prefix = rootName ? rootName : "";
        await this.walkDir(openlist, src, prefix, allFiles);
      }
    }

    let totalBytes = allFiles.reduce((sum, f) => sum + Number(f.size || 0), 0);
    updateTask(task.id, {
      total_files: allFiles.length,
      total_bytes: totalBytes,
      updated_at: new Date().toISOString(),
    } as any);
    appendLog(
      task.id,
      `已收集文件：${allFiles.length}，总大小：${formatBytes(totalBytes)}`,
    );

    const localRoot = task.local_download_path || settings.download_base_path;
    if (!localRoot) throw new Error("缺少本地下载目录");
    mkdirSync(localRoot, { recursive: true });
    appendLog(
      task.id,
      `下载策略：并发 ${DOWNLOAD_CONCURRENCY}，启动间隔 2s，115 403 自动重试`,
    );

    const dirCache: Record<string, string> = {};
    if (task.provider === "mobile") dirCache[""] = settings.mobile_parent_file_id;

    const queue = new PQueue({ concurrency: DOWNLOAD_CONCURRENCY });
    let processedFiles = 0;
    let processedBytes = 0;
    let lastProgressUpdate = 0;

    const buildMessage = (stage: string) => {
      const filePct = percent(processedFiles, allFiles.length);
      let msg = `${stage} ${processedFiles}/${allFiles.length}（${filePct}%）`;
      if (totalBytes > 0) {
        const bytePct = percent(processedBytes, totalBytes);
        msg += ` · ${formatBytes(processedBytes)}/${formatBytes(totalBytes)}（${bytePct}%）`;
      }
      return msg;
    };

    const updateProgress = (stage: string, force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressUpdate < 400) return;
      lastProgressUpdate = now;
      updateTask(task.id, {
        processed_files: processedFiles,
        processed_bytes: processedBytes,
        total_bytes: totalBytes,
        updated_at: new Date().toISOString(),
        message: buildMessage(stage),
      } as any);
    };

    for (let idx = 0; idx < allFiles.length; idx++) {
      const file = allFiles[idx];
      if (checkStop()) {
        stopFlag = true;
        break;
      }
      queue.add(async () => {
        if (checkStop()) return;
        const localPath = join(localRoot, file.relative_path);
        mkdirSync(dirname(localPath), { recursive: true });
        updateTask(task.id, { current_item: file.remote_path } as any);

        const expectedSize = Number(file.size || 0);
        let fileDownloaded = 0;
        const downloadLogger = this.makeFileProgressLogger(task.id, "下载", file.remote_path, idx, allFiles.length);
        const size = await this.downloadWithRetry(
          openlist,
          file.remote_path,
          localPath,
          task.id,
          (delta, loaded, total) => {
            fileDownloaded = loaded;
            processedBytes += delta;
            downloadLogger(loaded, total || expectedSize);
            updateProgress("下载中");
          },
          expectedSize,
        );
        if (size > fileDownloaded) processedBytes += size - fileDownloaded;
        if (!expectedSize && size > 0) {
          totalBytes += size;
          updateTask(task.id, { total_bytes: totalBytes, updated_at: new Date().toISOString() } as any);
        }
        const downloadPct = percent(idx + 1, allFiles.length);
        appendLog(task.id, `下载完成 [${idx + 1}/${allFiles.length}，${downloadPct}%]：${file.remote_path}`);

        if (task.provider === "sharepoint") {
          const target = this.joinRemote(task.target_path, file.relative_path);
          appendLog(task.id, `上传到世纪互联：${target}`);
          const uploadLogger = this.makeFileProgressLogger(task.id, "上传", target, idx, allFiles.length);
          await openlist.upload(localPath, target, (delta, loaded, total) => {
            uploadLogger(loaded, total || size);
            updateProgress("上传中");
          });
          const uploadPct = percent(idx + 1, allFiles.length);
          appendLog(task.id, `上传完成 [${idx + 1}/${allFiles.length}，${uploadPct}%]：${target}`);
        } else if (task.provider === "mobile" && mobile) {
          await this.uploadToMobile({
            task,
            settings,
            openlist,
            mobile,
            localPath,
            localRoot,
            fileItem: file,
            dirCache,
            index: idx,
            total: allFiles.length,
          });
        }

        if (task.provider === "sharepoint" && settings.clean_local_after_transfer) {
          try {
            rmSync(localPath, { force: true });
          } catch (_e) {
            // ignore
          }
          this.pruneEmptyDirs(localPath, localRoot);
        }

        processedFiles += 1;
        updateProgress("进行中", true);
      });

      if (idx < allFiles.length - 1) {
        await sleep(DOWNLOAD_INTERVAL_MS);
      }
    }

    try {
      await queue.onIdle();
    } catch (e: any) {
      this.markFailed(task.id, e?.message || String(e));
      throw e;
    }

    if (stopFlag || checkStop()) {
      this.markStopped(task.id);
      return;
    }

    updateTask(task.id, {
      status: "success",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_item: "",
    } as any);
    appendLog(task.id, "任务完成");

    if (settings.clean_local_after_transfer && existsSync(localRoot)) {
      try {
        rmSync(localRoot, { recursive: true, force: true });
      } catch (e) {
        logger.warn(e);
      }
    }
  }

  private async downloadWithRetry(
    openlist: OpenListClient,
    remote: string,
    local: string,
    taskId: number,
    onProgress?: (delta: number, loaded: number, total?: number) => void,
    expectedTotal?: number,
  ) {
    let lastErr: any;
    for (let attempt = 1; attempt <= DOWNLOAD_RETRY; attempt++) {
      try {
        return await openlist.download(remote, local, onProgress, expectedTotal);
      } catch (err: any) {
        lastErr = err;
        const status = err?.response?.status;
        const msg: string = err?.message || "";
        if (status === 403 || msg.includes("403")) {
          appendLog(taskId, `115 403，重试 ${attempt}/${DOWNLOAD_RETRY}`);
          await sleep(1500 * attempt);
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private async uploadToMobile(opts: {
    task: TaskRow;
    settings: any;
    openlist: OpenListClient;
    mobile: MobileCloudClient;
    localPath: string;
    localRoot: string;
    fileItem: FileItem;
    dirCache: Record<string, string>;
    index: number;
    total: number;
  }) {
    const { task, settings, openlist, mobile, localPath, localRoot, fileItem, dirCache, index, total } = opts;
    const fakeExtRaw = settings.mobile_fake_extension?.trim() || ".jpg";
    const fakeExt = fakeExtRaw.startsWith(".") ? fakeExtRaw : `.${fakeExtRaw}`;
    const originalName = localPath.split(/[/\\]/).pop() || "file";
    const stem = originalName.replace(/\.[^.]+$/, "");
    const fakeName = `${stem}${fakeExt}`;
    const fs = await import("fs");

    const relativeParent = pathPosix.dirname(fileItem.relative_path) === "." ? "" : pathPosix.dirname(fileItem.relative_path);
    const targetOpenlistDir = this.joinRemote(settings.mobile_target_openlist_path, relativeParent);

    const existsOriginal = await this.existsInOpenlist(openlist, targetOpenlistDir, originalName);
    const existsFake = await this.existsInOpenlist(openlist, targetOpenlistDir, fakeName);
    if (existsOriginal || existsFake) {
      appendLog(task.id, `跳过上传：目标目录已存在 ${originalName} 或 ${fakeName}（${targetOpenlistDir}）`);
      if (settings.clean_local_after_transfer && fs.existsSync(localPath)) {
        try {
          fs.unlinkSync(localPath);
        } catch (_e) {
          // ignore
        }
        this.pruneEmptyDirs(localPath, localRoot);
      }
      return;
    }

    const fakePath = join(dirname(localPath), fakeName);
    fs.renameSync(localPath, fakePath);
    appendLog(task.id, `移动上传：改后缀 ${originalName} -> ${fakeName}`);

    const targetParent = await this.ensureMobileDir(mobile, settings.mobile_parent_file_id, relativeParent, dirCache);
    const uploadLogger = this.makeFileProgressLogger(task.id, "上传", originalName, index, total);
    const res = await mobile.upload_file(fakePath, targetParent, (_delta, loaded, totalBytes) => {
      uploadLogger(loaded, totalBytes);
    });
    appendLog(task.id, `移动上传完成 [${index + 1}/${total}，${percent(index + 1, total)}%] file_id=${res.file_id}`);

    const renamed = await this.ensureMobileRename(mobile, targetParent, res.file_id, originalName, 5);
    if (renamed) {
      appendLog(task.id, `移动重命名成功：${originalName} (file_id=${res.file_id})`);
    } else {
      appendLog(task.id, `移动重命名失败：${originalName} (file_id=${res.file_id})`);
    }

    if (settings.clean_local_after_transfer && fs.existsSync(fakePath)) {
      try {
        fs.unlinkSync(fakePath);
      } catch (_e) {
        // ignore
      }
    }
    if (settings.clean_local_after_transfer) {
      this.pruneEmptyDirs(fakePath, localRoot);
    }
  }

  private async executeRapidTask(task: TaskRow, settings: any) {
    if (!settings.mobile_authorization || !settings.mobile_uni) {
      throw new Error("缺少移动云盘 Authorization/UNI");
    }
    let stopFlag = false;
    const checkStop = () => {
      if (stopFlag) return true;
      if (this.isStopped(task.id)) {
        stopFlag = true;
        appendLog(task.id, "检测到终止请求，正在停止...");
        return true;
      }
      return false;
    };
    if (checkStop()) {
      this.markStopped(task.id);
      return;
    }
    let payload: any = {};
    try {
      payload = JSON.parse(task.source_paths_json || "{}");
    } catch (_e) {
      payload = {};
    }
    const rawItems = Array.isArray(payload) ? payload : payload.items;
    if (!Array.isArray(rawItems) || !rawItems.length) throw new Error("items 不能为空");

    const keepDirs = payload.keep_dirs !== false;
    const concurrencyRaw = Number(payload.concurrency ?? 0);
    const concurrency =
      Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.min(Math.max(concurrencyRaw, 1), 16) : 8;
    const retryRaw = Number(payload.retry ?? 0);
    const retryCount = Number.isFinite(retryRaw) && retryRaw > 0 ? Math.min(Math.max(retryRaw, 1), 5) : 2;

    const baseParent = (payload.parent_file_id || settings.mobile_parent_file_id || "").trim();
    if (!baseParent) throw new Error("parent_file_id 不能为空");

    const items: RapidItem[] = rawItems
      .map((o: any) => {
        const name = String(o.name || o.path || o.file || "");
        const { base, dir } = splitPathParts(name);
        return {
          name,
          size: Number(o.size ?? o.length ?? o.file_size ?? o.filesize ?? o.bytes ?? 0),
          sha256: String(o.sha256 || o.hash || o.sha || "").toLowerCase(),
          parent_file_id: o.parent_file_id ? String(o.parent_file_id) : undefined,
          base_name: o.base_name || base || name,
          relative_dir: o.relative_dir || dir || "",
        };
      })
      .filter((x: RapidItem) => x.name && x.sha256);

    if (!items.length) throw new Error("items 不能为空");

    const totalBytes = items.reduce((sum, it) => sum + Number(it.size || 0), 0);
    updateTask(task.id, {
      total_files: items.length,
      total_bytes: totalBytes,
      updated_at: new Date().toISOString(),
    } as any);
    appendLog(
      task.id,
      `秒传任务开始：数量=${items.length}，并发=${concurrency}，重试=${retryCount}，保留目录=${keepDirs}`,
    );

    const mobile = new MobileCloudClient(
      settings.mobile_authorization,
      settings.mobile_uni,
      baseParent,
      settings.mobile_cloud_host,
      settings.mobile_app_channel,
      settings.mobile_client_info,
    );
    const fakeExtRaw = settings.mobile_fake_extension?.trim() || ".jpg";
    const fakeExt = fakeExtRaw.startsWith(".") ? fakeExtRaw : `.${fakeExtRaw}`;

    const dirCache: Record<string, string> = {};

    const shouldRetryRapid = (msg: string) => {
      if (!msg) return true;
      if (msg.includes("秒传未命中")) return false;
      if (msg.includes("文件名称不符合标准")) return false;
      return true;
    };

    const rapidUploadWithRetry = async (opts: {
      file_name: string;
      file_size: number;
      content_hash: string;
      parent_file_id: string;
    }) => {
      let lastErr: any;
      for (let attempt = 1; attempt <= retryCount; attempt++) {
        try {
          return await mobile.rapid_upload_only(opts);
        } catch (e: any) {
          lastErr = e;
          const msg = e?.message || String(e);
          if (!shouldRetryRapid(msg) || attempt >= retryCount) throw e;
          appendLog(task.id, `秒传重试 ${attempt}/${retryCount} 失败：${msg}`);
          await sleep(400 * attempt);
        }
      }
      throw lastErr || new Error("rapid upload failed");
    };

    const itemsByParent: Record<string, RapidItem[]> = {};
    for (const it of items) {
      const parentId = (it.parent_file_id || baseParent).trim() || baseParent;
      itemsByParent[parentId] = itemsByParent[parentId] || [];
      itemsByParent[parentId].push(it);
    }
    for (const [parentId, list] of Object.entries(itemsByParent)) {
      const dirs = new Set<string>();
      for (const it of list) {
        const rel = keepDirs ? it.relative_dir || "" : "";
        if (!rel) continue;
        const parts = rel.split("/").filter(Boolean);
        let built = "";
        for (const seg of parts) {
          built = built ? `${built}/${seg}` : seg;
          dirs.add(built);
        }
      }
      const ordered = Array.from(dirs).sort((a, b) => a.split("/").length - b.split("/").length);
      for (const dir of ordered) {
        await this.ensureMobileDir(mobile, parentId, dir, dirCache);
      }
    }

    const queue = new PQueue({ concurrency });
    let processedFiles = 0;
    let processedBytes = 0;
    let okCount = 0;
    let renameFail = 0;
    let missCount = 0;
    let failCount = 0;

    items.forEach((it, idx) => {
      queue.add(async () => {
        if (checkStop()) return;
        const parentId = (it.parent_file_id || baseParent).trim() || baseParent;
        const baseName = it.base_name || it.name;
        const relativeDir = keepDirs ? it.relative_dir || "" : "";
        const stem = baseName.replace(/\.[^.]+$/, "");
        const fakeName = `${stem}${fakeExt}`;
        updateTask(task.id, { current_item: it.name } as any);
        try {
          const targetParent = relativeDir
            ? await this.ensureMobileDir(mobile, parentId, relativeDir, dirCache)
            : parentId;
          const resu = await rapidUploadWithRetry({
            file_name: fakeName,
            file_size: Number(it.size || 0),
            content_hash: it.sha256,
            parent_file_id: targetParent,
          });
          const renamed = await this.ensureMobileRename(mobile, targetParent, resu.file_id, baseName, 5);
          if (renamed) {
            okCount += 1;
            appendLog(task.id, `移动重命名成功：${baseName} (file_id=${resu.file_id})`);
          } else {
            renameFail += 1;
            appendLog(task.id, `移动重命名失败：${baseName} (file_id=${resu.file_id})`);
          }
        } catch (err: any) {
          const msg = err?.message || String(err);
          if (msg.includes("秒传未命中")) missCount += 1;
          else failCount += 1;
          appendLog(task.id, `秒传失败：${it.name} -> ${msg}`);
        } finally {
          processedFiles += 1;
          processedBytes += Number(it.size || 0);
          updateTask(task.id, {
            processed_files: processedFiles,
            processed_bytes: processedBytes,
            updated_at: new Date().toISOString(),
            message: `秒传中 ${processedFiles}/${items.length}（${percent(processedFiles, items.length)}%）`,
          } as any);
        }
      });
    });

    await queue.onIdle();

    if (stopFlag || checkStop()) {
      this.markStopped(task.id);
      return;
    }

    const summary = `成功 ${okCount}，重命名失败 ${renameFail}，未命中 ${missCount}，失败 ${failCount}`;
    const hasIssue = renameFail + missCount + failCount > 0;
    updateTask(task.id, {
      status: hasIssue ? "failed" : "success",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_item: "",
      message: summary,
      error_message: hasIssue ? summary : "",
    } as any);
    appendLog(task.id, `秒传任务完成：${summary}`);
  }

  private async executeMobileExportTask(task: TaskRow, settings: any) {
    if (!settings.mobile_authorization || !settings.mobile_uni) {
      throw new Error("缺少移动云盘 Authorization/UNI");
    }
    let stopFlag = false;
    const checkStop = () => {
      if (stopFlag) return true;
      if (this.isStopped(task.id)) {
        stopFlag = true;
        appendLog(task.id, "检测到终止请求，正在停止...");
        return true;
      }
      return false;
    };
    if (checkStop()) {
      this.markStopped(task.id);
      return;
    }
    let payload: any = {};
    try {
      payload = JSON.parse(task.source_paths_json || "{}");
    } catch (_e) {
      payload = {};
    }
    const includeMissing = payload.include_missing === true;
    const scanRaw = Number(payload.scan_concurrency ?? payload.scanConcurrency ?? 0);
    const scanConcurrency =
      Number.isFinite(scanRaw) && scanRaw > 0 ? Math.min(Math.max(Math.floor(scanRaw), 1), 16) : 4;
    const rootsRaw = Array.isArray(payload.roots) && payload.roots.length ? payload.roots : null;
    const roots = rootsRaw
      ? rootsRaw
          .map((r: any) => ({
            parent_file_id: (r?.parent_file_id || "/").toString().trim() || "/",
            path_prefix: normalizePrefix(r?.path_prefix || ""),
          }))
          .filter((r: any) => !!r.parent_file_id)
      : [
          {
            parent_file_id: (payload.parent_file_id || "/").toString().trim() || "/",
            path_prefix: normalizePrefix(payload.path_prefix || ""),
          },
        ];

    const exportFiles: string[] = [];

    const exportRoot = join(process.cwd(), "..", "data", "exports");
    mkdirSync(exportRoot, { recursive: true });
    let totalFiles = 0;
    let exported = 0;
    let missing = 0;
    let lastLog = 0;
    let lastUpdate = 0;

    for (let idx = 0; idx < roots.length; idx++) {
      const root = roots[idx];
      const parentId = root.parent_file_id;
      const prefix = normalizePrefix(root.path_prefix || "");
      const folderName = sanitizeFileName(getFolderNameFromPath(prefix));
      const tmpName = `export_tmp_${task.id}_${idx}.json`;
      const tmpPath = join(exportRoot, tmpName);

      const client = new MobileCloudClient(
        settings.mobile_authorization,
        settings.mobile_uni,
        parentId,
        settings.mobile_cloud_host,
        settings.mobile_app_channel,
        settings.mobile_client_info,
      );

      appendLog(task.id, `开始导出：${prefix || "/"}（parent=${parentId}，扫描并发=${scanConcurrency}）`);
      const stream = createWriteStream(tmpPath, { encoding: "utf8" });
      const write = async (chunk: string) => {
        if (!stream.write(chunk)) {
          await new Promise<void>((resolve) => stream.once("drain", resolve));
        }
      };

      let first = true;
      let exportedThis = 0;
      let writeChain = Promise.resolve();

      await write("[");

      const enqueueWrite = (chunk: string) => {
        writeChain = writeChain.then(() => write(chunk));
        return writeChain;
      };

      const writeItem = async (obj: any) => {
        const line = JSON.stringify(obj);
        if (first) {
          first = false;
          await enqueueWrite(line);
        } else {
          await enqueueWrite(`,${line}`);
        }
        exported += 1;
        exportedThis += 1;
      };

      const queue = new PQueue({ concurrency: scanConcurrency });
      const enqueueDir = (pid: string, curPrefix: string) => {
        queue.add(async () => {
          if (checkStop()) return;
          let list: any[] = [];
          try {
            list = await client.list_dir(pid);
          } catch (e: any) {
            appendLog(task.id, `读取目录失败：${curPrefix || "/"} -> ${e?.message || String(e)}`);
            throw e;
          }
          for (const it of list) {
            if (checkStop()) return;
            const nextName = joinPrefix(curPrefix, it.name);
            if (it.is_dir) {
              enqueueDir(it.file_id, nextName);
            } else {
              totalFiles += 1;
              const size = Number(it.size || 0);
              const sha256 = extractSha256(it);
              if (sha256) {
                await writeItem({ name: nextName, size, sha256 });
              } else {
                missing += 1;
                if (includeMissing) await writeItem({ name: nextName, size, sha256: "" });
              }
            }

            const now = Date.now();
            if (now - lastLog > 3000) {
              appendLog(task.id, `已扫描 ${totalFiles} 个文件，已导出 ${exported} 条`);
              lastLog = now;
            }
            if (now - lastUpdate > 600) {
              updateTask(task.id, {
                processed_files: exported,
                total_files: totalFiles,
                current_item: nextName,
                updated_at: new Date().toISOString(),
                message: `导出中 已扫描 ${totalFiles}，已导出 ${exported}`,
              } as any);
              lastUpdate = now;
            }
          }
        });
      };

      enqueueDir(parentId, prefix);
      await queue.onIdle();
      await writeChain;
      await write("]");
      await new Promise<void>((resolve, reject) => {
        stream.end(() => resolve());
        stream.on("error", reject);
      });

      if (stopFlag || checkStop()) {
        this.markStopped(task.id);
        return;
      }

      const base = `${folderName}_${exportedThis}`;
      let finalName = `${base}.json`;
      let finalPath = join(exportRoot, finalName);
      let suffix = 1;
      while (existsSync(finalPath)) {
        suffix += 1;
        finalName = `${base}_${suffix}.json`;
        finalPath = join(exportRoot, finalName);
      }
      renameSync(tmpPath, finalPath);
      exportFiles.push(finalPath);
      appendLog(task.id, `导出完成：${finalName}`);
    }

    updateTask(task.id, {
      status: "success",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_item: "",
      processed_files: exported,
      total_files: totalFiles,
      message: `导出完成：文件数 ${exported}，缺少 ${missing}，导出文件 ${exportFiles.length} 个`,
      local_download_path: exportFiles.length === 1 ? exportFiles[0] : JSON.stringify(exportFiles),
    } as any);
  }

  private pruneEmptyDirs(filePath: string, rootPath: string) {
    if (!filePath || !rootPath) return;
    const root = resolve(rootPath);
    let current = resolve(dirname(filePath));
    while (current.startsWith(root)) {
      try {
        if (!existsSync(current)) {
          current = dirname(current);
          continue;
        }
        const entries = readdirSync(current);
        if (entries.length > 0) break;
        rmdirSync(current);
      } catch (_e) {
        break;
      }
      if (current === root) break;
      current = dirname(current);
    }
  }

  private makeFileProgressLogger(taskId: number, stage: string, label: string, index: number, totalFiles: number) {
    let lastPct = -1;
    let lastTs = 0;
    const safeLabel = label.length > 160 ? `${label.slice(0, 157)}...` : label;
    return (loaded: number, total?: number) => {
      if (!total || total <= 0) return;
      const pct = percent(loaded, total);
      if (pct >= 100 && lastPct >= 100) return;
      const now = Date.now();
      const hitStep = pct >= lastPct + 10;
      const hitTime = now - lastTs > 5000;
      const hitDone = pct >= 100 && lastPct < 100;
      if (hitDone || hitStep || hitTime) {
        appendLog(
          taskId,
          `${stage}进度 [${index + 1}/${totalFiles}] ${safeLabel}：${pct}%（${formatBytes(loaded)}/${formatBytes(total)}）`,
        );
        lastPct = pct;
        lastTs = now;
      }
    };
  }

  private async existsInOpenlist(openlist: OpenListClient, dir: string, name: string) {
    try {
      const data = await openlist.list(dir, false, 1, 0);
      const content = data.content || [];
      return content.some((it: any) => it?.name === name);
    } catch (e) {
      return false;
    }
  }

  private async ensureMobileRename(
    mobile: MobileCloudClient,
    parentId: string,
    fileId: string,
    expectedName: string,
    attempts = 5,
  ): Promise<boolean> {
    let lastName = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await mobile.rename_file(fileId, expectedName, parentId);
      } catch (_e) {
        // ignore
      }
      try {
        const items = await mobile.list_dir(parentId);
        const found = items.find((i: any) => i.file_id === fileId);
        if (found?.name) {
          lastName = found.name;
          if (found.name === expectedName) return true;
        }
      } catch (_e) {
        // ignore
      }
      await sleep(500 * attempt);
    }
    if (lastName && lastName !== expectedName) {
      logger.warn(`Mobile rename verify failed: file_id=${fileId}, name=${lastName}, expected=${expectedName}`);
    }
    return false;
  }

  private async renameOpenlistFile(opts: {
    openlist: OpenListClient;
    taskId: number;
    targetDir: string;
    candidateNames: string[];
    newName: string;
    delayBaseMs?: number;
  }) {
    const { openlist, taskId, targetDir, candidateNames, newName, delayBaseMs } = opts;
    const names = Array.from(new Set(candidateNames.filter((n) => !!n)));
    const maxAttempts = 5;
    let lastErr: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      for (const name of names) {
        const targetPath = this.joinRemote(targetDir, name);
        try {
          await openlist.rename(targetPath, newName);
          appendLog(taskId, `OpenList 重命名成功：${targetPath} -> ${newName}`);
          return;
        } catch (e: any) {
          lastErr = e;
        }
      }

      try {
        const data = await openlist.list(targetDir, true, 1, 0);
        const content = data.content || [];
          const found = content.find((it: any) => it && names.includes(it.name));
          if (found?.name) {
            const targetPath = this.joinRemote(targetDir, found.name);
            await openlist.rename(targetPath, newName);
            appendLog(taskId, `OpenList 重命名成功：${targetPath} -> ${newName}`);
            return;
          }
        } catch (e: any) {
          lastErr = e;
        }

      appendLog(taskId, `OpenList 重命名重试 ${attempt}/${maxAttempts} 失败：${lastErr?.message || String(lastErr)}`);
      const delay = (delayBaseMs || 1200) * attempt;
      await sleep(delay);
    }

    throw lastErr || new Error("OpenList rename failed");
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
        const size = Number(item.size ?? item.raw_size ?? item.length ?? 0);
        out.push({ remote_path: childPath, relative_path: rel, size });
      }
    }
  }

  private joinRemote(base: string, child: string) {
    const a = base.endsWith("/") ? base.slice(0, -1) : base || "/";
    const b = child.startsWith("/") ? child.slice(1) : child;
    return `${a}/${b}`.replace(/\\/g, "/");
  }

  private async ensureMobileDir(
    mobile: MobileCloudClient,
    root: string,
    relative: string,
    cache: Record<string, string>,
  ) {
    const clean = (relative || "").replace(/^\//, "").replace(/\.$/, "");
    if (!clean) return root;
    const rootKey = `${root}::${clean}`;
    if (cache[rootKey]) return cache[rootKey];

    const parts = clean.split("/").filter(Boolean);
    let current = root;
    let built = "";
    for (const seg of parts) {
      built = built ? `${built}/${seg}` : seg;
      const builtKey = `${root}::${built}`;
      if (cache[builtKey]) {
        current = cache[builtKey];
        continue;
      }
      const items = await mobile.list_dir(current);
      const found = items.find((i: any) => i.is_dir && i.name === seg);
      if (found) {
        current = found.file_id;
      } else {
        current = await mobile.create_folder(current, seg);
      }
      cache[builtKey] = current;
    }
    return current;
  }
}

