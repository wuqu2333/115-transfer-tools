import { createRouter, createWebHashHistory } from 'vue-router';

export const routes = [
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', component: () => import('./views/Dashboard.vue'), meta: { title: '控制台' } },
  { path: '/settings', component: () => import('./views/Settings.vue'), meta: { title: '基础设置' } },
  { path: '/tasks', component: () => import('./views/Tasks.vue'), meta: { title: '任务记录' } },
  { path: '/rapid', component: () => import('./views/RapidUpload.vue'), meta: { title: '秒传导入' } },
  { path: '/browser', component: () => import('./views/SourceBrowser.vue'), meta: { title: '源文件浏览' } },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

router.afterEach((to) => {
  if (to.meta?.title) {
    document.title = `115 Transfer · ${to.meta.title as string}`;
  }
});
