<template>
  <div class="card-header-center">
    <h2 class="card-title-center">
      <span v-if="emoji" class="title-emoji">{{ emoji }}</span>{{ title }}
    </h2>
    <p v-if="description" class="card-description-center">{{ description }}</p>
  </div>
</template>

<script setup lang="ts">
interface Props {
  title: string
  description?: string
  emoji?: string
}

withDefaults(defineProps<Props>(), {
  description: '',
  emoji: ''
})
</script>
