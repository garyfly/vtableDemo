<script setup lang="ts">
/** 状态列：导入的自定义组件（彩色胶囊标签） */
import { computed } from 'vue';

const props = defineProps<{ row: Record<string, any> }>();

const MAP: Record<string, { bg: string; fg: string }> = {
  待处理: { bg: '#FFF7E8', fg: '#FF7D00' },
  进行中: { bg: '#E8F0FF', fg: '#165DFF' },
  待审核: { bg: '#F5E8FF', fg: '#722ED1' },
  已完成: { bg: '#E8FFEA', fg: '#00B42A' },
  已关闭: { bg: '#F2F3F5', fg: '#86909C' },
};

const tone = computed(() => MAP[String(props.row.status)] ?? { bg: '#F2F3F5', fg: '#4E5969' });
</script>

<template>
  <div class="vtp-cell-status">
    <span class="vtp-cell-status__pill" :style="{ background: tone.bg, color: tone.fg }">{{ row.status }}</span>
  </div>
</template>

<style>
.vtp-cell-status {
  display: flex;
  align-items: center;
  padding: 0 10px;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.vtp-cell-status__pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border-radius: 10px;
  font-size: 12px;
  white-space: nowrap;
}
</style>
