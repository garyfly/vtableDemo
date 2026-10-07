<script setup lang="ts">
/**
 * 内置工具栏。
 *
 * 需求里的「工具栏上能拿到当前表格勾选的行」就落在这里：
 * 工具栏通过 inject 拿到表格句柄，点「获取勾选行」时调 `getCheckedRows()`。
 * 注意这一步是**显式**的 —— 勾选状态本身只是 SelectionModel 里的一个模式位 +
 * 一小组 key，不点这个按钮就永远不会把 10 万行展开成数组。
 */
import { computed } from 'vue';
import { useProTable } from './context';
import type { ScrollMetrics } from './types';

const props = defineProps<{
  total: number;
  filtered: number;
  selected: number;
  allSelected: boolean;
  indeterminate: boolean;
  chips: { field: string; title: string; text: string }[];
  viewMs: number;
  metrics: ScrollMetrics | null;
  customScrollbar: boolean;
}>();

const emit = defineEmits<{
  (e: 'select-all'): void;
  (e: 'invert'): void;
  (e: 'clear-selection'): void;
  (e: 'clear-filters'): void;
  (e: 'remove-filter', field: string): void;
  (e: 'query-selection', rows: unknown[]): void;
  (e: 'toggle-scrollbar', on: boolean): void;
  (e: 'scroll-to', progress: number): void;
}>();

const api = useProTable();

const pct = computed(() => {
  const m = props.metrics;
  if (!m || m.maxScrollTop <= 0) return 0;
  return (m.scrollTop / m.maxScrollTop) * 100;
});

function querySelection(): void {
  // 工具栏直接读表格句柄：只有点了这里才会真的把勾选行展开成数组
  emit('query-selection', api.getCheckedRows());
}
</script>

<template>
  <div class="vtp-bar">
    <slot name="left" />

    <div class="vtp-bar__stats">
      <span class="vtp-bar__stat" data-stat="total">共 <b>{{ total.toLocaleString() }}</b> 行</span>
      <span v-if="filtered !== total" class="vtp-bar__stat" data-stat="filtered">筛选后 <b>{{ filtered.toLocaleString() }}</b> 行</span>
      <span class="vtp-bar__stat" data-stat="selected">已勾选 <b>{{ selected.toLocaleString() }}</b> 行</span>
      <span v-if="viewMs > 0" class="vtp-bar__stat muted">视图计算 {{ viewMs.toFixed(1) }}ms</span>
    </div>

    <div class="vtp-bar__group">
      <button class="vtp-btn" data-act="select-all" @click="emit('select-all')">
        {{ allSelected ? '取消全选' : indeterminate ? '全选（含未选）' : '全选' }}
      </button>
      <button class="vtp-btn" data-act="invert" @click="emit('invert')">反选</button>
      <button class="vtp-btn" data-act="clear" :disabled="selected === 0" @click="emit('clear-selection')">清空勾选</button>
    </div>

    <div class="vtp-bar__group">
      <button class="vtp-btn primary" data-act="query" :disabled="selected === 0" @click="querySelection">获取勾选行</button>
      <slot name="actions" />
    </div>

    <div v-if="chips.length" class="vtp-bar__chips">
      <span class="vtp-bar__chips-label">列筛选</span>
      <span v-for="c in chips" :key="c.field" class="vtp-chip" :data-filter-chip="c.field">
        {{ c.title }}：{{ c.text }}
        <button class="vtp-chip__x" title="移除该列筛选" @click="emit('remove-filter', c.field)">✕</button>
      </span>
      <button class="vtp-btn ghost" data-act="clear-filters" @click="emit('clear-filters')">清除全部</button>
    </div>
    <span v-else class="vtp-bar__chips-label muted">（点表头的漏斗图标可对单列筛选）</span>

    <div class="vtp-bar__right">
      <label class="vtp-bar__toggle" title="用计算出来的滚动条替代 canvas 上那条">
        <input type="checkbox" data-act="toggle-scrollbar" :checked="customScrollbar" @change="emit('toggle-scrollbar', ($event.target as HTMLInputElement).checked)" />
        自绘滚动条
      </label>

      <div v-if="metrics" class="vtp-bar__scroll" data-scroll-metrics>
        <span data-metric="thumb">滑块 {{ metrics.thumbHeight }} / {{ metrics.trackHeight }} px</span>
        <span data-metric="pct">{{ pct.toFixed(1) }}%</span>
        <span data-metric="range">可视行 {{ (metrics.startRow + 1).toLocaleString() }}–{{ (metrics.endRow + 1).toLocaleString() }}</span>
        <input
          class="vtp-bar__slider"
          type="range"
          min="0"
          max="1000"
          :value="Math.round((metrics.maxScrollTop ? metrics.scrollTop / metrics.maxScrollTop : 0) * 1000)"
          @input="emit('scroll-to', Number(($event.target as HTMLInputElement).value) / 1000)"
        />
      </div>

      <slot name="right" />
    </div>
  </div>
</template>

<style>
.vtp-bar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 8px 12px;
  background: #fff;
  border-bottom: 1px solid #e5e6eb;
  font-size: 12px;
  color: #4e5969;
}
.vtp-bar__stats {
  display: flex;
  align-items: center;
  gap: 10px;
}
.vtp-bar__stat b {
  color: #1d2129;
  font-variant-numeric: tabular-nums;
}
.vtp-bar__stat.muted,
.vtp-bar__chips-label.muted {
  color: #86909c;
}
.vtp-bar__group {
  display: inline-flex;
  gap: 6px;
}
.vtp-bar__chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.vtp-bar__chips-label {
  color: #86909c;
}
.vtp-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 22px;
  padding: 0 4px 0 8px;
  border-radius: 11px;
  background: #e8f0ff;
  color: #165dff;
}
.vtp-chip__x {
  border: 0;
  background: transparent;
  color: #165dff;
  cursor: pointer;
  font-size: 10px;
}
.vtp-bar__right {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 12px;
}
.vtp-bar__toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.vtp-bar__scroll {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  color: #86909c;
  font-variant-numeric: tabular-nums;
}
.vtp-bar__slider {
  width: 120px;
}
</style>
