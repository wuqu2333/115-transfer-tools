<script setup lang="ts">
import { onMounted, ref, computed, reactive, watch, h } from "vue";
import { request } from "../api/request";
import { useSettingsStore } from "../stores/settings";
import { NButton, NIcon, useMessage, type DataTableColumns } from "naive-ui";
import { FolderOutlined, FileOutlined } from "@vicons/antd";

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
  needSelected: "请先选择要转运的文件或文件夹",
  taskOk: (id: number) => `任务 #${id} 已创建`,
  taskFail: "创建任务失败",
};

const message = useMessage();
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

const selectedList = computed(() => Array.from(selected.value));

const providerOptions = [
  { label: text.providerMobile, value: "mobile" },
  { label: text.providerSharepoint, value: "sharepoint" },
];

const columns: DataTableColumns<BrowserItem> = [
  {
    title: text.name,
    key: "name",
    render: (row) =>
      h(
        "span",
        { class: "name-cell" },
        [
          h(
            NIcon,
            { class: "name-icon", size: 16 },
            { default: () => h(row.is_dir ? FolderOutlined : FileOutlined) },
          ),
          h("span", null, row.name),
        ],
      ),
  },
  {
    title: text.size,
    key: "size",
    render: (row) => (row.size ?? "-") as any,
  },
  {
    title: text.modified,
    key: "modified",
    render: (row) => row.modified || "-",
  },
  {
    title: text.action,
    key: "action",
    width: 180,
    render: (row) =>
      h(
        "div",
        { class: "action-row" },
        [
          h(
            NButton,
            { size: "tiny", onClick: () => enter(row) },
            { default: () => (row.is_dir ? text.enter : text.select) },
          ),
          h(
            NButton,
            { size: "tiny", secondary: true, onClick: () => toggle(row) },
            { default: () => (selected.value.has(row.path) ? text.cancel : text.multi) },
          ),
        ],
      ),
  },
];

const rowKey = (row: BrowserItem) => row.path;
const rowProps = (row: BrowserItem) => ({
  onDblclick: () => row.is_dir && enter(row),
});

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

function removeSelected(p: string) {
  selected.value.delete(p);
  schedulePersist();
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
  <n-card :title="text.title" :bordered="false" class="page-card">
    <div class="path-row">
      <n-input v-model:value="path" />
      <n-button @click="() => load(path as any)">{{ text.jump }}</n-button>
      <n-button @click="goParent">{{ text.parent }}</n-button>
    </div>

    <n-data-table
      :data="items"
      :columns="columns"
      :loading="loading"
      :pagination="false"
      :row-key="rowKey"
      :row-props="rowProps"
      size="small"
    />

    <n-card size="small" :title="text.selectedTitle" style="margin-top: 12px">
      <div class="selected-box">
        <n-tag
          v-for="p in selectedList"
          :key="p"
          closable
          size="small"
          @close="removeSelected(p)"
        >
          {{ p }}
        </n-tag>
        <span v-if="!selectedList.length" class="hint">{{ text.needSelected }}</span>
      </div>
      <div style="margin-top: 10px">
        <n-button size="small" @click="clearSelected">{{ text.clearSelected }}</n-button>
      </div>
    </n-card>

    <n-card size="small" :title="text.taskTitle" style="margin-top: 12px">
      <n-form label-placement="top">
        <n-form-item :label="text.providerLabel">
          <n-select
            v-model:value="taskForm.provider"
            :options="providerOptions"
            style="max-width: 240px"
            @update:value="onProviderChange"
          />
        </n-form-item>
        <n-form-item :label="text.targetLabel">
          <n-input v-model:value="taskForm.target_path" />
        </n-form-item>
        <n-form-item :label="text.downloadBaseLabel">
          <div class="path-row">
            <n-input v-model:value="taskForm.download_base_path" />
            <n-button @click="selectLocalDir">{{ text.downloadSelect }}</n-button>
          </div>
        </n-form-item>
        <n-button type="primary" @click="createTask">{{ text.createTask }}</n-button>
      </n-form>
    </n-card>
  </n-card>
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
  align-items: center;
}
.hint {
  font-size: 12px;
  color: var(--muted);
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
.action-row {
  display: inline-flex;
  gap: 6px;
}
@media (max-width: 720px) {
  .path-row {
    grid-template-columns: 1fr;
  }
}
</style>

