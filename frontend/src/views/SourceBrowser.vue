<script setup lang="ts">
import { onMounted, ref, computed, reactive, watch } from "vue";
import { request } from "../api/request";
import { Button, Card, Form, Input, Select, Table, message } from "ant-design-vue";
import { FolderOutlined, FileOutlined } from "@ant-design/icons-vue";
import { useSettingsStore } from "../stores/settings";

interface BrowserItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified?: string;
}

const text = {
  title: "源文件浏览",
  name: "名称",
  size: "大小",
  modified: "修改时间",
  action: "操作",
  jump: "跳转",
  parent: "上一级",
  folder: "文件夹",
  file: "文件",
  enter: "进入",
  select: "选中",
  cancel: "取消",
  multi: "多选",
  selectedTitle: "已选路径",
  taskTitle: "创建转运任务",
  providerLabel: "目标平台",
  providerMobile: "移动云盘",
  providerSharepoint: "世纪互联",
  targetLabel: "目标路径",
  downloadBaseLabel: "本地下载目录",
  downloadSelect: "选择目录",
  createTask: "创建任务",
  clearSelected: "清空选择",
  exportHash: "导出 SHA256 清单",
  exportOk: (count: number) => `已导出 ${count} 条`,
  exportWarn: (count: number) => `已导出 ${count} 条（部分文件缺少 SHA256）`,
  exportFail: "导出失败",
  needSelected: "请先选择要转运的文件或文件夹",
  taskOk: (id: number) => `任务 #${id} 已创建`,
  taskFail: "创建任务失败",
};

const path = ref("/115");
const items = ref<BrowserItem[]>([]);
const selected = ref<Set<string>>(new Set());
const loading = ref(false);
const settingsStore = useSettingsStore();

const taskForm = reactive({
  provider: "mobile",
  target_path: "",
  download_base_path: "",
});

const isRestoring = ref(true);
let saveTimer: number | undefined;

const columns = [
  { title: text.name, dataIndex: "name" },
  { title: text.size, dataIndex: "size" },
  { title: text.modified, dataIndex: "modified" },
  { title: text.action, dataIndex: "action", width: 140 },
];

const selectedList = computed(() => Array.from(selected.value));
const exporting = ref(false);

async function load(p?: string) {
  loading.value = true;
  try {
    const res: any = await request.post("/api/openlist/list", {
      path: p ?? path.value,
      refresh: false,
      page: 1,
      per_page: 0,
    });
    path.value = (res as any).path;
    items.value = (res as any).items || [];
  } finally {
    loading.value = false;
  }
}

async function restoreState() {
  try {
    const res: any = await request.get("/api/ui/selection");
    if (Array.isArray(res?.selected_paths)) {
      selected.value = new Set(res.selected_paths.filter((p: any) => !!p));
    }
    if (typeof res?.current_path === "string" && res.current_path) {
      path.value = res.current_path;
    }
  } catch {
    // ignore
  } finally {
    isRestoring.value = false;
  }
}

function schedulePersist() {
  if (isRestoring.value) return;
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(async () => {
    try {
      await request.post("/api/ui/selection", {
        selected_paths: selectedList.value,
        current_path: path.value,
      });
    } catch {
      // ignore
    }
  }, 300);
}

function enter(record: BrowserItem) {
  if (record.is_dir) {
    load(record.path);
  } else {
    selected.value.add(record.path);
  }
}

function toggle(record: BrowserItem) {
  if (selected.value.has(record.path)) selected.value.delete(record.path);
  else selected.value.add(record.path);
}

function goParent() {
  const parts = path.value.split("/").filter(Boolean);
  parts.pop();
  const parent = "/" + parts.join("/");
  load(parent || "/");
}

onMounted(async () => {
  await restoreState();
  load(path.value);
});

async function initSettings() {
  try {
    await settingsStore.fetch();
    taskForm.download_base_path = settingsStore.data?.download_base_path || "";
    taskForm.target_path =
      taskForm.provider === "sharepoint"
        ? settingsStore.data?.sharepoint_target_path || "/"
        : settingsStore.data?.mobile_target_openlist_path || "/";
  } catch {
    // ignore
  }
}

function onProviderChange(value: any) {
  const v = String(value || "mobile");
  taskForm.provider = v;
  taskForm.target_path =
    v === "sharepoint"
      ? settingsStore.data?.sharepoint_target_path || "/"
      : settingsStore.data?.mobile_target_openlist_path || "/";
}

async function selectLocalDir() {
  try {
    const res: any = await request.post("/api/system/select-directory", { title: text.downloadBaseLabel });
    if (res?.path) taskForm.download_base_path = res.path;
  } catch (e: any) {
    message.error(e?.message || "选择目录失败");
  }
}

function clearSelected() {
  selected.value = new Set();
  schedulePersist();
}

function downloadJson(data: any, filename: string) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

async function exportSha256() {
  if (!selectedList.value.length) {
    message.error(text.needSelected);
    return;
  }
  exporting.value = true;
  try {
    const res: any = await request.post("/api/openlist/export-hash", {
      paths: selectedList.value,
      refresh: false,
    });
    const items = Array.isArray(res?.items) ? res.items : [];
    const missing = Number(res?.missing_hash || 0);
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const filename = `sha256_export_${ts}_${items.length}files.json`;
    downloadJson(items, filename);
    if (missing > 0) {
      message.warning(text.exportWarn(items.length));
    } else {
      message.success(text.exportOk(items.length));
    }
  } catch (e: any) {
    message.error(e?.message || text.exportFail);
  } finally {
    exporting.value = false;
  }
}

async function createTask() {
  if (!selectedList.value.length) {
    message.error(text.needSelected);
    return;
  }
  try {
    const payload = {
      provider: taskForm.provider,
      source_paths: selectedList.value,
      target_path: taskForm.target_path,
      download_base_path: taskForm.download_base_path,
    };
    const res: any = await request.post("/api/tasks", payload);
    if (res?.id) {
      message.success(text.taskOk(res.id));
    } else {
      message.success("提交完成");
    }
  } catch (e: any) {
    message.error(e?.message || text.taskFail);
  }
}

onMounted(initSettings);

watch(
  () => selectedList.value,
  () => schedulePersist(),
  { deep: true },
);

watch(
  () => path.value,
  () => schedulePersist(),
);
</script>

<template>
  <Card :title="text.title" :bordered="false">
    <div class="path-row">
      <Input v-model:value="path" />
      <Button @click="() => load(path as any)">{{ text.jump }}</Button>
      <Button @click="goParent">{{ text.parent }}</Button>
    </div>
    <Table
      :data-source="items"
      :columns="columns"
      :loading="loading"
      row-key="path"
      size="small"
      :customRow="(record) => ({ onDblclick: () => (record as any).is_dir && enter(record as any) })"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'name'">
          <span class="name-cell">
            <FolderOutlined v-if="(record as any).is_dir" class="name-icon" />
            <FileOutlined v-else class="name-icon" />
            <span>{{ (record as any).name }}</span>
          </span>
        </template>
        <template v-else-if="column.dataIndex === 'action'">
          <Button size="small" @click="() => enter(record as any)">{{ (record as any).is_dir ? text.enter : text.select }}</Button>
          <Button size="small" @click="() => toggle(record as any)" style="margin-left: 6px">
            {{ selected.has((record as any).path) ? text.cancel : text.multi }}
          </Button>
        </template>
        <template v-else>
          {{ (record as any)[column.dataIndex as string] ?? "-" }}
        </template>
      </template>
    </Table>
    <Card size="small" :title="text.selectedTitle" style="margin-top: 10px">
      <div class="selected-box">
        <span v-for="p in selectedList" :key="p" class="pill">
          {{ p }}
          <button @click="selected.delete(p)">x</button>
        </span>
      </div>
      <div style="margin-top: 10px">
        <Button size="small" @click="clearSelected">{{ text.clearSelected }}</Button>
        <Button size="small" :loading="exporting" style="margin-left: 8px" @click="exportSha256">
          {{ text.exportHash }}
        </Button>
      </div>
    </Card>
    <Card size="small" :title="text.taskTitle" style="margin-top: 10px">
      <Form layout="vertical">
        <Form.Item :label="text.providerLabel">
          <Select :value="taskForm.provider" style="max-width: 240px" @change="onProviderChange">
            <Select.Option value="mobile">{{ text.providerMobile }}</Select.Option>
            <Select.Option value="sharepoint">{{ text.providerSharepoint }}</Select.Option>
          </Select>
        </Form.Item>
        <Form.Item :label="text.targetLabel">
          <Input v-model:value="taskForm.target_path" />
        </Form.Item>
        <Form.Item :label="text.downloadBaseLabel">
          <div class="path-row">
            <Input v-model:value="taskForm.download_base_path" />
            <Button @click="selectLocalDir">{{ text.downloadSelect }}</Button>
          </div>
        </Form.Item>
        <Button type="primary" @click="createTask">{{ text.createTask }}</Button>
      </Form>
    </Card>
  </Card>
</template>

<style scoped>
.path-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  margin-bottom: 10px;
}
.selected-box {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  padding: 4px 8px;
  background: var(--panel-2);
}
.pill button {
  width: 18px;
  height: 18px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: #ffffff;
  cursor: pointer;
  line-height: 16px;
  font-size: 12px;
}
.name-cell {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.name-icon {
  color: var(--muted);
  font-size: 14px;
}
@media (max-width: 720px) {
  .path-row {
    grid-template-columns: 1fr;
  }
}
</style>

