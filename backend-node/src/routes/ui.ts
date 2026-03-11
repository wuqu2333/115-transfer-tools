import { Router } from "express";
import { getUiState, setUiState } from "../db";
import { ok, fail } from "../helpers";

export const router = Router();

router.get("/ui/selection", (req, res) => {
  try {
    const selectedRaw = getUiState("source_selected_paths");
    const pathRaw = getUiState("source_browser_path");
    let selected_paths: string[] = [];
    try {
      const parsed = selectedRaw ? JSON.parse(selectedRaw) : [];
      if (Array.isArray(parsed)) selected_paths = parsed.filter((p) => !!p).map(String);
    } catch {
      selected_paths = [];
    }
    const current_path = pathRaw ? String(pathRaw) : "/115";
    ok(res, { selected_paths, current_path });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});

router.post("/ui/selection", (req, res) => {
  try {
    const selected_paths = Array.isArray(req.body?.selected_paths)
      ? (req.body.selected_paths as any[]).filter(Boolean).map(String)
      : [];
    const current_path = typeof req.body?.current_path === "string" ? req.body.current_path : "";
    if (selected_paths) setUiState("source_selected_paths", JSON.stringify(selected_paths));
    if (current_path) setUiState("source_browser_path", current_path);
    ok(res, { selected_paths, current_path });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});
