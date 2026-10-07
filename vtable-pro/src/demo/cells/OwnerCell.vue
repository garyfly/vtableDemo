<script setup lang="ts">
/** 负责人列：导入的自定义组件（头像 + 姓名） */
import { computed } from 'vue';

const props = defineProps<{ row: Record<string, any> }>();

const COLORS = ['#165DFF', '#00B42A', '#FF7D00', '#F53F3F', '#722ED1', '#0FC6C2', '#3491FA', '#F7BA1E'];

const color = computed(() => COLORS[(String(props.row.owner ?? '').charCodeAt(0) || 0) % COLORS.length]);
</script>

<template>
  <div class="vtp-cell-owner">
    <span class="vtp-cell-owner__avatar" :style="{ background: color }">{{ String(row.owner ?? '').slice(0, 1) }}</span>
    <span class="vtp-cell-owner__name">{{ row.owner }}</span>
  </div>
</template>

<style>
.vtp-cell-owner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.vtp-cell-owner__avatar {
  flex: 0 0 auto;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: #fff;
  font-size: 11px;
  line-height: 20px;
  text-align: center;
}
.vtp-cell-owner__name {
  font-size: 13px;
  color: #1d2129;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
