import { Router } from "express";
import { ok } from "../helpers";

export const router = Router();

router.get("/health", (_req, res) => {
  ok(res, { status: "ok", time: new Date().toISOString() });
});
