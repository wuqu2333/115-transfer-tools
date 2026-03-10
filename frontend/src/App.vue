<script setup lang="ts">
import { Layout, Menu } from 'ant-design-vue';
import { RouterView, useRouter } from 'vue-router';

const router = useRouter();
const menuItems = [
  { key: '/dashboard', label: '控制台' },
  { key: '/settings', label: '基础设置' },
  { key: '/browser', label: '源文件浏览' },
  { key: '/rapid', label: '秒传导入' },
  { key: '/tasks', label: '任务记录' },
];

const onMenuClick = (info: any) => {
  router.push(info.key);
};
</script>

<template>
  <Layout class="shell">
    <Layout.Sider theme="dark" width="200">
      <div class="brand">115 Transfer</div>
      <Menu
        theme="dark"
        mode="inline"
        :items="menuItems"
        :selectedKeys="[$route.path]"
        @click="onMenuClick"
      />
    </Layout.Sider>
    <Layout>
      <Layout.Header class="header">
        <div>自动转存 · OpenList / SharePoint / 139</div>
      </Layout.Header>
      <Layout.Content class="content">
        <RouterView />
      </Layout.Content>
    </Layout>
  </Layout>
</template>

<style scoped>
.shell {
  min-height: 100vh;
}
.brand {
  color: #e8ecf5;
  font-weight: 700;
  padding: 14px;
}
.header {
  background: #0f141f;
  color: #e8ecf5;
  display: flex;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid #1c2433;
}
.content {
  padding: 16px;
  background: #0b0f17;
}
</style>
