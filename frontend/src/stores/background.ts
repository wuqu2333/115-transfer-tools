import { defineStore } from 'pinia'
import { ref } from 'vue'

export type BackgroundType = 'gradient' | 'bing' | 'custom' | 'girl'

export const useBackgroundStore = defineStore('background', () => {
  const backgroundType = ref<BackgroundType>('gradient')
  const customImageUrl = ref('')
  const bingImageUrl = ref('')
  const girlImageUrl = ref('')
  const loading = ref(false)
  const initialized = ref(false)

  const loadSettings = async () => {
    if (initialized.value) return
    loading.value = true
    try {
      const saved = localStorage.getItem('background_settings')
      if (saved) {
        const data = JSON.parse(saved)
        backgroundType.value = data.type || 'gradient'
        customImageUrl.value = data.customUrl || ''
        bingImageUrl.value = data.bingUrl || ''
        girlImageUrl.value = data.girlUrl || ''
      }
    } catch {
      backgroundType.value = 'gradient'
    } finally {
      initialized.value = true
      loading.value = false
    }
  }

  const saveSettings = () => {
    localStorage.setItem(
      'background_settings',
      JSON.stringify({
        type: backgroundType.value,
        customUrl: customImageUrl.value,
        bingUrl: bingImageUrl.value,
        girlUrl: girlImageUrl.value,
      }),
    )
  }

  const setBackgroundType = async (type: BackgroundType) => {
    backgroundType.value = type
    saveSettings()
  }

  return {
    backgroundType,
    customImageUrl,
    bingImageUrl,
    girlImageUrl,
    loading,
    initialized,
    loadSettings,
    saveSettings,
    setBackgroundType,
  }
})
