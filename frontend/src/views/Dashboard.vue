<template>
  <div class="dashboard">
    <a-card :bordered="false" class="hero-card">
      <div class="hero-content">
        <div>
          <p class="eyebrow">115 → 世纪互联 / 移动云盘</p>
          <h2>自动转存控制台</h2>
          <p>基于 OpenList 下载，后端负责上传与秒传，改名统一走 OpenList。</p>
          <div class="hero-actions">
            <router-link to="/settings">
              <a-button type="primary">设置</a-button>
            </router-link>
            <router-link to="/browser">
              <a-button>浏览源文件</a-button>
            </router-link>
            <router-link to="/rapid">
              <a-button type="default">秒传导入</a-button>
            </router-link>
          </div>
        </div>
        <div class="stats">
          <div class="stat">
            <span>下载策略</span>
            <strong>并发 3 · 2s 间隔</strong>
          </div>
          <div class="stat">
            <span>上传策略</span>
            <strong>伪后缀上传 + OpenList 重命名</strong>
          </div>
        </div>
      </div>
    </a-card>

    <div class="grid">
      <router-link to="/tasks">
        <a-card hoverable>
          <h3>任务记录</h3>
          <p>查看、重试、查看日志</p>
        </a-card>
      </router-link>
      <router-link to="/browser">
        <a-card hoverable>
          <h3>源文件浏览</h3>
          <p>选择 115 路径，批量入队</p>
        </a-card>
      </router-link>
      <router-link to="/rapid">
        <a-card hoverable>
          <h3>秒传导入</h3>
          <p>粘贴或导入 JSON 清单，一键秒传</p>
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
  background: linear-gradient(135deg, rgba(76, 130, 255, 0.12), rgba(34, 211, 238, 0.12));
}
.hero-content {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 16px;
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
}
.stat {
  background: rgba(0, 0, 0, 0.08);
  border-radius: 10px;
  padding: 10px 12px;
}
.stat span {
  color: #94a3b8;
  font-size: 12px;
}
.stat strong {
  display: block;
  margin-top: 6px;
}
.eyebrow {
  margin: 0;
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #c1d4ff;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 12px;
}
a {
  text-decoration: none;
}
</style>
