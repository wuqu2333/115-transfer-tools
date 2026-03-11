<script setup lang="ts">
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
  },
};
</script>

<template>
  <div class="dashboard">
    <a-card :bordered="false" class="hero-card">
      <div class="hero-content">
        <div>
          <p class="eyebrow">{{ text.eyebrow }}</p>
          <h2 class="title">{{ text.title }}</h2>
          <p class="desc">{{ text.desc }}</p>
          <div class="hero-actions">
            <router-link to="/settings">
              <a-button type="primary">{{ text.actions.settings }}</a-button>
            </router-link>
            <router-link to="/browser">
              <a-button>{{ text.actions.browser }}</a-button>
            </router-link>
            <router-link to="/rapid">
              <a-button type="default">{{ text.actions.rapid }}</a-button>
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
    </a-card>

    <div class="grid">
      <router-link to="/tasks">
        <a-card hoverable>
          <h3>{{ text.cards.tasksTitle }}</h3>
          <p>{{ text.cards.tasksDesc }}</p>
        </a-card>
      </router-link>
      <router-link to="/browser">
        <a-card hoverable>
          <h3>{{ text.cards.browserTitle }}</h3>
          <p>{{ text.cards.browserDesc }}</p>
        </a-card>
      </router-link>
      <router-link to="/rapid">
        <a-card hoverable>
          <h3>{{ text.cards.rapidTitle }}</h3>
          <p>{{ text.cards.rapidDesc }}</p>
        </a-card>
      </router-link>
    </div>
  </div>
</template>

<style scoped>
.dashboard {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.hero-card {
  position: relative;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(15, 118, 110, 0.18), rgba(37, 99, 235, 0.16));
  border: 1px solid var(--border);
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
  color: var(--muted);
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
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 12px 14px;
  box-shadow: var(--shadow-2);
}
.stat span {
  color: var(--muted);
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
  color: var(--accent-2);
  font-weight: 600;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
a {
  text-decoration: none;
}
:deep(.ant-card) {
  transition: transform 0.2s ease, box-shadow 0.2s ease;
}
:deep(.ant-card:hover) {
  transform: translateY(-2px);
  box-shadow: var(--shadow-1);
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

