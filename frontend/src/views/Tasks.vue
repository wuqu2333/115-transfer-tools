<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from "vue";
import { request } from "../api/request";
import { Button, Card, Table, Tag, message, Popconfirm, Switch } from "ant-design-vue";

interface TaskRow {
  id: number;
  provider: string;
  status: string;
  progress: string;
  current_item: string;
  message: string;
  created_at: string;
  logs: string[];
}

const text = {
  title: "任务记录",
  refresh: "刷新",
  log: "日志",
  retry: "重试",
  remove: "删除",
  download: "下载",
  removeOk: (id: number) => `任务 #${id} 已删除`,
  logTitle: "任务日志",
  logEmpty: "点击“日志”查看任务输出",
  retryOk: (id: number) => `任务 #${id} 已重试`,
  autoRefresh: "实时更新",
  columns: {
    target: "目标",
    status: "状态",
    progress: "进度",
    current: "当前项",
    message: "消息",
    created: "创建时间",
    action: "操作",
  },
};

const columns = [
  { title: "ID", dataIndex: "id", width: 70 },
  { title: text.columns.target, dataIndex: "provider" },
  { title: text.columns.status, dataIndex: "status" },
  { title: text.columns.progress, dataIndex: "progress" },
  { title: text.columns.current, dataIndex: "current_item" },
  { title: text.columns.message, dataIndex: "message" },
  { title: text.columns.created, dataIndex: "created_at" },
  {
    title: text.columns.action,
    dataIndex: "action",
  },
];

const dataSource = ref<TaskRow[]>([]);
const loading = ref(false);
const activeLog = ref<string[]>([]);
const activeTaskId = ref<number | null>(null);
const autoRefresh = ref(true);
let refreshTimer: number | undefined;

function formatBytes(bytes: number) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let idx = 0;
  let n = bytes;
  while (n >= 1024 && idx < units.length - 1) {
    n /= 1024;
    idx += 1;
  }
  const num = n >= 10 || idx === 0 ? n.toFixed(0) : n.toFixed(1);
  return `${num}${units[idx]}`;
}

function buildProgress(t: any) {
  const totalFiles = Number(t.total_files || 0);
  const doneFiles = Number(t.processed_files || 0);
  const filePercent = totalFiles > 0 ? Math.min(100, Math.round((doneFiles / totalFiles) * 100)) : 0;
  let text = totalFiles > 0 ? `${doneFiles}/${totalFiles}（${filePercent}%）` : `${doneFiles}/-`;
  const totalBytes = Number(t.total_bytes || 0);
  const doneBytes = Number(t.processed_bytes || 0);
  if (totalBytes > 0) {
    const bPercent = Math.min(100, Math.round((doneBytes / totalBytes) * 100));
    const left = formatBytes(doneBytes);
    const right = formatBytes(totalBytes);
    text += ` · ${left}/${right}（${bPercent}%）`;
  }
  return text;
}

async function loadTasks() {
  loading.value = true;
  try {
    const res = (await request.get<any[]>("/api/tasks?limit=120")) as any;
    const arr: any[] = Array.isArray(res) ? res : [];
    dataSource.value = arr.map((t: any) => ({
      key: t.id,
      id: t.id,
      provider: t.provider,
      status: t.status,
      progress: buildProgress(t),
      current_item: t.current_item,
      message: t.message,
      created_at: t.created_at,
      logs: t.logs || [],
    }));
    if (activeTaskId.value != null) {
      const found = dataSource.value.find((t) => t.id === activeTaskId.value);
      if (found) activeLog.value = found.logs || [];
      else {
        activeTaskId.value = null;
        activeLog.value = [];
      }
    }
  } finally {
    loading.value = false;
  }
}

async function retryTask(id: number) {
  await request.post(`/api/tasks/${id}/retry`);
  message.success(text.retryOk(id));
  loadTasks();
}

async function deleteTask(id: number) {
  await request.delete(`/api/tasks/${id}`);
  message.success(text.removeOk(id));
  loadTasks();
  if (activeLog.value.length) activeLog.value = [];
}

function showLog(record: TaskRow) {
  activeLog.value = record.logs || [];
  activeTaskId.value = record.id;
}

function statusTag(status: string) {
  const map: Record<string, string> = { success: "green", failed: "red", running: "blue", pending: "default" };
  return map[status] || "default";
}

function providerLabel(provider: string) {
  const map: Record<string, string> = {
    sharepoint: "世纪互联",
    mobile: "移动上传",
    rapid_mobile: "移动秒传",
    mobile_export: "移动云盘导出",
  };
  return map[provider] || provider;
}

async function downloadExport(id: number) {
  const data: any = await request.get(`/api/tasks/${id}/export`, { responseType: "blob" });
  const blob = data instanceof Blob ? data : new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `export_task_${id}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

onMounted(loadTasks);
onMounted(() => {
  startAutoRefresh();
});
onBeforeUnmount(() => {
  stopAutoRefresh();
});

function startAutoRefresh() {
  stopAutoRefresh();
  if (!autoRefresh.value) return;
  refreshTimer = window.setInterval(() => {
    loadTasks();
  }, 2000);
}

function stopAutoRefresh() {
  if (refreshTimer) {
    window.clearInterval(refreshTimer);
    refreshTimer = undefined;
  }
}

watch(autoRefresh, () => {
  startAutoRefresh();
});
</script>

<template>
  <Card :title="text.title" :bordered="false">
    <div class="list-actions">
      <Button @click="loadTasks">{{ text.refresh }}</Button>
      <div class="auto-refresh">
        <span>{{ text.autoRefresh }}</span>
        <Switch v-model:checked="autoRefresh" />
      </div>
    </div>
    <Table :columns="columns" :data-source="dataSource" :loading="loading" size="small" row-key="id">
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'status'">
          <Tag :color="statusTag((record as any).status)">{{ (record as any).status }}</Tag>
        </template>
        <template v-else-if="column.dataIndex === 'provider'">
          {{ providerLabel((record as any).provider) }}
        </template>
        <template v-else-if="column.dataIndex === 'action'">
          <Button size="small" @click="() => showLog(record as any)" style="margin-right: 8px">{{ text.log }}</Button>
          <Button
            v-if="(record as any).provider === 'mobile_export' && (record as any).status === 'success'"
            size="small"
            @click="() => downloadExport((record as any).id)"
            style="margin-right: 8px"
          >
            {{ text.download }}
          </Button>
          <Button size="small" @click="() => retryTask((record as any).id)">{{ text.retry }}</Button>
          <Popconfirm
            title="确定删除该任务？"
            ok-text="删除"
            cancel-text="取消"
            @confirm="() => deleteTask((record as any).id)"
          >
            <Button size="small" danger style="margin-left: 8px">{{ text.remove }}</Button>
          </Popconfirm>
        </template>
        <template v-else>
          {{ (record as any)[column.dataIndex as string] }}
        </template>
      </template>
    </Table>
    <Card style="margin-top: 12px" size="small" :title="text.logTitle">
      <pre class="log-view">{{ activeLog.join("\n") || text.logEmpty }}</pre>
    </Card>
  </Card>
</template>

<style scoped>
.list-actions {
  margin-bottom: 10px;
  display: flex;
  gap: 8px;
  align-items: center;
}
.auto-refresh {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: 8px;
}
.log-view {
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  background: #f7f5f0;
  color: var(--text);
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
}
</style>

