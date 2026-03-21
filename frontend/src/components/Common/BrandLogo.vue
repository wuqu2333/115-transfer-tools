<template>
  <div class="brand-logo" :class="`preset-${preset}`">
    <div class="brand-logo-surface">
      <img
        class="brand-logo-image"
        :class="{ compact: preset === 'sidebar-compact' }"
        :src="src"
        :alt="altText"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

type BrandLogoVariant = 'full' | 'mark'
type BrandLogoPreset = 'sidebar' | 'sidebar-compact' | 'auth' | 'hero' | 'plugin'

interface Props {
  variant?: BrandLogoVariant
  preset?: BrandLogoPreset
  alt?: string
}

const props = withDefaults(defineProps<Props>(), {
  variant: 'full',
  preset: 'sidebar'
})

const src = computed(() => {
  return props.variant === 'mark' ? '/brand/cloud-strm-mark.svg' : '/brand/cloud-strm-logo.svg'
})

const altText = computed(() => {
  if (props.alt) return props.alt
  return props.variant === 'mark' ? 'Cloud STRM Mark' : 'Cloud STRM Logo'
})
</script>

<style scoped>
.brand-logo {
  display: flex;
  align-items: center;
  justify-content: center;
}

.brand-logo-surface {
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(255, 255, 255, 0.98);
}

.brand-logo-image {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
}

.brand-logo.preset-sidebar {
  width: 100%;
  max-width: 212px;
}

.brand-logo.preset-sidebar .brand-logo-surface {
  width: 100%;
  padding: 10px 12px;
  border-radius: 18px;
  box-shadow: 0 12px 28px rgba(12, 42, 89, 0.14);
}

.brand-logo.preset-sidebar .brand-logo-image {
  max-height: 56px;
}

.brand-logo.preset-sidebar-compact {
  width: 48px;
  height: 48px;
}

.brand-logo.preset-sidebar-compact .brand-logo-surface {
  width: 48px;
  height: 48px;
  padding: 6px;
  border-radius: 16px;
  box-shadow: 0 12px 24px rgba(12, 42, 89, 0.14);
}

.brand-logo.preset-sidebar-compact .brand-logo-image {
  width: 34px;
  height: 34px;
  max-height: none;
}

.brand-logo.preset-auth {
  width: min(100%, 286px);
}

.brand-logo.preset-auth .brand-logo-surface {
  width: 100%;
  padding: 12px 16px;
  border-radius: 24px;
  box-shadow: 0 18px 42px rgba(15, 23, 42, 0.28);
}

.brand-logo.preset-hero {
  width: min(100%, 310px);
}

.brand-logo.preset-hero .brand-logo-surface {
  width: 100%;
  padding: 14px 18px;
  border-radius: 24px;
  box-shadow: 0 18px 36px rgba(12, 42, 89, 0.12);
}

.brand-logo.preset-plugin {
  width: 54px;
  height: 54px;
}

.brand-logo.preset-plugin .brand-logo-surface {
  width: 54px;
  height: 54px;
  padding: 8px;
  border-radius: 18px;
  box-shadow: 0 10px 22px rgba(12, 42, 89, 0.12);
}

.brand-logo.preset-plugin .brand-logo-image {
  width: 38px;
  height: 38px;
  max-height: none;
}

@media (max-width: 768px) {
  .brand-logo.preset-sidebar {
    max-width: 176px;
  }

  .brand-logo.preset-sidebar-compact {
    width: 44px;
    height: 44px;
  }

  .brand-logo.preset-sidebar-compact .brand-logo-surface {
    width: 44px;
    height: 44px;
  }

  .brand-logo.preset-sidebar .brand-logo-image {
    max-height: 46px;
  }
}
</style>
