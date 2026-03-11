import { Router } from "express";
import { getSettings, updateSettings } from "../db";
import { ok } from "../helpers";

export const router = Router();

router.get("/settings", (_req, res) => {
  ok(res, getSettings());
});

router.put("/settings", (req, res) => {
  try {
    const updated = updateSettings(req.body || {});
    ok(res, updated);
  } catch (e: any) {
    res.status(400).json({ code: 400, message: e.message, detail: e.message });
  }
});
