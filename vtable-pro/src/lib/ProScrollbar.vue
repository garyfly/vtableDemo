<script setup lang="ts">
/**
 * 自绘滚动条：完全用 computeScrollMetrics() 算出来的几何量渲染。
 *
 * 这条滑块的位置 / 高度都不是浏览器给的，而是从表格内部读数换算的：
 *   滑块高 = max(28, 轨道高 × 视口 / 内容)
 *   滑块顶 = 轨道高 - 滑块高 再乘滚动进度
 * 拖动它 = 按进度反算 scrollTop 写回表格 —— 所以它同时也是「计算对不对」的验证：
 * 拖到底，表格必须停在最后一行。
 */
import { computed, onBeforeUnmount, ref } from 'vue';
import type { ScrollMetrics } from './types';

const props = defineProps<{ metrics: ScrollMetrics }>();
const emit = defineEmits<{ (e: 'scroll-to', progress: number): void }>();

const dragging = ref(false);

const travel = computed(() => Math.max(0, props.metrics.trackHeight - props.metrics.thumbHeight));

const thumbStyle = computed(() => ({
  height: `${props.metrics.thumbHeight}px`,
  transform: `translateY(${props.metrics.thumbTop}px)`,
}));

function onThumbDown(e: PointerEvent): void {
  dragging.value = true;
  const startY = e.clientY;
  const startTop = props.metrics.thumbTop;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);

  const move = (ev: PointerEvent) => {
    const t = travel.value;
    if (t <= 0) return;
    const top = Math.min(t, Math.max(0, startTop + (ev.clientY - startY)));
    emit('scroll-to', top / t);
  };
  const up = () => {
    dragging.value = false;
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

function onTrackDown(e: PointerEvent): void {
  // 点轨道空白：直接跳到那个位置
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const top = Math.min(travel.value, Math.max(0, e.clientY - rect.top - props.metrics.thumbHeight / 2));
  if (travel.value > 0) emit('scroll-to', top / travel.value);
}

onBeforeUnmount(() => (dragging.value = false));
</script>

<template>
  <div class="vtp-sb" data-custom-scrollbar @pointerdown.self="onTrackDown">
    <div class="vtp-sb__thumb" :class="{ dragging }" :style="thumbStyle" @pointerdown.stop="onThumbDown" />
  </div>
</template>

<style>
.vtp-sb {
  position: absolute;
  top: 42px;
  right: 0;
  bottom: 0;
  width: 10px;
  background: rgba(242, 243, 245, 0.6);
  border-radius: 5px;
  z-index: 20;
  touch-action: none;
}
.vtp-sb__thumb {
  width: 10px;
  border-radius: 5px;
  background: #c9cdd4;
  cursor: grab;
}
.vtp-sb__thumb:hover,
.vtp-sb__thumb.dragging {
  background: #86909c;
}
.vtp-sb__thumb.dragging {
  cursor: grabbing;
}
</style>
