import { Router } from "express";
import { existsSync, createReadStream, readFileSync, statSync } from "fs";
import { extname } from "path";
import readline from "readline";
import { ok, fail } from "../helpers";
import {
  getSettings,
  updateSettings,
  clearTree,
  insertTreeNodes,
  setTreeMeta,
  getTreeMeta,
  getTreeNode,
  listTreeChildren,
} from "../db";

export const router = Router();

function isHex64(value: string) {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

function normalizeRoot(prefix: string) {
  let s = String(prefix || "/").trim();
  if (!s) return "/";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s || "/";
}

function normalizeTreePath(path: string, rootPrefix: string) {
  let s = String(path || "").trim();
  if (!s) return "";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) {
    const root = normalizeRoot(rootPrefix);
    s = root === "/" ? `/${s}` : `${root}/${s}`;
  }
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s;
}

function extractSha256(item: any): string {
  const candidates = [
    item?.sha256,
    item?.sha_256,
    item?.SHA256,
    item?.hash?.sha256,
    item?.hash?.SHA256,
    item?.hash_info?.sha256,
    item?.hash_info?.SHA256,
    item?.hashes?.sha256,
    item?.hashes?.SHA256,
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

function parseObject(obj: any, rootPrefix: string) {
  if (!obj || typeof obj !== "object") return null;
  const rawPath =
    obj.path ||
    obj.name ||
    obj.file ||
    obj.remote_path ||
    obj.file_path ||
    obj.full_path ||
    obj.fullPath;
  if (!rawPath) return null;
  const path = normalizeTreePath(String(rawPath), rootPrefix);
  if (!path) return null;
  const isDir =
    !!obj.is_dir || !!obj.isDir || !!obj.dir || obj.type === "dir" || String(rawPath).endsWith("/");
  const size = Number(obj.size ?? obj.length ?? obj.file_size ?? obj.filesize ?? obj.bytes ?? 0);
  const sha256 = extractSha256(obj);
  return { path, is_dir: isDir ? 1 : 0, size, sha256 };
}

function parseLine(line: string, rootPrefix: string) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const obj = JSON.parse(trimmed);
      return parseObject(obj, rootPrefix);
    } catch {
      // ignore
    }
  }
  const parts = trimmed.split("|").map((p) => p.trim());
  const rawPath = parts[0];
  if (!rawPath) return null;
  const path = normalizeTreePath(rawPath, rootPrefix);
  if (!path) return null;
  const size = parts.length > 1 ? Number(parts[1] || 0) : 0;
  const sha256 = parts.length > 2 && isHex64(parts[2] || "") ? String(parts[2]).toLowerCase() : "";
  const isDir = rawPath.endsWith("/");
  return { path, is_dir: isDir ? 1 : 0, size, sha256 };
}

async function importTreeFromFile(filePath: string, rootPrefix: string, clearExisting: boolean) {
  if (!existsSync(filePath)) throw new Error("目录树文件不存在");
  if (clearExisting) clearTree();

  const ext = extname(filePath).toLowerCase();
  const batch: Array<{ path: string; is_dir: number; size: number; sha256?: string }> = [];
  const flush = () => {
    if (!batch.length) return;
    insertTreeNodes(batch.splice(0, batch.length));
  };

  let totalFiles = 0;
  let totalDirs = 0;

  const pushNode = (node: any) => {
    if (!node?.path) return;
    batch.push(node);
    if (node.is_dir) totalDirs += 1;
    else totalFiles += 1;
    if (batch.length >= 2000) flush();
  };

  if (ext === ".json") {
    const stat = statSync(filePath);
    if (stat.size > 200 * 1024 * 1024) {
      throw new Error("JSON 文件过大，建议使用 txt 或 jsonl");
    }
    const raw = readFileSync(filePath, "utf8");
    const data = JSON.parse(raw);
    const arr = Array.isArray(data)
      ? data
      : Array.isArray((data as any).items)
        ? (data as any).items
        : Array.isArray((data as any).data)
          ? (data as any).data
          : Array.isArray((data as any).content)
            ? (data as any).content
            : [];
    for (const item of arr) {
      const node = parseObject(item, rootPrefix);
      if (node) pushNode(node);
    }
    flush();
  } else {
    const rl = readline.createInterface({
      input: createReadStream(filePath),
      crlfDelay: Infinity,
    });
    for await (const line of rl) {
      const node = parseLine(line, rootPrefix);
      if (node) pushNode(node);
    }
    flush();
  }

  const imported_at = new Date().toISOString();
  setTreeMeta({
    file_path: filePath,
    root_prefix: rootPrefix,
    total_files: totalFiles,
    total_dirs: totalDirs,
    imported_at,
  });
  return { total_files: totalFiles, total_dirs: totalDirs, imported_at };
}

router.get("/tree/status", (req, res) => {
  try {
    const settings = getSettings();
    const meta = getTreeMeta();
    ok(res, {
      enabled: settings.tree_enabled,
      file_path: settings.tree_file_path || meta?.file_path || "",
      root_prefix: settings.tree_root_prefix || meta?.root_prefix || "/",
      total_files: meta?.total_files || 0,
      total_dirs: meta?.total_dirs || 0,
      imported_at: meta?.imported_at || "",
    });
  } catch (e: any) {
    fail(res, 400, e.message || "获取目录树状态失败", e.message);
  }
});

router.post("/tree/import", async (req, res) => {
  try {
    const settings = getSettings();
    const file_path = String(req.body?.file_path || settings.tree_file_path || "").trim();
    if (!file_path) return fail(res, 400, "目录树文件路径不能为空");
    const root_prefix = normalizeRoot(req.body?.root_prefix || settings.tree_root_prefix || "/");
    const clearExisting = req.body?.clear !== false;
    const result = await importTreeFromFile(file_path, root_prefix, clearExisting);
    updateSettings({ tree_file_path: file_path, tree_root_prefix: root_prefix });
    ok(res, result);
  } catch (e: any) {
    fail(res, 400, e.message || "导入目录树失败", e.message);
  }
});

router.post("/tree/clear", (req, res) => {
  try {
    clearTree();
    ok(res, { total_files: 0, total_dirs: 0 });
  } catch (e: any) {
    fail(res, 400, e.message || "清空目录树失败", e.message);
  }
});

router.post("/tree/list", (req, res) => {
  try {
    const settings = getSettings();
    const meta = getTreeMeta();
    if (!(meta?.total_files || meta?.total_dirs)) {
      return fail(res, 400, "目录树未导入");
    }
    const rootPrefix = settings.tree_root_prefix || meta?.root_prefix || "/";
    const rawPath = String(req.body?.path || "/");
    const current = normalizeTreePath(rawPath, rootPrefix) || "/";

    const node = getTreeNode(current);
    if (node && !node.is_dir) {
      return ok(res, { path: current, items: [] });
    }

    const rows = listTreeChildren(current);
    const map = new Map<string, { name: string; path: string; is_dir: boolean; size: number }>();
    for (const row of rows) {
      const rest = current === "/" ? row.path.slice(1) : row.path.slice(current.length + 1);
      if (!rest) continue;
      const first = rest.split("/")[0];
      if (!first) continue;
      const isDir = rest.includes("/") ? true : !!row.is_dir;
      const fullPath = current === "/" ? `/${first}` : `${current}/${first}`;
      const existing = map.get(first);
      if (!existing) {
        map.set(first, {
          name: first,
          path: fullPath,
          is_dir: isDir,
          size: isDir ? 0 : Number(row.size || 0),
        });
      } else if (isDir && !existing.is_dir) {
        existing.is_dir = true;
        existing.size = 0;
      }
    }
    const items = Array.from(map.values()).sort((a, b) => {
      if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
      return a.name.localeCompare(b.name, "zh-Hans-CN");
    });
    ok(res, { path: current, items });
  } catch (e: any) {
    fail(res, 400, e.message || "目录树读取失败", e.message);
  }
});
