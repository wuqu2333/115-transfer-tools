<script setup lang="ts">
import { reactive, ref } from 'vue';
import { request } from '../api/request';
import { Button, Card, Form, Input, Upload, message } from 'ant-design-vue';

type RapidItem = { name: string; size: number; sha256: string };

const form = reactive({
  parent_file_id: '',
  text: '',
});
const resultText = ref('');

function parseInput(text: string): RapidItem[] {
  const trimmed = (text || '').trim();
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
        name: String(o.name || o.path || o.file || ''),
        size: Number(o.size ?? o.length ?? o.file_size ?? o.filesize ?? o.bytes ?? 0),
        sha256: String(o.sha256 || o.hash || o.sha || '').toLowerCase(),
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
      const parts = line.split('|').map((p) => p.trim());
      if (parts.length < 3) throw new Error(`行格式错误: ${line}`);
      const name = String(parts[0] ?? '');
      const size = Number(parts[1] ?? 0);
      const sha = String(parts[2] ?? '').toLowerCase();
      return { name, size, sha256: sha };
    });
}

const beforeUpload = async (file: File) => {
  const txt = await file.text();
  try {
    const items = parseInput(txt);
    form.text = items.map((i: RapidItem) => `${i.name}|${i.size}|${i.sha256}`).join('\n');
    message.success(`已读取 ${items.length} 条`);
  } catch (e: any) {
    message.error(e?.message || '解析失败');
  }
  return false;
};

const submit = async () => {
  try {
    const items = parseInput(form.text);
    if (!form.parent_file_id.trim()) throw new Error('parent_file_id 不能为空');
    const res: any = await request.post('/api/mobile/rapid-upload', {
      parent_file_id: form.parent_file_id.trim(),
      items,
    });
    const resData: any = res || {};
    const results: any[] = Array.isArray(resData.results) ? resData.results : [];
    const lines = results.map((r: any) =>
      r.status === 'hit' ? `✅ ${r.name} -> ${r.file_id}` : `❌ ${r.name} -> ${r.error}`,
    );
    resultText.value = lines.join('\n');
    message.success('提交完成');
  } catch (e: any) {
    message.error(e?.message || '提交失败');
  }
};
</script>

<template>
  <Card title="秒传导入" :bordered="false">
    <p class="tip">支持 JSON 清单或每行 name|size|sha256；提交前可选择 parentFileId。</p>
    <Form layout="vertical">
      <Form.Item label="parent_file_id">
        <Input v-model:value="form.parent_file_id" placeholder="默认使用基础设置的 parentFileId，建议明确填写" />
      </Form.Item>
      <Form.Item label="清单">
        <Upload :before-upload="beforeUpload" :show-upload-list="false" accept=".json,.txt,.log">
          <Button>从文件导入</Button>
        </Upload>
        <Input.TextArea
          v-model:value="form.text"
          :rows="8"
          placeholder="示例：&#10;movie.mp4|60906485|6914d7d6f4f55808745ce82d7954c81f1f18cf75ea3e39931955599e2a22dcd6"
        />
      </Form.Item>
      <Button type="primary" @click="submit">提交秒传</Button>
    </Form>
    <pre class="result" v-if="resultText">{{ resultText }}</pre>
  </Card>
</template>

<style scoped>
.tip {
  color: #94a3b8;
  margin-bottom: 10px;
}
.result {
  margin-top: 12px;
  background: #0c1220;
  color: #e2e8f0;
  padding: 10px;
  border-radius: 10px;
  white-space: pre-wrap;
}
</style>
