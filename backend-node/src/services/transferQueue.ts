import { join, dirname, resolve, posix as pathPosix } from "path";
import { mkdirSync, existsSync, rmSync, createWriteStream, renameSync, readdirSync, rmdirSync } from "fs";
import PQueue from "p-queue";
import { OpenListClient } from "../clients/openlist";
import { MobileCloudClient } from "../clients/mobile";
import { getDiskInfo, clearRecycleBin } from "../utils/systemInfo";
import {
  appendLog,
  getSettings,
  pendingTask,
  resetRunningTasks,
  updateTask,
  getTask,
  hasRunningTask,
  getTreeMeta,
  getTreeNode,
  listTreeFiles,
  listTreeChildren,
  listTreeDirectChildren,
  listTreeBySuffix,
} from "../db";
import { FileItem, TaskRow } from "../models";
import { logger } from "../logger";

const DOWNLOAD_CONCURRENCY = 3;
const UPLOAD_CONCURRENCY = 5;
const DOWNLOAD_INTERVAL_MS = 2000;
const DOWNLOAD_RETRY = 3;
const UPLOAD_RETRY = 3;
const SHAREPOINT_DOWNLOAD_CONCURRENCY = 1;
const SHAREPOINT_UPLOAD_CONCURRENCY = 2;
const SHAREPOINT_MAX_BUFFERED_BYTES = 10 * 1024 * 1024 * 1024;

function abortMessage(reason: unknown) {
  return typeof reason === "string" && reason ? reason : "任务已终止";
}

function createAbortError(reason?: unknown) {
  const err: any = new Error(abortMessage(reason));
  err.name = "AbortError";
  err.code = "ERR_CANCELED";
  return err;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(createAbortError(signal.reason));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
      reject(createAbortError(signal?.reason));
    };
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
  });
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

function normalizeRemotePath(p: string) {
  if (!p) return "/";
  let s = String(p).trim();
  if (!s) return "/";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s || "/";
}

function getOpenlistMountRoot(p: string) {
  const norm = normalizeRemotePath(p || "/");
  if (norm === "/") return "/";
  const parts = norm.split("/").filter(Boolean);
  return parts.length ? `/${parts[0]}` : "/";
}

function getParentDirOrSelf(p: string) {
  const norm = normalizeRemotePath(p || "/");
  if (norm === "/") return "/";
  const parent = pathPosix.dirname(norm);
  if (!parent || parent === "." || parent === norm) return norm;
  return normalizeRemotePath(parent);
}


function normalizeTreeRoot(prefix: string) {
  let s = String(prefix || "/").trim();
  if (!s) return "/";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s || "/";
}

function normalizeTreePath(input: string, rootPrefix: string) {
  let s = String(input || "").trim();
  if (!s) return "";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) {
    const root = normalizeTreeRoot(rootPrefix);
    s = root === "/" ? `/${s}` : `${root}/${s}`;
  }
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s;
}

function normalizeLooseName(value: string) {
  const s = String(value || "").trim();
  if (!s) return "";
  return s
    .normalize("NFKC")
    .replace(/^[\p{P}\p{S}\s]+/gu, "")
    .replace(/[\p{P}\p{S}\s]+$/gu, "")
    .toLowerCase();
}

function basenameFromPath(pathStr: string) {
  if (!pathStr) return "";
  const parts = pathStr.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function isTreeExportArtifactPath(pathStr: string) {
  const base = basenameFromPath(String(pathStr || ""));
  if (!base) return false;
  return /\d{10,}_目录树\.txt$/u.test(base);
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

function summarizeError(err: any) {
  return {
    name: err?.name || "Error",
    message: err?.message || String(err),
    code: err?.code,
    status: err?.response?.status,
  };
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
  private taskControllers = new Map<number, AbortController>();

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
      try {
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
          logger.error({ err: summarizeError(e), taskId: task.id }, "Task failed");
          this.markFailed(task.id, e?.message || String(e));
        }
      } catch (e: any) {
        logger.error({ err: summarizeError(e) }, "Queue loop error");
        await sleep(1000);
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
    this.taskControllers.delete(taskId);
  }

  private markStopped(taskId: number, message = "任务已终止") {
    const current = getTask(taskId);
    updateTask(taskId, {
      status: "stopped",
      error_message: message,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_item: "",
      message,
    } as any);
    if (current?.status !== "stopped" || current?.message !== message) {
      appendLog(taskId, message);
    }
    this.taskControllers.delete(taskId);
  }

  private isStopped(taskId: number): boolean {
    const current = getTask(taskId);
    return !!current && current.status === "stopped";
  }

  stopTask(taskId: number, reason = "任务已终止") {
    const controller = this.taskControllers.get(taskId);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(reason);
    return true;
  }

  private isAbortError(err: any) {
    const name = String(err?.name || "");
    const code = String(err?.code || "").toUpperCase();
    const msg = String(err?.message || "").toLowerCase();
    return (
      name === "AbortError" ||
      name === "CanceledError" ||
      code === "ERR_CANCELED" ||
      msg.includes("aborted") ||
      msg.includes("canceled") ||
      msg.includes("cancelled")
    );
  }

  private resolveFilesFromTree(taskId: number, sourcePaths: string[], rootPrefix: string) {
    const files: FileItem[] = [];
    const seen = new Set<string>();
    const missing: string[] = [];
    const skippedArtifacts: string[] = [];
    const root = normalizeTreeRoot(rootPrefix || "/");
    const childrenCache = new Map<string, Array<{ path: string; is_dir: number; size: number }>>();
    let allNodesCache: Array<{ path: string; is_dir: number; size: number }> | null = null;

    const getChildren = (parent: string) => {
      const key = parent || "/";
      if (childrenCache.has(key)) return childrenCache.get(key)!;
      const rows = listTreeDirectChildren(key);
      childrenCache.set(key, rows);
      return rows;
    };

    const getAllNodes = () => {
      if (allNodesCache) return allNodesCache;
      allNodesCache = listTreeChildren("/");
      return allNodesCache;
    };

    const matchSuffixLoose = (rawPath: string): string | null => {
      const norm = normalizeTreePath(rawPath, root);
      if (!norm) return null;
      const parts = norm.split("/").filter(Boolean);
      if (!parts.length) return null;
      const maxLen = parts.length;
      for (let len = maxLen; len >= 1; len -= 1) {
        const suffixParts = parts.slice(maxLen - len);
        const suffix = suffixParts.join("/");
        let filtered = listTreeBySuffix(suffix).filter((c) => {
          const cParts = c.path.split("/").filter(Boolean);
          if (cParts.length < suffixParts.length) return false;
          const start = cParts.length - suffixParts.length;
          for (let i = 0; i < suffixParts.length; i += 1) {
            if (normalizeLooseName(cParts[start + i]) !== normalizeLooseName(suffixParts[i])) return false;
          }
          return true;
        });
        if (!filtered.length) {
          filtered = getAllNodes().filter((c) => {
            const cParts = c.path.split("/").filter(Boolean);
            if (cParts.length < suffixParts.length) return false;
            const start = cParts.length - suffixParts.length;
            for (let i = 0; i < suffixParts.length; i += 1) {
              if (normalizeLooseName(cParts[start + i]) !== normalizeLooseName(suffixParts[i])) return false;
            }
            return true;
          });
        }
        if (!filtered.length) continue;
        if (filtered.length === 1) {
          appendLog(taskId, `路径匹配纠正：${rawPath} -> ${filtered[0].path}`);
          return filtered[0].path;
        }
      }
      return null;
    };

    const resolveTreePathLoose = (rawPath: string): string | null => {
      const norm = normalizeTreePath(rawPath, root);
      if (!norm) return null;
      if (getTreeNode(norm)) return norm;
      if (!norm.startsWith(root)) return matchSuffixLoose(rawPath);
      const rel = norm.slice(root.length).replace(/^\//, "");
      const parts = rel.split("/").filter(Boolean);
      if (!parts.length) return root === "/" ? "/" : root;
      let current = root === "/" ? "" : root;
      let matched = current;
      for (let i = 0; i < parts.length; i += 1) {
        const seg = parts[i];
        const children = getChildren(matched || "/");
        if (!children.length) {
          matched = "";
          break;
        }
        const exact = children.find((c) => basenameFromPath(c.path) === seg);
        if (exact) {
          matched = exact.path;
        } else {
          const segNorm = normalizeLooseName(seg);
          const candidates = children.filter((c) => normalizeLooseName(basenameFromPath(c.path)) === segNorm);
          if (!candidates.length) {
            matched = "";
            break;
          }
          if (candidates.length === 1) {
            matched = candidates[0].path;
          } else {
            const preferDir = i < parts.length - 1;
            const pick = preferDir ? candidates.find((c) => c.is_dir) || candidates[0] : candidates[0];
            matched = pick.path;
          }
        }
        if (!matched) break;
      }
      if (matched && matched !== norm) {
        appendLog(taskId, `路径匹配纠正：${rawPath} -> ${matched}`);
      }
      return matched || matchSuffixLoose(rawPath);
    };

    for (const raw of sourcePaths) {
      const treePath = resolveTreePathLoose(raw);
      const actualPath = normalizeRemotePath(raw);
      if (!treePath) {
        missing.push(actualPath || raw);
        continue;
      }
      const node = getTreeNode(treePath);
      if (node && !node.is_dir) {
        if (isTreeExportArtifactPath(node.path)) {
          if (skippedArtifacts.length < 5) skippedArtifacts.push(node.path);
          continue;
        }
        if (!seen.has(actualPath)) {
          seen.add(actualPath);
          files.push({
            remote_path: actualPath,
            relative_path: pathPosix.basename(actualPath),
            size: Number(node.size || 0),
          });
        }
        continue;
      }
      const list = listTreeFiles(treePath);
      if (!list.length) {
        missing.push(actualPath || treePath);
        continue;
      }
      const rootName = actualPath === "/" ? "" : actualPath.split("/").filter(Boolean).pop() || "";
      for (const row of list) {
        if (isTreeExportArtifactPath(row.path)) {
          if (skippedArtifacts.length < 5) skippedArtifacts.push(row.path);
          continue;
        }
        const relTail = treePath === "/" ? row.path.replace(/^\//, "") : row.path.slice(treePath.length + 1);
        const remotePath = relTail ? this.joinRemote(actualPath, relTail) : actualPath;
        if (seen.has(remotePath)) continue;
        seen.add(remotePath);
        const relative = rootName ? `${rootName}/${relTail}` : relTail;
        files.push({
          remote_path: remotePath,
          relative_path: relative,
          size: Number(row.size || 0),
        });
      }
    }

    if (missing.length) {
      const head = missing.slice(0, 5).join("，");
      const suffix = missing.length > 5 ? " 等" : "";
      appendLog(taskId, `目录树未命中路径：${head}${suffix}`);
    }
    if (skippedArtifacts.length) {
      const head = skippedArtifacts.slice(0, 3).join("，");
      const suffix = skippedArtifacts.length > 3 ? " 等" : "";
      appendLog(taskId, `已跳过目录树临时文件：${head}${suffix}`);
    }
    return files;
  }


  private async executeTask(task: TaskRow) {
    const settings = getSettings();
    const minFreeGb = Number(settings.min_free_gb ?? 50);
    const minFreeBytes = (Number.isFinite(minFreeGb) ? minFreeGb : 50) * 1024 * 1024 * 1024;
    const controller = new AbortController();
    const signal = controller.signal;
    this.taskControllers.set(task.id, controller);
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
    let stopLogged = false;
    const checkStop = () => {
      if (stopFlag) return true;
      if (signal.aborted) {
        stopFlag = true;
      }
      if (this.isStopped(task.id)) {
        stopFlag = true;
        if (!signal.aborted) controller.abort("任务已终止");
      }
      if (stopFlag) {
        if (!stopLogged) {
          appendLog(task.id, "检测到终止请求，正在停止...");
          stopLogged = true;
        }
        return true;
      }
      return false;
    };

    if (task.provider === "rapid_mobile") {
      await this.executeRapidTask(task, settings, signal);
      this.taskControllers.delete(task.id);
      return;
    }
    if (checkStop()) {
      this.markStopped(task.id);
      return;
    }
    if (task.provider === "mobile_export") {
      await this.executeMobileExportTask(task, settings, signal);
      this.taskControllers.delete(task.id);
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
    const treeMeta = getTreeMeta();
    if (!(treeMeta?.total_files || 0)) {
      throw new Error("目录树未导入，无法扫描 115 目录");
    }
    const downloadConcurrency =
      task.provider === "sharepoint" ? SHAREPOINT_DOWNLOAD_CONCURRENCY : DOWNLOAD_CONCURRENCY;
    const uploadConcurrency =
      task.provider === "sharepoint" ? SHAREPOINT_UPLOAD_CONCURRENCY : UPLOAD_CONCURRENCY;
    const maxBufferedBytes =
      task.provider === "sharepoint" ? SHAREPOINT_MAX_BUFFERED_BYTES : Number.POSITIVE_INFINITY;
    appendLog(
      task.id,
      `目录树模式：文件 ${treeMeta?.total_files || 0}，目录 ${treeMeta?.total_dirs || 0}`,
    );
    allFiles.push(...this.resolveFilesFromTree(task.id, sourcePaths, settings.tree_root_prefix || "/"));
    if (!allFiles.length) throw new Error("目录树未命中任何文件");

    async function refreshOpenlistDir(dir: string, createIfMissing = false, label = "目标目录") {
      const normDir = normalizeRemotePath(dir);
      try {
        await openlist.list(normDir, true, 1, 1, signal);
        return true;
      } catch (e: any) {
        if (signal.aborted) return;
        const msg = String(e?.message || "").toLowerCase();
        const notFound =
          msg.includes("object not found") ||
          msg.includes("not found") ||
          msg.includes("no such") ||
          msg.includes("path not found");
        if (createIfMissing && notFound) {
          try {
            await openlist.ensureDir(normDir, signal);
            await openlist.list(normDir, true, 1, 1, signal);
            return true;
          } catch (err: any) {
            if (signal.aborted) return;
            e = err;
          }
        }
        const fallbackDir = getParentDirOrSelf(normDir);
        if (fallbackDir !== normDir) {
          try {
            await openlist.list(fallbackDir, true, 1, 1, signal);
            appendLog(task.id, `${label}刷新回退到父目录：${normDir} -> ${fallbackDir}`);
            return true;
          } catch {
            // ignore fallback error
          }
        }
        appendLog(task.id, `${label}刷新失败：${normDir} -> ${e?.message || String(e)}`);
        return false;
      }
    }

    const listOpenlistNames = async (dir: string) => {
      const names = new Set<string>();
      const perPage = 200;
      let page = 1;
      let total = 0;
      while (true) {
        const data = await openlist.list(dir, page === 1, page, perPage, signal);
        const content = data.content || [];
        for (const it of content) {
          if (it?.name) names.add(String(it.name));
        }
        const nextTotal = Number(data.total || data.total_count || data.totalCount || 0);
        if (nextTotal > 0) total = nextTotal;
        if (content.length < perPage) break;
        if (total > 0 && names.size >= total) break;
        page += 1;
      }
      return names;
    };

    if (task.provider === "sharepoint") {
      appendLog(task.id, "开始对比目标端已存在文件...");
      const baseTarget = normalizeRemotePath(task.target_path || "/");
      const byDir = new Map<string, FileItem[]>();
      for (const f of allFiles) {
        const targetPath = this.joinRemote(baseTarget, f.relative_path);
        const dir = pathPosix.dirname(targetPath);
        const list = byDir.get(dir) || [];
        list.push(f);
        byDir.set(dir, list);
      }
      let skipped = 0;
      const kept: FileItem[] = [];
      for (const [dir, files] of byDir.entries()) {
        await refreshOpenlistDir(dir, true);
        let names: Set<string>;
        try {
          names = await listOpenlistNames(dir);
        } catch (e: any) {
          appendLog(task.id, `目标目录扫描失败：${dir} -> ${e?.message || String(e)}`);
          // fallback: if scan failed, keep all files in this dir
          kept.push(...files);
          continue;
        }
        for (const f of files) {
          const targetPath = this.joinRemote(baseTarget, f.relative_path);
          const name = pathPosix.basename(targetPath);
          if (names.has(name)) {
            skipped += 1;
          } else {
            kept.push(f);
          }
        }
      }
      if (skipped > 0) {
        appendLog(task.id, `对比完成：已跳过 ${skipped} 个已存在文件`);
      } else {
        appendLog(task.id, "对比完成：未发现重复文件");
      }
      allFiles.length = 0;
      allFiles.push(...kept);
      if (!allFiles.length) {
        updateTask(task.id, {
          status: "success",
          finished_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          current_item: "",
          message: "目标端已存在全部文件，已跳过下载",
        } as any);
        appendLog(task.id, "目标端已存在全部文件，任务结束");
        this.taskControllers.delete(task.id);
        return;
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
      `传输策略：下载并发 ${downloadConcurrency}，上传并发 ${uploadConcurrency}，启动间隔 2s，115 403 自动重试`,
    );
    if (task.provider === "sharepoint") {
      appendLog(
        task.id,
        `世纪互联保护：最多缓存 ${formatBytes(SHAREPOINT_MAX_BUFFERED_BYTES)} 待上传数据，避免服务内存被大文件压垮`,
      );
    }

    const dirCache: Record<string, string> = {};
    if (task.provider === "mobile") dirCache[""] = settings.mobile_parent_file_id;
    const mobileFileCache = new Map<string, Set<string>>();
    const mobileFilePending = new Map<string, Promise<Set<string>>>();
    const refreshedTargets = new Set<string>();
    let mobileTouched = false;

    const getMobileNames = async (parentId: string) => {
      if (mobileFileCache.has(parentId)) return mobileFileCache.get(parentId)!;
      if (mobileFilePending.has(parentId)) return await mobileFilePending.get(parentId)!;
      if (!mobile) return new Set<string>();
      const p: Promise<Set<string>> = mobile
        .list_dir(parentId, signal)
        .then((items) => new Set<string>(items.map((i: any) => String(i.name || ""))));
      mobileFilePending.set(parentId, p);
      try {
        const names = await p;
        mobileFileCache.set(parentId, names);
        return names;
      } finally {
        mobileFilePending.delete(parentId);
      }
    };

    const queue = new PQueue({ concurrency: downloadConcurrency });
    const uploadQueue = new PQueue({ concurrency: uploadConcurrency });
    let processedFiles = 0;
    let processedBytes = 0;
    let lastProgressUpdate = 0;
    let lastDiskWaitLog = 0;
    let lastDiskFree = -1;
    let monitorBusy = false;
    let pausedByDisk = false;
    let monitorStop = false;
    let recycleBusy = false;
    let lastRecycleClear = 0;
    let lastRecycleLog = 0;
    let bufferedUploadBytes = 0;
    let lastUploadWaitLog = 0;

    signal.addEventListener("abort", () => {
      queue.clear();
      uploadQueue.clear();
      if (pausedByDisk) {
        queue.start();
        pausedByDisk = false;
      }
    }, { once: true });


    const monitorDisk = async () => {
      if (monitorBusy || monitorStop || signal.aborted) return;
      monitorBusy = true;
      try {
        if (!localRoot) return;
        const info = await getDiskInfo(localRoot);
        if (!info || info.free === null || info.free === undefined) return;
        const minFreeGb = Number(settings.min_free_gb ?? 50);
        const minFreeBytes = (Number.isFinite(minFreeGb) ? minFreeGb : 50) * 1024 * 1024 * 1024;
        if (info.free < minFreeBytes && !pausedByDisk) {
          queue.pause();
          pausedByDisk = true;
          appendLog(task.id, `本地空间不足（${formatBytes(info.free)} 可用），暂停下载队列`);
        } else if (info.free >= minFreeBytes && pausedByDisk) {
          queue.start();
          pausedByDisk = false;
          appendLog(task.id, `本地空间恢复（${formatBytes(info.free)} 可用），恢复下载队列`);
        }
      } catch (_e) {
        // ignore
      } finally {
        monitorBusy = false;
      }
    };

    const monitorTimer = setInterval(monitorDisk, 5000);

    const clearRecycleBinThrottled = async () => {
      if (recycleBusy) return;
      const now = Date.now();
      if (now - lastRecycleClear < 30000) return;
      recycleBusy = true;
      lastRecycleClear = now;
      try {
        await clearRecycleBin();
        if (now - lastRecycleLog > 600000) {
          appendLog(task.id, "已清空回收站");
          lastRecycleLog = now;
        }
      } catch (e: any) {
        appendLog(task.id, `清空回收站失败：${e?.message || String(e)}`);
      } finally {
        recycleBusy = false;
      }
    };

    const buildMessage = (stage: string) => {
      const filePct = percent(processedFiles, allFiles.length);
      let msg = `${stage} ${processedFiles}/${allFiles.length}（${filePct}%）`;
      if (totalBytes > 0) {
        const safeProcessedBytes = Math.min(processedBytes, totalBytes);
        const bytePct = percent(safeProcessedBytes, totalBytes);
        msg += ` · ${formatBytes(safeProcessedBytes)}/${formatBytes(totalBytes)}（${bytePct}%）`;
      }
      return msg;
    };

    const updateProgress = (stage: string, force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressUpdate < 1000) return;
      lastProgressUpdate = now;
      const safeProcessedBytes = totalBytes > 0 ? Math.min(processedBytes, totalBytes) : processedBytes;
      updateTask(task.id, {
        processed_files: processedFiles,
        processed_bytes: safeProcessedBytes,
        total_bytes: totalBytes,
        updated_at: new Date().toISOString(),
        message: buildMessage(stage),
      } as any);
    };

    // Refresh directories once per task
    try {
      const refreshDirs = new Set<string>();
      sourcePaths.forEach((raw) => {
        refreshDirs.add(getOpenlistMountRoot(raw));
      });
      for (const dir of refreshDirs) {
        await refreshOpenlistDir(dir, false, "源挂载目录");
      }
      if (task.provider === "mobile" && mobile) {
        try {
          await mobile.list_dir(settings.mobile_parent_file_id, signal);
        } catch (e: any) {
          if (signal.aborted) {
            // ignore stop
          } else {
          appendLog(task.id, `移动网盘刷新失败：${e?.message || String(e)}`);
          }
        }
      }
      if (task.provider === "sharepoint") {
        const refreshTargets = new Set<string>();
        if (task.provider === "sharepoint") {
          const base = getOpenlistMountRoot(task.target_path || "/");
          refreshTargets.add(base);
        }
        for (const dir of refreshTargets) {
          await refreshOpenlistDir(dir, false, "世纪互联挂载目录");
        }
      }
    } catch (_e) {
      // ignore refresh errors
    }

    let failedFiles = 0;
    let skippedFiles = 0;
    let successFiles = 0;
    const failedSamples: string[] = [];
    const finishItem = (stage: string) => {
      processedFiles += 1;
      if (!signal.aborted && !this.isStopped(task.id)) {
        updateProgress(stage, true);
      }
    };
    const recordFailure = (itemLabel: string, msg: string, accountedBytes = 0) => {
      if (accountedBytes > 0) {
        processedBytes = Math.max(0, processedBytes - accountedBytes);
      }
      failedFiles += 1;
      appendLog(task.id, `文件失败：${itemLabel} -> ${msg}`);
      if (failedSamples.length < 5) failedSamples.push(`${pathPosix.basename(itemLabel)}: ${msg}`);
    };
    const scheduleUpload = (file: FileItem, localPath: string, size: number, downloadAccounted: number, index: number) => {
      const uploadPromise = uploadQueue.add(async () => {
        try {
          if (checkStop()) return;
          if (task.provider === "sharepoint") {
            const target = this.joinRemote(task.target_path, file.relative_path);
            appendLog(task.id, `上传到世纪互联：${target}`);
            const uploadLogger = this.makeFileProgressLogger(task.id, "上传", target, index, allFiles.length);
            await this.uploadWithRetry(openlist, localPath, target, task.id, (_delta, loaded, total) => {
              uploadLogger(loaded, total || size);
              updateProgress("上传中");
            }, signal);
            const uploadPct = percent(processedFiles + skippedFiles + successFiles + failedFiles + 1, allFiles.length);
            appendLog(task.id, `上传完成 [${Math.min(processedFiles + skippedFiles + successFiles + failedFiles + 1, allFiles.length)}/${allFiles.length}，${uploadPct}%]：${target}`);
            if (settings.clean_local_after_transfer) {
              try {
                rmSync(localPath, { force: true });
                void clearRecycleBinThrottled();
              } catch (_e) {
                // ignore
              }
              this.pruneEmptyDirs(localPath, localRoot);
            }
            successFiles += 1;
          } else if (task.provider === "mobile" && mobile) {
            const uploadResult = await this.uploadToMobile({
              task,
              settings,
              openlist,
              mobile,
              localPath,
              localRoot,
              fileItem: file,
              dirCache,
              fileCache: mobileFileCache,
              filePending: mobileFilePending,
              index,
              total: allFiles.length,
              onRecycle: () => {
                void clearRecycleBinThrottled();
              },
              signal,
            });
            if (uploadResult === "skipped") {
              skippedFiles += 1;
            } else {
              successFiles += 1;
            }
          }
        } catch (e: any) {
          if (this.isAbortError(e) && (signal.aborted || this.isStopped(task.id))) return;
          const msg = e?.message || String(e);
          const itemLabel =
            task.provider === "sharepoint"
              ? this.joinRemote(task.target_path, file.relative_path)
              : file.remote_path;
          recordFailure(itemLabel, msg, downloadAccounted);
          logger.error({ err: summarizeError(e), taskId: task.id, file: file.remote_path }, "Task upload failed");
        } finally {
          bufferedUploadBytes = Math.max(0, bufferedUploadBytes - Math.max(0, size || downloadAccounted || 0));
          if (!signal.aborted && !this.isStopped(task.id)) {
            finishItem(failedFiles > 0 ? "进行中（含失败）" : "进行中");
          }
        }
      });
      void uploadPromise.catch((err) => {
        logger.error({ err: summarizeError(err), taskId: task.id, file: file.remote_path }, "Upload queue leaked error");
      });
    };

    for (let idx = 0; idx < allFiles.length; idx++) {
      const file = allFiles[idx];
      if (checkStop()) {
        stopFlag = true;
        break;
      }
      const itemPromise = queue.add(async () => {
        let downloadAccounted = 0;
        try {
          if (checkStop()) return;
          // wait for free disk space
          if (localRoot) {
            while (true) {
              const info = await getDiskInfo(localRoot);
              if (!info || info.free === null || info.free === undefined) break;
              if (info.free >= minFreeBytes) break;
              const now = Date.now();
              if (now - lastDiskWaitLog > 15000 || lastDiskFree !== info.free) {
                appendLog(
                  task.id,
                  `本地空间不足（${formatBytes(info.free)} 可用），等待上传释放空间...`,
                );
                lastDiskWaitLog = now;
                lastDiskFree = info.free;
              }
              if (checkStop()) return;
              await sleep(5000, signal);
            }
          }
          if (task.provider === "sharepoint" && Number.isFinite(maxBufferedBytes)) {
            while (bufferedUploadBytes >= maxBufferedBytes) {
              const now = Date.now();
              if (now - lastUploadWaitLog > 15000) {
                appendLog(
                  task.id,
                  `上传缓冲已达 ${formatBytes(bufferedUploadBytes)}，等待世纪互联上传释放内存...`,
                );
                lastUploadWaitLog = now;
              }
              if (checkStop()) return;
              await sleep(5000, signal);
            }
          }
          const localPath = join(localRoot, file.relative_path);
          mkdirSync(dirname(localPath), { recursive: true });
          updateTask(task.id, { current_item: file.remote_path } as any);

          // duplicate check before download
          try {
            if (task.provider === "sharepoint") {
              const target = this.joinRemote(task.target_path, file.relative_path);
              const targetDir = pathPosix.dirname(target);
              if (!refreshedTargets.has(targetDir)) {
                await refreshOpenlistDir(targetDir, true);
                refreshedTargets.add(targetDir);
              }
              const exists = await this.existsInOpenlistPath(openlist, target, signal);
              if (exists) {
                const targetName = pathPosix.basename(target);
                appendLog(task.id, `跳过下载：目标已存在 ${targetName}（${targetDir}）`);
                skippedFiles += 1;
                processedBytes += Number(file.size || 0);
                finishItem(failedFiles > 0 ? "进行中（含失败）" : "进行中");
                return;
              }
            } else if (task.provider === "mobile" && mobile) {
              const fakeExtRaw = settings.mobile_fake_extension?.trim() || ".jpg";
              const fakeExt = fakeExtRaw.startsWith(".") ? fakeExtRaw : `.${fakeExtRaw}`;
              const originalName = pathPosix.basename(file.relative_path || "file");
              const stem = originalName.replace(/\.[^.]+$/, "");
              const fakeName = `${stem}${fakeExt}`;
              const relativeParent =
                pathPosix.dirname(file.relative_path) === "." ? "" : pathPosix.dirname(file.relative_path);
              const openlistDir = this.joinRemote(settings.mobile_target_openlist_path, relativeParent);
              mobileTouched = true;
              const existsOriginal = await this.existsInOpenlistPath(
                openlist,
                this.joinRemote(openlistDir, originalName),
                signal,
              );
              const existsFake = await this.existsInOpenlistPath(
                openlist,
                this.joinRemote(openlistDir, fakeName),
                signal,
              );
              if (existsOriginal || existsFake) {
                appendLog(
                  task.id,
                  `跳过下载：目标已存在 ${originalName} 或 ${fakeName}（${openlistDir}）`,
                );
                skippedFiles += 1;
                processedBytes += Number(file.size || 0);
                finishItem(failedFiles > 0 ? "进行中（含失败）" : "进行中");
                return;
              }
              const targetParent = await this.ensureMobileDir(
                mobile,
                settings.mobile_parent_file_id,
                relativeParent,
                dirCache,
                signal,
              );
              const names = await getMobileNames(targetParent);
              if (names.has(originalName) || names.has(fakeName)) {
                appendLog(task.id, `跳过下载：移动云盘已存在 ${originalName} 或 ${fakeName}（parent=${targetParent}）`);
                skippedFiles += 1;
                processedBytes += Number(file.size || 0);
                finishItem(failedFiles > 0 ? "进行中（含失败）" : "进行中");
                return;
              }
            }
          } catch (e: any) {
            if (this.isAbortError(e) && (signal.aborted || this.isStopped(task.id))) return;
            appendLog(task.id, `重复检查失败，继续下载：${e?.message || String(e)}`);
          }

          const expectedSize = Number(file.size || 0);
          const downloadLogger = this.makeFileProgressLogger(task.id, "下载", file.remote_path, idx, allFiles.length);
          const size = await this.downloadWithRetry(
            openlist,
            file.remote_path,
            localPath,
            task.id,
            (_delta, loaded, total) => {
              if (loaded > downloadAccounted) {
                processedBytes += loaded - downloadAccounted;
                downloadAccounted = loaded;
              }
              downloadLogger(loaded, total || expectedSize);
              updateProgress("下载中");
            },
            expectedSize,
            signal,
          );
          if (size > downloadAccounted) {
            processedBytes += size - downloadAccounted;
            downloadAccounted = size;
          }
          if (!expectedSize && size > 0) {
            totalBytes += size;
            updateTask(task.id, { total_bytes: totalBytes, updated_at: new Date().toISOString() } as any);
          }
          bufferedUploadBytes += Math.max(0, size);
          const downloadPct = percent(idx + 1, allFiles.length);
          appendLog(task.id, `下载完成 [${idx + 1}/${allFiles.length}，${downloadPct}%]：${file.remote_path}，已加入上传队列`);
          scheduleUpload(file, localPath, size, downloadAccounted, idx);
        } catch (e: any) {
          if (downloadAccounted > 0) {
            processedBytes = Math.max(0, processedBytes - downloadAccounted);
            downloadAccounted = 0;
          }
          if (this.isAbortError(e) && (signal.aborted || this.isStopped(task.id))) return;
          const msg = e?.message || String(e);
          const itemLabel =
            task.provider === "sharepoint"
              ? this.joinRemote(task.target_path, file.relative_path)
              : file.remote_path;
          recordFailure(itemLabel, msg);
          logger.error({ err: summarizeError(e), taskId: task.id, file: file.remote_path }, "Task download failed");
          finishItem("进行中（含失败）");
        }
      });
      void itemPromise.catch((err) => {
        logger.error({ err: summarizeError(err), taskId: task.id, file: file.remote_path }, "Download queue leaked error");
      });

      if (idx < allFiles.length - 1) {
        try {
          await sleep(DOWNLOAD_INTERVAL_MS, signal);
        } catch (e: any) {
          if (this.isAbortError(e) && (signal.aborted || this.isStopped(task.id))) {
            stopFlag = true;
            break;
          }
          throw e;
        }
      }
    }

    try {
      await queue.onIdle();
      await uploadQueue.onIdle();
    } catch (e: any) {
      this.markFailed(task.id, e?.message || String(e));
      throw e;
    } finally {
      monitorStop = true;
      clearInterval(monitorTimer);
    }

    if (task.provider === "mobile" && mobileTouched) {
      const dir = normalizeRemotePath(settings.mobile_target_openlist_path || "/");
      appendLog(task.id, `任务完成后刷新移动云盘目录：${dir}`);
      await refreshOpenlistDir(dir, false, "移动云盘目录");
    }

    if (stopFlag || checkStop()) {
      this.markStopped(task.id);
      return;
    }

    if (failedFiles > 0) {
      const summary = `任务完成：成功 ${successFiles}，跳过 ${skippedFiles}，失败 ${failedFiles}`;
      updateTask(task.id, {
        status: "failed",
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        current_item: "",
        message: summary,
        error_message: failedSamples.join("；") || summary,
      } as any);
      appendLog(task.id, summary);
      this.taskControllers.delete(task.id);
      return;
    }

    updateTask(task.id, {
      status: "success",
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      current_item: "",
      message: `任务完成：成功 ${successFiles}，跳过 ${skippedFiles}`,
    } as any);
    appendLog(task.id, `任务完成：成功 ${successFiles}，跳过 ${skippedFiles}`);

    if (settings.clean_local_after_transfer && existsSync(localRoot)) {
      try {
        rmSync(localRoot, { recursive: true, force: true });
      } catch (e) {
        logger.warn(e);
      }
    }
    this.taskControllers.delete(task.id);
  }

  private async downloadWithRetry(
    openlist: OpenListClient,
    remote: string,
    local: string,
    taskId: number,
    onProgress?: (delta: number, loaded: number, total?: number) => void,
    expectedTotal?: number,
    signal?: AbortSignal,
  ) {
    let lastErr: any;
    for (let attempt = 1; attempt <= DOWNLOAD_RETRY; attempt++) {
      try {
        return await openlist.download(remote, local, onProgress, expectedTotal, signal);
      } catch (err: any) {
        lastErr = err;
        if (this.isAbortError(err)) throw err;
        const status = err?.response?.status;
        const msg: string = err?.message || "";
        const retry403 = status === 403 || msg.includes("403");
        const retryNetwork = this.isRetryableDownloadError(err);
        if ((retry403 || retryNetwork) && attempt < DOWNLOAD_RETRY) {
          if (retry403) {
            appendLog(taskId, `115 403，重试 ${attempt}/${DOWNLOAD_RETRY}`);
            await sleep(1500 * attempt, signal);
          } else {
            appendLog(taskId, `下载重试 ${attempt}/${DOWNLOAD_RETRY}：${pathPosix.basename(remote)} -> ${msg}`);
            await sleep(2000 * attempt, signal);
          }
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private isRetryableDownloadError(err: any) {
    const msg = String(err?.message || "").toLowerCase();
    const code = String(err?.code || "").toUpperCase();
    return (
      code === "ECONNRESET" ||
      code === "ECONNABORTED" ||
      code === "ETIMEDOUT" ||
      msg.includes("timeout") ||
      msg.includes("aborted") ||
      msg.includes("socket hang up") ||
      msg.includes("connection reset") ||
      msg.includes("econnreset")
    );
  }

  private isRetryableUploadError(err: any) {
    const msg = String(err?.message || "").toLowerCase();
    const code = String(err?.code || "").toUpperCase();
    return (
      code === "ECONNRESET" ||
      code === "ECONNABORTED" ||
      code === "ETIMEDOUT" ||
      msg.includes("timeout") ||
      msg.includes("aborted") ||
      msg.includes("eproto") ||
      msg.includes("socket hang up") ||
      msg.includes("connection reset")
    );
  }

  private async confirmOpenlistTarget(openlist: OpenListClient, remotePath: string) {
    const targetDir = pathPosix.dirname(remotePath);
    try {
      await openlist.list(targetDir, true, 1, 1);
    } catch (_e) {
      // ignore
    }
    return await this.existsInOpenlistPath(openlist, remotePath);
  }

  private async uploadWithRetry(
    openlist: OpenListClient,
    localPath: string,
    remotePath: string,
    taskId: number,
    onProgress?: (delta: number, loaded: number, total?: number) => void,
    signal?: AbortSignal,
  ) {
    let lastErr: any;
    for (let attempt = 1; attempt <= UPLOAD_RETRY; attempt++) {
      try {
        await openlist.upload(localPath, remotePath, onProgress, signal);
        return;
      } catch (err: any) {
        lastErr = err;
        if (this.isAbortError(err)) throw err;
        const msg = err?.message || String(err);
        const confirmed = await this.confirmOpenlistTarget(openlist, remotePath);
        if (confirmed) {
          appendLog(taskId, `上传结果延迟确认成功：${remotePath}`);
          return;
        }
        if (!this.isRetryableUploadError(err) || attempt >= UPLOAD_RETRY) {
          throw err;
        }
        appendLog(taskId, `上传重试 ${attempt}/${UPLOAD_RETRY}：${pathPosix.basename(remotePath)} -> ${msg}`);
        await sleep(2000 * attempt, signal);
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
    fileCache: Map<string, Set<string>>;
    filePending: Map<string, Promise<Set<string>>>;
    index: number;
    total: number;
    onRecycle?: () => void;
    signal?: AbortSignal;
  }) {
    const {
      task,
      settings,
      openlist,
      mobile,
      localPath,
      localRoot,
      fileItem,
      dirCache,
      fileCache,
      filePending,
      index,
      total,
      onRecycle,
      signal,
    } = opts;
    const fakeExtRaw = settings.mobile_fake_extension?.trim() || ".jpg";
    const fakeExt = fakeExtRaw.startsWith(".") ? fakeExtRaw : `.${fakeExtRaw}`;
    const originalName = localPath.split(/[/\\]/).pop() || "file";
    const stem = originalName.replace(/\.[^.]+$/, "");
    const fakeName = `${stem}${fakeExt}`;
    const fs = await import("fs");

    const relativeParent =
      pathPosix.dirname(fileItem.relative_path) === "." ? "" : pathPosix.dirname(fileItem.relative_path);
    const targetOpenlistDir = this.joinRemote(settings.mobile_target_openlist_path, relativeParent);

    const existsOriginal = await this.existsInOpenlist(openlist, targetOpenlistDir, originalName, signal);
    const existsFake = await this.existsInOpenlist(openlist, targetOpenlistDir, fakeName, signal);
    if (existsOriginal || existsFake) {
      appendLog(task.id, `跳过上传：目标目录已存在 ${originalName} 或 ${fakeName}（${targetOpenlistDir}）`);
      if (settings.clean_local_after_transfer && fs.existsSync(localPath)) {
        try {
          fs.unlinkSync(localPath);
          if (onRecycle) onRecycle();
        } catch (_e) {
          // ignore
        }
        this.pruneEmptyDirs(localPath, localRoot);
      }
      return "skipped";
    }

    const fakePath = join(dirname(localPath), fakeName);
    fs.renameSync(localPath, fakePath);
    appendLog(task.id, `移动上传：改后缀 ${originalName} -> ${fakeName}`);

    const targetParent = await this.ensureMobileDir(mobile, settings.mobile_parent_file_id, relativeParent, dirCache, signal);

    const getMobileNames = async (parentId: string) => {
      if (fileCache.has(parentId)) return fileCache.get(parentId)!;
      if (filePending.has(parentId)) return await filePending.get(parentId)!;
      const p: Promise<Set<string>> = mobile
        .list_dir(parentId, signal)
        .then((items) => new Set<string>(items.map((i: any) => String(i.name || ""))));
      filePending.set(parentId, p);
      try {
        const names = await p;
        fileCache.set(parentId, names);
        return names;
      } finally {
        filePending.delete(parentId);
      }
    };

    const mobileNames = await getMobileNames(targetParent);
    if (mobileNames.has(originalName) || mobileNames.has(fakeName)) {
      appendLog(task.id, `跳过上传：移动云盘已存在 ${originalName} 或 ${fakeName}（parent=${targetParent}）`);
      if (settings.clean_local_after_transfer && fs.existsSync(localPath)) {
        try {
          fs.unlinkSync(localPath);
          if (onRecycle) onRecycle();
        } catch (_e) {
          // ignore
        }
        this.pruneEmptyDirs(localPath, localRoot);
      }
      return "skipped";
    }
    const uploadLogger = this.makeFileProgressLogger(task.id, "上传", originalName, index, total);
    appendLog(task.id, `移动上传准备：${originalName}`);
    const res = await mobile.upload_file(fakePath, targetParent, (_delta, loaded, totalBytes) => {
      uploadLogger(loaded, totalBytes);
    }, signal);
    appendLog(task.id, `移动上传完成 [${index + 1}/${total}，${percent(index + 1, total)}%] file_id=${res.file_id}`);

    const renamed = await this.ensureMobileRename(mobile, targetParent, res.file_id, originalName, 5, signal);
    if (renamed) {
      appendLog(task.id, `移动重命名成功：${originalName} (file_id=${res.file_id})`);
      mobileNames.add(originalName);
      mobileNames.delete(fakeName);
    } else {
      appendLog(task.id, `移动重命名失败：${originalName} (file_id=${res.file_id})`);
    }

    if (settings.clean_local_after_transfer && fs.existsSync(fakePath)) {
      try {
        fs.unlinkSync(fakePath);
        if (onRecycle) onRecycle();
      } catch (_e) {
        // ignore
      }
    }
    if (settings.clean_local_after_transfer) {
      this.pruneEmptyDirs(fakePath, localRoot);
    }
    return "uploaded";
  }

  private async executeRapidTask(task: TaskRow, settings: any, signal?: AbortSignal) {
    if (!settings.mobile_authorization || !settings.mobile_uni) {
      throw new Error("缺少移动云盘 Authorization/UNI");
    }
    let stopFlag = false;
    const checkStop = () => {
      if (stopFlag) return true;
      if (signal?.aborted) {
        stopFlag = true;
      }
      if (this.isStopped(task.id)) {
        stopFlag = true;
      }
      if (stopFlag) {
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
          return await mobile.rapid_upload_only({ ...opts, signal });
        } catch (e: any) {
          lastErr = e;
          if (this.isAbortError(e)) throw e;
          const msg = e?.message || String(e);
          if (!shouldRetryRapid(msg) || attempt >= retryCount) throw e;
          appendLog(task.id, `秒传重试 ${attempt}/${retryCount} 失败：${msg}`);
          await sleep(400 * attempt, signal);
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
        await this.ensureMobileDir(mobile, parentId, dir, dirCache, signal);
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
            ? await this.ensureMobileDir(mobile, parentId, relativeDir, dirCache, signal)
            : parentId;
          const resu = await rapidUploadWithRetry({
            file_name: fakeName,
            file_size: Number(it.size || 0),
            content_hash: it.sha256,
            parent_file_id: targetParent,
          });
          const renamed = await this.ensureMobileRename(mobile, targetParent, resu.file_id, baseName, 5, signal);
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
    this.taskControllers.delete(task.id);
  }

  private async executeMobileExportTask(task: TaskRow, settings: any, signal?: AbortSignal) {
    if (!settings.mobile_authorization || !settings.mobile_uni) {
      throw new Error("缺少移动云盘 Authorization/UNI");
    }
    let stopFlag = false;
    const checkStop = () => {
      if (stopFlag) return true;
      if (signal?.aborted) {
        stopFlag = true;
      }
      if (this.isStopped(task.id)) {
        stopFlag = true;
      }
      if (stopFlag) {
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
            list = await client.list_dir(pid, signal);
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
    this.taskControllers.delete(task.id);
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

  private async existsInOpenlistPath(openlist: OpenListClient, fullPath: string, signal?: AbortSignal) {
    try {
      await openlist.get(fullPath, signal);
      return true;
    } catch (e: any) {
      if (this.isAbortError(e)) throw e;
      const msg = String(e?.message || "").toLowerCase();
      if (
        msg.includes("not found") ||
        msg.includes("file not found") ||
        msg.includes("path not found") ||
        msg.includes("no such file")
      ) {
        return false;
      }
      return false;
    }
  }

  private async existsInOpenlist(openlist: OpenListClient, dir: string, name: string, signal?: AbortSignal) {
    const target = this.joinRemote(dir, name);
    return await this.existsInOpenlistPath(openlist, target, signal);
  }

  private async ensureMobileRename(
    mobile: MobileCloudClient,
    parentId: string,
    fileId: string,
    expectedName: string,
    attempts = 5,
    signal?: AbortSignal,
  ): Promise<boolean> {
    let lastName = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await mobile.rename_file(fileId, expectedName, parentId, signal);
      } catch (_e) {
        // ignore
      }
      try {
        const items = await mobile.list_dir(parentId, signal);
        const found = items.find((i: any) => i.file_id === fileId);
        if (found?.name) {
          lastName = found.name;
          if (found.name === expectedName) return true;
        }
      } catch (_e) {
        // ignore
      }
      await sleep(500 * attempt, signal);
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
    signal?: AbortSignal,
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
      const items = await mobile.list_dir(current, signal);
      const found = items.find((i: any) => i.is_dir && i.name === seg);
      if (found) {
        current = found.file_id;
      } else {
        current = await mobile.create_folder(current, seg, signal);
      }
      cache[builtKey] = current;
    }
    return current;
  }
}

export const transferQueue = new TransferQueue();

