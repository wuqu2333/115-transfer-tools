<script setup lang="ts">
import { computed, h, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { NButton, NDataTable, NModal, NPopconfirm, NTag, useMessage, type DataTableColumns } from "naive-ui";
import { request } from "../api/request";

type StatusTone = "success" | "error" | "info" | "warning" | "default";
type TransferStage = "download" | "upload";

interface TaskApiRow {
  id: number;
  provider: string;
  status: string;
  current_item: string;
  message: string;
  created_at: string;
  updated_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  total_files?: number;
  processed_files?: number;
  total_bytes?: number;
  processed_bytes?: number;
  error_message?: string;
  logs?: string[];
}

interface TransferPulse {
  stage: TransferStage;
  path: string;
  fileName: string;
  percent: number | null;
  summary: string;
  raw: string;
  loadedBytes: number | null;
  totalBytes: number | null;
  timestampMs: number | null;
  speedText: string;
  etaText: string;
}

interface TaskRow extends TaskApiRow {
  logs: string[];
  providerLabel: string;
  statusTone: StatusTone;
  statusLabel: string;
  progressText: string;
  filePercent: number;
  bytePercent: number;
  primaryPercent: number;
  currentDisplay: string;
  headline: string;
  createdText: string;
  updatedText: string;
  liveDownload: TransferPulse[];
  liveUpload: TransferPulse[];
  signalNotes: string[];
  overallSpeedText: string;
  overallEtaText: string;
}

interface TaskSnapshot {
  processedBytes: number;
  updatedAtMs: number;
  speedText: string;
  etaText: string;
}

const text = {
  eyebrow: "Realtime Transfer Matrix",
  title: "任务记录",
  subtitle: "用实时轨道看清 115 下载、目标端上传、排队和失败原因。",
  refresh: "刷新",
  autoRefresh: "实时刷新",
  liveBoard: "实时监控板",
  liveBoardEmpty: "当前没有运行中的任务。新任务启动后，这里会显示下载轨道、上传轨道和当前文件进度。",
  historyTitle: "历史任务",
  historyHint: "保留批量管理能力，同时把当前任务的传输细节做成可视化面板。",
  logTitle: "实时日志",
  logEmpty: "选择一个任务后，这里会显示完整日志。",
  exportTitle: "导出文件",
  exportEmpty: "当前任务没有可下载的导出文件。",
  exportListFail: "获取导出文件失败",
  needSelect: "请先选择任务",
  batchDone: (ok: number, failed: number) => `批量操作完成：成功 ${ok}，失败 ${failed}`,
  retryOk: (id: number) => `任务 #${id} 已重新排队`,
  stopOk: (id: number) => `任务 #${id} 已终止`,
  removeOk: (id: number) => `任务 #${id} 已删除`,
  lane: {
    download: "下载轨道",
    upload: "上传轨道",
    noDownload: "暂时还没有捕获到下载进度。",
    noUpload: "暂时还没有捕获到上传进度。",
  },
  cards: {
    active: "活跃任务",
    running: "运行中",
    pending: "排队中",
    failed: "失败任务",
    transfer: "总传输量",
  },
  columns: {
    target: "目标平台",
    status: "状态",
    progress: "总进度",
    current: "当前传输",
    message: "消息",
    updated: "更新时间",
    action: "操作",
  },
  action: {
    log: "日志",
    retry: "重试",
    remove: "删除",
    stop: "终止",
    download: "下载",
    batchStop: "批量终止",
    batchRetry: "批量重试",
    batchDelete: "批量删除",
    cancel: "取消",
  },
  focus: {
    overall: "总体进度",
    currentFile: "当前文件",
    downloadFocus: "当前下载",
    uploadFocus: "当前上传",
    events: "最近事件",
  },
};

const message = useMessage();
const dataSource = ref<TaskRow[]>([]);
const loading = ref(false);
const autoRefresh = ref(true);
const streamConnected = ref(false);
const activeLog = ref<string[]>([]);
const activeTaskId = ref<number | null>(null);
const selectedRowKeys = ref<number[]>([]);
const exportModalVisible = ref(false);
const exportFiles = ref<Array<{ index: number; name: string }>>([]);
const exportTaskId = ref<number | null>(null);
const exportLoading = ref(false);

let refreshTimer: number | undefined;
let eventSource: EventSource | null = null;
let loadingTasks = false;
const taskSnapshots = new Map<number, TaskSnapshot>();

function formatBytes(bytes: number | null | undefined) {
  if (!bytes || bytes <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let value = bytes;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)}${units[index]}`;
}

function safePercent(done: number, total: number) {
  if (!total || total <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
}

function stripLogPrefix(line: string) {
  return String(line || "").replace(/^\[[^\]]+\]\s*/, "").trim();
}

function formatDateTime(value?: string | null) {
  if (!value) return "未记录";
  return value.replace("T", " ").replace("Z", "").slice(0, 19);
}

function parseDateTime(value?: string | null) {
  if (!value) return null;
  const normalized = String(value).trim().replace(" ", "T").replace("Z", "");
  const time = new Date(normalized).getTime();
  return Number.isFinite(time) ? time : null;
}

function parseLogTimestamp(line: string) {
  const match = String(line || "").match(/^\[([^\]]+)\]/);
  return parseDateTime(match?.[1] || null);
}

function parseSizeText(value: string) {
  const normalized = String(value || "")
    .trim()
    .replace(/,/g, "")
    .replace(/字节/gi, "B");
  if (!normalized) return null;
  const match = normalized.match(/^([\d.]+)\s*(B|KB|MB|GB|TB|PB)$/i);
  if (!match) return null;
  const amount = Number(match[1] || 0);
  const unit = String(match[2] || "B").toUpperCase();
  if (!Number.isFinite(amount)) return null;
  const powerMap: Record<string, number> = { B: 0, KB: 1, MB: 2, GB: 3, TB: 4, PB: 5 };
  const power = powerMap[unit];
  if (power == null) return null;
  return amount * 1024 ** power;
}

function formatSpeed(bytesPerSecond: number | null) {
  if (!bytesPerSecond || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "速度待计算";
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatEta(seconds: number | null) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return "预计完成待计算";
  const totalSeconds = Math.ceil(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours > 0) return `预计 ${hours}小时${minutes}分`;
  if (minutes > 0) return `预计 ${minutes}分${secs}秒`;
  return `预计 ${secs}秒`;
}

function fileNameFromPath(pathValue: string): string {
  const normalized = String(pathValue || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] || normalized || "未识别文件" : normalized || "未识别文件";
}

function ellipsize(value: string, max = 48) {
  const source = String(value || "").trim();
  if (!source) return "暂无";
  return source.length > max ? `${source.slice(0, max - 1)}…` : source;
}

function tailPath(pathValue: string, segments = 3) {
  const normalized = String(pathValue || "").replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) return normalized || "暂无";
  return `/${parts.slice(Math.max(parts.length - segments, 0)).join("/")}`;
}

function providerLabel(provider: string) {
  const providerMap: Record<string, string> = {
    sharepoint: "世纪互联",
    mobile: "移动云盘",
    rapid_mobile: "移动秒传",
    mobile_export: "移动云盘导出",
  };
  return providerMap[provider] || provider;
}

function statusTone(status: string): StatusTone {
  const toneMap: Record<string, StatusTone> = {
    success: "success",
    failed: "error",
    running: "info",
    pending: "warning",
    stopped: "default",
  };
  return toneMap[status] || "default";
}

function statusLabel(status: string) {
  const labelMap: Record<string, string> = {
    success: "已完成",
    failed: "失败",
    running: "运行中",
    pending: "排队中",
    stopped: "已终止",
  };
  return labelMap[status] || status;
}

function buildProgressText(task: TaskApiRow) {
  const totalFiles = Number(task.total_files || 0);
  const processedFiles = Number(task.processed_files || 0);
  const totalBytes = Number(task.total_bytes || 0);
  const processedBytes = totalBytes > 0 ? Math.min(Number(task.processed_bytes || 0), totalBytes) : Number(task.processed_bytes || 0);

  let summary = totalFiles > 0
    ? `${processedFiles}/${totalFiles}（${safePercent(processedFiles, totalFiles)}%）`
    : `${processedFiles}/-`;

  if (totalBytes > 0) {
    summary += ` · ${formatBytes(processedBytes)}/${formatBytes(totalBytes)}（${safePercent(processedBytes, totalBytes)}%）`;
  }
  return summary;
}

function pulseKey(pulse: TransferPulse) {
  return `${pulse.stage}:${pulse.path || pulse.fileName || pulse.raw}`;
}

function withPulseTelemetry(current: TransferPulse, previous: TransferPulse | null): TransferPulse {
  let speedText = current.percent === 100 ? "已完成" : "速度待计算";
  let etaText = current.percent === 100 ? "已完成" : "预计完成待计算";

  if (current.loadedBytes != null && current.totalBytes != null && current.loadedBytes >= current.totalBytes) {
    etaText = "已完成";
  }

  if (
    previous &&
    current.loadedBytes != null &&
    previous.loadedBytes != null &&
    current.timestampMs != null &&
    previous.timestampMs != null
  ) {
    const deltaBytes = current.loadedBytes - previous.loadedBytes;
    const deltaMs = current.timestampMs - previous.timestampMs;
    if (deltaBytes > 0 && deltaMs > 0) {
      const bytesPerSecond = (deltaBytes / deltaMs) * 1000;
      speedText = formatSpeed(bytesPerSecond);
      if (current.totalBytes != null && current.loadedBytes < current.totalBytes) {
        etaText = formatEta((current.totalBytes - current.loadedBytes) / bytesPerSecond);
      } else {
        etaText = "已完成";
      }
    }
  }

  return {
    ...current,
    speedText,
    etaText,
  };
}

function buildOverallTelemetry(task: TaskApiRow) {
  const processedBytes = Number(task.processed_bytes || 0);
  const totalBytes = Number(task.total_bytes || 0);
  const updatedAtMs = parseDateTime(task.updated_at) ?? Date.now();
  const previous = taskSnapshots.get(task.id);

  let overallSpeedText = "待启动";
  let overallEtaText = "等待调度";

  if (task.status === "success") {
    overallSpeedText = "任务完成";
    overallEtaText = "已完成";
  } else if (task.status === "failed") {
    overallSpeedText = "任务失败";
    overallEtaText = "请看日志";
  } else if (task.status === "stopped") {
    overallSpeedText = "任务已停";
    overallEtaText = "手动终止";
  } else if (task.status === "pending") {
    overallSpeedText = "等待执行";
    overallEtaText = "队列中";
  } else if (task.status === "running") {
    overallSpeedText = previous?.speedText || "速度待计算";
    overallEtaText = previous?.etaText || "预计完成待计算";
    if (previous && updatedAtMs > previous.updatedAtMs && processedBytes >= previous.processedBytes) {
      const deltaBytes = processedBytes - previous.processedBytes;
      const deltaMs = updatedAtMs - previous.updatedAtMs;
      if (deltaBytes > 0 && deltaMs > 0) {
        const bytesPerSecond = (deltaBytes / deltaMs) * 1000;
        overallSpeedText = formatSpeed(bytesPerSecond);
        if (totalBytes > processedBytes) {
          overallEtaText = formatEta((totalBytes - processedBytes) / bytesPerSecond);
        } else if (totalBytes > 0) {
          overallEtaText = "已完成";
        }
      }
    }
  }

  taskSnapshots.set(task.id, {
    processedBytes,
    updatedAtMs,
    speedText: overallSpeedText,
    etaText: overallEtaText,
  });

  return { overallSpeedText, overallEtaText };
}

function parsePulse(line: string): TransferPulse | null {
  const body = stripLogPrefix(line);
  const progressMatch = body.match(/^(下载|上传)进度 \[(\d+)\/(\d+)\] (.+?)[：:]\s*(\d+)%[（(]([^/]+)\/(.+?)[）)]$/);
  if (progressMatch) {
    const stage = progressMatch[1] === "下载" ? "download" : "upload";
    const pathValue: string = progressMatch[4] ? progressMatch[4].trim() : "";
    const loaded = progressMatch[6] ?? "";
    const total = progressMatch[7] ?? "";
    return {
      stage,
      path: pathValue,
      fileName: fileNameFromPath(pathValue),
      percent: Number(progressMatch[5] || 0),
      summary: `${loaded.trim()}/${total.trim()}`,
      raw: line,
      loadedBytes: parseSizeText(loaded),
      totalBytes: parseSizeText(total),
      timestampMs: parseLogTimestamp(line),
      speedText: "速度待计算",
      etaText: Number(progressMatch[5] || 0) >= 100 ? "已完成" : "预计完成待计算",
    };
  }

  const sharepointPrepare = body.match(/^上传到世纪互联[：:]\s*(.+)$/);
  if (sharepointPrepare) {
    const pathValue: string = sharepointPrepare[1] ? sharepointPrepare[1].trim() : "";
    return {
      stage: "upload",
      path: pathValue,
      fileName: fileNameFromPath(pathValue),
      percent: null,
      summary: "等待目标端接收",
      raw: line,
      loadedBytes: null,
      totalBytes: null,
      timestampMs: parseLogTimestamp(line),
      speedText: "等待上传",
      etaText: "等待目标端接收",
    };
  }

  const mobilePrepare = body.match(/^移动上传[：:]\s*(.+)$/);
  if (mobilePrepare) {
    const pathValue: string = mobilePrepare[1] ? mobilePrepare[1].trim() : "";
    return {
      stage: "upload",
      path: pathValue,
      fileName: fileNameFromPath(pathValue),
      percent: null,
      summary: "准备上传",
      raw: line,
      loadedBytes: null,
      totalBytes: null,
      timestampMs: parseLogTimestamp(line),
      speedText: "准备上传",
      etaText: "等待开始",
    };
  }

  return null;
}

function extractPulses(logs: string[], stage: TransferStage, limit: number) {
  const pulses: TransferPulse[] = [];
  const latestIndexByKey = new Map<string, number>();
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const pulse = parsePulse(logs[index] ?? "");
    if (!pulse || pulse.stage !== stage) continue;
    const key = pulseKey(pulse);
    if (latestIndexByKey.has(key)) continue;
    latestIndexByKey.set(key, index);

    let previous: TransferPulse | null = null;
    for (let prevIndex = index - 1; prevIndex >= 0; prevIndex -= 1) {
      const prevPulse = parsePulse(logs[prevIndex] ?? "");
      if (!prevPulse || prevPulse.stage !== stage) continue;
      if (pulseKey(prevPulse) !== key) continue;
      previous = prevPulse;
      break;
    }

    pulses.push(withPulseTelemetry(pulse, previous));
    if (pulses.length >= limit) break;
  }
  return pulses;
}

function extractSignalNotes(logs: string[], limit = 4) {
  const notes: string[] = [];
  const seen = new Set<string>();
  for (let index = logs.length - 1; index >= 0; index -= 1) {
    const textLine = stripLogPrefix(logs[index] ?? "");
    if (!textLine) continue;
    if (/^(下载|上传)进度 /.test(textLine)) continue;
    if (seen.has(textLine)) continue;
    seen.add(textLine);
    notes.push(textLine);
    if (notes.length >= limit) break;
  }
  return notes;
}

function buildHeadline(task: TaskApiRow, downloads: TransferPulse[], uploads: TransferPulse[]) {
  if (task.status === "running") {
    if (downloads.length && uploads.length) return "下载与上传双轨并行中";
    if (downloads.length) return "115 下载通道正在持续拉取文件";
    if (uploads.length) return "目标端正在接收已下载文件";
    return task.message || "任务已启动，等待新的传输轨迹";
  }
  if (task.status === "pending") return "任务已排队，等待调度";
  if (task.status === "success") return "任务已完成，本次传输已收口";
  if (task.status === "failed") return task.error_message || "任务已失败，请查看日志定位原因";
  if (task.status === "stopped") return "任务已终止";
  return task.message || "暂无状态信息";
}

function buildCurrentDisplay(task: TaskApiRow, downloads: TransferPulse[], uploads: TransferPulse[]) {
  const currentDownload = downloads[0];
  const currentUpload = uploads[0];
  if (currentDownload && currentUpload) return `下载 ${ellipsize(currentDownload.fileName, 18)} · 上传 ${ellipsize(currentUpload.fileName, 18)}`;
  if (currentUpload) return `上传 ${ellipsize(currentUpload.fileName, 32)}`;
  if (currentDownload) return `下载 ${ellipsize(currentDownload.fileName, 32)}`;
  if (task.current_item) return ellipsize(fileNameFromPath(String(task.current_item || "")), 32);
  return ellipsize(task.message || "暂无活动文件", 32);
}

function hydrateTask(task: TaskApiRow): TaskRow {
  const logs = Array.isArray(task.logs) ? task.logs : [];
  const liveDownload = extractPulses(logs, "download", 3);
  const liveUpload = extractPulses(logs, "upload", 4);
  const filePercent = safePercent(Number(task.processed_files || 0), Number(task.total_files || 0));
  const totalBytes = Number(task.total_bytes || 0);
  const safeProcessedBytes = totalBytes > 0 ? Math.min(Number(task.processed_bytes || 0), totalBytes) : Number(task.processed_bytes || 0);
  const bytePercent = safePercent(safeProcessedBytes, totalBytes);
  const primaryPercent = bytePercent > 0 ? bytePercent : filePercent;
  const overall = buildOverallTelemetry(task);

  return {
    ...task,
    logs,
    providerLabel: providerLabel(task.provider),
    statusTone: statusTone(task.status),
    statusLabel: statusLabel(task.status),
    progressText: buildProgressText(task),
    filePercent,
    bytePercent,
    primaryPercent,
    currentDisplay: buildCurrentDisplay(task, liveDownload, liveUpload),
    headline: buildHeadline(task, liveDownload, liveUpload),
    createdText: formatDateTime(task.created_at),
    updatedText: formatDateTime(task.updated_at),
    liveDownload,
    liveUpload,
    signalNotes: extractSignalNotes(logs),
    overallSpeedText: overall.overallSpeedText,
    overallEtaText: overall.overallEtaText,
  };
}

const liveTasks = computed(() => dataSource.value.filter((task) => task.status === "running" || task.status === "pending"));
const selectedTask = computed(() => dataSource.value.find((task) => task.id === activeTaskId.value) || null);
const hasSelection = computed(() => selectedRowKeys.value.length > 0);
const dashboardStats = computed(() => {
  const running = dataSource.value.filter((task) => task.status === "running").length;
  const pending = dataSource.value.filter((task) => task.status === "pending").length;
  const failed = dataSource.value.filter((task) => task.status === "failed").length;
  const liveBytes = liveTasks.value.reduce((total, task) => total + Number(task.processed_bytes || 0), 0);
  const liveTotalBytes = liveTasks.value.reduce((total, task) => total + Number(task.total_bytes || 0), 0);
  return [
    { label: text.cards.active, value: `${liveTasks.value.length}`, detail: "正在实时追踪的任务数" },
    { label: text.cards.running, value: `${running}`, detail: "当前有数据流动的任务" },
    { label: text.cards.pending, value: `${pending}`, detail: "等待队列调度启动" },
    { label: text.cards.failed, value: `${failed}`, detail: "需要回看日志和重试的任务" },
    { label: text.cards.transfer, value: liveTotalBytes > 0 ? `${formatBytes(liveBytes)}/${formatBytes(liveTotalBytes)}` : "0B", detail: "活跃任务累计传输量" },
  ];
});

function orbitStyle(percent: number) {
  const clamped = Math.max(0, Math.min(percent, 100));
  const stop = Math.max(clamped, clamped > 0 ? 2 : 0);
  return {
    background: `conic-gradient(from 210deg, rgba(91, 231, 246, 0.96) 0%, rgba(45, 203, 231, 0.88) ${stop}%, rgba(255, 255, 255, 0.08) ${stop}%, rgba(255, 255, 255, 0.08) 100%)`,
  };
}

function laneWidth(pulse: TransferPulse) {
  if (pulse.percent == null) return "14%";
  if (pulse.percent === 0) return "2%";
  return `${Math.max(2, Math.min(100, pulse.percent))}%`;
}

async function loadTasks(silent = false) {
  if (loadingTasks) return;
  loadingTasks = true;
  if (!silent) loading.value = true;
  try {
    const response = (await request.get<any[]>("/api/tasks?limit=120")) as any;
    const list: TaskApiRow[] = Array.isArray(response) ? response : [];
    applyTaskList(list);
  } finally {
    loadingTasks = false;
    if (!silent) loading.value = false;
  }
}

function applyTaskList(list: TaskApiRow[]) {
  const validIds = new Set(list.map((task) => task.id));
  Array.from(taskSnapshots.keys()).forEach((id) => {
    if (!validIds.has(id)) taskSnapshots.delete(id);
  });

  dataSource.value = list.map(hydrateTask);

  if (activeTaskId.value != null) {
    const active = dataSource.value.find((task) => task.id === activeTaskId.value);
    if (active) {
      activeLog.value = active.logs;
    } else {
      activeTaskId.value = null;
      activeLog.value = [];
    }
  }

  if (activeTaskId.value == null && dataSource.value.length) {
    const first = liveTasks.value[0] || dataSource.value[0];
    if (first) {
      activeTaskId.value = first.id;
      activeLog.value = first.logs;
    }
  }
}

async function retryTask(id: number) {
  await request.post(`/api/tasks/${id}/retry`);
  message.success(text.retryOk(id));
  await loadTasks();
}

async function stopTask(id: number) {
  await request.post(`/api/tasks/${id}/stop`);
  message.success(text.stopOk(id));
  await loadTasks();
}

async function deleteTask(id: number) {
  await request.delete(`/api/tasks/${id}`);
  message.success(text.removeOk(id));
  await loadTasks();
  if (activeTaskId.value === id) {
    activeTaskId.value = null;
    activeLog.value = [];
  }
}

function showLog(task: TaskRow) {
  activeTaskId.value = task.id;
  activeLog.value = task.logs;
}

async function batchAction(action: "stop" | "retry" | "delete") {
  if (!selectedRowKeys.value.length) {
    message.warning(text.needSelect);
    return;
  }
  const response: any = await request.post("/api/tasks/batch", { action, ids: selectedRowKeys.value });
  const okCount = Array.isArray(response?.ok) ? response.ok.length : 0;
  const failedCount = Array.isArray(response?.failed) ? response.failed.length : 0;
  message.success(text.batchDone(okCount, failedCount));
  selectedRowKeys.value = [];
  await loadTasks();
}

function updateCheckedRowKeys(keys: Array<string | number>) {
  selectedRowKeys.value = keys as number[];
}

async function downloadExportFile(id: number, index: number, name?: string) {
  const data: any = await request.get(`/api/tasks/${id}/export?index=${index}`, { responseType: "blob" });
  const blob = data instanceof Blob ? data : new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name || `export_task_${id}_${index}.json`;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

async function downloadExport(id: number) {
  exportLoading.value = true;
  try {
    const response: any = await request.get(`/api/tasks/${id}/exports`);
    const files = Array.isArray(response?.files) ? response.files : [];
    if (!files.length) {
      message.warning(text.exportEmpty);
      return;
    }
    if (files.length === 1) {
      await downloadExportFile(id, files[0].index, files[0].name);
      return;
    }
    exportFiles.value = files;
    exportTaskId.value = id;
    exportModalVisible.value = true;
  } catch (error: any) {
    message.error(error?.message || text.exportListFail);
  } finally {
    exportLoading.value = false;
  }
}

function renderProgressCell(row: TaskRow) {
  return h("div", { class: "table-progress" }, [
    h("div", { class: "table-progress__value" }, row.progressText),
    h("div", { class: "table-progress__track" }, [h("div", { class: "table-progress__fill", style: { width: `${row.primaryPercent}%` } })]),
  ]);
}

function renderCurrentCell(row: TaskRow) {
  const download = row.liveDownload[0];
  const upload = row.liveUpload[0];
  const secondary = [download ? `下载 ${download.percent != null ? `${download.percent}%` : download.summary}` : "", upload ? `上传 ${upload.percent != null ? `${upload.percent}%` : upload.summary}` : ""].filter(Boolean).join(" · ");
  return h("div", { class: "table-current" }, [
    h("div", { class: "table-current__primary" }, row.currentDisplay),
    h("div", { class: "table-current__secondary" }, secondary || row.headline),
  ]);
}

const columns: DataTableColumns<TaskRow> = [
  { type: "selection", width: 44 },
  { title: "ID", key: "id", width: 68 },
  { title: text.columns.target, key: "provider", minWidth: 120, render: (row) => row.providerLabel },
  { title: text.columns.status, key: "status", width: 104, render: (row) => h("div", { class: "status-cell" }, [h("span", { class: ["status-dot", `is-${row.status}`] }), h(NTag, { type: row.statusTone, bordered: false, round: true }, { default: () => row.statusLabel })]) },
  { title: text.columns.progress, key: "progress", minWidth: 240, render: (row) => renderProgressCell(row) },
  { title: text.columns.current, key: "current", minWidth: 280, render: (row) => renderCurrentCell(row) },
  { title: text.columns.message, key: "message", minWidth: 220, render: (row) => h("div", { class: "table-message" }, row.message || row.headline) },
  { title: text.columns.updated, key: "updated_at", width: 168, render: (row) => row.updatedText },
  {
    title: text.columns.action,
    key: "action",
    minWidth: 264,
    render: (row) => {
      const actions: any[] = [h(NButton, { size: "small", quaternary: true, onClick: () => showLog(row) }, { default: () => text.action.log })];
      if (row.provider === "mobile_export" && row.status === "success") actions.push(h(NButton, { size: "small", secondary: true, onClick: () => downloadExport(row.id) }, { default: () => text.action.download }));
      if (row.status === "running" || row.status === "pending") actions.push(h(NPopconfirm, { positiveText: text.action.stop, negativeText: text.action.cancel, onPositiveClick: () => stopTask(row.id) }, { trigger: () => h(NButton, { size: "small", type: "error", secondary: true }, { default: () => text.action.stop }) }));
      actions.push(h(NButton, { size: "small", onClick: () => retryTask(row.id) }, { default: () => text.action.retry }));
      actions.push(h(NPopconfirm, { positiveText: text.action.remove, negativeText: text.action.cancel, onPositiveClick: () => deleteTask(row.id) }, { trigger: () => h(NButton, { size: "small", type: "error", tertiary: true }, { default: () => text.action.remove }) }));
      return h("div", { class: "table-actions" }, actions);
    },
  },
];

const rowKey = (row: TaskRow) => row.id;

function startPolling() {
  if (refreshTimer != null) return;
  refreshTimer = window.setInterval(() => void loadTasks(true), 2000);
}

function stopPolling() {
  if (refreshTimer == null) return;
  window.clearInterval(refreshTimer);
  refreshTimer = undefined;
}

function stopTaskStream() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  streamConnected.value = false;
}

function startTaskStream() {
  if (typeof window === "undefined" || !("EventSource" in window)) return false;
  stopTaskStream();
  try {
    eventSource = new EventSource("/api/tasks/stream?limit=120");
    eventSource.onopen = () => {
      streamConnected.value = true;
      stopPolling();
    };
    eventSource.onmessage = (event) => {
      if (!event.data) return;
      try {
        const payload = JSON.parse(event.data);
        const list: TaskApiRow[] = Array.isArray(payload) ? payload : [];
        applyTaskList(list);
      } catch {
        // ignore malformed keep-alive payloads
      }
    };
    eventSource.onerror = () => {
      stopTaskStream();
      if (autoRefresh.value) startPolling();
    };
    return true;
  } catch {
    stopTaskStream();
    return false;
  }
}

function startAutoRefresh() {
  stopPolling();
  stopTaskStream();
  if (!autoRefresh.value) return;
  if (!startTaskStream()) startPolling();
}

function stopAutoRefresh() {
  stopPolling();
  stopTaskStream();
}

watch(autoRefresh, () => startAutoRefresh());
onMounted(async () => {
  await loadTasks();
  startAutoRefresh();
});
onBeforeUnmount(() => stopAutoRefresh());
</script>

<template>
  <div class="page-stack tasks-page">
    <section class="page-card command-panel">
      <div class="command-panel__grid">
        <div class="command-panel__intro">
          <div class="panel-eyebrow">{{ text.eyebrow }}</div>
          <h2 class="panel-title">{{ text.title }}</h2>
          <p class="panel-subtitle">{{ text.subtitle }}</p>
        </div>
        <div class="command-panel__actions">
          <n-button @click="loadTasks()">{{ text.refresh }}</n-button>
          <div class="auto-refresh-chip">
            <span>{{ streamConnected ? "SSE 已连接" : autoRefresh ? "轮询模式" : "手动模式" }}</span>
          </div>
          <div class="auto-refresh-chip">
            <span>{{ text.autoRefresh }}</span>
            <n-switch v-model:value="autoRefresh" />
          </div>
        </div>
      </div>
      <div class="stats-grid">
        <div v-for="item in dashboardStats" :key="item.label" class="stats-card">
          <div class="stats-card__label">{{ item.label }}</div>
          <div class="stats-card__value">{{ item.value }}</div>
          <div class="stats-card__detail">{{ item.detail }}</div>
        </div>
      </div>
    </section>

    <section class="page-card monitor-board">
        <div class="section-head">
          <div>
            <h3 class="section-title">{{ text.liveBoard }}</h3>
            <p class="section-subtitle">运行中的任务会在这里显示下载和上传双轨状态。</p>
          </div>
        <div class="section-tag">{{ streamConnected ? "LIVE" : autoRefresh ? "POLL" : "MANUAL" }} · {{ liveTasks.length }} active</div>
      </div>
      <div v-if="!liveTasks.length" class="monitor-empty"><p>{{ text.liveBoardEmpty }}</p></div>
      <div v-else class="monitor-grid">
        <article v-for="task in liveTasks" :key="task.id" class="monitor-card" :data-status="task.status" @click="showLog(task)">
          <div class="monitor-card__scan"></div>
          <div class="monitor-card__head">
            <div>
              <div class="monitor-meta">
                <span class="monitor-id">TASK #{{ task.id }}</span>
                <span class="monitor-provider">{{ task.providerLabel }}</span>
              </div>
              <h4 class="monitor-title">{{ task.headline }}</h4>
              <p class="monitor-subtitle">{{ task.message || task.currentDisplay }}</p>
            </div>
            <div class="monitor-status">
              <span class="status-dot" :class="`is-${task.status}`"></span>
              <span>{{ task.statusLabel }}</span>
            </div>
          </div>
          <div class="monitor-card__overview">
            <div class="orbit-panel">
              <div class="orbit-ring" :style="orbitStyle(task.primaryPercent)">
                <div class="orbit-ring__core">
                  <span>{{ text.focus.overall }}</span>
                  <strong>{{ task.primaryPercent }}%</strong>
                  <small>{{ task.progressText }}</small>
                </div>
              </div>
            </div>
            <div class="overview-grid">
              <div class="overview-chip"><span>文件进度</span><strong>{{ task.filePercent }}%</strong><small>{{ Number(task.processed_files || 0) }} / {{ Number(task.total_files || 0) || "-" }}</small></div>
              <div class="overview-chip"><span>流量进度</span><strong>{{ task.bytePercent }}%</strong><small>{{ formatBytes(task.processed_bytes) }} / {{ formatBytes(task.total_bytes) }}</small></div>
              <div class="overview-chip"><span>实时速度</span><strong>{{ task.overallSpeedText }}</strong><small>{{ task.overallEtaText }}</small></div>
              <div class="overview-chip"><span>更新时间</span><strong>{{ task.updatedText }}</strong><small>{{ task.createdText }}</small></div>
            </div>
          </div>
          <div class="lane-grid">
            <section class="lane-panel">
              <div class="lane-head"><span class="lane-title">{{ text.lane.download }}</span><span class="lane-count">{{ task.liveDownload.length }}/3</span></div>
              <div v-if="task.liveDownload.length" class="lane-list">
                <div v-for="pulse in task.liveDownload" :key="pulse.raw" class="lane-item">
                  <div class="lane-item__top"><strong>{{ pulse.fileName }}</strong><span>{{ pulse.percent != null ? `${pulse.percent}%` : pulse.summary }}</span></div>
                  <div class="lane-item__path">{{ tailPath(pulse.path, 4) }}</div>
                  <div class="lane-item__track"><div class="lane-item__fill is-download" :style="{ width: laneWidth(pulse) }"></div></div>
                  <div class="lane-item__meta">{{ pulse.summary }} · {{ pulse.speedText }} · {{ pulse.etaText }}</div>
                </div>
              </div>
              <div v-else class="lane-empty">{{ text.lane.noDownload }}</div>
            </section>
            <section class="lane-panel">
              <div class="lane-head"><span class="lane-title">{{ text.lane.upload }}</span><span class="lane-count">{{ task.liveUpload.length }}/4</span></div>
              <div v-if="task.liveUpload.length" class="lane-list">
                <div v-for="pulse in task.liveUpload" :key="pulse.raw" class="lane-item">
                  <div class="lane-item__top"><strong>{{ pulse.fileName }}</strong><span>{{ pulse.percent != null ? `${pulse.percent}%` : pulse.summary }}</span></div>
                  <div class="lane-item__path">{{ tailPath(pulse.path, 4) }}</div>
                  <div class="lane-item__track"><div class="lane-item__fill is-upload" :style="{ width: laneWidth(pulse) }"></div></div>
                  <div class="lane-item__meta">{{ pulse.summary }} · {{ pulse.speedText }} · {{ pulse.etaText }}</div>
                </div>
              </div>
              <div v-else class="lane-empty">{{ text.lane.noUpload }}</div>
            </section>
          </div>
          <div class="monitor-card__foot">
            <div class="monitor-current"><span>{{ text.focus.currentFile }}</span><strong>{{ task.currentDisplay }}</strong></div>
            <div class="card-actions">
              <n-button size="small" quaternary @click.stop="showLog(task)">{{ text.action.log }}</n-button>
              <n-button size="small" @click.stop="retryTask(task.id)">{{ text.action.retry }}</n-button>
              <n-popconfirm v-if="task.status === 'running' || task.status === 'pending'" :positive-text="text.action.stop" :negative-text="text.action.cancel" @positive-click="stopTask(task.id)">
                <template #trigger><n-button size="small" type="error" secondary @click.stop>{{ text.action.stop }}</n-button></template>
              </n-popconfirm>
            </div>
          </div>
        </article>
      </div>
    </section>

    <div class="detail-grid">
      <section class="page-card history-card">
        <div class="section-head"><div><h3 class="section-title">{{ text.historyTitle }}</h3><p class="section-subtitle">{{ text.historyHint }}</p></div></div>
        <div class="batch-actions">
          <n-button :disabled="!hasSelection" @click="batchAction('stop')">{{ text.action.batchStop }}</n-button>
          <n-button :disabled="!hasSelection" @click="batchAction('retry')">{{ text.action.batchRetry }}</n-button>
          <n-popconfirm :positive-text="text.action.batchDelete" :negative-text="text.action.cancel" @positive-click="batchAction('delete')"><template #trigger><n-button :disabled="!hasSelection" type="error">{{ text.action.batchDelete }}</n-button></template></n-popconfirm>
        </div>
        <n-data-table :columns="columns" :data="dataSource" :loading="loading" :pagination="{ pageSize: 12 }" :row-key="rowKey" :checked-row-keys="selectedRowKeys" :scroll-x="1280" size="small" @update:checked-row-keys="updateCheckedRowKeys" />
      </section>

      <section class="page-card logs-card">
        <div class="section-head"><div><h3 class="section-title">{{ text.logTitle }}</h3><p class="section-subtitle">{{ selectedTask ? `任务 #${selectedTask.id} · ${selectedTask.providerLabel}` : text.logEmpty }}</p></div></div>
        <template v-if="selectedTask">
          <div class="focus-grid">
            <div class="focus-card"><span>{{ text.focus.downloadFocus }}</span><strong>{{ selectedTask.liveDownload[0]?.fileName || "暂无下载" }}</strong><small>{{ selectedTask.liveDownload[0] ? `${selectedTask.liveDownload[0]?.percent ?? "-"}% · ${selectedTask.liveDownload[0]?.speedText}` : "当前没有下载轨道" }}</small></div>
            <div class="focus-card"><span>{{ text.focus.uploadFocus }}</span><strong>{{ selectedTask.liveUpload[0]?.fileName || "暂无上传" }}</strong><small>{{ selectedTask.liveUpload[0] ? `${selectedTask.liveUpload[0]?.percent ?? "-"}% · ${selectedTask.liveUpload[0]?.speedText}` : "当前没有上传轨道" }}</small></div>
            <div class="focus-card focus-card--wide"><span>{{ text.focus.currentFile }}</span><strong>{{ selectedTask.currentDisplay }}</strong><small>{{ selectedTask.progressText }} · {{ selectedTask.overallSpeedText }} · {{ selectedTask.overallEtaText }}</small></div>
          </div>
          <div v-if="selectedTask.signalNotes.length" class="signal-board">
            <div class="signal-board__label">{{ text.focus.events }}</div>
            <div class="signal-board__list"><span v-for="note in selectedTask.signalNotes" :key="note" class="signal-chip">{{ note }}</span></div>
          </div>
        </template>
        <pre class="log-view">{{ activeLog.join("\n") || text.logEmpty }}</pre>
      </section>
    </div>

    <n-modal v-model:show="exportModalVisible" preset="card" :title="text.exportTitle" style="width: 520px">
      <div v-if="!exportFiles.length" class="export-empty">{{ text.exportEmpty }}</div>
      <div v-else class="export-list">
        <div v-for="file in exportFiles" :key="file.index" class="export-item">
          <span>{{ file.name }}</span>
          <n-button size="small" :loading="exportLoading" @click="exportTaskId != null && downloadExportFile(exportTaskId, file.index, file.name)">{{ text.action.download }}</n-button>
        </div>
      </div>
    </n-modal>
  </div>
</template>

<style scoped src="../styles/tasks-telemetry.css"></style>
