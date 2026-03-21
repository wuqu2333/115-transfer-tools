<script setup lang="ts">
import { onMounted, ref } from "vue";
import { request } from "../api/request";

const text = {
  eyebrow: "115 -> 世纪互联 / 移动云盘",
  title: "自动转存控制台",
  desc: "基于 OpenList 下载，后端负责上传与秒传，改名统一走 OpenList。",
  actions: {
    settings: "设置",
    browser: "浏览源文件",
    rapid: "秒传导入",
  },
  stats: {
    downloadLabel: "下载策略",
    downloadValue: "并发 3 路 / 2 秒间隔",
    uploadLabel: "上传策略",
    uploadValue: "图片伪后缀上传 + OpenList 重命名",
  },
  cards: {
    tasksTitle: "任务记录",
    tasksDesc: "查看、重试、查看日志",
    browserTitle: "源文件浏览",
    browserDesc: "选择 115 路径，批量入列",
    rapidTitle: "秒传导入",
    rapidDesc: "粘贴或导入 JSON 清单，一键秒传",
    settingsTitle: "基础设置",
    settingsDesc: "连接信息与参数配置",
  },
};

const storageLoading = ref(false);
const storageError = ref("");
const storageItems = ref<any[]>([]);
const storageUpdatedAt = ref("");
const metricsLoading = ref(false);
const metricsError = ref("");
const metrics = ref<any>(null);

function formatTB(bytes?: number | null) {
  if (!bytes || bytes <= 0) return "0.00TB";
  const tb = bytes / 1024 ** 4;
  return `${tb.toFixed(2)}TB`;
}

function formatGB(bytes?: number | null) {
  if (!bytes || bytes <= 0) return "0.00GB";
  const gb = bytes / 1024 ** 3;
  return `${gb.toFixed(2)}GB`;
}

function getItem(type: string) {
  return storageItems.value.find((it: any) => it?.type === type);
}

function usagePercent(item: any) {
  if (!item || !item.total || item.total <= 0 || item.used === null || item.used === undefined) return null;
  const pct = Math.round((Number(item.used) / Number(item.total)) * 100);
  return Math.min(100, Math.max(0, pct));
}

function formatUsage(item: any) {
  if (!item) return "未找到挂载点";
  if (item.status === "missing") return item.message || "未配置";
  if (item.status === "error") return item.message || "获取失败";
  if (item.total === null && item.used === null) return "未能获取空间";
  if (item.total === null || item.total === undefined) {
    return `${formatTB(item.used)} / 未知`;
  }
  if (item.used === null || item.used === undefined) {
    return `未知 / ${formatTB(item.total)}`;
  }
  const pct = usagePercent(item);
  const pctLabel = pct === null ? "" : ` (${pct}%)`;
  return `${formatTB(item.used)} / ${formatTB(item.total)}${pctLabel}`;
}

function formatTime(value: string) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString();
}

async function loadStorage() {
  storageLoading.value = true;
  storageError.value = "";
  try {
    const res: any = await request.get("/api/system/storage");
    storageItems.value = Array.isArray(res?.items) ? res.items : [];
    storageUpdatedAt.value = res?.updated_at || "";
  } catch (e: any) {
    storageError.value = e?.message || "获取空间信息失败";
  } finally {
    storageLoading.value = false;
  }
}

async function loadMetrics() {
  metricsLoading.value = true;
  metricsError.value = "";
  try {
    const res: any = await request.get("/api/system/metrics");
    metrics.value = res || null;
  } catch (e: any) {
    metricsError.value = e?.message || "获取系统信息失败";
  } finally {
    metricsLoading.value = false;
  }
}

onMounted(() => {
  loadStorage();
  loadMetrics();
});
</script>

<template>
  <div class="page-stack">
    <n-card class="modern-card hero-card" :bordered="false">
      <div class="hero-content">
        <div>
          <p class="eyebrow">{{ text.eyebrow }}</p>
          <h2 class="title">{{ text.title }}</h2>
          <p class="desc">{{ text.desc }}</p>
          <div class="hero-actions">
            <router-link to="/settings">
              <n-button type="primary">{{ text.actions.settings }}</n-button>
            </router-link>
            <router-link to="/browser">
              <n-button secondary>{{ text.actions.browser }}</n-button>
            </router-link>
            <router-link to="/rapid">
              <n-button>{{ text.actions.rapid }}</n-button>
            </router-link>
          </div>
        </div>
        <div class="stats">
          <div class="stat">
            <span>{{ text.stats.downloadLabel }}</span>
            <strong>{{ text.stats.downloadValue }}</strong>
          </div>
          <div class="stat">
            <span>{{ text.stats.uploadLabel }}</span>
            <strong>{{ text.stats.uploadValue }}</strong>
          </div>
        </div>
      </div>
    </n-card>

    <n-card class="modern-card storage-card" :bordered="false">
      <div class="storage-header">
        <h3>网盘空间</h3>
        <div class="storage-actions">
          <n-button size="tiny" secondary :loading="storageLoading" @click="loadStorage">刷新</n-button>
        </div>
      </div>
      <div class="storage-grid">
        <div class="storage-item">
          <span>115 网盘</span>
          <strong>{{ formatUsage(getItem("115")) }}</strong>
          <n-progress
            v-if="usagePercent(getItem('115')) !== null"
            type="line"
            :percentage="usagePercent(getItem('115')) || 0"
            :show-indicator="false"
            :height="6"
          />
        </div>
        <div class="storage-item">
          <span>世纪互联</span>
          <strong>{{ formatUsage(getItem("sharepoint")) }}</strong>
          <n-progress
            v-if="usagePercent(getItem('sharepoint')) !== null"
            type="line"
            :percentage="usagePercent(getItem('sharepoint')) || 0"
            :show-indicator="false"
            :height="6"
          />
        </div>
      </div>
      <div v-if="storageUpdatedAt" class="storage-meta">
        更新时间：{{ formatTime(storageUpdatedAt) }}
      </div>
      <div v-if="storageError" class="storage-meta storage-error">
        {{ storageError }}
      </div>
    </n-card>

    <n-card class="modern-card metrics-card" :bordered="false">
      <div class="storage-header">
        <h3>系统资源</h3>
        <div class="storage-actions">
          <n-button size="tiny" secondary :loading="metricsLoading" @click="loadMetrics">刷新</n-button>
        </div>
      </div>
      <div class="storage-grid">
        <div class="storage-item">
          <span>CPU</span>
          <strong>{{ metrics?.cpu ? metrics.cpu.usage_percent + "%" : "-" }}</strong>
        </div>
        <div class="storage-item">
          <span>内存</span>
          <strong v-if="metrics?.memory">
            {{ formatGB(metrics.memory.used) }} / {{ formatGB(metrics.memory.total) }}
            ({{ metrics.memory.usage_percent }}%)
          </strong>
          <strong v-else>-</strong>
        </div>
        <div class="storage-item">
          <span>磁盘</span>
          <strong v-if="metrics?.disk">
            {{ formatGB(metrics.disk.used) }} / {{ formatGB(metrics.disk.total) }}
            ({{ metrics.disk.usage_percent }}%)
          </strong>
          <strong v-else>-</strong>
        </div>
      </div>
      <div v-if="metricsError" class="storage-meta storage-error">
        {{ metricsError }}
      </div>
    </n-card>

    <div class="grid">
      <router-link to="/tasks">
        <n-card class="modern-card quick-card" :bordered="false">
          <h3>{{ text.cards.tasksTitle }}</h3>
          <p>{{ text.cards.tasksDesc }}</p>
        </n-card>
      </router-link>
      <router-link to="/browser">
        <n-card class="modern-card quick-card" :bordered="false">
          <h3>{{ text.cards.browserTitle }}</h3>
          <p>{{ text.cards.browserDesc }}</p>
        </n-card>
      </router-link>
      <router-link to="/rapid">
        <n-card class="modern-card quick-card" :bordered="false">
          <h3>{{ text.cards.rapidTitle }}</h3>
          <p>{{ text.cards.rapidDesc }}</p>
        </n-card>
      </router-link>
      <router-link to="/settings">
        <n-card class="modern-card quick-card" :bordered="false">
          <h3>{{ text.cards.settingsTitle }}</h3>
          <p>{{ text.cards.settingsDesc }}</p>
        </n-card>
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.hero-card {
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(15, 118, 110, 0.18), rgba(37, 99, 235, 0.16));
  border: 1px solid var(--ui-border-light);
}
.hero-card::before {
  content: "";
  position: absolute;
  width: 320px;
  height: 320px;
  right: -120px;
  top: -140px;
  background: radial-gradient(circle, rgba(249, 115, 22, 0.3), transparent 70%);
  opacity: 0.7;
}
.hero-content {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
  position: relative;
  z-index: 1;
}
.title {
  margin: 8px 0 6px;
  font-size: 30px;
  letter-spacing: 0.01em;
}
.desc {
  color: var(--ui-text-secondary-light);
  margin: 0;
  max-width: 520px;
}
.hero-actions {
  margin-top: 14px;
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.stats {
  display: grid;
  gap: 10px;
  align-content: start;
}
.stat {
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid var(--ui-border-light);
  border-radius: 14px;
  padding: 12px 14px;
  box-shadow: var(--ui-shadow-card);
}
.stat span {
  color: var(--ui-text-secondary-light);
  font-size: 12px;
}
.stat strong {
  display: block;
  margin-top: 6px;
  font-size: 14px;
}
.eyebrow {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ui-accent);
  font-weight: 600;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
.storage-card {
  border: 1px solid var(--ui-border-light);
  background: rgba(255, 255, 255, 0.88);
}
.storage-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}
.storage-header h3 {
  margin: 0;
  font-size: 16px;
}
.storage-actions {
  display: flex;
  gap: 8px;
}
.storage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
.storage-item {
  border: 1px solid var(--ui-border-light);
  border-radius: 12px;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.7);
  display: grid;
  gap: 8px;
}
.storage-item span {
  font-size: 12px;
  color: var(--ui-text-secondary-light);
}
.storage-item strong {
  font-size: 14px;
}
.storage-meta {
  margin-top: 10px;
  font-size: 12px;
  color: var(--ui-text-secondary-light);
}
.storage-error {
  color: #b42318;
}
.quick-card p {
  color: var(--ui-text-secondary-light);
}
a {
  text-decoration: none;
}
@media (max-width: 960px) {
  .hero-content {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 720px) {
  .title {
    font-size: 24px;
  }
}
</style>
