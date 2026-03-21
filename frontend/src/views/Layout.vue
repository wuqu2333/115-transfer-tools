<template>
  <div class="layout" :class="backgroundClass" :style="backgroundStyle">
    <n-layout has-sider class="layout-container">
      <div class="mobile-menu-toggle" @click="toggleMobileMenu">
        <n-button quaternary circle size="large">
          <n-icon size="20">
            <MenuOutlined />
          </n-icon>
        </n-button>
      </div>

      <div v-if="showMobileMenu" class="mobile-menu-overlay" @click="closeMobileMenu"></div>

      <Sidebar
        :show-mobile-menu="showMobileMenu"
        :sidebar-collapsed="sidebarCollapsed"
        :on-menu-select="handleMenuSelectCallback"
      />

      <n-layout class="main-layout-shell">
        <Header />

        <n-layout-content
          class="main-content"
          content-style="padding: var(--layout-content-padding, clamp(16px, 3vw, 32px)); padding-bottom: var(--layout-content-bottom-padding, calc(var(--layout-footer-height, 48px) + env(safe-area-inset-bottom, 0px) + 24px));"
          :native-scrollbar="false"
        >
          <div class="page-shell page-stack">
            <router-view v-slot="{ Component }">
              <transition name="fade-slide" mode="out-in">
                <component :is="Component" />
              </transition>
            </router-view>
          </div>
        </n-layout-content>

        <Footer />
      </n-layout>
    </n-layout>
  </div>
</template>

<script setup lang="ts">
import { useLayoutResponsive } from '@/composables/useLayoutResponsive'
import { useLayoutBackground } from '@/composables/useLayoutBackground'
import Sidebar from '@/components/Layout/Sidebar.vue'
import Header from '@/components/Layout/Header.vue'
import Footer from '@/components/Layout/Footer.vue'
import { MenuOutlined } from '@vicons/antd'

const { showMobileMenu, sidebarCollapsed, toggleMobileMenu, closeMobileMenu } = useLayoutResponsive()
const { backgroundClass, backgroundStyle } = useLayoutBackground()

const handleMenuSelectCallback = () => {
  closeMobileMenu()
}
</script>

<style scoped>
@import '@/styles/layout.css';
</style>





