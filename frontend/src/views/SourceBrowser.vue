<script setup lang="ts">
import { onMounted, ref, computed } from 'vue';
import { request } from '../api/request';
import { Button, Card, Input, Table } from 'ant-design-vue';

interface BrowserItem {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified?: string;
}

const path = ref('/115');
const items = ref<BrowserItem[]>([]);
const selected = ref<Set<string>>(new Set());
const loading = ref(false);

const columns = [
  { title: '名称', dataIndex: 'name' },
  { title: '大小', dataIndex: 'size' },
  { title: '修改时间', dataIndex: 'modified' },
  { title: '操作', dataIndex: 'action', width: 140 },
];

const selectedList = computed(() => Array.from(selected.value));

async function load(p?: string) {
  loading.value = true;
  try {
    const res: any = await request.post('/api/openlist/list', {
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
  const parts = path.value.split('/').filter(Boolean);
  parts.pop();
  const parent = '/' + parts.join('/');
  load(parent || '/');
}

onMounted(() => load());
</script>

<template>
  <Card title="源文件浏览" :bordered="false">
    <div class="path-row">
      <Input v-model:value="path" />
      <Button @click="() => load(path as any)">跳转</Button>
      <Button @click="goParent">上一级</Button>
    </div>
    <Table :data-source="items" :columns="columns" :loading="loading" row-key="path" size="small">
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'name'">
          <span>{{ (record as any).is_dir ? '📁 ' : '📄 ' }}{{ (record as any).name }}</span>
        </template>
        <template v-else-if="column.dataIndex === 'action'">
          <Button size="small" @click="() => enter(record as any)">{{ (record as any).is_dir ? '进入' : '选中' }}</Button>
          <Button size="small" @click="() => toggle(record as any)" style="margin-left: 6px">
            {{ selected.has((record as any).path) ? '取消' : '多选' }}
          </Button>
        </template>
        <template v-else>
          {{ (record as any)[column.dataIndex as string] ?? '-' }}
        </template>
      </template>
    </Table>
    <Card size="small" title="已选路径" style="margin-top: 10px">
      <div class="selected-box">
        <span v-for="p in selectedList" :key="p" class="pill">
          {{ p }}
          <button @click="selected.delete(p)">x</button>
        </span>
      </div>
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
  border: 1px solid #1c2433;
  padding: 4px 8px;
}
.pill button {
  background: transparent;
  border: none;
  cursor: pointer;
}
</style>
