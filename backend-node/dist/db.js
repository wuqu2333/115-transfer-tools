"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = void 0;
exports.getSettings = getSettings;
exports.updateSettings = updateSettings;
exports.insertTask = insertTask;
exports.updateTask = updateTask;
exports.getTask = getTask;
exports.listTasks = listTasks;
exports.pendingTask = pendingTask;
exports.appendLog = appendLog;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const path_1 = require("path");
const fs_1 = require("fs");
const DEFAULT_DB = (0, path_1.join)(process.cwd(), '..', 'data', 'transfer.db');
function ensureDir(path) {
    if (!(0, fs_1.existsSync)(path)) {
        (0, fs_1.mkdirSync)(path, { recursive: true });
    }
}
const dbPath = process.env.SQLITE_PATH || DEFAULT_DB;
ensureDir((0, path_1.join)(dbPath, '..'));
exports.db = new better_sqlite3_1.default(dbPath);
// init tables
const initSQL = `
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY,
  openlist_base_url TEXT,
  openlist_token TEXT,
  openlist_password TEXT,
  source_115_root_path TEXT,
  sharepoint_target_path TEXT,
  mobile_target_openlist_path TEXT,
  download_base_path TEXT,
  mobile_parent_file_id TEXT,
  mobile_authorization TEXT,
  mobile_uni TEXT,
  mobile_cloud_host TEXT,
  mobile_fake_extension TEXT,
  mobile_client_info TEXT,
  mobile_app_channel TEXT,
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
`;
exports.db.exec(initSQL);
const nowISO = () => new Date().toISOString();
const defaultSettings = {
    openlist_base_url: '',
    openlist_token: '',
    openlist_password: '',
    source_115_root_path: '/',
    sharepoint_target_path: '/',
    mobile_target_openlist_path: '/',
    download_base_path: '',
    mobile_parent_file_id: '',
    mobile_authorization: '',
    mobile_uni: '',
    mobile_cloud_host: 'https://personal-kd-njs.yun.139.com/hcy',
    mobile_fake_extension: '.jpg',
    mobile_client_info: '1|127.0.0.1|1|12.5.3|nubia|NX729J|E78EFE74714DADB70377C93EEDFDA909|02-00-00-00-00-00|android 14|1116X2480|zh||||021|0|',
    mobile_app_channel: '10000023',
    clean_local_after_transfer: 1 === 1,
    created_at: nowISO(),
    updated_at: nowISO(),
};
function getSettings() {
    const row = exports.db.prepare('SELECT * FROM app_settings WHERE id=1').get();
    if (!row) {
        exports.db.prepare(`INSERT INTO app_settings (
      id, openlist_base_url, openlist_token, openlist_password,
      source_115_root_path, sharepoint_target_path, mobile_target_openlist_path,
      download_base_path, mobile_parent_file_id, mobile_authorization, mobile_uni,
      mobile_cloud_host, mobile_fake_extension, mobile_client_info, mobile_app_channel,
      clean_local_after_transfer, created_at, updated_at
    ) VALUES (
      1, @openlist_base_url, @openlist_token, @openlist_password,
      @source_115_root_path, @sharepoint_target_path, @mobile_target_openlist_path,
      @download_base_path, @mobile_parent_file_id, @mobile_authorization, @mobile_uni,
      @mobile_cloud_host, @mobile_fake_extension, @mobile_client_info, @mobile_app_channel,
      @clean_local_after_transfer, @created_at, @updated_at
    )`).run(defaultSettings);
        return defaultSettings;
    }
    return {
        ...row,
        clean_local_after_transfer: !!row.clean_local_after_transfer,
    };
}
function updateSettings(payload) {
    const existing = getSettings();
    const merged = { ...existing, ...payload, updated_at: nowISO() };
    exports.db.prepare(`UPDATE app_settings SET
    openlist_base_url=@openlist_base_url,
    openlist_token=@openlist_token,
    openlist_password=@openlist_password,
    source_115_root_path=@source_115_root_path,
    sharepoint_target_path=@sharepoint_target_path,
    mobile_target_openlist_path=@mobile_target_openlist_path,
    download_base_path=@download_base_path,
    mobile_parent_file_id=@mobile_parent_file_id,
    mobile_authorization=@mobile_authorization,
    mobile_uni=@mobile_uni,
    mobile_cloud_host=@mobile_cloud_host,
    mobile_fake_extension=@mobile_fake_extension,
    mobile_client_info=@mobile_client_info,
    mobile_app_channel=@mobile_app_channel,
    clean_local_after_transfer=@clean_local_after_transfer,
    updated_at=@updated_at
    WHERE id=1
  `).run(merged);
    return merged;
}
function insertTask(task) {
    const stmt = exports.db.prepare(`INSERT INTO transfer_tasks (
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
function updateTask(id, patch) {
    const sets = Object.keys(patch).map((k) => `${k}=@${k}`).join(', ');
    exports.db.prepare(`UPDATE transfer_tasks SET ${sets} WHERE id=@id`).run({ id, ...patch });
}
function getTask(id) {
    const row = exports.db.prepare('SELECT * FROM transfer_tasks WHERE id=?').get(id);
    if (!row)
        return undefined;
    return { ...row, clean_local_after_transfer: !!row.clean_local_after_transfer };
}
function listTasks(limit = 100) {
    return exports.db.prepare('SELECT * FROM transfer_tasks ORDER BY id DESC LIMIT ?').all(limit);
}
function pendingTask() {
    const row = exports.db
        .prepare("SELECT * FROM transfer_tasks WHERE status='pending' ORDER BY id ASC LIMIT 1")
        .get();
    return row;
}
function appendLog(id, message) {
    const task = getTask(id);
    if (!task)
        return;
    const logs = JSON.parse(task.logs_json || '[]');
    const ts = new Date().toISOString().replace('T', ' ').replace('Z', '');
    logs.push(`[${ts}] ${message}`);
    const trimmed = logs.slice(-400);
    updateTask(id, { logs_json: JSON.stringify(trimmed), message, updated_at: nowISO() });
}
