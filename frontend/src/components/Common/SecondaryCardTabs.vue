<template>
  <div class="secondary-card-tabs" :style="rootStyle">
    <div class="subnav-grid" role="tablist" aria-label="页面分区导航">
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        class="subnav-item"
        :class="{ 'is-active': modelValue === item.key }"
        role="tab"
        :aria-selected="modelValue === item.key"
        @click="handleChange(item.key)"
      >
        <span class="subnav-icon">{{ item.icon }}</span>
        <span class="subnav-copy">
          <span class="subnav-title">{{ item.title }}</span>
          <span class="subnav-desc">{{ item.desc }}</span>
        </span>
      </button>
    </div>

    <div class="tab-panel">
      <slot />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'

export interface SecondaryCardTabItem {
  key: string
  title: string
  desc: string
  icon: string
}

interface Props {
  modelValue: string
  items: SecondaryCardTabItem[]
  maxColumns?: number
  tabletColumns?: number
  panelPadding?: string
}

const props = withDefaults(defineProps<Props>(), {
  maxColumns: 4,
  tabletColumns: 2,
  panelPadding: '12px'
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

const safeColumns = computed(() => Math.max(1, Math.min(6, Number(props.maxColumns) || 4)))
const safeTabletColumns = computed(() => Math.max(1, Math.min(4, Number(props.tabletColumns) || 2)))

const rootStyle = computed(() => ({
  '--secondary-tabs-columns': String(safeColumns.value),
  '--secondary-tabs-tablet-columns': String(safeTabletColumns.value),
  '--secondary-tabs-panel-padding': props.panelPadding
}))

const handleChange = (value: string) => {
  if (value !== props.modelValue) {
    emit('update:modelValue', value)
  }
}
</script>

<style scoped>
.secondary-card-tabs {
  width: 100%;
}

.subnav-grid {
  display: grid;
  grid-template-columns: repeat(var(--secondary-tabs-columns), minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 14px;
}

.subnav-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  width: 100%;
  text-align: left;
  border: 1px solid #d6d9e0;
  background: linear-gradient(145deg, #ffffff 0%, #f7f9fc 100%);
  border-radius: 14px;
  padding: 12px 14px;
  cursor: pointer;
  transition: all 0.22s ease;
}

.subnav-item:hover {
  border-color: #9aa7bd;
  transform: translateY(-1px);
  box-shadow: 0 8px 20px rgba(19, 47, 87, 0.08);
}

.subnav-item.is-active {
  border-color: #2f73ff;
  background: linear-gradient(145deg, #eef4ff 0%, #f7fbff 100%);
  box-shadow: 0 10px 22px rgba(47, 115, 255, 0.2);
}

.subnav-icon {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #ffffff;
  border: 1px solid #dce4f0;
  font-size: 16px;
}

.subnav-copy {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.subnav-title {
  font-size: 14px;
  font-weight: 700;
  color: #1f2a44;
  line-height: 1.2;
}

.subnav-desc {
  font-size: 12px;
  color: #66748f;
  line-height: 1.35;
}

.tab-panel {
  border: 1px solid #e1e6ef;
  border-radius: 16px;
  padding: var(--secondary-tabs-panel-padding);
  background:
    radial-gradient(circle at top right, rgba(46, 115, 255, 0.08), transparent 45%),
    linear-gradient(180deg, #ffffff 0%, #f9fbff 100%);
}

.tab-panel :deep(.tab-section) {
  min-height: 220px;
}

@media (max-width: 980px) {
  .subnav-grid {
    grid-template-columns: repeat(var(--secondary-tabs-tablet-columns), minmax(0, 1fr));
  }
}

@media (max-width: 640px) {
  .subnav-grid {
    grid-template-columns: 1fr;
  }
}
</style>
