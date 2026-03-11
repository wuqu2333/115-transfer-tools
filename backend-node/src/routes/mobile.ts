import { Router } from "express";
import PQueue from "p-queue";
import { getSettings, insertTask, appendLog } from "../db";
import { MobileCloudClient } from "../clients/mobile";
import { OpenListClient } from "../clients/openlist";
import { ok, fail } from "../helpers";

const normalizeRemote = (p: string) => {
  if (!p) return "/";
  let s = String(p).trim();
  if (!s) return "/";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s || "/";
};

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

type RapidItem = {
  name: string;
  size: number;
  sha256: string;
  parent_file_id?: string;
  base_name: string;
  relative_dir: string;
};

function splitPathParts(input: string) {
  const clean = String(input || "").replace(/\\/g, "/");
  if (!clean) return { base: "", dir: "" };
  const parts = clean.split("/").filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : clean;
  const dir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
  return { base, dir };
}

function parseRapidItems(raw: any): RapidItem[] {
  if (Array.isArray(raw)) {
    return raw
      .map((o: any) => {
        const name = String(o.name || o.path || o.file || "");
        const { base, dir } = splitPathParts(name);
        return {
          name,
          base_name: base || name,
          relative_dir: dir,
          size: Number(o.size ?? o.length ?? o.file_size ?? o.filesize ?? o.bytes ?? 0),
          sha256: String(o.sha256 || o.hash || o.sha || "").toLowerCase(),
          parent_file_id: o.parent_file_id ? String(o.parent_file_id) : undefined,
        };
      })
      .filter((x) => x.name && x.sha256);
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    try {
      const j = JSON.parse(trimmed);
      return parseRapidItems(Array.isArray(j) ? j : (j as any).data ?? (j as any).content ?? []);
    } catch (_e) {
      // line mode
      return trimmed
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split("|").map((p) => p.trim());
          if (parts.length < 3) throw new Error(`行格式错误: ${line}`);
          const name = parts[0];
          const { base, dir } = splitPathParts(name);
          return {
            name,
            base_name: base || name,
            relative_dir: dir,
            size: Number(parts[1]),
            sha256: parts[2].toLowerCase(),
          };
        });
    }
  }
  return [];
}

export const router = Router();

router.post("/mobile/list", async (req, res) => {
  try {
    const settings = getSettings();
    const { parent_file_id, authorization, uni, cloud_host, app_channel, client_info } = req.body || {};
    if (!parent_file_id) return fail(res, 400, "parent_file_id 不能为空");
    const client = new MobileCloudClient(
      authorization || settings.mobile_authorization,
      uni || settings.mobile_uni,
      parent_file_id,
      cloud_host || settings.mobile_cloud_host,
      app_channel || settings.mobile_app_channel,
      client_info || settings.mobile_client_info,
    );
    const items = await client.list_dir(parent_file_id);
    ok(res, { parent_file_id, items });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});

router.post("/mobile/resolve-parent", async (req, res) => {
  try {
    const settings = getSettings();
    const target_path = normalizeRemote(req.body?.openlist_target_path || settings.mobile_target_openlist_path || "/");
    if (!settings.openlist_base_url || !settings.openlist_token) return fail(res, 400, "OpenList 未配置");
    const openlist = new OpenListClient(settings.openlist_base_url, settings.openlist_token, settings.openlist_password);
    const storages = (await openlist.listStorages(1, 2000)).content || [];
    const matched = storages.find(
      (s: any) => (s.driver || "").toLowerCase().includes("139") && target_path.startsWith((s.mount_path || "/").replace(/\/$/, "")),
    );
    if (!matched) return fail(res, 400, "未找到 139 挂载点");
    const mount = normalizeRemote(matched.mount_path || "/");
    const addition = matched.addition ? JSON.parse(matched.addition) : {};
    const root_folder_id = (addition.root_folder_id || "/").toString();
    const relative = target_path === mount ? "" : target_path.slice(mount.length).replace(/^\//, "");
    const segs = relative.split("/").filter(Boolean);

    const client = new MobileCloudClient(
      settings.mobile_authorization,
      settings.mobile_uni,
      root_folder_id,
      settings.mobile_cloud_host,
      settings.mobile_app_channel,
      settings.mobile_client_info,
    );

    let current = root_folder_id;
    for (const s of segs) {
      const items = await client.list_dir(current);
      const found = items.find((i: any) => i.is_dir && i.name === s);
      if (!found) return fail(res, 400, `目录不存在: ${s}`);
      current = found.file_id;
    }
    ok(res, {
      openlist_target_path: target_path,
      mount_path: mount,
      driver: matched.driver,
      root_folder_id,
      resolved_parent_file_id: current,
    });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});

router.post("/mobile/rapid-upload", async (req, res) => {
  try {
    const settings = getSettings();
    if (!settings.mobile_authorization || !settings.mobile_uni) return fail(res, 400, "缺少 mobile authorization/uni");
    const parent = (req.body?.parent_file_id || settings.mobile_parent_file_id || "").trim();
    if (!parent) return fail(res, 400, "parent_file_id 不能为空");

    const itemsRaw = req.body?.items ?? req.body?.text ?? req.body;
    const items = parseRapidItems(itemsRaw);
    if (!Array.isArray(items) || !items.length) return fail(res, 400, "items 不能为空");
    const keepDirs = req.body?.keep_dirs !== false;
    const concurrencyRaw = Number(req.body?.concurrency ?? 0);
    const concurrency =
      Number.isFinite(concurrencyRaw) && concurrencyRaw > 0 ? Math.min(Math.max(concurrencyRaw, 1), 16) : 8;
    const retryRaw = Number(req.body?.retry ?? 0);
    const retryCount = Number.isFinite(retryRaw) && retryRaw > 0 ? Math.min(Math.max(retryRaw, 1), 5) : 2;
    const asTask = req.body?.as_task !== false;

    if (asTask) {
      const created_at = new Date().toISOString();
      const totalBytes = items.reduce((sum, it) => sum + Number(it.size || 0), 0);
      const payload = {
        items,
        keep_dirs: keepDirs,
        concurrency,
        retry: retryCount,
        parent_file_id: parent,
      };
      const id = insertTask({
        provider: "rapid_mobile" as any,
        status: "pending",
        source_paths_json: JSON.stringify(payload),
        source_base_path: "",
        target_path: settings.mobile_target_openlist_path || "/",
        local_download_path: "",
        total_files: items.length,
        processed_files: 0,
        total_bytes: totalBytes,
        processed_bytes: 0,
        current_item: "",
        message: "秒传任务已入队",
        error_message: "",
        logs_json: "[]",
        created_at,
        updated_at: created_at,
        started_at: null,
        finished_at: null,
      } as any);
      appendLog(
        id,
        `秒传任务已入队：数量=${items.length}，并发=${concurrency}，重试=${retryCount}，保留目录=${keepDirs}`,
      );
      return ok(res, { task_id: id });
    }

    const client = new MobileCloudClient(
      settings.mobile_authorization,
      settings.mobile_uni,
      parent,
      settings.mobile_cloud_host,
      settings.mobile_app_channel,
      settings.mobile_client_info,
    );
    const fakeExtRaw = (settings.mobile_fake_extension || ".jpg").trim() || ".jpg";
    const fakeExt = fakeExtRaw.startsWith(".") ? fakeExtRaw : `.${fakeExtRaw}`;

    const dirCache: Record<string, string> = {};
    const dirKey = (root: string, rel: string) => `${root}::${rel}`;

    const ensureMobileDir = async (relative: string, rootParent: string) => {
      const clean = (relative || "").replace(/^\//, "").replace(/\.$/, "");
      if (!clean) return rootParent;
      const fullKey = dirKey(rootParent, clean);
      if (dirCache[fullKey]) return dirCache[fullKey];

      const parts = clean.split("/").filter(Boolean);
      let current = rootParent;
      let built = "";
      for (const seg of parts) {
        built = built ? `${built}/${seg}` : seg;
        const builtKey = dirKey(rootParent, built);
        if (dirCache[builtKey]) {
          current = dirCache[builtKey];
          continue;
        }
        const items = await client.list_dir(current);
        const found = items.find((i: any) => i.is_dir && i.name === seg);
        if (found) {
          current = found.file_id;
        } else {
          current = await client.create_folder(current, seg);
        }
        dirCache[builtKey] = current;
      }
      return current;
    };

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
          return await client.rapid_upload_only(opts);
        } catch (e: any) {
          lastErr = e;
          const msg = e?.message || String(e);
          if (!shouldRetryRapid(msg) || attempt >= retryCount) throw e;
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
      throw lastErr || new Error("rapid upload failed");
    };
    const itemsByParent: Record<string, RapidItem[]> = {};
    for (const it of items) {
      const parentId = (it.parent_file_id || parent).trim() || parent;
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
        await ensureMobileDir(dir, parentId);
      }
    }

    const results: any[] = new Array(items.length);
    const queue = new PQueue({ concurrency });
    items.forEach((it, idx) => {
      queue.add(async () => {
        const parentId = (it.parent_file_id || parent).trim() || parent;
        try {
          const baseName = it.base_name || it.name;
          const stem = baseName.replace(/\.[^.]+$/, "");
          const fakeName = `${stem}${fakeExt}`;
          const relativeDir = keepDirs ? it.relative_dir || "" : "";
          const rootParent = parentId || parent;
          const targetParent = relativeDir ? await ensureMobileDir(relativeDir, rootParent) : rootParent;
          const resu = await rapidUploadWithRetry({
            file_name: fakeName,
            file_size: Number(it.size || 0),
            content_hash: it.sha256,
            parent_file_id: targetParent,
          });
          let renameStatus = "success";
          let renameError = "";
          try {
            await client.rename_file(resu.file_id, baseName, targetParent);
          } catch (e: any) {
            renameStatus = "failed";
            renameError = e?.message || String(e);
          }
          results[idx] = {
            name: it.name,
            status: renameStatus === "success" ? "ok" : "rename_failed",
            file_id: resu.file_id,
            upload_id: resu.upload_id,
            uploaded_name: resu.uploaded_name,
            parent_file_id: parentId,
            rename_status: renameStatus,
            rename_error: renameError,
          };
        } catch (err: any) {
          const msg = err?.message || String(err);
          results[idx] = {
            name: it.name,
            status: msg.includes("秒传未命中") ? "miss" : "failed",
            error: msg,
            parent_file_id: parentId,
          };
        }
      });
    });
    await queue.onIdle();
    ok(res, { parent_file_id: parent, results, concurrency });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});

router.post("/mobile/export-hash", async (req, res) => {
  try {
    const settings = getSettings();
    if (!settings.mobile_authorization || !settings.mobile_uni) return fail(res, 400, "缺少 mobile authorization/uni");
    const parent = (req.body?.parent_file_id || settings.mobile_parent_file_id || "").trim();
    if (!parent) return fail(res, 400, "parent_file_id 不能为空");
    const includeMissing = req.body?.include_missing === true;
    const basePrefix = normalizePrefix(req.body?.path_prefix || "");

    const client = new MobileCloudClient(
      settings.mobile_authorization,
      settings.mobile_uni,
      parent,
      settings.mobile_cloud_host,
      settings.mobile_app_channel,
      settings.mobile_client_info,
    );

    const items: any[] = [];
    let totalFiles = 0;
    let missingHash = 0;

    const walk = async (parentId: string, prefix: string) => {
      const list = await client.list_dir(parentId);
      for (const it of list) {
        const nextName = joinPrefix(prefix, it.name);
        if (it.is_dir) {
          await walk(it.file_id, nextName);
        } else {
          totalFiles += 1;
          const size = Number(it.size || 0);
          const sha256 = extractSha256(it);
          if (sha256) {
            items.push({ name: nextName, size, sha256 });
          } else {
            missingHash += 1;
            if (includeMissing) items.push({ name: nextName, size, sha256: "" });
          }
        }
      }
    };

    await walk(parent, basePrefix);
    ok(res, { items, total_files: totalFiles, missing_hash: missingHash });
  } catch (e: any) {
    fail(res, 400, e.message, e.message);
  }
});





