<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { request } from "../api/request";
import { useSettingsStore } from "../stores/settings";
import { Button, Card, Form, Input, InputNumber, Upload, Switch, message } from "ant-design-vue";

type RapidItem = { name: string; size: number; sha256: string };

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
    <pre class="result" v-if="resultText">{{ resultText }}</pre>
  </Card>
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
</style>

