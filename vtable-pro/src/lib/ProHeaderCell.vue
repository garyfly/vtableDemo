<script setup lang="ts">
/**
 * 表头单元格（DOM 覆盖层里的 Vue 组件）。
 *
 * 表头放在 DOM 而不是 canvas 上，换来三件事：
 *   1. 排序、筛选是真按钮，有 hover / focus / title；
 *   2. 列筛选弹窗的锚点就是一个真实 DOM 元素，不用拿 canvas 单元格矩形去凑；
 *   3. 表头状态（排序方向、是否在筛选中）能独立于 canvas 重绘更新 ——
 *      通过内部总线的 `header-sync` 消息刷新，不依赖表格何时重画。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { HeaderBinding } from './columns';
import type { ProColumn } from './types';

const props = defineProps<{
  column: ProColumn;
  binding: HeaderBinding;
}>();

const sortOrder = ref<'asc' | 'desc' | null>(null);
const filtered = ref(false);

function refresh(): void {
  sortOrder.value = props.binding.getSort()?.field === props.column.field ? props.binding.getSort()!.order : null;
  filtered.value = props.binding.isFiltered(props.column.field);
}

let off: (() => void) | null = null;
onMounted(() => {
  refresh();
  off = props.binding.bus.on(e => {
    if (e.topic === 'header-sync') refresh();
  });
});
onBeforeUnmount(() => off?.());

const sortable = () => props.column.sortable !== false;
const filterable = () => props.column.filterable !== false;

function onTitleClick(): void {
  if (sortable()) props.binding.toggleSort(props.column.field);
}

function onFunnelClick(e: MouseEvent): void {
  const el = e.currentTarget as HTMLElement;
  props.binding.openFilter(props.column.field, el);
}
</script>

<template>
  <div class="vtp-hd" :class="{ 'is-filtered': filtered }" :data-field="column.field" :title="column.title">
    <span class="vtp-hd__title" :class="{ 'is-sortable': sortable() }" @click="onTitleClick">{{ column.title }}</span>

    <span v-if="sortable()" class="vtp-hd__sort" :class="{ 'is-on': sortOrder }">
      <svg class="vtp-hd__caret" :class="{ on: sortOrder === 'asc' }" viewBox="0 0 8 5" width="8" height="5"><path d="M4 0 L8 5 L0 5 Z" /></svg>
      <svg class="vtp-hd__caret" :class="{ on: sortOrder === 'desc' }" viewBox="0 0 8 5" width="8" height="5"><path d="M4 5 L0 0 L8 0 Z" /></svg>
    </span>

    <button v-if="filterable()" class="vtp-hd__funnel" :class="{ on: filtered }" :data-filter-for="column.field" title="筛选该列" @click.stop="onFunnelClick">
      <svg viewBox="0 0 14 14" width="13" height="13">
        <path d="M1 2.2 H13 L8.4 7.4 V12 L5.6 10.6 V7.4 Z" fill="currentColor" />
      </svg>
    </button>
  </div>
</template>

<style>
.vtp-hd {
  display: flex;
  align-items: center;
  gap: 4px;
  width: 100%;
  height: 100%;
  padding: 0 4px 0 8px;
  box-sizing: border-box;
  border-right: 1px solid #e5e6eb;
  font-size: 12px;
  font-weight: 600;
  color: #4e5969;
  user-select: none;
  overflow: hidden;
}
.vtp-hd.is-filtered {
  color: #165dff;
  background: #e8f0ff;
}
.vtp-hd__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vtp-hd__title.is-sortable {
  cursor: pointer;
}
.vtp-hd__title.is-sortable:hover {
  color: #165dff;
}
.vtp-hd__sort {
  display: inline-flex;
  flex-direction: column;
  gap: 2px;
  flex: 0 0 auto;
}
.vtp-hd__caret {
  fill: #c9cdd4;
  transition: fill 0.12s;
}
.vtp-hd__caret.on {
  fill: #165dff;
}
.vtp-hd__funnel {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #c9cdd4;
  cursor: pointer;
}
.vtp-hd__funnel:hover {
  background: #e5e6eb;
  color: #4e5969;
}
.vtp-hd__funnel.on {
  color: #165dff;
  background: #d6e4ff;
}
</style>
