<script setup lang="ts">
import { Layout, Menu, Drawer, Button } from "ant-design-vue";
import { MenuOutlined } from "@ant-design/icons-vue";
import { RouterView, useRouter } from "vue-router";
import { ref } from "vue";

const router = useRouter();
const drawerOpen = ref(false);
const text = {
  brand: "115 转存",
  brandSub: "OpenList / SharePoint / 139",
  headerTitle: "自动转存控制台",
  headerSub:
    "一键搬运 · 图片伪后缀上传 · OpenList 重命名",
  menu: {
    dashboard: "控制台",
    settings: "基础设置",
    browser: "源文件浏览",
    rapid: "秒传导入",
    tasks: "任务记录",
  },
};

const menuItems = [
  { key: "/dashboard", label: text.menu.dashboard },
  { key: "/settings", label: text.menu.settings },
  { key: "/browser", label: text.menu.browser },
  { key: "/rapid", label: text.menu.rapid },
  { key: "/tasks", label: text.menu.tasks },
];

const onMenuClick = (info: any) => {
  router.push(info.key);
};

const openDrawer = () => {
  drawerOpen.value = true;
};

const closeDrawer = () => {
  drawerOpen.value = false;
};
</script>

<template>
  <Layout class="shell">
    <Layout.Sider class="sider" theme="light" width="220" breakpoint="lg" collapsedWidth="0">
      <div class="brand">
        <div class="brand-title">{{ text.brand }}</div>
        <div class="brand-sub">{{ text.brandSub }}</div>
      </div>
      <Menu
        theme="light"
        mode="inline"
        :items="menuItems"
        :selectedKeys="[$route.path]"
        @click="onMenuClick"
      />
    </Layout.Sider>
    <Layout class="main">
      <Layout.Header class="header">
        <div class="header-left">
          <Button class="mobile-menu-btn" type="text" @click="openDrawer">
            <MenuOutlined />
          </Button>
          <div>
            <div class="header-title">{{ text.headerTitle }}</div>
            <div class="header-sub">{{ text.headerSub }}</div>
          </div>
        </div>
      </Layout.Header>
      <Layout.Content class="content">
        <div class="content-inner">
          <RouterView />
        </div>
      </Layout.Content>
    </Layout>
  </Layout>

  <Drawer placement="left" width="220" :open="drawerOpen" @close="closeDrawer" :bodyStyle="{ padding: '12px 0' }">
    <div class="brand drawer-brand">
      <div class="brand-title">{{ text.brand }}</div>
      <div class="brand-sub">{{ text.brandSub }}</div>
    </div>
    <Menu
      theme="light"
      mode="inline"
      :items="menuItems"
      :selectedKeys="[$route.path]"
      @click="(info) => { onMenuClick(info); closeDrawer(); }"
    />
  </Drawer>
</template>

<style scoped>
.shell {
  min-height: 100vh;
}
.sider {
  border-right: 1px solid var(--border);
}
.brand {
  padding: 18px 16px 12px;
}
.drawer-brand {
  padding: 12px 16px 8px;
}
.brand-title {
  color: var(--text);
  font-weight: 800;
  font-size: 18px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.brand-sub {
  color: var(--muted);
  font-size: 12px;
  margin-top: 4px;
}
.header {
  background: rgba(255, 255, 255, 0.72);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border);
  height: auto;
  min-height: 70px;
  position: sticky;
  top: 0;
  z-index: 20;
  backdrop-filter: blur(10px);
}
.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.header-title {
  font-size: 18px;
  font-weight: 700;
  line-height: 1.2;
}
.header-sub {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.3;
  white-space: normal;
}
.content {
  padding: 22px;
}
.content-inner {
  max-width: 1200px;
  margin: 0 auto;
}
.mobile-menu-btn {
  display: none;
}
@media (max-width: 992px) {
  .mobile-menu-btn {
    display: inline-flex;
  }
  .header {
    min-height: 64px;
  }
}
@media (max-width: 720px) {
  .header-sub {
    display: none;
  }
  .content {
    padding: 14px;
  }
}
</style>

