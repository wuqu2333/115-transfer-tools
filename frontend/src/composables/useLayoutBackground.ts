import { computed, onMounted } from 'vue'
import { useBackgroundStore } from '@/stores/background'
import { storeToRefs } from 'pinia'

export function useLayoutBackground() {
  const backgroundStore = useBackgroundStore()
  const { backgroundType, customImageUrl, bingImageUrl, girlImageUrl } = storeToRefs(backgroundStore)

  const backgroundClass = computed(() => {
    if (backgroundType.value === 'gradient') {
      return 'animated-bg'
    }
    return ''
  })

  const backgroundStyle = computed(() => {
    if (backgroundType.value === 'bing' && bingImageUrl.value) {
      return {
        backgroundImage: `url(${bingImageUrl.value})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      }
    }
    if (backgroundType.value === 'custom' && customImageUrl.value) {
      return {
        backgroundImage: `url(${customImageUrl.value})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      }
    }
    if (backgroundType.value === 'girl' && girlImageUrl.value) {
      return {
        backgroundImage: `url(${girlImageUrl.value})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundAttachment: 'fixed',
      }
    }
    return {}
  })

  onMounted(async () => {
    await backgroundStore.loadSettings()
  })

  return {
    backgroundClass,
    backgroundStyle,
  }
}
