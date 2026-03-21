<script setup lang="ts">
import { onMounted, reactive, ref, h } from "vue";
import { request } from "../api/request";
import { useSettingsStore } from "../stores/settings";
import { NButton, useMessage, type DataTableColumns, type UploadCustomRequestOptions } from "naive-ui";

type RapidItem = { name: string; size: number; sha256: string };
interface MobileItem {
  name: string;
  file_id: string;
  is_dir: boolean;
  size: number;
}

const text = {
  title: "秒传导入",
  tip: "支持 JSON 清单或每行 name|size|sha256；name 可以是完整路径。建议用任务模式查看日志。",
  parentLabel: "parent_file_id",
  parentPlaceholder: "默认使用基础设置的 parentFileId，建议明确填写",
  listLabel: "清单",
  importBtn: "从文件导入",
  importAndSubmit: "导入并秒传",
  submitBtn: "提交秒传",
  parseFail: "解析失败",
  submitOk: "提交完成",
  submitFail: "提交失败",
  parentRequired: "parent_file_id 不能为空",
  lineError: "行格式错误:",
  example: "示例：\nmovie.mp4|60906485|6914d7d6f4f55808745ce82d7954c81f1f18cf75ea3e39931955599e2a22dcd6",
  exportTitle: "移动云盘 SHA256 导出",
  exportTip: "仅导出移动云盘目录内已有 SHA256 的文件；缺少 SHA256 的会被跳过。",
  exportDirLabel: "已选目录",
  exportDirPlaceholder: "请选择需要导出的目录",
  exportSelectDir: "选择目录",
  exportClearDir: "清空选择",
  exportBtn: "导出清单",
  exportConcurrencyLabel: "扫描并发数",
  exportConcurrencyHint: "建议 2-6，过高可能被限速",
  exportNeedParent: "无法获取移动云盘目录（请检查 Authorization / x-yun-uni）",
  exportNeedDir: "请先选择要导出的目录",
  exportOk: (count: number) => `已导出 ${count} 条`,
  exportWarn: (count: number) => `已导出 ${count} 条（部分文件缺少 SHA256）`,
  exportQueued: (id: number) => `导出任务已创建 #${id}，请到“任务记录”查看进度`,
  exportFail: "导出失败",
  pickerTitle: "选择移动云盘目录",
  pickerPath: "当前目录",
  pickerParent: "上一级",
  pickerChoose: "选择当前目录",
  pickerAddSelected: "添加已选目录",
  pickerName: "目录名称",
  pickerAction: "操作",
  pickerEnter: "进入",
};

const message = useMessage();
const form = reactive({
  parent_file_id: "",
  text: "",
});
const resultText = ref("");
const settingsStore = useSettingsStore();
const keepDirs = ref(true);
const concurrency = ref(8);
const retryTimes = ref(2);
const asTask = ref(true);
const exporting = ref(false);
const exportConcurrency = ref(4);

const exportDirs = ref<{ id: string; path: string }[]>([]);

const pickerVisible = ref(false);
const pickerLoading = ref(false);
const pickerItems = ref<MobileItem[]>([]);
const pickerStack = ref<{ id: string; name: string }[]>([]);
const pickerSelectedKeys = ref<string[]>([]);
const pickerSelectedRows = ref<MobileItem[]>([]);

const pickerColumns: DataTableColumns<MobileItem> = [
  { type: "selection" },
  { title: text.pickerName, key: "name" },
  {
    title: text.pickerAction,
    key: "action",
    width: 120,
    render: (row) =>
      h(
        NButton,
        { size: "tiny", onClick: () => pickerEnterDir(row) },
        { default: () => text.pickerEnter },
      ),
  },
];

const rootParentId = () => "/";
const currentPickerId = () => {
  const root = rootParentId();
  if (!pickerStack.value.length) return root || "";
  const last = pickerStack.value[pickerStack.value.length - 1];
  return last?.id || root || "";
};
const currentPickerPath = () => {
  if (!pickerStack.value.length) return "/";
  const names = pickerStack.value.map((s) => s.name).filter(Boolean);
  return "/" + names.join("/");
};

onMounted(async () => {
  try {
    await settingsStore.fetch();
    if (!form.parent_file_id.trim() && settingsStore.data.mobile_parent_file_id) {
      form.parent_file_id = settingsStore.data.mobile_parent_file_id;
    }
  } catch {
    // ignore settings load errors
  }
});

function parseInput(input: string): RapidItem[] {
  const trimmed = (input || "").trim();
  if (!trimmed) return [];
  try {
    const j = JSON.parse(trimmed);
    const arr = Array.isArray(j)
      ? j
      : Array.isArray((j as any).data)
        ? (j as any).data
        : Array.isArray((j as any).content)
          ? (j as any).content
          : null;
    if (arr) {
      const mapped = (arr as any[]).map((o: any): RapidItem => ({
        name: String(o.name || o.path || o.file || ""),
        size: Number(o.size ?? o.length ?? o.file_size ?? o.filesize ?? o.bytes ?? 0),
        sha256: String(o.sha256 || o.hash || o.sha || "").toLowerCase(),
      }));
      return mapped;
    }
  } catch (_e) {
    // fallback
  }
  return trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line): RapidItem => {
      const parts = line.split("|").map((p) => p.trim());
      if (parts.length < 3) throw new Error(`${text.lineError} ${line}`);
      const name = String(parts[0] ?? "");
      const size = Number(parts[1] ?? 0);
      const sha = String(parts[2] ?? "").toLowerCase();
      return { name, size, sha256: sha };
    });
}

function stripPath(name: string): string {
  const clean = String(name || "").replace(/\\/g, "/");
  const parts = clean.split("/").filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : name;
  return last || name;
}

function prepareItems(input: string): RapidItem[] {
  const items = parseInput(input);
  if (!keepDirs.value) {
    return items.map((i) => ({ ...i, name: stripPath(i.name) }));
  }
  return items;
}

async function submitItems(items: RapidItem[]) {
  const fallbackParent = (settingsStore.data?.mobile_parent_file_id || "").trim();
  if (!form.parent_file_id.trim() && !fallbackParent) throw new Error(text.parentRequired);
  const res: any = await request.post("/api/mobile/rapid-upload", {
    parent_file_id: form.parent_file_id.trim() || undefined,
    items,
    keep_dirs: keepDirs.value,
    concurrency: Number(concurrency.value) || undefined,
    retry: Number(retryTimes.value) || undefined,
    as_task: asTask.value,
  });
  const resData: any = res || {};
  if (resData.task_id) {
    resultText.value = `已创建任务 #${resData.task_id}，请到“任务记录”查看日志与进度。`;
    message.success(text.submitOk);
    return;
  }
  const results: any[] = Array.isArray(resData.results) ? resData.results : [];
  const lines = results.map((r: any) => {
    if (r.status === "ok") return `OK ${r.name} -> ${r.file_id}（已重命名）`;
    if (r.status === "rename_failed") {
      const detail = r.rename_error ? `，原因：${r.rename_error}` : "";
      const dir = r.target_openlist_dir ? `，目录：${r.target_openlist_dir}` : "";
      return `WARN ${r.name} -> ${r.file_id}（重命名失败${detail}${dir}）`;
    }
    if (r.status === "miss") return `MISS ${r.name} -> ${r.error || "秒传未命中"}`;
    return `FAIL ${r.name} -> ${r.error || "未知错误"}`;
  });
  resultText.value = lines.join("\n");
  message.success(text.submitOk);
}

async function handleImport(file: File, submitAfter: boolean) {
  const txt = await file.text();
  const items = prepareItems(txt);
  form.text = items.map((i: RapidItem) => `${i.name}|${i.size}|${i.sha256}`).join("\n");
  if (submitAfter) {
    await submitItems(items);
  } else {
    message.success(`已读取 ${items.length} 条`);
  }
}

const importRequest = async ({ file, onFinish, onError }: UploadCustomRequestOptions) => {
  try {
    const raw = file.file as File | null | undefined;
    if (!raw) throw new Error("读取文件失败");
    await handleImport(raw, false);
    onFinish();
  } catch (e: any) {
    message.error(e?.message || text.parseFail);
    onError();
  }
};

const importAndSubmitRequest = async ({ file, onFinish, onError }: UploadCustomRequestOptions) => {
  try {
    const raw = file.file as File | null | undefined;
    if (!raw) throw new Error("读取文件失败");
    await handleImport(raw, true);
    onFinish();
  } catch (e: any) {
    message.error(e?.message || text.parseFail);
    onError();
  }
};

const submit = async () => {
  try {
    const items = prepareItems(form.text);
    await submitItems(items);
  } catch (e: any) {
    message.error(e?.message || text.submitFail);
  }
};

async function loadMobileDirs(parentId: string) {
  pickerLoading.value = true;
  try {
    const res: any = await request.post("/api/mobile/list", { parent_file_id: parentId });
    const items = Array.isArray(res?.items) ? res.items : [];
    pickerItems.value = items.filter((it: any) => it.is_dir);
    updatePickerSelection(pickerSelectedKeys.value);
  } catch (e: any) {
    message.error(e?.message || text.exportFail);
  } finally {
    pickerLoading.value = false;
  }
}

function updatePickerSelection(keys: Array<string | number>) {
  pickerSelectedKeys.value = keys as string[];
  const keySet = new Set(pickerSelectedKeys.value);
  pickerSelectedRows.value = pickerItems.value.filter((row) => keySet.has(row.file_id));
}

function openExportPicker() {
  const rootId = rootParentId();
  pickerStack.value = [];
  pickerSelectedKeys.value = [];
  pickerSelectedRows.value = [];
  pickerVisible.value = true;
  loadMobileDirs(rootId);
}

function pickerEnterDir(record: MobileItem) {
  if (!record.is_dir) return;
  pickerStack.value.push({ id: record.file_id, name: record.name });
  pickerSelectedKeys.value = [];
  pickerSelectedRows.value = [];
  loadMobileDirs(record.file_id);
}

function pickerGoParent() {
  if (pickerStack.value.length === 0) {
    const rootId = rootParentId();
    if (rootId) loadMobileDirs(rootId);
    return;
  }
  pickerStack.value.pop();
  pickerSelectedKeys.value = [];
  pickerSelectedRows.value = [];
  const parentId = currentPickerId();
  if (parentId) loadMobileDirs(parentId);
}

function pickerChooseCurrent() {
  const currentId = currentPickerId();
  const path = currentPickerPath() || "/";
  if (!currentId) {
    message.error(text.exportNeedParent);
    return;
  }
  if (!exportDirs.value.find((d) => d.id === currentId)) {
    exportDirs.value.push({ id: currentId, path });
  }
  pickerVisible.value = false;
}

function pickerAddSelected() {
  const basePath = currentPickerPath() || "/";
  if (!pickerSelectedRows.value.length) {
    message.warning(text.exportNeedDir);
    return;
  }
  pickerSelectedRows.value.forEach((row) => {
    const path = basePath === "/" ? `/${row.name}` : `${basePath}/${row.name}`;
    if (!exportDirs.value.find((d) => d.id === row.file_id)) {
      exportDirs.value.push({ id: row.file_id, path });
    }
  });
  pickerSelectedKeys.value = [];
  pickerSelectedRows.value = [];
  pickerVisible.value = false;
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
  if (!exportDirs.value.length) {
    message.warning(text.exportNeedDir);
    return;
  }
  exporting.value = true;
  try {
    const res: any = await request.post("/api/mobile/export-hash", {
      roots: exportDirs.value.map((d) => ({ parent_file_id: d.id, path_prefix: d.path })),
      scan_concurrency: Number(exportConcurrency.value) || undefined,
      as_task: true,
    });
    if (res?.task_id) {
      message.success(text.exportQueued(res.task_id));
      return;
    }
    const items = Array.isArray(res?.items) ? res.items : [];
    const missing = Number(res?.missing_hash || 0);
    const ts = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
    const filename = `mobile_sha256_${ts}_${items.length}files.json`;
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

function removeExportDir(id: string) {
  exportDirs.value = exportDirs.value.filter((d) => d.id !== id);
}

function clearExportDirs() {
  exportDirs.value = [];
}
</script>

<template>
  <div class="page-stack">
    <n-card :title="text.title" :bordered="false" class="page-card">
      <p class="tip">{{ text.tip }}</p>
      <n-form label-placement="top">
        <n-form-item label="任务模式">
          <div class="inline-row">
            <n-switch v-model:value="asTask" />
            <span class="hint">开启后写入任务记录并输出日志</span>
          </div>
        </n-form-item>
        <n-form-item label="保留目录结构">
          <n-switch v-model:value="keepDirs" />
        </n-form-item>
        <n-form-item label="并发数">
          <div class="inline-row">
            <n-input-number v-model:value="concurrency" :min="1" :max="16" :step="1" />
            <span class="hint">建议 6-10，过高可能失败</span>
          </div>
        </n-form-item>
        <n-form-item label="失败重试次数">
          <div class="inline-row">
            <n-input-number v-model:value="retryTimes" :min="1" :max="5" :step="1" />
            <span class="hint">仅对网络/临时错误重试</span>
          </div>
        </n-form-item>
        <n-form-item :label="text.parentLabel">
          <n-input v-model:value="form.parent_file_id" :placeholder="text.parentPlaceholder" />
        </n-form-item>
        <n-form-item :label="text.listLabel">
          <div class="inline-row">
            <n-upload :custom-request="importRequest" :show-file-list="false" accept=".json,.txt,.log">
              <n-button>{{ text.importBtn }}</n-button>
            </n-upload>
            <n-upload :custom-request="importAndSubmitRequest" :show-file-list="false" accept=".json,.txt,.log">
              <n-button>{{ text.importAndSubmit }}</n-button>
            </n-upload>
          </div>
          <n-input
            v-model:value="form.text"
            type="textarea"
            :autosize="{ minRows: 8, maxRows: 16 }"
            :placeholder="text.example"
          />
        </n-form-item>
        <n-button type="primary" @click="submit">{{ text.submitBtn }}</n-button>
      </n-form>

      <n-card size="small" :title="text.exportTitle" style="margin-top: 12px">
        <p class="tip">{{ text.exportTip }}</p>
        <n-form label-placement="top">
          <n-form-item :label="text.exportDirLabel">
            <div class="selected-box">
              <n-tag v-for="d in exportDirs" :key="d.id" closable size="small" @close="removeExportDir(d.id)">
                {{ d.path }}
              </n-tag>
              <span v-if="!exportDirs.length" class="hint">{{ text.exportDirPlaceholder }}</span>
            </div>
            <div class="inline-row" style="margin-top: 8px">
              <n-button @click="openExportPicker">{{ text.exportSelectDir }}</n-button>
              <n-button @click="clearExportDirs">{{ text.exportClearDir }}</n-button>
            </div>
          </n-form-item>
          <n-form-item :label="text.exportConcurrencyLabel">
            <div class="inline-row">
              <n-input-number v-model:value="exportConcurrency" :min="1" :max="16" :step="1" />
              <span class="hint">{{ text.exportConcurrencyHint }}</span>
            </div>
          </n-form-item>
          <n-button type="primary" :loading="exporting" @click="exportSha256">{{ text.exportBtn }}</n-button>
        </n-form>
      </n-card>

      <pre class="result" v-if="resultText">{{ resultText }}</pre>
    </n-card>

    <n-modal v-model:show="pickerVisible" preset="card" :title="text.pickerTitle" style="width: 720px">
      <div class="picker-bar">
        <n-input :value="currentPickerPath()" :placeholder="text.pickerPath" readonly />
        <n-button @click="pickerGoParent">{{ text.pickerParent }}</n-button>
        <n-button @click="pickerChooseCurrent">{{ text.pickerChoose }}</n-button>
        <n-button type="primary" @click="pickerAddSelected">{{ text.pickerAddSelected }}</n-button>
      </div>
      <n-data-table
        :columns="pickerColumns"
        :data="pickerItems"
        :loading="pickerLoading"
        :pagination="false"
        :row-key="(row: MobileItem) => row.file_id"
        :row-props="(row: MobileItem) => ({ onDblclick: () => row.is_dir && pickerEnterDir(row) })"
        :checked-row-keys="pickerSelectedKeys"
        @update:checked-row-keys="updatePickerSelection"
        size="small"
      />
    </n-modal>
  </div>
</template>

<style scoped>
.tip {
  color: var(--muted);
  margin-bottom: 10px;
  font-size: 13px;
}
.result {
  margin-top: 12px;
  background: #f7f5f0;
  color: var(--text);
  padding: 10px;
  border-radius: 10px;
  border: 1px solid var(--border);
  white-space: pre-wrap;
}
.inline-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.hint {
  font-size: 12px;
  color: var(--muted);
}
.selected-box {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
.picker-bar {
  display: grid;
  grid-template-columns: 1fr auto auto auto;
  gap: 8px;
  margin-bottom: 10px;
}
@media (max-width: 720px) {
  .picker-bar {
    grid-template-columns: 1fr;
  }
}
</style>

