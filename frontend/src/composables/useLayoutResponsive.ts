/**
 * Layout 响应式管理 Composable
 */
import { ref, computed, watch } from 'vue'
import { useResponsive } from '@/composables/useResponsive'

export function useLayoutResponsive() {
  const showMobileMenu = ref(false)
  const { isMobile } = useResponsive()
  
  const sidebarCollapsed = computed(() => isMobile.value && !showMobileMenu.value)

  const toggleMobileMenu = () => {
    showMobileMenu.value = !showMobileMenu.value
  }
  
  const closeMobileMenu = () => {
    showMobileMenu.value = false
  }

  watch(isMobile, (mobile) => {
    if (!mobile) {
      showMobileMenu.value = false
    }
  }, { immediate: true })
  
  return {
    showMobileMenu,
    isMobile,
    sidebarCollapsed,
    toggleMobileMenu,
    closeMobileMenu
  }
}

