<script setup lang="ts">
/**
 * 全局工具栏：品牌区、查看态/编辑态、保存/回滚/撤销/重做、脏数据角标、规模切换、使用说明。
 *
 * 按钮的可用态全部由 store 推导 —— 组件不复制任何状态，
 * 所以「编辑一格」「批量改一列」「撤销」之后不会出现按钮态滞后。
 */

import { computed, ref } from 'vue';
import { DEFAULT_SCALE, type DataScale } from '../data/mock-source';
import { useStore, useStoreTick } from '../composables/store-context';
import { ms, num, type AnchorRect } from '../utils/format';
import AppPopover from './AppPopover.vue';
import HelpPanel from './HelpPanel.vue';

const props = defineProps<{
  scale: DataScale;
  sourceMode: 'mock' | 'http';
  bootMs: number;
}>();

const store = useStore();
const tick = useStoreTick(['dirty', 'cells', 'mode', 'data']);

const mode = computed(() => {
  void tick.value;
  return store.mode;
});
const dirtyCount = computed(() => {
  void tick.value;
  return store.dirtyCount();
});
const canUndo = computed(() => {
  void tick.value;
  return store.canUndo;
});
const canRedo = computed(() => {
  void tick.value;
  return store.canRedo;
});
const dirtyText = computed(() => (dirtyCount.value ? `${num(dirtyCount.value)} 处未保存` : '无未保存修改'));

/* 撤销 / 重做可能产生「零变化」的补丁（值本来就相等），此时 store 不会广播，
   所以点完按钮各自补一次刷新，避免按钮态滞后 */
function onUndo(): void {
  store.undo();
  tick.value++;
}
function onRedo(): void {
  store.redo();
  tick.value++;
}

/* ---- 规模切换：重新生成数据需要重载页面 ---- */
const presets: { label: string; v: DataScale }[] = [
  { label: '小 · 6 千行', v: { project: 200, task: 5_000, execution: 1_000 } },
  { label: '中 · 3 万行', v: { project: 1_000, task: 25_000, execution: 5_000 } },
  { label: '大 · 14 万行（默认）', v: DEFAULT_SCALE },
  { label: '超大 · 30 万行', v: { project: 3_000, task: 200_000, execution: 100_000 } },
];
const scaleKey = (v: DataScale): string => `${v.project}-${v.task}-${v.execution}`;
const currentScaleKey = computed(() => {
  const hit = presets.find(p => scaleKey(p.v) === scaleKey(props.scale));
  return scaleKey(hit ? hit.v : DEFAULT_SCALE);
});

function onScaleChange(e: Event): void {
  const [p, t, x] = (e.target as HTMLSelectElement).value.split('-');
  const params = new URLSearchParams(location.search);
  params.set('p', p);
  params.set('t', t);
  params.set('e', x);
  location.search = params.toString();
}

const dsNote = computed(() =>
  props.sourceMode === 'http' ? '数据源：HTTP（未连上后端会自动降级到本地 mock）' : '数据源：本地 mock（可切换为 HTTP 预留接口）'
);

/* ---- 使用说明浮层 ---- */
const helpOpen = ref(false);
const helpRect = ref<AnchorRect | null>(null);
const helpBtn = ref<HTMLButtonElement | null>(null);

function toggleHelp(): void {
  if (helpOpen.value) {
    helpOpen.value = false;
    return;
  }
  const el = helpBtn.value;
  if (!el) return;
  helpRect.value = el.getBoundingClientRect();
  helpOpen.value = true;
}
</script>

<template>
  <header class="app-bar">
    <div class="brand">
      <span class="logo">VT</span>
      <div>
        <div class="brand-title">VTable 三表联动 · 10 万级数据</div>
        <div class="brand-sub">启动耗时 {{ ms(bootMs) }}　{{ dsNote }}</div>
      </div>
    </div>
    <div class="spacer" />
    <div class="seg-group">
      <button class="seg" :class="{ on: mode === 'view' }" @click="store.setMode('view')">查看态</button>
      <button class="seg" :class="{ on: mode === 'edit' }" @click="store.setMode('edit')">编辑态</button>
    </div>
    <div class="btn-group">
      <button class="btn pri" :disabled="dirtyCount === 0" @click="store.save()">保存修改</button>
      <button class="btn" :disabled="dirtyCount === 0" @click="store.revertAll()">回滚</button>
      <button class="btn" :disabled="!canUndo" @click="onUndo">撤销</button>
      <button class="btn" :disabled="!canRedo" @click="onRedo">重做</button>
    </div>
    <span class="dirty-badge" :class="{ on: dirtyCount > 0 }">{{ dirtyText }}</span>
    <div class="grow" />
    <label class="scale">数据规模<select class="input compact" :value="currentScaleKey" @change="onScaleChange">
        <option v-for="p in presets" :key="scaleKey(p.v)" :value="scaleKey(p.v)">{{ p.label }}</option>
      </select></label>
    <button ref="helpBtn" class="btn" @click="toggleHelp">使用说明</button>

    <AppPopover :open="helpOpen" :rect="helpRect" :anchor-el="helpBtn" :width="520" align="right" @close="helpOpen = false">
      <HelpPanel />
    </AppPopover>
  </header>
</template>
