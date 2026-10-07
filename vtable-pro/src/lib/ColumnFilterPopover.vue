<script setup lang="ts">
/**
 * 列筛选弹窗（每列独立一个）。
 *
 * 两种形态由 `resolveFilterKind` 决定：
 *   · options —— 数据里该列去重值不多（≤200），给勾选列表 + 搜索 + 全选/反选；
 *   · text    —— 去重值太多（比如 10 万行里 10 万个不同的人名），勾选列表没有意义，
 *                退回关键字匹配（包含 / 等于 / 前缀）。
 *
 * 取值列表来自 BulkData.domain()，是对**当前视图**的一次 O(n) 统计，
 * 结果会被缓存；统计耗时直接显示在弹窗里，方便感知 10 万行的代价。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { BulkData } from './BulkData';
import { resolveFilterKind } from './filters';
import type { ColumnFilter, ProColumn } from './types';

const props = defineProps<{
  column: ProColumn;
  filter: ColumnFilter | null;
  bulk: BulkData;
  anchor: HTMLElement | null;
}>();

const emit = defineEmits<{
  (e: 'apply', filter: ColumnFilter | null): void;
  (e: 'close'): void;
}>();

/* ---------------- 取值统计 ---------------- */
const domain = props.bulk.domain(props.column.field);
const kind = resolveFilterKind(props.column, domain.entries.length, domain.truncated);

/* ---------------- 本地编辑态 ---------------- */
const text = ref(props.filter?.kind === 'text' ? props.filter.value : '');
const match = ref<'contains' | 'equals' | 'startsWith'>(props.filter?.kind === 'text' ? props.filter.match : 'contains');
const exclude = ref(props.filter?.kind === 'options' ? !!props.filter.exclude : false);
const selected = ref<Set<string>>(new Set(props.filter?.kind === 'options' ? props.filter.values : []));
const search = ref('');

const VISIBLE_LIMIT = 300;

const shownEntries = computed(() => {
  const q = search.value.trim().toLowerCase();
  const hit = q ? domain.entries.filter(e => e.text.toLowerCase().includes(q)) : domain.entries;
  return { list: hit.slice(0, VISIBLE_LIMIT), more: Math.max(0, hit.length - VISIBLE_LIMIT), total: hit.length };
});

/* ---------------- 位置 ---------------- */
const style = ref<Record<string, string>>({ visibility: 'hidden' });
const wrap = ref<HTMLElement | null>(null);

function place(): void {
  const a = props.anchor;
  const el = wrap.value;
  if (!a || !el) return;
  const r = a.getBoundingClientRect();
  const w = el.offsetWidth || 280;
  const h = el.offsetHeight || 320;
  let left = r.left;
  let top = r.bottom + 6;
  if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 6);
  style.value = { left: `${Math.max(8, left)}px`, top: `${Math.max(8, top)}px`, visibility: 'visible' };
}

/* ---------------- 关闭 ---------------- */
function onDocMouseDown(e: MouseEvent): void {
  const t = e.target as Node;
  if (wrap.value?.contains(t)) return;
  if (props.anchor?.contains(t)) return;
  emit('close');
}
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => {
  place();
  document.addEventListener('mousedown', onDocMouseDown, true);
  document.addEventListener('keydown', onKey, true);
});
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocMouseDown, true);
  document.removeEventListener('keydown', onKey, true);
});

/* ---------------- 操作 ---------------- */
function toggleValue(v: string): void {
  const next = new Set(selected.value);
  if (next.has(v)) next.delete(v);
  else next.add(v);
  selected.value = next;
}

function selectAllShown(): void {
  const next = new Set(selected.value);
  for (const e of shownEntries.value.list) next.add(e.text);
  selected.value = next;
}

function invertShown(): void {
  const next = new Set(selected.value);
  for (const e of shownEntries.value.list) {
    if (next.has(e.text)) next.delete(e.text);
    else next.add(e.text);
  }
  selected.value = next;
}

function apply(): void {
  if (kind === 'text') {
    if (!text.value.trim()) return emit('apply', null);
    return emit('apply', { kind: 'text', value: text.value, match: match.value });
  }
  if (selected.value.size === 0) return emit('apply', null);
  return emit('apply', { kind: 'options', values: Array.from(selected.value), exclude: exclude.value });
}

function clear(): void {
  text.value = '';
  selected.value = new Set();
  exclude.value = false;
  emit('apply', null);
}
</script>

<template>
  <Teleport to="body">
    <div ref="wrap" class="vtp-filter" :style="style" @mousedown.stop>
      <div class="vtp-filter__hd">
        <span class="vtp-filter__title">{{ column.title }}</span>
        <span class="vtp-filter__kind">{{ kind === 'options' ? '按取值筛选' : '按关键字筛选' }}</span>
        <button class="vtp-filter__x" title="关闭" @click="emit('close')">✕</button>
      </div>

      <!-- 关键字模式 -->
      <div v-if="kind === 'text'" class="vtp-filter__body">
        <input v-model="text" class="vtp-filter__input" placeholder="输入关键字…" @keydown.enter="apply" />
        <div class="vtp-filter__modes">
          <label><input v-model="match" type="radio" value="contains" /> 包含</label>
          <label><input v-model="match" type="radio" value="equals" /> 等于</label>
          <label><input v-model="match" type="radio" value="startsWith" /> 开头是</label>
        </div>
        <p class="vtp-filter__hint">
          该列有 {{ domain.entries.length.toLocaleString() }} 个不同取值<span v-if="domain.truncated">（已截断）</span>，取值太多，建议用关键字。
        </p>
      </div>

      <!-- 取值模式 -->
      <div v-else class="vtp-filter__body">
        <input v-model="search" class="vtp-filter__input" placeholder="搜索取值…" />
        <div class="vtp-filter__actions">
          <button @click="selectAllShown">全选</button>
          <button @click="selected = new Set()">清空</button>
          <button @click="invertShown">反选</button>
          <label class="vtp-filter__exclude"><input v-model="exclude" type="checkbox" /> 排除</label>
        </div>
        <div class="vtp-filter__list">
          <label v-for="e in shownEntries.list" :key="e.text" class="vtp-filter__row">
            <input type="checkbox" :checked="selected.has(e.text)" @change="toggleValue(e.text)" />
            <span class="vtp-filter__val">{{ e.text || '（空）' }}</span>
            <span class="vtp-filter__cnt">{{ e.count.toLocaleString() }}</span>
          </label>
          <p v-if="shownEntries.more" class="vtp-filter__hint">还有 {{ shownEntries.more.toLocaleString() }} 项未显示，用搜索框缩小范围</p>
        </div>
        <p class="vtp-filter__hint">
          共 {{ domain.entries.length.toLocaleString() }} 个取值 · 统计 {{ domain.ms.toFixed(1) }}ms
        </p>
      </div>

      <div class="vtp-filter__ft">
        <span class="vtp-filter__picked">{{ kind === 'options' ? `已选 ${selected.size.toLocaleString()}` : text ? '1 个条件' : '无' }}</span>
        <button class="vtp-btn ghost" @click="clear">清除该列筛选</button>
        <button class="vtp-btn primary" @click="apply">应用</button>
      </div>
    </div>
  </Teleport>
</template>

<style>
.vtp-filter {
  position: fixed;
  z-index: 3000;
  width: 288px;
  background: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(29, 33, 41, 0.14);
  font-size: 12px;
  color: #1d2129;
}
.vtp-filter__hd {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid #f2f3f5;
}
.vtp-filter__title {
  font-weight: 600;
}
.vtp-filter__kind {
  color: #86909c;
}
.vtp-filter__x {
  margin-left: auto;
  border: 0;
  background: transparent;
  cursor: pointer;
  color: #86909c;
}
.vtp-filter__body {
  padding: 10px 12px;
}
.vtp-filter__input {
  width: 100%;
  height: 28px;
  padding: 0 8px;
  box-sizing: border-box;
  border: 1px solid #e5e6eb;
  border-radius: 4px;
  outline: none;
  font-size: 12px;
}
.vtp-filter__input:focus {
  border-color: #165dff;
}
.vtp-filter__modes {
  display: flex;
  gap: 12px;
  margin-top: 8px;
  color: #4e5969;
}
.vtp-filter__modes label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
.vtp-filter__actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 0;
}
.vtp-filter__actions button {
  border: 1px solid #e5e6eb;
  background: #fff;
  border-radius: 4px;
  height: 24px;
  padding: 0 8px;
  cursor: pointer;
  color: #4e5969;
}
.vtp-filter__actions button:hover {
  border-color: #165dff;
  color: #165dff;
}
.vtp-filter__exclude {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: #4e5969;
  cursor: pointer;
}
.vtp-filter__list {
  max-height: 220px;
  overflow: auto;
  border: 1px solid #f2f3f5;
  border-radius: 4px;
  padding: 4px;
}
.vtp-filter__row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: 3px;
  cursor: pointer;
}
.vtp-filter__row:hover {
  background: #f7f8fa;
}
.vtp-filter__val {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vtp-filter__cnt {
  color: #86909c;
  font-variant-numeric: tabular-nums;
}
.vtp-filter__hint {
  margin: 8px 0 0;
  color: #86909c;
  line-height: 1.5;
}
.vtp-filter__ft {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid #f2f3f5;
}
.vtp-filter__picked {
  margin-right: auto;
  color: #86909c;
}
</style>
