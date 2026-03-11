import { Router } from "express";
import { getSettings } from "../db";
import { OpenListClient } from "../clients/openlist";
import { ok, fail } from "../helpers";

export const router = Router();

function isHex64(value: string) {
  return /^[a-fA-F0-9]{64}$/.test(value);
}

function extractSha256(item: any): string {
  const candidates = [
    item?.sha256,
    item?.sha_256,
    item?.SHA256,
    item?.contentHash,
    item?.content_hash,
    item?.hash?.sha256,
    item?.hash?.SHA256,
    item?.hash?.sha_256,
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

function collectDebugHashes(item: any) {
  const out: any = {};
  if (item?.etag) out.etag = item.etag;
  if (item?.md5) out.md5 = item.md5;
  if (item?.sha1) out.sha1 = item.sha1;
  if (item?.hash) out.hash = item.hash;
  if (item?.contentHash) out.contentHash = item.contentHash;
  if (item?.content_hash) out.content_hash = item.content_hash;
  return out;
}

router.post("/openlist/login", async (req, res) => {
  try {
    const settings = getSettings();
    const { username, password } = req.body || {};
    if (!settings.openlist_base_url) return fail(res, 400, "请先配置 OpenList 地址");
    const token = await new OpenListClient(settings.openlist_base_url, "", "").login(username, password);
    ok(res, { token });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});

router.post("/openlist/list", async (req, res) => {
  try {
    const settings = getSettings();
    const { path = "/", refresh = false, page = 1, per_page = 0, password } = req.body || {};
    if (!settings.openlist_base_url || !settings.openlist_token) return fail(res, 400, "OpenList 未配置");
    const client = new OpenListClient(settings.openlist_base_url, settings.openlist_token, password || settings.openlist_password);
    const data = await client.list(path, refresh, page, per_page);
    const current = client.normalize(path);
    const content = (data.content || []).map((item: any) => ({
      name: item.name,
      path: client.normalize(`${current}/${item.name}`),
      is_dir: !!item.is_dir,
      size: Number(item.size || 0),
      modified: item.modified,
    }));
    ok(res, { path: current, items: content, raw: data });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});

router.post("/openlist/export-hash", async (req, res) => {
  try {
    const settings = getSettings();
    const { paths = [], refresh = false, include_missing = false } = req.body || {};
    const listPaths: string[] = Array.isArray(paths) ? paths.filter((p) => !!p) : [];
    if (!listPaths.length) return fail(res, 400, "paths 不能为空");
    if (!settings.openlist_base_url || !settings.openlist_token) return fail(res, 400, "OpenList 未配置");
    const client = new OpenListClient(settings.openlist_base_url, settings.openlist_token, settings.openlist_password);

    const items: any[] = [];
    const skipped: any[] = [];
    let totalFiles = 0;
    let missingHash = 0;

    const normalizePath = (p: string) => client.normalize(p);

    const pushFile = (item: any, relative: string) => {
      totalFiles += 1;
      const sha256 = extractSha256(item);
      const size = Number(item?.size ?? item?.raw_size ?? item?.length ?? 0);
      if (sha256) {
        items.push({ name: relative, size, sha256 });
      } else {
        missingHash += 1;
        if (include_missing) {
          items.push({ name: relative, size, sha256: "", missing: true, available: collectDebugHashes(item) });
        }
      }
    };

    const walkDir = async (dir: string, prefix: string) => {
      const data = await client.list(dir, refresh, 1, 0);
      const content = data.content || [];
      for (const entry of content) {
        const name = entry.name;
        const childPath = normalizePath(`${dir}/${name}`);
        const rel = prefix ? `${prefix}/${name}` : name;
        if (entry.is_dir) {
          await walkDir(childPath, rel);
        } else {
          pushFile(entry, rel);
        }
      }
    };

    for (const raw of listPaths) {
      const src = normalizePath(raw);
      try {
        const obj = await client.get(src);
        if (!obj) {
          skipped.push({ path: src, reason: "not found" });
          continue;
        }
        if (obj.is_dir) {
          const rootName = src === "/" ? "" : src.split("/").filter(Boolean).pop() || "";
          await walkDir(src, rootName);
        } else {
          const name = src.split("/").filter(Boolean).pop() || "file";
          pushFile(obj, name);
        }
      } catch (e: any) {
        skipped.push({ path: src, reason: e?.message || String(e) });
      }
    }

    ok(res, {
      items,
      total_files: totalFiles,
      missing_hash: missingHash,
      skipped,
    });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});

router.get("/openlist/storages", async (req, res) => {
  try {
    const settings = getSettings();
    const page = Number(req.query.page || 1);
    const per_page = Number(req.query.per_page || 200);
    if (!settings.openlist_base_url || !settings.openlist_token) return fail(res, 400, "OpenList 未配置");
    const client = new OpenListClient(settings.openlist_base_url, settings.openlist_token, settings.openlist_password);
    const data = await client.listStorages(page, per_page);
    ok(res, data);
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});
