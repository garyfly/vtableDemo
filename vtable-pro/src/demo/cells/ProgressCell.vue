<script setup lang="ts">
/** 进度列：导入的自定义组件（进度条 + 百分比） */
import { computed } from 'vue';

const props = defineProps<{ row: Record<string, any> }>();

const pct = computed(() => Math.max(0, Math.min(100, Number(props.row.progress) || 0)));
const color = computed(() => (pct.value >= 100 ? '#00B42A' : pct.value >= 60 ? '#165DFF' : pct.value >= 30 ? '#FF7D00' : '#F53F3F'));
</script>

<template>
  <div class="vtp-cell-progress">
    <span class="vtp-cell-progress__track"><i class="vtp-cell-progress__fill" :style="{ width: pct + '%', background: color }" /></span>
    <span class="vtp-cell-progress__text">{{ pct }}%</span>
  </div>
</template>

<style>
.vtp-cell-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.vtp-cell-progress__track {
  flex: 1 1 auto;
  height: 8px;
  border-radius: 4px;
  background: #edeff2;
  overflow: hidden;
}
.vtp-cell-progress__fill {
  display: block;
  height: 100%;
  border-radius: 4px;
}
.vtp-cell-progress__text {
  flex: 0 0 34px;
  font-size: 12px;
  color: #4e5969;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
</style>
