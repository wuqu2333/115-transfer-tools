import { join, resolve, posix as pathPosix } from "path";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { clearTree, insertTreeNodes, setTreeMeta, getSettings, updateSettings } from "../db";
import { P115Client } from "../clients/p115";
import { OpenListClient } from "../clients/openlist";

let treeRefreshLock = Promise.resolve();
let treeRefreshBusy = false;
let latestRefreshFingerprint = "";
let latestRefreshAt = 0;

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function normalizeLooseName(value: string) {
  return String(value || "")
    .trim()
    .normalize("NFKC")
    .replace(/^[\p{P}\p{S}\s]+/gu, "")
    .replace(/[\p{P}\p{S}\s]+$/gu, "")
    .toLowerCase();
}

function basenameFromPath(pathStr: string) {
  if (!pathStr) return "";
  const parts = String(pathStr).split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function normalize115Path(input: string, rootPrefix: string) {
  let s = String(input || "").trim();
  if (!s) return "/";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/");
  if (rootPrefix && rootPrefix !== "/" && s.startsWith(rootPrefix)) {
    s = s.slice(rootPrefix.length);
    if (!s.startsWith("/")) s = "/" + s;
  }
  return s || "/";
}

function normalizeTreePath(path: string, rootPrefix: string) {
  let s = String(path || "").trim();
  if (!s) return "";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) {
    const root = rootPrefix || "/";
    s = root === "/" ? `/${s}` : `${root}/${s}`;
  }
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s;
}

function normalizeOpenlistPath(input: string) {
  let s = String(input || "").trim();
  if (!s) return "/";
  s = s.replace(/\\/g, "/");
  if (!s.startsWith("/")) s = "/" + s;
  s = s.replace(/\/+/g, "/");
  if (s.length > 1 && s.endsWith("/")) s = s.replace(/\/+$/, "");
  return s || "/";
}

function joinOpenlist(base: string, tail: string) {
  const a = normalizeOpenlistPath(base || "/");
  if (!tail) return a;
  const b = String(tail || "").replace(/^\/+/, "");
  return normalizeOpenlistPath(`${a}/${b}`);
}

function readTreeRootName(filePath: string) {
  try {
    const raw = readFileSync(filePath, "utf16le");
    const text = raw.replace(/^\uFEFF/, "");
    const first = text.split(/\r?\n/).find((l) => l.trim().length > 0) || "";
    return first.trimEnd().replace(/^[\|\-\s]+/, "").trim();
  } catch {
    return "";
  }
}

function isTreeExportArtifactName(name: string) {
  const base = basenameFromPath(name);
  if (!base) return false;
  return /\d{10,}_目录树\.txt$/u.test(base);
}

function get115ItemName(item: any) {
  return String(item?.n || item?.ns || item?.file_name || item?.name || item?.fileName || "").trim();
}

function get115ItemId(item: any) {
  return String(
    item?.fid ||
      item?.file_id ||
      item?.fileId ||
      item?.file_id_str ||
      item?.fileIdStr ||
      item?.id ||
      "",
  ).trim();
}

function is115Dir(item: any) {
  const hasFileId = !!(
    item?.fid ||
    item?.file_id ||
    item?.fileId ||
    item?.file_id_str ||
    item?.fileIdStr
  );
  const hasDirId = !!(item?.cid || item?.dir_id || item?.dirId);
  return (
    item?.is_dir === 1 ||
    item?.is_dir === true ||
    item?.isdir === 1 ||
    item?.isdir === true ||
    item?.dir === 1 ||
    item?.dir === true ||
    item?.isfolder === 1 ||
    item?.isfolder === true ||
    item?.isFolder === 1 ||
    item?.isFolder === true ||
    (!hasFileId && hasDirId)
  );
}

async function cleanupExportTreeArtifact(opts: {
  client: P115Client;
  openlist: OpenListClient;
  exportFileId?: string;
  exportFileName: string;
  remotePaths: string[];
  logIt: (msg: string) => void;
}) {
  const { client, openlist, exportFileId, exportFileName, remotePaths, logIt } = opts;

  if (exportFileId) {
    try {
      await client.deleteFiles(exportFileId);
      logIt(`目录树文件已从 115 删除：file_id=${exportFileId}`);
      return;
    } catch (e: any) {
      logIt(`目录树文件 115 删除失败：file_id=${exportFileId} -> ${e?.message || String(e)}`);
    }
  }

  const tried = new Set<string>();
  let lastErr: any;
  for (const rawPath of remotePaths) {
    const remotePath = normalizeOpenlistPath(rawPath);
    if (!remotePath || tried.has(remotePath)) continue;
    tried.add(remotePath);
    try {
      await openlist.remove(remotePath);
      logIt(`目录树文件已通过 OpenList 删除：${remotePath}`);
      return;
    } catch (e: any) {
      lastErr = e;
    }
  }

  if (tried.size > 0) {
    logIt(`目录树文件删除失败：${exportFileName} -> ${lastErr?.message || "unknown error"}`);
  }
}

async function cleanupHistoricalExportArtifacts(
  client: P115Client,
  dirIds: Array<string | number>,
  logIt: (msg: string) => void,
) {
  const deleteMap = new Map<string, string>();
  const scanned = new Set<string>();

  for (const dirIdRaw of dirIds) {
    const dirId = String(dirIdRaw || "").trim();
    if (!dirId || scanned.has(dirId)) continue;
    scanned.add(dirId);
    try {
      const list = await client.listByCid(dirId);
      for (const item of list) {
        if (is115Dir(item)) continue;
        const name = get115ItemName(item);
        const id = get115ItemId(item);
        if (!id || !name || !isTreeExportArtifactName(name)) continue;
        deleteMap.set(id, name);
      }
    } catch (e: any) {
      logIt(`历史目录树扫描失败：cid=${dirId} -> ${e?.message || String(e)}`);
    }
  }

  if (!deleteMap.size) return;

  let okCount = 0;
  for (const [id, name] of deleteMap.entries()) {
    try {
      await client.deleteFiles(id);
      okCount += 1;
      logIt(`已清理历史目录树文件：${name}`);
    } catch (e: any) {
      logIt(`历史目录树删除失败：${name} -> ${e?.message || String(e)}`);
    }
  }

  if (okCount > 0) {
    logIt(`历史目录树清理完成：共删除 ${okCount} 个文件`);
  }
}

function parse115ExportTreeFile(
  filePath: string,
  rootPrefix: string,
  rootOverride?: string,
  excludeFileNames: string[] = [],
) {
  const raw = readFileSync(filePath, "utf16le");
  const text = raw.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const nodes: Array<{ path: string; is_dir: number; size: number; sha256?: string }> = [];
  if (!lines.length) return { nodes, totalFiles: 0, totalDirs: 0 };

  const first = lines.shift() || "";
  let rootName = first.trimEnd().replace(/^[\|\-\s]+/, "").trim();
  const rootIsRoot = !rootName || rootName === "根目录" || rootName === "/" || rootName.toLowerCase() === "root";
  const rootPath = rootIsRoot ? "/" : "/" + rootName;
  const stack: string[] = [rootPath === "/" ? "" : rootPath];
  const prefixRegex = /^(?:\| )+\|-(.*)$/;
  let prev: { path: string; depth: number } | null = null;
  let totalFiles = 0;
  let totalDirs = 0;

  const override = rootOverride ? normalizeOpenlistPath(rootOverride) : "";
  const overrideBase = override ? basenameFromPath(override) : "";
  const dropRootSegment =
    !!override && !!rootName && normalizeLooseName(rootName) === normalizeLooseName(overrideBase);
  const excludedNames = new Set(
    excludeFileNames
      .map((name) => basenameFromPath(name))
      .map((name) => normalizeLooseName(name))
      .filter(Boolean),
  );
  let skippedFiles = 0;

  const pushPrev = (isDir: boolean) => {
    if (!prev || !prev.path) return;
    const relative = prev.path.startsWith("/") ? prev.path.slice(1) : prev.path;
    let fullPath = "";
    if (override) {
      const parts = relative.split("/").filter(Boolean);
      const tailParts = dropRootSegment ? parts.slice(1) : parts;
      const tail = tailParts.join("/");
      fullPath = tail ? joinOpenlist(override, tail) : override;
    } else {
      fullPath = normalizeTreePath(relative, rootPrefix);
    }
    if (!fullPath) return;
    const baseName = basenameFromPath(fullPath);
    const isTreeArtifact =
      !isDir &&
      (excludedNames.has(normalizeLooseName(baseName)) || isTreeExportArtifactName(baseName));
    if (isTreeArtifact) {
      skippedFiles += 1;
      return;
    }
    nodes.push({ path: fullPath, is_dir: isDir ? 1 : 0, size: 0 });
    if (isDir) totalDirs += 1;
    else totalFiles += 1;
  };

  for (const lineRaw of lines) {
    const line = lineRaw.replace(/\r/g, "");
    const m = prefixRegex.exec(line);
    if (!m) {
      if (prev) prev.path += "\n" + line;
      continue;
    }
    const name = m[1];
    const depth = Math.max(1, Math.floor((line.length - name.length) / 2 - 1));
    if (prev) pushPrev(depth > prev.depth);
    const base = stack[depth - 1] || "";
    const path = base ? `${base}/${name}` : `/${name}`;
    if (stack.length > depth) stack[depth] = path;
    else stack.push(path);
    prev = { path, depth };
  }
  if (prev) pushPrev(false);

  return { nodes, totalFiles, totalDirs, rootName, skippedFiles } as any;
}

function tryParseJsonString(raw: any) {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function extractIdsFromOpenListObject(obj: any) {
  const candidates: any[] = [];
  const raw = tryParseJsonString(obj?.raw ?? obj?.extra ?? obj?.data ?? obj?.info ?? null);
  if (raw) {
    candidates.push(raw);
    if (raw?.data) candidates.push(raw.data);
    if (raw?.info) candidates.push(raw.info);
    if (raw?.item) candidates.push(raw.item);
  }
  candidates.push(obj);
  const getVal = (o: any, keys: string[]) => {
    for (const k of keys) {
      if (o && Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined && o[k] !== null) {
        return o[k];
      }
    }
    return undefined;
  };
  let isDir = false;
  for (const c of candidates) {
    const v = getVal(c, ["is_dir", "isdir", "dir", "isFolder", "isfolder", "folder"]);
    if (v !== undefined) {
      isDir = !!v;
      break;
    }
    if (c?.type === "dir" || c?.type === "folder") {
      isDir = true;
      break;
    }
  }
  let fid: any;
  let cid: any;
  let parentId: any;
  for (const c of candidates) {
    fid = fid ?? getVal(c, ["fid", "file_id", "fileId", "id", "file_id_str", "fileIdStr"]);
    cid = cid ?? getVal(c, ["cid", "dir_id", "dirId"]);
    parentId = parentId ?? getVal(c, ["parent_id", "parentId", "pid", "parent"]);
  }
  return { is_dir: isDir, fid, cid, parent_id: parentId };
}

export async function refreshTreeFrom115(
  settings: ReturnType<typeof getSettings>,
  sourcePaths: string[],
  log?: (msg: string) => void,
) {
  if (!settings.source_115_cookie) {
    throw new Error("?? 115 Cookie??????????");
  }

  const logIt = (msg: string) => {
    if (log) log(msg);
  };

  const rootPrefix = settings.tree_root_prefix || "/115";
  const fingerprint = JSON.stringify({
    rootPrefix,
    sourcePaths: sourcePaths.map((p) => normalizeOpenlistPath(p)).sort(),
  });

  if (treeRefreshBusy) {
    logIt("???????????????????????");
  }
  const previousLock = treeRefreshLock;
  let release!: () => void;
  treeRefreshLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previousLock;

  try {
    treeRefreshBusy = true;
    if (latestRefreshFingerprint === fingerprint && Date.now() - latestRefreshAt < 30000) {
      logIt("???????? 30 ???????");
      return;
    }

    logIt("?????????? 115 ????");
    const client = new P115Client(settings.source_115_cookie);

    const exportIds = new Set<string>();
    const resolvedSources: Array<{ raw: string; is_dir: boolean }> = [];
    for (const raw of sourcePaths) {
      const path = normalize115Path(raw, rootPrefix);
      const info = await client.resolvePathId(path);
      if (!info) {
        logIt(`??????????? ${path}`);
        continue;
      }
      resolvedSources.push({ raw, is_dir: !!info.is_dir });
      if (info.is_dir) exportIds.add(String(info.id));
      else if (info.parent_id) exportIds.add(String(info.parent_id));
    }

    if (exportIds.size === 0) {
      const baseUrl = settings.openlist_base_url;
      let token = settings.openlist_token;
      const password = settings.openlist_password;
      if (baseUrl) {
        if (!token && settings.openlist_username && settings.openlist_login_password) {
          try {
            const newToken = await new OpenListClient(baseUrl, "", "").login(
              settings.openlist_username,
              settings.openlist_login_password,
            );
            token = newToken;
            updateSettings({ openlist_token: newToken });
          } catch {
            // ignore
          }
        }
        if (token) {
          const ol = new OpenListClient(baseUrl, token, password);
          for (const raw of sourcePaths) {
            try {
              const obj: any = await ol.get(raw);
              const info = extractIdsFromOpenListObject(obj);
              if (info.is_dir) {
                if (info.cid || info.fid) exportIds.add(String(info.cid || info.fid));
              } else if (info.parent_id || info.cid || info.fid) {
                exportIds.add(String(info.parent_id || info.cid || info.fid));
              }
            } catch {
              // ignore
            }
          }
          if (exportIds.size > 0) {
            logIt("????????? OpenList ???? ID");
          }
        }
      }
    }

    if (exportIds.size === 0) {
      try {
        const rootList = await client.listByCid("0");
        if (!rootList.length) {
          throw new Error("115 Cookie ????????????????");
        }
      } catch (e: any) {
        throw new Error(e?.message || "115 Cookie ??????");
      }
      throw new Error("???????? ID???? 115 ??????");
    }

    const exportIdList = Array.from(exportIds);
    const cleanupDirIds = exportIdList.length > 1 ? [...exportIdList, "0"] : exportIdList;
    await cleanupHistoricalExportArtifacts(client, cleanupDirIds, logIt);
    const target = exportIdList.length === 1 ? `U_1_${exportIdList[0]}` : "U_1_0";
    const exportResp: any = await client.exportDir(exportIdList.join(","), target, 25);
    const exportId =
      exportResp?.data?.export_id ||
      exportResp?.export_id ||
      exportResp?.data?.exportId ||
      exportResp?.exportId;
    if (!exportId) throw new Error("???????????");
    logIt(`???????????${exportId}`);

    const started = Date.now();
    let exportResult: any = null;
    let finalPickcode = "";
    let lastStatusLog = 0;
    const extractPickcode = (obj: any): string => {
      if (!obj) return "";
      if (typeof obj === "string") return obj;
      if (obj.pick_code || obj.pickcode) return String(obj.pick_code || obj.pickcode);
      if (obj.data) {
        const fromData = extractPickcode(obj.data);
        if (fromData) return fromData;
      }
      if (obj.result) {
        const fromResult = extractPickcode(obj.result);
        if (fromResult) return fromResult;
      }
      if (obj.info) {
        const fromInfo = extractPickcode(obj.info);
        if (fromInfo) return fromInfo;
      }
      return "";
    };
    while (true) {
      const status: any = await client.exportDirStatus(exportId);
      const pickcode = extractPickcode(status);
      if (pickcode) {
        finalPickcode = pickcode;
        exportResult = status?.data || status;
        break;
      }
      const now = Date.now();
      if (now - lastStatusLog > 10000) {
        const progress =
          status?.data?.process ??
          status?.data?.progress ??
          status?.process ??
          status?.progress ??
          status?.data?.status;
        if (progress !== undefined && progress !== null) {
          logIt(`?????????${progress}`);
        } else {
          logIt("????????...");
        }
        lastStatusLog = now;
      }
      if (Date.now() - started > 60 * 60 * 1000) {
        throw new Error("???????");
      }
      await sleep(1000);
    }

    const pickcode = finalPickcode || exportResult?.pick_code || exportResult?.pickcode;
    if (!pickcode) throw new Error("????????????");
    logIt(`??????????? ${pickcode}`);

    const exportFileId = String(
      exportResult?.file_id ||
        exportResult?.fileId ||
        exportResp?.data?.file_id ||
        exportResp?.file_id ||
        "",
    ).trim();
    const exportFileName = exportResult?.file_name || exportResult?.fileName || "";
    if (!exportFileName) throw new Error("????????????? OpenList ??");

    const treeDir = resolve(process.cwd(), "..", "data");
    mkdirSync(treeDir, { recursive: true });
    const treeFile = join(treeDir, `tree-latest.txt`);

    if (!settings.openlist_base_url) {
      throw new Error("??? OpenList????????");
    }
    let token = settings.openlist_token;
    const password = settings.openlist_password;
    if (!token && settings.openlist_username && settings.openlist_login_password) {
      try {
        const newToken = await new OpenListClient(settings.openlist_base_url, "", "").login(
          settings.openlist_username,
          settings.openlist_login_password,
        );
        token = newToken;
        updateSettings({ openlist_token: newToken });
      } catch {
        // ignore
      }
    }
    if (!token) throw new Error("OpenList Token ??????????");

    const openlist = new OpenListClient(settings.openlist_base_url, token, password);
    const candidates: string[] = [];
    const rootMount = normalizeOpenlistPath(rootPrefix || "/115");
    if (exportIdList.length > 1) {
      candidates.push(rootMount);
    }
    for (const item of resolvedSources) {
      const rawPath = normalizeOpenlistPath(item.raw);
      const dir = item.is_dir ? rawPath : pathPosix.dirname(rawPath);
      if (dir) candidates.push(dir);
    }
    if (!candidates.length) candidates.push(rootMount);

    const tried = new Set<string>();
    let downloaded = false;
    let lastErr: any;
    let downloadedRemotePath = "";
    logIt("??????? OpenList");
    for (const dir of candidates) {
      const normDir = normalizeOpenlistPath(dir);
      if (tried.has(normDir)) continue;
      tried.add(normDir);
      try {
        await openlist.list(normDir, true, 1, 0);
      } catch {
        // ignore refresh errors
      }
      const remotePath = normalizeOpenlistPath(`${normDir}/${exportFileName}`);
      try {
        await openlist.download(remotePath, treeFile);
        downloaded = true;
        downloadedRemotePath = remotePath;
        break;
      } catch (err: any) {
        lastErr = err;
      }
    }
    if (!downloaded) {
      throw new Error(lastErr?.message || "OpenList ???????");
    }
    logIt("???????? OpenList ??");

    const cleanupCandidates = [
      downloadedRemotePath,
      ...candidates.map((dir) => normalizeOpenlistPath(`${dir}/${exportFileName}`)),
    ].filter(Boolean);
    await cleanupExportTreeArtifact({
      client,
      openlist,
      exportFileId: exportFileId || undefined,
      exportFileName,
      remotePaths: cleanupCandidates,
      logIt,
    });

    const rootOverride =
      resolvedSources.length === 1
        ? (() => {
            const item = resolvedSources[0];
            let base = normalizeOpenlistPath(item.raw);
            if (!item.is_dir) {
              base = normalizeOpenlistPath(pathPosix.dirname(base));
            }
            const rootName = readTreeRootName(treeFile);
            if (rootName) {
              const parent = normalizeOpenlistPath(pathPosix.dirname(base));
              const rootNorm = normalizeLooseName(rootName);
              if (parent && normalizeLooseName(basenameFromPath(parent)) === rootNorm) {
                return parent;
              }
            }
            return base;
          })()
        : "";
    if (rootOverride) {
      logIt(`?????????${rootOverride}`);
    }

    logIt("???????????????");
    clearTree();
    const parsed = parse115ExportTreeFile(treeFile, rootPrefix, rootOverride, [exportFileName]) as any;
    if (parsed.nodes.length) {
      insertTreeNodes(parsed.nodes);
    }
    const importedAt = new Date().toISOString();
    setTreeMeta({
      file_path: treeFile,
      root_prefix: rootPrefix,
      total_files: parsed.totalFiles,
      total_dirs: parsed.totalDirs,
      imported_at: importedAt,
    });
    latestRefreshFingerprint = fingerprint;
    latestRefreshAt = Date.now();
    const skippedSuffix = parsed.skippedFiles ? `????????? ${parsed.skippedFiles} ?` : "";
    logIt(`?????????? ${parsed.totalFiles}??? ${parsed.totalDirs}${skippedSuffix}`);
  } finally {
    treeRefreshBusy = false;
    release();
  }
}
