import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { Settings, TaskRow } from './models';
import { logger } from './logger';

const DEFAULT_DB = join(process.cwd(), '..', 'data', 'transfer.db');

// Normalize OpenList-style remote paths: leading '/', collapse '//', no trailing '/'
function normalizeRemotePath(p: string): string {
  if (!p) return '/';
  let s = String(p).trim();
  if (!s) return '/';
  s = s.replace(/\\/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/+/g, '/');
  if (s.length > 1 && s.endsWith('/')) s = s.replace(/\/+$/, '');
  return s || '/';
}

function ensureDir(path: string) {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function coerceString(value: any): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value === 'object') {
    if (Object.prototype.hasOwnProperty.call(value, 'path')) {
      const v = (value as any).path;
      return v === undefined || v === null ? '' : String(v);
    }
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function sanitizeSettingsPayload(payload: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = {};
  const stringFields: (keyof Settings)[] = [
    'openlist_base_url',
    'openlist_token',
    'openlist_password',
    'openlist_username',
    'openlist_login_password',
    'source_115_cookie',
    'source_115_root_path',
    'sharepoint_target_path',
    'sharepoint_tenant_id',
    'sharepoint_client_id',
    'sharepoint_client_secret',
    'sharepoint_drive_id',
    'sharepoint_site_id',
    'sharepoint_access_token',
    'mobile_target_openlist_path',
    'download_base_path',
    'min_free_gb',
    'mobile_parent_file_id',
    'mobile_authorization',
    'mobile_uni',
    'mobile_cloud_host',
    'mobile_fake_extension',
    'mobile_client_info',
    'mobile_app_channel',
    'tree_file_path',
    'tree_root_prefix',
  ];
  for (const key of stringFields) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      (out as any)[key] = coerceString((payload as any)[key]);
    }
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'clean_local_after_transfer')) {
    out.clean_local_after_transfer = !!(payload as any).clean_local_after_transfer;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'min_free_gb')) {
    const num = Number((payload as any).min_free_gb);
    out.min_free_gb = Number.isFinite(num) ? num : (payload as any).min_free_gb;
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'tree_enabled')) {
    (out as any).tree_enabled = !!(payload as any).tree_enabled;
  }
  return out;
}

const dbPath = process.env.SQLITE_PATH || DEFAULT_DB;
ensureDir(join(dbPath, '..'));
export const db = new Database(dbPath);

// init tables
const initSQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY,
  openlist_base_url TEXT,
  openlist_token TEXT,
  openlist_password TEXT,
  openlist_username TEXT,
  openlist_login_password TEXT,
  source_115_cookie TEXT,
  source_115_root_path TEXT,
  sharepoint_target_path TEXT,
  sharepoint_tenant_id TEXT,
  sharepoint_client_id TEXT,
  sharepoint_client_secret TEXT,
  sharepoint_drive_id TEXT,
  sharepoint_site_id TEXT,
  sharepoint_access_token TEXT,
  mobile_target_openlist_path TEXT,
  download_base_path TEXT,
  min_free_gb REAL,
  mobile_parent_file_id TEXT,
  mobile_authorization TEXT,
  mobile_uni TEXT,
  mobile_cloud_host TEXT,
  mobile_fake_extension TEXT,
  mobile_client_info TEXT,
  mobile_app_channel TEXT,
  tree_enabled INTEGER,
  tree_file_path TEXT,
  tree_root_prefix TEXT,
  clean_local_after_transfer INTEGER,
  created_at TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS transfer_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT,
  status TEXT,
  source_paths_json TEXT,
  source_base_path TEXT,
  target_path TEXT,
  local_download_path TEXT,
  total_files INTEGER DEFAULT 0,
  processed_files INTEGER DEFAULT 0,
  total_bytes INTEGER DEFAULT 0,
  processed_bytes INTEGER DEFAULT 0,
  current_item TEXT DEFAULT '',
  message TEXT DEFAULT '',
  error_message TEXT DEFAULT '',
  logs_json TEXT DEFAULT '[]',
  created_at TEXT,
  updated_at TEXT,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS ui_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT
);
CREATE TABLE IF NOT EXISTS tree_nodes (
  path TEXT PRIMARY KEY,
  is_dir INTEGER DEFAULT 0,
  size INTEGER DEFAULT 0,
  sha256 TEXT
);
CREATE TABLE IF NOT EXISTS tree_meta (
  id INTEGER PRIMARY KEY,
  file_path TEXT,
  root_prefix TEXT,
  total_files INTEGER DEFAULT 0,
  total_dirs INTEGER DEFAULT 0,
  imported_at TEXT
);
`;
db.exec(initSQL);

// migrate columns if needed
const ensureColumn = (table: string, name: string, type: string) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (cols.some((c) => c.name === name)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
};
ensureColumn("app_settings", "tree_enabled", "INTEGER");
ensureColumn("app_settings", "tree_file_path", "TEXT");
ensureColumn("app_settings", "tree_root_prefix", "TEXT");
ensureColumn("app_settings", "source_115_cookie", "TEXT");
ensureColumn("app_settings", "openlist_username", "TEXT");
ensureColumn("app_settings", "openlist_login_password", "TEXT");
ensureColumn("app_settings", "sharepoint_tenant_id", "TEXT");
ensureColumn("app_settings", "sharepoint_client_id", "TEXT");
ensureColumn("app_settings", "sharepoint_client_secret", "TEXT");
ensureColumn("app_settings", "sharepoint_drive_id", "TEXT");
ensureColumn("app_settings", "sharepoint_site_id", "TEXT");
ensureColumn("app_settings", "sharepoint_access_token", "TEXT");
ensureColumn("app_settings", "min_free_gb", "REAL");

const nowISO = () => new Date().toISOString();

const defaultSettings: Settings = {
  openlist_base_url: '',
  openlist_token: '',
  openlist_password: '',
  openlist_username: '',
  openlist_login_password: '',
  source_115_cookie: '',
  source_115_root_path: '/',
  sharepoint_target_path: '/',
  sharepoint_tenant_id: '',
  sharepoint_client_id: '',
  sharepoint_client_secret: '',
  sharepoint_drive_id: '',
  sharepoint_site_id: '',
  sharepoint_access_token: '',
  mobile_target_openlist_path: '/',
  download_base_path: '',
  min_free_gb: 50,
  mobile_parent_file_id: '',
  mobile_authorization: '',
  mobile_uni: '',
  mobile_cloud_host: 'https://personal-kd-njs.yun.139.com/hcy',
  mobile_fake_extension: '.jpg',
  mobile_client_info:
    '1|127.0.0.1|1|12.5.3|nubia|NX729J|E78EFE74714DADB70377C93EEDFDA909|02-00-00-00-00-00|android 14|1116X2480|zh||||021|0|',
  mobile_app_channel: '10000023',
  tree_enabled: false,
  tree_file_path: '',
  tree_root_prefix: '/115',
  clean_local_after_transfer: 1 === 1,
  created_at: nowISO(),
  updated_at: nowISO(),
};

export function getSettings(): Settings {
  const row = db.prepare('SELECT * FROM app_settings WHERE id=1').get();
  if (!row) {
    const dbDefaults = {
      ...defaultSettings,
      clean_local_after_transfer: defaultSettings.clean_local_after_transfer ? 1 : 0,
      tree_enabled: defaultSettings.tree_enabled ? 1 : 0,
    };
    db.prepare(`INSERT INTO app_settings (
      id, openlist_base_url, openlist_token, openlist_password,
      openlist_username, openlist_login_password,
      source_115_cookie, source_115_root_path, sharepoint_target_path,
      sharepoint_tenant_id, sharepoint_client_id, sharepoint_client_secret, sharepoint_drive_id, sharepoint_site_id, sharepoint_access_token,
      mobile_target_openlist_path,
      download_base_path, min_free_gb, mobile_parent_file_id, mobile_authorization, mobile_uni,
      mobile_cloud_host, mobile_fake_extension, mobile_client_info, mobile_app_channel,
      tree_enabled, tree_file_path, tree_root_prefix,
      clean_local_after_transfer, created_at, updated_at
    ) VALUES (
      1, @openlist_base_url, @openlist_token, @openlist_password,
      @openlist_username, @openlist_login_password,
      @source_115_cookie, @source_115_root_path, @sharepoint_target_path,
      @sharepoint_tenant_id, @sharepoint_client_id, @sharepoint_client_secret, @sharepoint_drive_id, @sharepoint_site_id, @sharepoint_access_token,
      @mobile_target_openlist_path,
      @download_base_path, @min_free_gb, @mobile_parent_file_id, @mobile_authorization, @mobile_uni,
      @mobile_cloud_host, @mobile_fake_extension, @mobile_client_info, @mobile_app_channel,
      @tree_enabled, @tree_file_path, @tree_root_prefix,
      @clean_local_after_transfer, @created_at, @updated_at
    )`).run(dbDefaults);
    return defaultSettings;
  }
  return {
    ...row,
    openlist_username: coerceString((row as any).openlist_username || ''),
    openlist_login_password: coerceString((row as any).openlist_login_password || ''),
    source_115_cookie: coerceString((row as any).source_115_cookie || ''),
    source_115_root_path: normalizeRemotePath(row.source_115_root_path),
    sharepoint_target_path: normalizeRemotePath(row.sharepoint_target_path),
    sharepoint_tenant_id: coerceString((row as any).sharepoint_tenant_id || ''),
    sharepoint_client_id: coerceString((row as any).sharepoint_client_id || ''),
    sharepoint_client_secret: coerceString((row as any).sharepoint_client_secret || ''),
    sharepoint_drive_id: coerceString((row as any).sharepoint_drive_id || ''),
    sharepoint_site_id: coerceString((row as any).sharepoint_site_id || ''),
    sharepoint_access_token: coerceString((row as any).sharepoint_access_token || ''),
    mobile_target_openlist_path: normalizeRemotePath(row.mobile_target_openlist_path),
    min_free_gb: Number((row as any).min_free_gb ?? 50),
    tree_root_prefix: normalizeRemotePath(row.tree_root_prefix || '/'),
    tree_file_path: coerceString(row.tree_file_path || ''),
    tree_enabled: !!row.tree_enabled,
    clean_local_after_transfer: !!row.clean_local_after_transfer,
  } as Settings;
}

export function updateSettings(payload: Partial<Settings>): Settings {
  const existing = getSettings();
  const sanitized = sanitizeSettingsPayload(payload);
  const merged: Settings = {
    ...existing,
    ...sanitized,
    source_115_root_path: normalizeRemotePath(sanitized.source_115_root_path ?? existing.source_115_root_path),
    openlist_username: coerceString(sanitized.openlist_username ?? (existing as any).openlist_username),
    openlist_login_password: coerceString(
      sanitized.openlist_login_password ?? (existing as any).openlist_login_password,
    ),
    source_115_cookie: coerceString(sanitized.source_115_cookie ?? (existing as any).source_115_cookie),
    sharepoint_target_path: normalizeRemotePath(sanitized.sharepoint_target_path ?? existing.sharepoint_target_path),
    sharepoint_tenant_id: coerceString(sanitized.sharepoint_tenant_id ?? (existing as any).sharepoint_tenant_id),
    sharepoint_client_id: coerceString(sanitized.sharepoint_client_id ?? (existing as any).sharepoint_client_id),
    sharepoint_client_secret: coerceString(
      sanitized.sharepoint_client_secret ?? (existing as any).sharepoint_client_secret,
    ),
    sharepoint_drive_id: coerceString(sanitized.sharepoint_drive_id ?? (existing as any).sharepoint_drive_id),
    sharepoint_site_id: coerceString(sanitized.sharepoint_site_id ?? (existing as any).sharepoint_site_id),
    sharepoint_access_token: coerceString(
      sanitized.sharepoint_access_token ?? (existing as any).sharepoint_access_token,
    ),
    mobile_target_openlist_path: normalizeRemotePath(
      sanitized.mobile_target_openlist_path ?? existing.mobile_target_openlist_path,
    ),
    min_free_gb: Number(
      sanitized.min_free_gb ??
        (existing as any).min_free_gb ??
        50,
    ),
    tree_root_prefix: normalizeRemotePath(sanitized.tree_root_prefix ?? existing.tree_root_prefix),
    tree_file_path: coerceString(sanitized.tree_file_path ?? existing.tree_file_path),
    tree_enabled:
      typeof sanitized.tree_enabled === 'boolean' ? sanitized.tree_enabled : existing.tree_enabled,
    updated_at: nowISO(),
  };
  const dbPayload = {
    openlist_base_url: coerceString(merged.openlist_base_url),
    openlist_token: coerceString(merged.openlist_token),
    openlist_password: coerceString(merged.openlist_password),
    source_115_root_path: coerceString(merged.source_115_root_path),
    openlist_username: coerceString((merged as any).openlist_username),
    openlist_login_password: coerceString((merged as any).openlist_login_password),
    source_115_cookie: coerceString((merged as any).source_115_cookie),
    sharepoint_target_path: coerceString(merged.sharepoint_target_path),
    sharepoint_tenant_id: coerceString((merged as any).sharepoint_tenant_id),
    sharepoint_client_id: coerceString((merged as any).sharepoint_client_id),
    sharepoint_client_secret: coerceString((merged as any).sharepoint_client_secret),
    sharepoint_drive_id: coerceString((merged as any).sharepoint_drive_id),
    sharepoint_site_id: coerceString((merged as any).sharepoint_site_id),
    sharepoint_access_token: coerceString((merged as any).sharepoint_access_token),
    mobile_target_openlist_path: coerceString(merged.mobile_target_openlist_path),
    download_base_path: coerceString(merged.download_base_path),
    min_free_gb: Number((merged as any).min_free_gb ?? 50),
    mobile_parent_file_id: coerceString(merged.mobile_parent_file_id),
    mobile_authorization: coerceString(merged.mobile_authorization),
    mobile_uni: coerceString(merged.mobile_uni),
    mobile_cloud_host: coerceString(merged.mobile_cloud_host),
    mobile_fake_extension: coerceString(merged.mobile_fake_extension),
    mobile_client_info: coerceString(merged.mobile_client_info),
    mobile_app_channel: coerceString(merged.mobile_app_channel),
    tree_enabled: merged.tree_enabled ? 1 : 0,
    tree_file_path: coerceString(merged.tree_file_path),
    tree_root_prefix: coerceString(merged.tree_root_prefix),
    clean_local_after_transfer: merged.clean_local_after_transfer ? 1 : 0,
    updated_at: coerceString(merged.updated_at),
  };
  db.prepare(`UPDATE app_settings SET
    openlist_base_url=@openlist_base_url,
    openlist_token=@openlist_token,
    openlist_password=@openlist_password,
    openlist_username=@openlist_username,
    openlist_login_password=@openlist_login_password,
    source_115_cookie=@source_115_cookie,
    source_115_root_path=@source_115_root_path,
    sharepoint_target_path=@sharepoint_target_path,
    sharepoint_tenant_id=@sharepoint_tenant_id,
    sharepoint_client_id=@sharepoint_client_id,
    sharepoint_client_secret=@sharepoint_client_secret,
    sharepoint_drive_id=@sharepoint_drive_id,
    sharepoint_site_id=@sharepoint_site_id,
    sharepoint_access_token=@sharepoint_access_token,
    mobile_target_openlist_path=@mobile_target_openlist_path,
    download_base_path=@download_base_path,
    min_free_gb=@min_free_gb,
    mobile_parent_file_id=@mobile_parent_file_id,
    mobile_authorization=@mobile_authorization,
    mobile_uni=@mobile_uni,
    mobile_cloud_host=@mobile_cloud_host,
    mobile_fake_extension=@mobile_fake_extension,
    mobile_client_info=@mobile_client_info,
    mobile_app_channel=@mobile_app_channel,
    tree_enabled=@tree_enabled,
    tree_file_path=@tree_file_path,
    tree_root_prefix=@tree_root_prefix,
    clean_local_after_transfer=@clean_local_after_transfer,
    updated_at=@updated_at
    WHERE id=1
  `).run(dbPayload);
  return merged;
}

export function insertTask(task: Omit<TaskRow, 'id'>): number {
  const stmt = db.prepare(`INSERT INTO transfer_tasks (
    provider, status, source_paths_json, source_base_path, target_path, local_download_path,
    total_files, processed_files, total_bytes, processed_bytes, current_item, message,
    error_message, logs_json, created_at, updated_at, started_at, finished_at
  ) VALUES (
    @provider, @status, @source_paths_json, @source_base_path, @target_path, @local_download_path,
    @total_files, @processed_files, @total_bytes, @processed_bytes, @current_item, @message,
    @error_message, @logs_json, @created_at, @updated_at, @started_at, @finished_at
  )`);
  const info = stmt.run(task);
  return Number(info.lastInsertRowid);
}

export function updateTask(id: number, patch: Partial<TaskRow>) {
  const sets = Object.keys(patch).map((k) => `${k}=@${k}`).join(', ');
  db.prepare(`UPDATE transfer_tasks SET ${sets} WHERE id=@id`).run({ id, ...patch });
}

export function getTask(id: number): TaskRow | undefined {
  const row = db.prepare('SELECT * FROM transfer_tasks WHERE id=?').get(id);
  if (!row) return undefined;
  return { ...row, clean_local_after_transfer: !!row.clean_local_after_transfer } as any;
}

export function listTasks(limit = 100): TaskRow[] {
  return db.prepare('SELECT * FROM transfer_tasks ORDER BY id DESC LIMIT ?').all(limit) as TaskRow[];
}

export function resetRunningTasks(): number[] {
  const rows = db.prepare("SELECT id FROM transfer_tasks WHERE status='running'").all() as any[];
  if (!rows.length) return [];
  db.prepare("UPDATE transfer_tasks SET status='pending', updated_at=@updated_at WHERE status='running'").run({
    updated_at: nowISO(),
  });
  return rows.map((r) => Number(r.id)).filter((n) => Number.isFinite(n));
}

export function pendingTask(): TaskRow | undefined {
  const row = db
    .prepare("SELECT * FROM transfer_tasks WHERE status='pending' ORDER BY id ASC LIMIT 1")
    .get();
  return row as TaskRow | undefined;
}

export function hasRunningTask(): boolean {
  const row = db.prepare("SELECT id FROM transfer_tasks WHERE status='running' LIMIT 1").get();
  return !!row;
}

export function deleteTask(id: number) {
  db.prepare('DELETE FROM transfer_tasks WHERE id=?').run(id);
}

export function appendLog(id: number, message: string) {
  const task = getTask(id);
  if (!task) return;
  const logs: string[] = JSON.parse(task.logs_json || '[]');
  const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
  logs.push(`[${ts}] ${message}`);
  const trimmed = logs.slice(-400);
  updateTask(id, { logs_json: JSON.stringify(trimmed), message, updated_at: nowISO() } as any);
}

export function getUiState(key: string): string | null {
  const row = db.prepare('SELECT value FROM ui_state WHERE key=?').get(key);
  return row ? String((row as any).value ?? '') : null;
}

export function setUiState(key: string, value: string) {
  const now = nowISO();
  db.prepare(
    `INSERT INTO ui_state (key, value, updated_at) VALUES (@key, @value, @updated_at)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
  ).run({ key, value, updated_at: now });
}

export interface TreeMeta {
  file_path: string;
  root_prefix: string;
  total_files: number;
  total_dirs: number;
  imported_at: string;
}

export function getTreeMeta(): TreeMeta | null {
  const row = db.prepare("SELECT * FROM tree_meta WHERE id=1").get() as any;
  if (!row) return null;
  return {
    file_path: coerceString(row.file_path || ""),
    root_prefix: normalizeRemotePath(row.root_prefix || "/"),
    total_files: Number(row.total_files || 0),
    total_dirs: Number(row.total_dirs || 0),
    imported_at: coerceString(row.imported_at || ""),
  };
}

export function setTreeMeta(meta: Partial<TreeMeta>) {
  const existing = getTreeMeta();
  const merged = {
    file_path: meta.file_path ?? existing?.file_path ?? "",
    root_prefix: meta.root_prefix ?? existing?.root_prefix ?? "/",
    total_files: Number(meta.total_files ?? existing?.total_files ?? 0),
    total_dirs: Number(meta.total_dirs ?? existing?.total_dirs ?? 0),
    imported_at: meta.imported_at ?? existing?.imported_at ?? "",
  };
  db.prepare(
    `INSERT INTO tree_meta (id, file_path, root_prefix, total_files, total_dirs, imported_at)
     VALUES (1, @file_path, @root_prefix, @total_files, @total_dirs, @imported_at)
     ON CONFLICT(id) DO UPDATE SET
       file_path=excluded.file_path,
       root_prefix=excluded.root_prefix,
       total_files=excluded.total_files,
       total_dirs=excluded.total_dirs,
       imported_at=excluded.imported_at`,
  ).run(merged);
}

export function clearTree() {
  db.prepare("DELETE FROM tree_nodes").run();
  db.prepare("DELETE FROM tree_meta").run();
}

export function insertTreeNodes(nodes: Array<{ path: string; is_dir: number; size: number; sha256?: string }>) {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO tree_nodes (path, is_dir, size, sha256) VALUES (@path, @is_dir, @size, @sha256)",
  );
  const tx = db.transaction((items: typeof nodes) => {
    for (const it of items) {
      stmt.run({
        path: it.path,
        is_dir: it.is_dir ? 1 : 0,
        size: Number(it.size || 0),
        sha256: it.sha256 || "",
      });
    }
  });
  tx(nodes);
}

export function getTreeNode(path: string) {
  return db.prepare("SELECT path, is_dir, size, sha256 FROM tree_nodes WHERE path=?").get(path) as
    | { path: string; is_dir: number; size: number; sha256?: string }
    | undefined;
}

export function listTreeFiles(prefix: string) {
  const like = prefix === "/" ? "/%" : `${prefix}/%`;
  return db
    .prepare("SELECT path, size, sha256 FROM tree_nodes WHERE is_dir=0 AND path LIKE ? ORDER BY path")
    .all(like) as Array<{ path: string; size: number; sha256?: string }>;
}

export function listTreeChildren(prefix: string) {
  const like = prefix === "/" ? "/%" : `${prefix}/%`;
  return db
    .prepare("SELECT path, is_dir, size FROM tree_nodes WHERE path LIKE ? ORDER BY path")
    .all(like) as Array<{ path: string; is_dir: number; size: number }>;
}

export function listTreeDirectChildren(prefix: string) {
  const norm = normalizeRemotePath(prefix || "/");
  if (norm === "/") {
    return db
      .prepare(
        "SELECT path, is_dir, size FROM tree_nodes WHERE path LIKE '/%' AND instr(substr(path,2), '/')=0 ORDER BY path",
      )
      .all() as Array<{ path: string; is_dir: number; size: number }>;
  }
  const like = `${norm}/%`;
  const offset = norm.length + 2;
  return db
    .prepare(
      "SELECT path, is_dir, size FROM tree_nodes WHERE path LIKE ? AND instr(substr(path, ?), '/')=0 ORDER BY path",
    )
    .all(like, offset) as Array<{ path: string; is_dir: number; size: number }>;
}

export function listTreeBySuffix(suffix: string) {
  const clean = normalizeRemotePath(suffix || "/").replace(/^\/+/, "");
  if (!clean) return [];
  const like = `%/${clean}`;
  return db
    .prepare("SELECT path, is_dir, size FROM tree_nodes WHERE path LIKE ? ORDER BY path")
    .all(like) as Array<{ path: string; is_dir: number; size: number }>;
}
