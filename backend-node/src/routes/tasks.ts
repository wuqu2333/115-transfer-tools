import { Router } from "express";
import path from "path";
import { existsSync } from "fs";
import { getSettings, insertTask, listTasks, getTask, updateTask, appendLog, deleteTask } from "../db";
import { ok, fail } from "../helpers";

export const router = Router();

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
  };
  if (task.status !== "running") patch.finished_at = now;
  updateTask(id, patch);
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
  const filePath = String(task.local_download_path || "");
  if (!filePath || !existsSync(filePath)) return fail(res, 404, "export file not found");
  const exportRoot = path.resolve(process.cwd(), "..", "data", "exports");
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(exportRoot)) return fail(res, 403, "invalid export path");
  return res.download(resolved, path.basename(resolved));
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



