import { Router } from "express";
import path from "path";
import { existsSync } from "fs";
import { getSettings, insertTask, listTasks, getTask, updateTask, appendLog, deleteTask } from "../db";
import { ok, fail } from "../helpers";
import { refreshTreeFrom115 } from "../services/treeRefresh";
import { transferQueue } from "../services/transferQueue";
import { logger } from "../logger";

export const router = Router();

const exportRoot = path.resolve(process.cwd(), "..", "data", "exports");

function parseExportFiles(raw: string): string[] {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed);
      if (Array.isArray(arr)) return arr.map((p) => String(p));
    } catch {
      return [];
    }
  }
  return [trimmed];
}

function getExportFiles(task: any): string[] {
  const raw = String(task?.local_download_path || "");
  const list = parseExportFiles(raw);
  return list
    .map((p) => path.resolve(String(p)))
    .filter((p) => p.startsWith(exportRoot) && existsSync(p));
}

function stopTaskInternal(id: number) {
  const task = getTask(id);
  if (!task) throw new Error("task not found");
  if (task.status === "success" || task.status === "failed" || task.status === "stopped") {
    return task;
  }
  const now = new Date().toISOString();
  const patch: any = {
    status: "stopped",
    updated_at: now,
    message: "任务已终止",
    error_message: "任务已终止",
    finished_at: now,
  };
  updateTask(id, patch);
  transferQueue.stopTask(id, "任务已终止");
  appendLog(id, "任务已终止");
  return getTask(id);
}

function toTask(row: any) {
  let logs: string[] = [];
  try {
    logs = JSON.parse(row.logs_json || "[]");
  } catch {
    logs = [];
  }
  return { ...row, logs };
}

function sendTaskSnapshot(res: any, limit: number) {
  const payload = JSON.stringify(listTasks(limit).map(toTask));
  res.write(`data: ${payload}\n\n`);
  return payload;
}

router.post("/tasks", async (req, res) => {
  try {
    const settings = getSettings();
    const payload = req.body || {};
    const provider = payload.provider;
    const source_paths: string[] = (payload.source_paths || []).filter((p: string) => !!p);
    if (!source_paths.length) return fail(res, 400, "source_paths 不能为空");

    const target_path = payload.target_path || (provider === "sharepoint" ? settings.sharepoint_target_path : settings.mobile_target_openlist_path) || "/";
    const source_base = payload.source_base_path || settings.source_115_root_path || "/";
    const download_base = (payload.download_base_path || settings.download_base_path || "").trim();
    if (!download_base) return fail(res, 400, "请先配置本地下载目录或在任务中填写");

    if (provider === "mobile" || provider === "sharepoint") {
      try {
        await refreshTreeFrom115(settings, source_paths, (msg) => logger.info(`[tree] ${msg}`));
      } catch (e: any) {
        logger.error({ err: e }, "[tree] 目录树生成失败");
        return fail(res, 400, `目录树生成失败：${e?.message || "unknown error"}`);
      }
    }

    const created_at = new Date().toISOString();
    const local_root = path.resolve(download_base, `task_${Date.now()}`); // placeholder, will be replaced by id
    const id = insertTask({
      provider,
      status: "pending",
      source_paths_json: JSON.stringify(source_paths),
      source_base_path: source_base,
      target_path,
      local_download_path: local_root,
      total_files: 0,
      processed_files: 0,
      total_bytes: 0,
      processed_bytes: 0,
      current_item: "",
      message: "",
      error_message: "",
      logs_json: "[]",
      created_at,
      updated_at: created_at,
      started_at: null,
      finished_at: null,
    } as any);
    const final_local = path.resolve(download_base, `task_${id}`);
    updateTask(id, { local_download_path: final_local } as any);
    const row = getTask(id)!;
    ok(res, { ...row, local_download_path: final_local });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});

router.post("/tasks/:id/retry", (req, res) => {
  const id = Number(req.params.id);
  const task = getTask(id);
  if (!task) return fail(res, 404, "task not found");
  if (task.status === "running") return fail(res, 400, "任务运行中，不能重试");
  updateTask(id, { status: "pending", updated_at: new Date().toISOString() } as any);
  appendLog(id, "任务已重新排队");
  ok(res, getTask(id));
});

router.post("/tasks/:id/stop", (req, res) => {
  const id = Number(req.params.id);
  try {
    const row = stopTaskInternal(id);
    ok(res, row);
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});

router.get("/tasks", (req, res) => {
  const limit = Number(req.query.limit || 100);
  ok(res, listTasks(limit).map(toTask));
});

router.get("/tasks/stream", (req, res) => {
  const limit = Number(req.query.limit || 120);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  res.write("retry: 2000\n\n");

  let lastPayload = sendTaskSnapshot(res, limit);
  const timer = setInterval(() => {
    try {
      const payload = JSON.stringify(listTasks(limit).map(toTask));
      if (payload === lastPayload) {
        res.write(": keep-alive\n\n");
        return;
      }
      lastPayload = payload;
      res.write(`data: ${payload}\n\n`);
    } catch (e: any) {
      logger.error({ err: e?.message || String(e) }, "tasks stream error");
    }
  }, 1500);

  req.on("close", () => {
    clearInterval(timer);
    res.end();
  });
});

router.get("/tasks/:id", (req, res) => {
  const id = Number(req.params.id);
  const task = getTask(id);
  if (!task) return fail(res, 404, "task not found");
  ok(res, toTask(task));
});

router.get("/tasks/:id/export", (req, res) => {
  const id = Number(req.params.id);
  const task = getTask(id);
  if (!task) return fail(res, 404, "task not found");
  if (task.provider !== "mobile_export") return fail(res, 400, "not export task");
  const files = getExportFiles(task);
  if (!files.length) return fail(res, 404, "export file not found");
  const indexRaw = req.query.index;
  if (indexRaw == null) {
    if (files.length !== 1) return fail(res, 400, "export files multiple, specify index");
    return res.download(files[0], path.basename(files[0]));
  }
  const idx = Number(indexRaw);
  if (!Number.isFinite(idx) || idx < 0 || idx >= files.length) return fail(res, 400, "invalid index");
  return res.download(files[idx], path.basename(files[idx]));
});

router.get("/tasks/:id/exports", (req, res) => {
  const id = Number(req.params.id);
  const task = getTask(id);
  if (!task) return fail(res, 404, "task not found");
  if (task.provider !== "mobile_export") return fail(res, 400, "not export task");
  const files = getExportFiles(task);
  if (!files.length) return fail(res, 404, "export file not found");
  ok(res, {
    files: files.map((p, index) => ({ index, name: path.basename(p) })),
    count: files.length,
  });
});

router.post("/tasks/batch", (req, res) => {
  const action = String(req.body?.action || "");
  const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map((n: any) => Number(n)).filter((n: any) => Number.isFinite(n)) : [];
  if (!ids.length) return fail(res, 400, "ids 不能为空");
  if (!["stop", "delete", "retry"].includes(action)) return fail(res, 400, "不支持的 action");

  const okIds: number[] = [];
  const failed: any[] = [];
  ids.forEach((id) => {
    try {
      if (action === "stop") {
        stopTaskInternal(id);
      } else if (action === "delete") {
        const task = getTask(id);
        if (!task) throw new Error("task not found");
        deleteTask(id);
      } else if (action === "retry") {
        const task = getTask(id);
        if (!task) throw new Error("task not found");
        if (task.status === "running") throw new Error("任务运行中，不能重试");
        updateTask(id, { status: "pending", updated_at: new Date().toISOString() } as any);
        appendLog(id, "任务已重新排队");
      }
      okIds.push(id);
    } catch (e: any) {
      failed.push({ id, error: e?.message || String(e) });
    }
  });
  ok(res, { action, ok: okIds, failed });
});

router.delete("/tasks/:id", (req, res) => {
  const id = Number(req.params.id);
  const task = getTask(id);
  if (!task) return fail(res, 404, "task not found");
  deleteTask(id);
  ok(res, { id });
});



