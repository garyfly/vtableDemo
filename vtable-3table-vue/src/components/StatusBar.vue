<script setup lang="ts">
/**
 * 状态栏：一句话状态 + 三表规模 + 启动耗时 + JS 堆 + 降级告警。
 *
 * 后端连不上时界面必须明说自己正在展示本地兜底数据 —— 这条规则在 Vue 版里
 * 依然由 store.degraded / store.sourceError 推导，不做本地判断。
 */

import { computed } from 'vue';
import { SCHEMAS } from '../domain/schema';
import { ENTITY_CHAIN } from '../domain/types';
import { useStore, useStoreTick } from '../composables/store-context';
import { ms, num } from '../utils/format';

const props = defineProps<{ bootMs: number }>();

const store = useStore();
const tick = useStoreTick(['data', 'status', 'selection', 'mode', 'dirty']);

const statusText = computed(() => {
  void tick.value;
  return store.statusText || '就绪';
});

const perfText = computed(() => {
  void tick.value;
  const totals = ENTITY_CHAIN.map(e => `${SCHEMAS[e].short} ${num(store.entities[e].rows.length)}/${num(store.entities[e].total)}`).join('　');
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const memText = mem ? `　JS 堆 ${(mem.usedJSHeapSize / 1024 / 1024).toFixed(0)} MB` : '';
  return `${totals}　启动 ${ms(props.bootMs)}${memText}`;
});

const degraded = computed(() => {
  void tick.value;
  return store.degraded;
});

const degradedText = computed(() =>
  degraded.value ? `⚠ 后端不可用，当前展示的是本地兜底数据${store.sourceError ? `（${store.sourceError}）` : ''}` : ''
);
</script>

<template>
  <footer class="status-bar">
    <span class="status-text">{{ statusText }}</span>
    <span class="spacer" />
    <span class="degraded-badge" :class="{ on: degraded }">{{ degradedText }}</span>
    <span class="status-perf">{{ perfText }}</span>
  </footer>
</template>
