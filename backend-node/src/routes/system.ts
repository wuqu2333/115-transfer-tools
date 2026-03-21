import { Router } from "express";
import os from "os";
import { execFile } from "child_process";
import { ok, fail } from "../helpers";
import { getSettings } from "../db";
import { P115Client } from "../clients/p115";
import { getDiskInfo, getCpuUsagePercent } from "../utils/systemInfo";
import axios from "axios";

function escapePsString(value: string) {
  return (value || "").replace(/'/g, "''");
}

function selectDirectoryWindows(title: string): Promise<string> {
  const desc = escapePsString(title || "Choose folder");
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$f.Description = '${desc}'`,
    "$f.ShowNewFolderButton = $true",
    "if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }",
  ].join("; ");

  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      const out = (stdout || "").trim();
      if (!out) return reject(new Error("\u672a\u9009\u62e9\u76ee\u5f55"));
      resolve(out);
    });
  });
}

function selectFileWindows(title: string, filter = "All files (*.*)|*.*"): Promise<string> {
  const desc = escapePsString(title || "Choose file");
  const filt = escapePsString(filter);
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$f = New-Object System.Windows.Forms.OpenFileDialog",
    `$f.Title = '${desc}'`,
    `$f.Filter = '${filt}'`,
    "$f.CheckFileExists = $true",
    "if ($f.ShowDialog() -eq 'OK') { $f.FileName }",
  ].join("; ");

  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-STA", "-Command", script], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      const out = (stdout || "").trim();
      if (!out) return reject(new Error("\u672a\u9009\u62e9\u6587\u4ef6"));
      resolve(out);
    });
  });
}

export const router = Router();

function toNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object") {
    const keys = ["size", "value", "bytes", "num", "count", "total", "used", "free", "remain", "left"];
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(value, k)) {
        const num = toNumber((value as any)[k]);
        if (num !== null) return num;
      }
    }
    return null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const cleaned = trimmed.replace(/,/g, "");
    const num = Number(cleaned);
    if (Number.isFinite(num)) return num;
    const numberMatch = cleaned.match(/^[\d.]+/);
    if (numberMatch && numberMatch[0]) {
      const n = Number(numberMatch[0]);
      if (Number.isFinite(n)) return n;
    }
    const match = cleaned.match(/^([\d.]+)\s*([kmgpt]?b?|[kmgpt])$/i);
    if (!match) return null;
    const base = Number(match[1]);
    if (!Number.isFinite(base)) return null;
    const unit = match[2].toUpperCase();
    const unitMap: Record<string, number> = {
      B: 1,
      KB: 1024,
      K: 1024,
      MB: 1024 ** 2,
      M: 1024 ** 2,
      GB: 1024 ** 3,
      G: 1024 ** 3,
      TB: 1024 ** 4,
      T: 1024 ** 4,
      PB: 1024 ** 5,
      P: 1024 ** 5,
    };
    const mul = unitMap[unit];
    if (!mul) return null;
    return Math.round(base * mul);
  }
  return null;
}

function pickNumber(obj: any, keys: string[]): number | null {
  for (const key of keys) {
    const num = toNumber(obj?.[key]);
    if (num !== null) return num;
  }
  return null;
}

function extractUsage(storage: any) {
  const quota = storage?.quota || storage?.stats || storage?.usage || storage?.storage || {};
  const total =
    pickNumber(storage, [
      "total",
      "total_size",
      "totalSize",
      "total_space",
      "totalSpace",
      "total_bytes",
      "totalBytes",
      "space_total",
      "storage_total",
      "quota_total",
      "all_total",
      "space_all",
    ]) ??
    pickNumber(quota, [
      "total",
      "total_size",
      "totalSize",
      "total_space",
      "totalSpace",
      "total_bytes",
      "totalBytes",
      "quota",
      "space_total",
      "all_total",
    ]);

  const used =
    pickNumber(storage, [
      "used",
      "used_size",
      "usedSize",
      "used_space",
      "usedSpace",
      "used_bytes",
      "usedBytes",
      "space_used",
      "storage_used",
      "quota_used",
      "space_use",
      "all_used",
    ]) ??
    pickNumber(quota, [
      "used",
      "used_size",
      "usedSize",
      "used_space",
      "usedSpace",
      "used_bytes",
      "usedBytes",
      "usedQuota",
      "space_used",
      "space_use",
    ]);

  const free =
    pickNumber(storage, [
      "free",
      "free_size",
      "freeSize",
      "free_space",
      "freeSpace",
      "free_bytes",
      "freeBytes",
      "space_free",
      "storage_free",
      "quota_free",
      "space_remaining",
      "remaining",
      "remain",
      "left_space",
    ]) ??
    pickNumber(quota, [
      "free",
      "free_size",
      "freeSize",
      "free_space",
      "freeSpace",
      "free_bytes",
      "freeBytes",
      "freeQuota",
      "space_free",
      "remaining",
    ]);

  const computedFree = total !== null && used !== null ? Math.max(total - used, 0) : null;
  let finalTotal = total;
  let finalUsed = used;
  let finalFree = free ?? computedFree;
  if (finalTotal === null && finalUsed !== null && finalFree !== null) {
    finalTotal = finalUsed + finalFree;
  }
  if (finalUsed === null && finalTotal !== null && finalFree !== null) {
    finalUsed = Math.max(finalTotal - finalFree, 0);
  }
  if (finalFree === null && finalTotal !== null && finalUsed !== null) {
    finalFree = Math.max(finalTotal - finalUsed, 0);
  }
  return {
    total: finalTotal,
    used: finalUsed,
    free: finalFree,
  };
}

function extract115Usage(resp: any) {
  if (!resp) return { total: null, used: null, free: null };
  const candidates: any[] = [];
  const payload = resp?.data ?? resp;
  const addCandidate = (obj: any) => {
    if (!obj || typeof obj !== "object") return;
    candidates.push(obj);
  };
  addCandidate(payload);
  addCandidate(payload?.data);
  addCandidate(payload?.space_info);
  addCandidate(payload?.space);
  addCandidate(payload?.quota);
  addCandidate(payload?.space_summury);
  addCandidate(payload?.type_summury);
  addCandidate(payload?.rt_space_info);
  addCandidate(resp?.space_info);
  addCandidate(resp?.quota);

  const seen = new Set<any>();
  const walk = (obj: any, depth = 0) => {
    if (!obj || typeof obj !== "object" || depth > 3 || seen.has(obj)) return;
    seen.add(obj);
    const keys = Object.keys(obj || {});
    if (keys.some((k) => /total|used|free|remain|space|quota/i.test(k))) {
      addCandidate(obj);
    }
    for (const k of keys) {
      const v = (obj as any)[k];
      if (!v || typeof v !== "object") continue;
      if (["space_summury", "type_summury", "rt_space_info", "space_info", "space", "quota"].includes(k)) {
        addCandidate(v);
      }
      walk(v, depth + 1);
    }
  };
  walk(payload, 0);
  for (const obj of candidates) {
    const usage = extractUsage(obj);
    if (usage.total !== null || usage.used !== null || usage.free !== null) return usage;
  }
  return { total: null, used: null, free: null };
}

function extract115Error(resp: any): string | null {
  if (!resp) return null;
  if (typeof resp === "string") {
    if (resp.includes("<html") || resp.includes("<!DOCTYPE")) return "Cookie 失效或被风控";
    return null;
  }
  const payload = resp?.data ?? resp;
  const msg =
    payload?.error || payload?.message || payload?.msg || payload?.err_msg || payload?.errmsg || payload?.err;
  if (payload?.state === false || payload?.state === 0 || payload?.state === "false") {
    return msg || "115 接口返回失败";
  }
  if (payload?.error && typeof payload.error === "string") return payload.error;
  if (payload?.message && typeof payload.message === "string" && payload.message !== "success") {
    return payload.message;
  }
  return null;
}

function summarize115(resp: any) {
  const out: any = {};
  if (!resp) return out;
  if (typeof resp === "string") {
    out.preview = resp.slice(0, 120);
    return out;
  }
  const payload = resp?.data ?? resp;
  const inner = payload?.data ?? payload;
  out.keys = Object.keys(payload || {}).slice(0, 40);
  out.data_keys = Object.keys(inner || {}).slice(0, 40);
  const collect = (obj: any) => {
    const picked: Record<string, any> = {};
    if (!obj || typeof obj !== "object") return picked;
    const keys = Object.keys(obj);
    for (const k of keys) {
      if (!/total|used|free|remain|left|space|quota/i.test(k)) continue;
      const v = obj[k];
      if (typeof v === "string" || typeof v === "number") {
        picked[k] = v;
      }
      if (typeof v === "object" && v !== null) {
        const innerVal = toNumber(v);
        if (innerVal !== null) picked[k] = innerVal;
      }
      if (Object.keys(picked).length >= 20) break;
    }
    return picked;
  };
  out.sample = collect(inner);
  out.space_summury = collect(inner?.space_summury);
  out.type_summury = collect(inner?.type_summury);
  out.rt_space_info = collect(inner?.rt_space_info);
  return out;
}

const GRAPH_CN_BASE = "https://microsoftgraph.chinacloudapi.cn";
const GRAPH_CN_TOKEN_BASE = "https://login.partner.microsoftonline.cn";

router.post("/system/select-directory", async (req, res) => {
  try {
    if (os.platform() !== "win32") return fail(res, 400, "\u4ec5\u652f\u6301 Windows \u9009\u62e9\u76ee\u5f55");
    const title = req.body?.title || "\u9009\u62e9\u76ee\u5f55";
    const path = await selectDirectoryWindows(title);
    ok(res, { path });
  } catch (e: any) {
    fail(res, 400, e.message || "\u9009\u62e9\u76ee\u5f55\u5931\u8d25", e.message);
  }
});

router.post("/system/select-file", async (req, res) => {
  try {
    if (os.platform() !== "win32") return fail(res, 400, "\u4ec5\u652f\u6301 Windows \u9009\u62e9\u6587\u4ef6");
    const title = req.body?.title || "\u9009\u62e9\u6587\u4ef6";
    const filter = req.body?.filter || "All files (*.*)|*.*";
    const path = await selectFileWindows(title, filter);
    ok(res, { path });
  } catch (e: any) {
    fail(res, 400, e.message || "\u9009\u62e9\u6587\u4ef6\u5931\u8d25", e.message);
  }
});

router.get("/system/storage", async (req, res) => {
  try {
    const settings = getSettings();
    const items: any[] = [];

    // 115 usage
    if (!settings.source_115_cookie) {
      items.push({ type: "115", status: "missing", message: "未填写 115 Cookie" });
    } else {
      try {
        const client = new P115Client(settings.source_115_cookie);
        let resp: any;
        let usage: any = { total: null, used: null, free: null };
        let lastRaw: any = null;
        let lastErrMsg: string | null = null;
        try {
          resp = await client.storageInfo();
          lastRaw = resp;
          usage = extract115Usage(resp);
          lastErrMsg = extract115Error(resp);
        } catch (_e) {
          // ignore and try fallback
        }
        if (usage.total === null && usage.used === null) {
          try {
            resp = await client.userSpaceInfo();
            lastRaw = resp;
            usage = extract115Usage(resp);
            lastErrMsg = extract115Error(resp) || lastErrMsg;
          } catch (_e) {
            // ignore
          }
        }
        if (usage.total === null && usage.used === null) {
          try {
            resp = await client.indexInfo();
            lastRaw = resp;
            usage = extract115Usage(resp);
            lastErrMsg = extract115Error(resp) || lastErrMsg;
          } catch (_e) {
            // ignore
          }
        }
        if (usage.total === null && usage.used === null) {
          try {
            resp = await client.spaceSummury();
            lastRaw = resp;
            usage = extract115Usage(resp);
            lastErrMsg = extract115Error(resp) || lastErrMsg;
          } catch (_e) {
            // ignore
          }
        }
        if (usage.total === null && usage.used === null) {
          const hint = lastErrMsg || "115 空间解析失败";
          const debug = req.query?.debug ? summarize115(lastRaw) : undefined;
          items.push({ type: "115", status: "error", message: hint, debug });
        } else {
          items.push({
            type: "115",
            status: "ok",
            total: usage.total,
            used: usage.used,
            free: usage.free,
          });
        }
      } catch (e: any) {
        items.push({ type: "115", status: "error", message: e?.message || "115 获取失败" });
      }
    }

    // SharePoint (世纪互联) usage
    const hasToken = !!settings.sharepoint_access_token;
    const hasClientCreds = !!(
      settings.sharepoint_tenant_id &&
      settings.sharepoint_client_id &&
      settings.sharepoint_client_secret
    );
    if (!hasToken && !hasClientCreds) {
      items.push({ type: "sharepoint", status: "missing", message: "未配置世纪互联凭据" });
    } else {
      try {
        let accessToken = settings.sharepoint_access_token;
        if (!accessToken && hasClientCreds) {
          const params = new URLSearchParams();
          params.append("client_id", settings.sharepoint_client_id);
          params.append("client_secret", settings.sharepoint_client_secret);
          params.append("grant_type", "client_credentials");
          params.append("scope", `${GRAPH_CN_BASE}/.default`);
          const tokenUrl = `${GRAPH_CN_TOKEN_BASE}/${settings.sharepoint_tenant_id}/oauth2/v2.0/token`;
          const tokenResp = await axios.post(tokenUrl, params, {
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            timeout: 20000,
          });
          accessToken = tokenResp?.data?.access_token || "";
        }
        if (!accessToken) throw new Error("未获取到世纪互联访问令牌");
        const driveId = String(settings.sharepoint_drive_id || "").trim();
        const siteId = String(settings.sharepoint_site_id || "").trim();
        if (!driveId && !siteId) {
          items.push({ type: "sharepoint", status: "missing", message: "未填写 Drive ID 或 Site ID" });
        } else {
          const url = driveId
            ? `${GRAPH_CN_BASE}/v1.0/drives/${driveId}?$select=quota`
            : `${GRAPH_CN_BASE}/v1.0/sites/${siteId}/drive?$select=quota`;
          const resp = await axios.get(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 20000,
          });
          const quota = resp?.data?.quota || {};
          const usage = extractUsage(quota);
          if (usage.total === null && usage.used === null) {
            items.push({ type: "sharepoint", status: "error", message: "世纪互联空间解析失败" });
          } else {
            items.push({
              type: "sharepoint",
              status: "ok",
              total: usage.total,
              used: usage.used,
              free: usage.free,
            });
          }
        }
      } catch (e: any) {
        items.push({ type: "sharepoint", status: "error", message: e?.message || "世纪互联获取失败" });
      }
    }

    ok(res, {
      updated_at: new Date().toISOString(),
      items,
      source: "official",
    });
  } catch (e: any) {
    fail(res, 400, e.message || "获取空间信息失败", e.message);
  }
});

router.get("/system/metrics", async (_req, res) => {
  try {
    const settings = getSettings();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = Math.max(totalMem - freeMem, 0);
    const memPct = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
    const cpuPct = await getCpuUsagePercent();
    const disk = await getDiskInfo(settings.download_base_path || process.cwd());
    const diskPct = disk?.total ? Math.round(((disk.total - (disk.free || 0)) / disk.total) * 100) : null;
    ok(res, {
      updated_at: new Date().toISOString(),
      cpu: { usage_percent: cpuPct, cores: os.cpus().length },
      memory: { total: totalMem, free: freeMem, used: usedMem, usage_percent: memPct },
      disk: disk
        ? { ...disk, usage_percent: diskPct, path: settings.download_base_path || process.cwd() }
        : null,
    });
  } catch (e: any) {
    fail(res, 400, e.message || "获取系统信息失败", e.message);
  }
});
