<template>
  <n-layout-header class="glass-header">
    <div class="header-center">
      <h2 class="page-title-center">{{ pageTitle }}</h2>
      <p class="page-subtitle-center">{{ pageSubtitle }}</p>
    </div>
    <div class="header-right">
      <n-space :size="12">
        <n-button @click="toggleTheme" quaternary circle size="large" class="theme-toggle">
          <n-icon size="20">
            <component :is="isDark ? BulbFilled : BulbOutlined" />
          </n-icon>
        </n-button>
      </n-space>
    </div>
  </n-layout-header>
</template>

<script setup lang="ts">
import { useLayoutMenu } from '@/composables/useLayoutMenu'
import { useThemeStore } from '@/stores/theme'
import { storeToRefs } from 'pinia'
import { BulbFilled, BulbOutlined } from '@vicons/antd'

const { pageTitle, pageSubtitle } = useLayoutMenu()
const themeStore = useThemeStore()
const { isDark } = storeToRefs(themeStore)

const toggleTheme = () => {
  themeStore.toggleTheme()
}
</script>

<style scoped>
@import '@/styles/header.css';
</style>
