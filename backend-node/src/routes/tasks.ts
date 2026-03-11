import { Router } from "express";
import path from "path";
import { getSettings, insertTask, listTasks, getTask, updateTask, appendLog, deleteTask } from "../db";
import { ok, fail } from "../helpers";

export const router = Router();

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
  appendLog(id, "Task retried");
  ok(res, getTask(id));
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

router.delete("/tasks/:id", (req, res) => {
  const id = Number(req.params.id);
  const task = getTask(id);
  if (!task) return fail(res, 404, "task not found");
  deleteTask(id);
  ok(res, { id });
});

