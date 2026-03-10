<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { request } from '../api/request';
import { Button, Card, Table, Tag, message } from 'ant-design-vue';

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

const columns = [
  { title: 'ID', dataIndex: 'id', width: 70 },
  { title: '目标', dataIndex: 'provider' },
  { title: '状态', dataIndex: 'status' },
  { title: '进度', dataIndex: 'progress' },
  { title: '当前项', dataIndex: 'current_item' },
  { title: '消息', dataIndex: 'message' },
  { title: '创建时间', dataIndex: 'created_at' },
  {
    title: '操作',
    dataIndex: 'action',
  },
];

const dataSource = ref<TaskRow[]>([]);
const loading = ref(false);
const activeLog = ref<string[]>([]);

async function loadTasks() {
  loading.value = true;
  try {
    const res = (await request.get<any[]>('/api/tasks?limit=120')) as any;
    const arr: any[] = Array.isArray(res) ? res : [];
    dataSource.value = arr.map((t: any) => ({
      key: t.id,
      id: t.id,
      provider: t.provider,
      status: t.status,
      progress: t.total_files > 0 ? `${t.processed_files}/${t.total_files}` : `${t.processed_files}/-`,
      current_item: t.current_item,
      message: t.message,
      created_at: t.created_at,
      logs: t.logs || [],
    }));
  } finally {
    loading.value = false;
  }
}

async function retryTask(id: number) {
  await request.post(`/api/tasks/${id}/retry`);
  message.success(`任务 #${id} 已重试`);
  loadTasks();
}

function showLog(record: TaskRow) {
  activeLog.value = record.logs || [];
}

function statusTag(status: string) {
  const map: Record<string, string> = { success: 'green', failed: 'red', running: 'blue', pending: 'default' };
  return map[status] || 'default';
}

onMounted(loadTasks);
</script>

<template>
  <Card title="任务记录" :bordered="false">
    <div class="list-actions">
      <Button @click="loadTasks">刷新</Button>
    </div>
    <Table :columns="columns" :data-source="dataSource" :loading="loading" size="small" row-key="id">
      <template #bodyCell="{ column, record }">
        <template v-if="column.dataIndex === 'status'">
          <Tag :color="statusTag((record as any).status)">{{ (record as any).status }}</Tag>
        </template>
        <template v-else-if="column.dataIndex === 'action'">
          <Button size="small" @click="() => showLog(record as any)" style="margin-right: 8px">日志</Button>
          <Button size="small" @click="() => retryTask((record as any).id)">重试</Button>
        </template>
        <template v-else>
          {{ (record as any)[column.dataIndex as string] }}
        </template>
      </template>
    </Table>
    <Card style="margin-top: 12px" size="small" title="任务日志">
      <pre class="log-view">{{ activeLog.join('\n') || '点击“日志”查看任务输出' }}</pre>
    </Card>
  </Card>
</template>

<style scoped>
.list-actions {
  margin-bottom: 10px;
  display: flex;
  gap: 8px;
}
.log-view {
  max-height: 280px;
  overflow: auto;
  white-space: pre-wrap;
  background: #0c1220;
  color: #e2e8f0;
  padding: 10px;
  border-radius: 10px;
}
</style>
