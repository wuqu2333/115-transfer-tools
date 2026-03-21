<template>
  <n-layout-footer class="glass-footer">
    <n-text depth="3" class="footer-text">© {{ year }} 115 Transfer Tools</n-text>
  </n-layout-footer>
</template>

<script setup lang="ts">
const year = new Date().getFullYear()
</script>

<style scoped>
@import '@/styles/footer.css';
</style>
