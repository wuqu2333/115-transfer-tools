<template>
  <n-layout-sider
    class="glass-sidebar"
    :class="{ 'mobile-sidebar-open': showMobileMenu }"
    show-trigger
    collapse-mode="width"
    :collapsed-width="64"
    :width="260"
    :collapsed="sidebarCollapsed"
    :native-scrollbar="false"
    style="height: 100vh"
  >
    <div class="logo" :class="{ collapsed: sidebarCollapsed }">
      <BrandLogo
        :preset="sidebarCollapsed ? 'sidebar-compact' : 'sidebar'"
        :variant="sidebarCollapsed ? 'mark' : 'full'"
      />
      <div v-if="!sidebarCollapsed" class="logo-subtitle">115 Transfer Tools</div>
    </div>
    <n-menu
      :value="activeKey"
      @update:value="handleMenuSelect"
      :collapsed-width="64"
      :collapsed-icon-size="22"
      :options="menuOptions"
      :inverted="isDark"
    />
  </n-layout-sider>
</template>

<script setup lang="ts">
import BrandLogo from '@/components/Common/BrandLogo.vue'
import { useLayoutMenu } from '@/composables/useLayoutMenu'
import { useThemeStore } from '@/stores/theme'
import { storeToRefs } from 'pinia'

interface Props {
  showMobileMenu: boolean
  sidebarCollapsed: boolean
  onMenuSelect?: () => void
}

const props = defineProps<Props>()

const themeStore = useThemeStore()
const { isDark } = storeToRefs(themeStore)

const { activeKey, menuOptions, handleMenuSelect: baseHandleMenuSelect } = useLayoutMenu()

const handleMenuSelect = (key: string) => {
  baseHandleMenuSelect(key, props.onMenuSelect)
}
</script>

<style scoped>
@import '@/styles/sidebar.css';
</style>
