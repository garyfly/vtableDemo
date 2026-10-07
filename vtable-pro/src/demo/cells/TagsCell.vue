<script setup lang="ts">
/** 标签列：导入的自定义组件（多个小标签） */
defineProps<{ row: Record<string, any> }>();
</script>

<template>
  <div class="vtp-cell-tags">
    <span v-for="t in (row.tags as string[])" :key="t" class="vtp-cell-tags__tag">{{ t }}</span>
  </div>
</template>

<style>
.vtp-cell-tags {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 10px;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.vtp-cell-tags__tag {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  background: #f2f3f5;
  color: #4e5969;
  font-size: 11px;
  white-space: nowrap;
}
</style>
