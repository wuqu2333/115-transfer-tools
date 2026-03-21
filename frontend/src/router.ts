import { createRouter, createWebHashHistory } from 'vue-router'
import Layout from './views/Layout.vue'
import Dashboard from './views/Dashboard.vue'
import SourceBrowser from './views/SourceBrowser.vue'
import Tasks from './views/Tasks.vue'
import RapidUpload from './views/RapidUpload.vue'
import Settings from './views/Settings.vue'

const routes = [
  {
    path: '/',
    component: Layout,
    redirect: '/dashboard',
    children: [
      { path: 'dashboard', name: 'dashboard', component: Dashboard, meta: { title: '仪表盘' } },
      { path: 'browser', name: 'browser', component: SourceBrowser, meta: { title: '源文件浏览' } },
      { path: 'tasks', name: 'tasks', component: Tasks, meta: { title: '任务记录' } },
      { path: 'rapid', name: 'rapid', component: RapidUpload, meta: { title: '秒传导入' } },
      { path: 'settings', name: 'settings', component: Settings, meta: { title: '基础设置' } },
    ],
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

router.afterEach((to) => {
  if (to.meta?.title) {
    document.title = `115 Transfer Tools · ${to.meta.title as string}`
  }
})

export default router
