<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { request } from "../api/request";
import { useSettingsStore } from "../stores/settings";
import { Button, Card, Form, Input, InputNumber, Upload, Switch, message, Modal, Table } from "ant-design-vue";

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
  exportDirLabel: "导出目录",
  exportDirPlaceholder: "默认使用移动云盘父目录",
  exportSelectDir: "选择目录",
  exportBtn: "导出清单",
  exportNeedParent: "请先在基础设置中配置移动云盘父目录 ID",
  exportOk: (count: number) => `已导出 ${count} 条`,
  exportWarn: (count: number) => `已导出 ${count} 条（部分文件缺少 SHA256）`,
  exportFail: "导出失败",
  pickerTitle: "选择移动云盘目录",
  pickerPath: "当前目录",
  pickerParent: "上一级",
  pickerChoose: "选择当前目录",
  pickerName: "目录名称",
  pickerAction: "操作",
  pickerEnter: "进入",
};

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

const exportForm = reactive({
  parent_file_id: "",
  path: "/",
});

const pickerVisible = ref(false);
const pickerLoading = ref(false);
const pickerItems = ref<MobileItem[]>([]);
const pickerStack = ref<{ id: string; name: string }[]>([]);

const pickerColumns = [
  { title: text.pickerName, dataIndex: "name" },
  { title: text.pickerAction, dataIndex: "action", width: 120 },
];

const rootParentId = () => (settingsStore.data?.mobile_parent_file_id || "").trim();
const currentPickerId = () =>
  pickerStack.value.length ? pickerStack.value[pickerStack.value.length - 1].id : rootParentId();
const currentPickerPath = () => {
  const names = pickerStack.value.map((s) => s.name);
  return "/" + names.join("/");
};

onMounted(async () => {
  try {
    await settingsStore.fetch();
    if (!form.parent_file_id.trim() && settingsStore.data.mobile_parent_file_id) {
      form.parent_file_id = settingsStore.data.mobile_parent_file_id;
    }
    if (!exportForm.parent_file_id.trim() && settingsStore.data.mobile_parent_file_id) {
      exportForm.parent_file_id = settingsStore.data.mobile_parent_file_id;
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

const beforeUpload = async (file: File) => {
  const txt = await file.text();
  try {
    const items = prepareItems(txt);
    form.text = items.map((i: RapidItem) => `${i.name}|${i.size}|${i.sha256}`).join("\n");
    message.success(`已读取 ${items.length} 条`);
  } catch (e: any) {
    message.error(e?.message || text.parseFail);
  }
  return false;
};

const beforeUploadAndSubmit = async (file: File) => {
  const txt = await file.text();
  try {
    const items = prepareItems(txt);
    form.text = items.map((i: RapidItem) => `${i.name}|${i.size}|${i.sha256}`).join("\n");
    await submitItems(items);
  } catch (e: any) {
    message.error(e?.message || text.parseFail);
  }
  return false;
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
  } catch (e: any) {
    message.error(e?.message || text.exportFail);
  } finally {
    pickerLoading.value = false;
  }
}

function openExportPicker() {
  const rootId = rootParentId();
  if (!rootId) {
    message.error(text.exportNeedParent);
    return;
  }
  pickerStack.value = [];
  pickerVisible.value = true;
  loadMobileDirs(rootId);
}

function pickerEnterDir(record: MobileItem) {
  if (!record.is_dir) return;
  pickerStack.value.push({ id: record.file_id, name: record.name });
  loadMobileDirs(record.file_id);
}

function pickerGoParent() {
  if (pickerStack.value.length === 0) {
    const rootId = rootParentId();
    if (rootId) loadMobileDirs(rootId);
    return;
  }
  pickerStack.value.pop();
  const parentId = currentPickerId();
  if (parentId) loadMobileDirs(parentId);
}

function pickerChooseCurrent() {
  const currentId = currentPickerId();
  if (!currentId) {
    message.error(text.exportNeedParent);
    return;
  }
  exportForm.parent_file_id = currentId;
  exportForm.path = currentPickerPath() || "/";
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
  const parentId = exportForm.parent_file_id.trim() || rootParentId();
  if (!parentId) {
    message.error(text.exportNeedParent);
    return;
  }
  exporting.value = true;
  try {
    const res: any = await request.post("/api/mobile/export-hash", {
      parent_file_id: parentId,
      path_prefix: exportForm.path || "/",
    });
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
</script>

<template>
  <Card :title="text.title" :bordered="false">
    <p class="tip">{{ text.tip }}</p>
    <Form layout="vertical">
      <Form.Item label="任务模式">
        <div class="inline-row">
          <Switch v-model:checked="asTask" />
          <span class="hint">开启后写入任务记录并输出日志</span>
        </div>
      </Form.Item>
      <Form.Item label="保留目录结构">
        <Switch v-model:checked="keepDirs" />
      </Form.Item>
      <Form.Item label="并发数">
        <div class="inline-row">
          <InputNumber v-model:value="concurrency" :min="1" :max="16" :step="1" />
          <span class="hint">建议 6-10，过高可能失败</span>
        </div>
      </Form.Item>
      <Form.Item label="失败重试次数">
        <div class="inline-row">
          <InputNumber v-model:value="retryTimes" :min="1" :max="5" :step="1" />
          <span class="hint">仅对网络/临时错误重试</span>
        </div>
      </Form.Item>
      <Form.Item :label="text.parentLabel">
        <Input v-model:value="form.parent_file_id" :placeholder="text.parentPlaceholder" />
      </Form.Item>
      <Form.Item :label="text.listLabel">
        <Upload :before-upload="beforeUpload" :show-upload-list="false" accept=".json,.txt,.log">
          <Button>{{ text.importBtn }}</Button>
        </Upload>
        <Upload :before-upload="beforeUploadAndSubmit" :show-upload-list="false" accept=".json,.txt,.log">
          <Button style="margin-left: 8px">{{ text.importAndSubmit }}</Button>
        </Upload>
        <Input.TextArea v-model:value="form.text" :rows="8" :placeholder="text.example" />
      </Form.Item>
      <Button type="primary" @click="submit">{{ text.submitBtn }}</Button>
    </Form>
    <Card size="small" :title="text.exportTitle" style="margin-top: 12px">
      <p class="tip">{{ text.exportTip }}</p>
      <Form layout="vertical">
        <Form.Item :label="text.exportDirLabel">
          <div class="inline-row">
            <Input v-model:value="exportForm.path" :placeholder="text.exportDirPlaceholder" readonly />
            <Button @click="openExportPicker">{{ text.exportSelectDir }}</Button>
          </div>
        </Form.Item>
        <Button type="primary" :loading="exporting" @click="exportSha256">{{ text.exportBtn }}</Button>
      </Form>
    </Card>
    <pre class="result" v-if="resultText">{{ resultText }}</pre>
  </Card>

  <Modal v-model:open="pickerVisible" :title="text.pickerTitle" :footer="null" width="720">
    <div class="picker-bar">
      <Input :value="currentPickerPath()" :placeholder="text.pickerPath" readonly />
      <Button @click="pickerGoParent">{{ text.pickerParent }}</Button>
      <Button type="primary" @click="pickerChooseCurrent">{{ text.pickerChoose }}</Button>
    </div>
    <Table
      :columns="pickerColumns"
      :data-source="pickerItems"
      :loading="pickerLoading"
      row-key="file_id"
      size="small"
      :pagination="false"
      :customRow="(record) => ({ onDblclick: () => (record as any).is_dir && pickerEnterDir(record as any) })"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'action'">
          <Button size="small" @click="() => pickerEnterDir(record as any)">{{ text.pickerEnter }}</Button>
        </template>
        <template v-else>
          {{ (record as any).name }}
        </template>
      </template>
    </Table>
  </Modal>
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
}
.hint {
  font-size: 12px;
  color: var(--muted);
}
.picker-bar {
  display: grid;
  grid-template-columns: 1fr auto auto;
  gap: 8px;
  margin-bottom: 10px;
}
@media (max-width: 720px) {
  .picker-bar {
    grid-template-columns: 1fr;
  }
}
</style>

