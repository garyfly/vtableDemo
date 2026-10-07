<script setup lang="ts">
/**
 * 应用外壳：加载进度、全局工具栏、三级面包屑、三个表格面板、状态栏。
 *
 * 与命令式版本的分工完全一致，只是「什么时候渲染什么」由 phase 这个状态表达，
 * 不再手工 appendChild / remove：
 *   loading → 生成数据的进度卡
 *   ready   → 正常界面（三个 TablePane 在各自的 onMounted 里挂 VTable）
 *   error   → 兜底的失败面板
 */

import { nextTick, onMounted, ref } from 'vue';
import { HttpDataSource } from './data/http-source';
import { MockDataSource, scaleFromLocation } from './data/mock-source';
import { SCHEMAS, evaluateRowState } from './domain/schema';
import { ENTITY_CHAIN } from './domain/types';
import { AppStore } from './state/store';
import { provideStore } from './composables/store-context';
import { providePanelRegistry } from './composables/panel-registry';
import { num } from './utils/format';
import AppBar from './components/AppBar.vue';
import CrumbTrail from './components/CrumbTrail.vue';
import StatusBar from './components/StatusBar.vue';
import TablePane from './components/TablePane.vue';

type Phase = 'loading' | 'ready' | 'error';

/* ------------------------------------------------------------------ *
 * 数据源装配
 * ------------------------------------------------------------------ */

/** 演示环境没有后端：?ds=http 时请求失败会自动降级到 mock，并在工具栏标出来 */
function createSource(scale: ReturnType<typeof scaleFromLocation>): { store: AppStore; mode: 'mock' | 'http' } {
  const params = new URLSearchParams(location.search);
  const mock = new MockDataSource(scale);
  if (params.get('ds') === 'http') {
    const http = new HttpDataSource({ baseUrl: params.get('api') ?? '/api', fallback: mock });
    return { store: new AppStore(http), mode: 'http' };
  }
  return { store: new AppStore(mock), mode: 'mock' };
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

const scale = scaleFromLocation(location.search);
const { store, mode: sourceMode } = createSource(scale);

// store 与面板注册表在这里就绪，子树任何组件都能 inject 到
provideStore(store);
const registry = providePanelRegistry();

const phase = ref<Phase>('loading');
const loadStage = ref('正在生成数据…');
const loadRatio = ref(0);
const bootMs = ref(0);
const errorText = ref('');

onMounted(async () => {
  try {
    const t0 = performance.now();
    await store.init((stage, ratio) => {
      loadStage.value = stage;
      loadRatio.value = Math.max(0, Math.min(1, ratio));
    });
    bootMs.value = performance.now() - t0;

    phase.value = 'ready';
    // 等这一帧的子组件 onMounted 跑完：三个面板此时才真正挂上 VTable
    await nextTick();

    /* 调试钩子：形状与命令式版本一致，tools/probe.mjs 无需改动 */
    window.__vtDemo = { store, panels: registry.all(), sourceMode, schemas: SCHEMAS, evaluateRowState };

    /* 默认进入编辑态，方便直接体验联动 */
    store.setMode('edit');

    /* 首屏默认：前两张表全勾选。
       全勾选 = 作用域覆盖全部行 = 不收窄，所以三张表都是全量 ——
       看得出「联动是活的」（面包屑有数据、面板有勾选计数），但一上来不会被收窄。
       想只看某几个项目的任务，把其余项目的勾去掉即可。 */
    store.entities.project.selection.selectAll();
    await store.selectionChanged('project');
    // 注意顺序：上面的 rescopeFrom('project') 会清掉下级勾选，所以任务表要在这之后再全选
    store.entities.task.selection.selectAll();
    await store.selectionChanged('task');
  } catch (err) {
    errorText.value = String(err instanceof Error ? err.stack ?? err.message : err);
    phase.value = 'error';
  }
});
</script>

<template>
  <div v-if="phase === 'loading'" class="loading">
    <div class="loading-card">
      <div class="loading-title">VTable 三表联动 · 10 万级</div>
      <div class="load-stage">{{ loadStage }}</div>
      <div class="load-bar"><i :style="{ width: `${Math.round(loadRatio * 100)}%` }" /></div>
      <div class="loading-hint">
        目标规模：项目 {{ num(scale.project) }} / 任务 {{ num(scale.task) }} / 明细 {{ num(scale.execution) }}
      </div>
    </div>
  </div>

  <div v-else-if="phase === 'error'" class="fatal">
    <h2>页面初始化失败</h2>
    <pre>{{ errorText }}</pre>
  </div>

  <div v-else class="app">
    <AppBar :scale="scale" :source-mode="sourceMode" :boot-ms="bootMs" />
    <CrumbTrail />
    <main class="panes">
      <TablePane v-for="(entity, i) in ENTITY_CHAIN" :key="entity" :entity="entity" :index="i + 1" />
    </main>
    <StatusBar :boot-ms="bootMs" />
  </div>
</template>
