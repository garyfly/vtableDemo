<script setup lang="ts">
/**
 * 单张表的面板：标题 / 作用域 / 搜索 / 筛选 / 选择 / 批量操作 / 列设置 / 联动规则。
 *
 * 三张表共用这一个组件，行为差异全部来自 schema —— 面板本身不认识任何具体字段。
 *
 * 与命令式版本的分工差别只有一处：
 *   原来每个控件是「先建 DOM、再在事件里手工改 textContent/className」，
 *   现在这些派生值全是 computed，事件只负责把变化交给 store。
 * 表格本身（canvas）不走 Vue 的渲染管线，仍由 LinkedTable 直接订阅 store。
 */

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { SCHEMAS } from '../domain/schema';
import type { EntityKey, FilterCondition } from '../domain/types';
import { useEntityTick, useStore } from '../composables/store-context';
import type { EntityRuntime } from '../state/store';
import { usePanelRegistry, type PanelHandle } from '../composables/panel-registry';
import { useLinkedTable } from '../composables/use-linked-table';
import { num, type AnchorRect } from '../utils/format';
import { describeCondition } from '../utils/filter-ops';
import AppPopover from './AppPopover.vue';
import BulkDialog from './BulkDialog.vue';
import ColumnFilterPopover from './ColumnFilterPopover.vue';
import ColumnSettingsPanel from './ColumnSettingsPanel.vue';
import FilterPanel from './FilterPanel.vue';
import RulesPanel from './RulesPanel.vue';

const props = defineProps<{ entity: EntityKey; index: number }>();

const store = useStore();
const registry = usePanelRegistry();
const schema = SCHEMAS[props.entity];
const tick = useEntityTick(props.entity);

const rt = (): EntityRuntime => store.entities[props.entity];

/* ------------------------------------------------------------------ *
 * VTable 挂载
 * ------------------------------------------------------------------ */

const rootEl = ref<HTMLElement | null>(null);
const bodyEl = ref<HTMLElement | null>(null);

/* 点表头 → 打开「只管这一列」的筛选弹窗；表头在 canvas 上，只能拿到 rect */
const colFilter = ref<{ field: string; rect: AnchorRect } | null>(null);

const linked = useLinkedTable(bodyEl, {
  store,
  entity: props.entity,
  onHeaderClick: (field, rect) => {
    colFilter.value = { field, rect };
  },
});

let unregister: (() => void) | null = null;

onMounted(() => {
  const el = rootEl.value;
  if (!el) return;
  const handle: PanelHandle = {
    entity: props.entity,
    el,
    // 面板句柄对外暴露 live 的 linked：挂载顺序上它此刻已经就绪，
    // 但状态栏 / 探针拿到的始终是同一个 getter，不会拿到过期引用
    get linked() {
      return linked.value;
    },
  };
  unregister = registry.register(handle);
});

onBeforeUnmount(() => unregister?.());

/* ------------------------------------------------------------------ *
 * 头部信息
 * ------------------------------------------------------------------ */

const stats = computed(() => {
  void tick.value;
  const r = rt();
  return { total: r.total, showing: r.rows.length, selected: r.selection.size, queryMs: r.lastQueryMs, loading: r.loading };
});

/** 作用域：本表看到的是「上级勾选了的那几行」的下级 */
const scope = computed(() => {
  void tick.value;
  const parent = schema.parent;
  if (!parent) return { text: '顶层', on: false, showClear: false, parentEntity: null as EntityKey | null };
  const up = store.entities[parent.entity];
  const ids = up.selection.ids();
  if (ids.length > 0) {
    return {
      text: `← ${SCHEMAS[parent.entity].short}：${store.selectionTitle(parent.entity, ids)}`,
      on: true,
      showClear: true,
      parentEntity: parent.entity,
    };
  }
  return { text: `← 未勾选${SCHEMAS[parent.entity].short}，展示全部`, on: false, showClear: false, parentEntity: parent.entity };
});

const countText = computed(() => {
  void tick.value;
  const r = rt();
  const s = stats.value;
  const filtered = Boolean(r.query.keyword) || r.query.conditions.length > 0;
  const q = s.queryMs < 1 ? '<1' : s.queryMs.toFixed(0);
  return filtered || s.showing !== s.total ? `${num(s.showing)} / ${num(s.total)} 条 · 查询 ${q}ms` : `${num(s.total)} 条 · 查询 ${q}ms`;
});

const editable = computed(() => {
  void tick.value;
  return store.editable;
});

const bulkTitle = computed(() => {
  if (!editable.value) return '查看态下不可批量修改';
  if (stats.value.selected === 0) return '请先勾选要修改的行';
  return `对已勾选 ${num(stats.value.selected)} 行执行批量操作`;
});

const showEmpty = computed(() => stats.value.showing === 0 && !stats.value.loading);

const conditions = computed(() => {
  void tick.value;
  return rt().query.conditions;
});

const filterLabel = computed(() => (conditions.value.length ? `筛选 (${conditions.value.length})` : '筛选'));

/* ------------------------------------------------------------------ *
 * 条件 chips
 * ------------------------------------------------------------------ */

interface ChipView {
  id: string;
  text: string;
  cls: string;
  title?: string;
  remove?: () => void;
}

const chips = computed<ChipView[]>(() => {
  void tick.value;
  const r = rt();
  const fields = schema.fields;
  const out: ChipView[] = [];

  if (r.query.keyword) {
    out.push({
      id: 'keyword',
      cls: 'chip',
      text: `关键字：${r.query.keyword}`,
      remove: () => {
        keyword.value = '';
        lastSent = '';
        void store.setKeyword(props.entity, '');
      },
    });
  }

  for (const c of r.query.conditions) {
    out.push({
      id: c.id,
      cls: 'chip',
      text: describeCondition(c, fields),
      remove: () => void removeCondition(c.id),
    });
  }

  if (r.query.sort) {
    const sort = r.query.sort;
    const fs = fields.find(f => f.field === sort.field);
    out.push({
      id: 'sort',
      cls: 'chip sort',
      text: `排序：${fs?.title ?? sort.field} ${sort.order === 'asc' ? '↑' : '↓'}`,
      remove: () => void store.setSort(props.entity, null),
    });
  }

  /* 联动命中统计：当前结果集里有多少行被规则改写了属性 */
  const ruleHits = countRuleHits();
  if (ruleHits.length) {
    out.push({
      id: 'linkage',
      cls: 'chip linkage',
      title: ruleHits.map(x => x.label).join('\n'),
      text: `联动生效：${ruleHits.slice(0, 2).map(x => x.tag).join(' / ')}${ruleHits.length > 2 ? ` 等 ${ruleHits.length} 条` : ''}`,
    });
  }

  if (store.editable) {
    out.push({ id: 'edit', cls: 'chip edit', text: '编辑态：双击单元格编辑，开关单击即可切换' });
  }

  return out;
});

/**
 * 统计当前结果集中各规则的命中行数。
 *
 * 只抽样前 3000 行做趋势提示；结果按 store.version 缓存，
 * 否则每次状态栏刷新（选中、编辑、筛选都会触发）都要重扫一遍规则。
 */
let ruleHitCache: { version: number; hits: { tag: string; label: string; count: number }[] } | null = null;

function countRuleHits(): { tag: string; label: string; count: number }[] {
  const v = store.version;
  if (ruleHitCache && ruleHitCache.version === v) return ruleHitCache.hits;
  const rows = rt().rows;
  const sample = Math.min(rows.length, 3000);
  const hits = new Map<string, { tag: string; label: string; count: number }>();
  for (let i = 0; i < sample; i++) {
    const row = rows[i];
    for (const rule of schema.rules) {
      if (!rule.when(row)) continue;
      const cur = hits.get(rule.id) ?? { tag: rule.tag, label: rule.label, count: 0 };
      cur.count++;
      hits.set(rule.id, cur);
    }
  }
  const sorted = Array.from(hits.values())
    .filter(x => x.count > 0)
    .sort((a, b) => b.count - a.count);
  ruleHitCache = { version: v, hits: sorted };
  return sorted;
}

/* ------------------------------------------------------------------ *
 * 搜索框
 * ------------------------------------------------------------------ */

const keyword = ref(rt().query.keyword);
/** 上一次真正下发给 store 的关键字；用来区分「用户正在输入」和「别处清了关键字」 */
let lastSent = keyword.value;
let searchTimer = 0;

function onSearchInput(): void {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    lastSent = keyword.value;
    void store.setKeyword(props.entity, keyword.value);
  }, 260);
}

onBeforeUnmount(() => window.clearTimeout(searchTimer));

// 关键字被别处（例如 chip 上的 ✕）清掉时，把输入框同步回来
watch(
  () => {
    void tick.value;
    return rt().query.keyword;
  },
  k => {
    if (k === lastSent) return;
    keyword.value = k;
    lastSent = k;
  }
);

/* ------------------------------------------------------------------ *
 * 操作
 * ------------------------------------------------------------------ */

function selectAll(): void {
  const r = rt();
  r.selection.selectAll();
  store.setStatus(`${schema.label}：已全选当前结果集 ${num(r.selection.size)} 条（下级跟着收窄）`);
  void store.selectionChanged(props.entity);
}

function invert(): void {
  const r = rt();
  r.selection.invert();
  store.setStatus(`${schema.label}：已反选，当前勾选 ${num(r.selection.size)} 条`);
  void store.selectionChanged(props.entity);
}

function clearSelection(): void {
  const r = rt();
  r.selection.clear();
  store.setStatus(`${schema.label}：已清空勾选`);
  void store.selectionChanged(props.entity);
}

async function removeCondition(id: string): Promise<void> {
  await store.setConditions(
    props.entity,
    rt().query.conditions.filter(c => c.id !== id)
  );
}

/**
 * 「显示全部」= 清掉**上级**的勾选。
 *
 * 本表的作用域来自上级勾了谁，所以要解除收窄只能从上级下手。
 * （命令式版本这里清的是本表自己的下钻锚点，按钮说「显示全部」却重置了下级，是个反的。）
 */
function clearScope(): void {
  const parent = scope.value.parentEntity;
  if (parent) void store.clearSelection(parent);
}

/* ------------------------------------------------------------------ *
 * 浮层
 * ------------------------------------------------------------------ */

type PopName = 'filter' | 'columns' | 'rules';

const openPop = ref<PopName | null>(null);
const popRect = ref<AnchorRect | null>(null);
const popAnchor = ref<HTMLElement | null>(null);

function togglePop(name: PopName, e: MouseEvent): void {
  if (openPop.value === name) {
    openPop.value = null;
    return;
  }
  const el = e.currentTarget as HTMLElement;
  popAnchor.value = el;
  popRect.value = el.getBoundingClientRect();
  if (name === 'columns') hiddenList.value = [...(linked.value?.hidden ?? [])];
  openPop.value = name;
}

function closePop(): void {
  openPop.value = null;
}

function applyConditions(conds: FilterCondition[]): void {
  void store.setConditions(props.entity, conds);
}

/** 列筛选的条件或排序变过之后，表头的漏斗角标要重画 */
function onColumnFilterChanged(): void {
  linked.value?.rebuildColumns();
  tick.value++;
}

/* ---- 列显示 ---- */

const hiddenList = ref<string[]>([]);

function onHiddenChange(fields: string[]): void {
  hiddenList.value = fields;
  linked.value?.setHiddenFields(new Set(fields));
}

/* ---- 批量操作 ---- */

const bulkOpen = ref(false);
</script>

<template>
  <section ref="rootEl" class="pane" :class="`pane-${entity}`" :data-entity="entity">
    <div class="pane-hd">
      <span class="pane-idx">{{ index }}</span>
      <span class="pane-title">{{ schema.label }}</span>
      <span class="scope" :class="{ on: scope.on }">{{ scope.text }}</span>
      <span class="spacer" />
      <span class="metric">{{ countText }}</span>
      <span v-if="stats.selected > 0" class="metric accent">已勾选 {{ num(stats.selected) }}</span>
      <div class="pane-tools">
        <input v-model="keyword" class="search" type="search" :placeholder="`搜索${schema.label}…`" @input="onSearchInput" />
        <button class="btn" :class="{ pri: conditions.length > 0 }" @click="togglePop('filter', $event)">{{ filterLabel }}</button>
        <button class="btn" @click="selectAll">全选</button>
        <button class="btn" @click="invert">反选</button>
        <button class="btn" @click="clearSelection">清空选择</button>
        <button class="btn" :disabled="stats.selected === 0 || !editable" :title="bulkTitle" @click="bulkOpen = true">批量操作</button>
        <button class="btn" @click="togglePop('columns', $event)">列设置</button>
        <button class="btn" @click="togglePop('rules', $event)">联动规则</button>
        <!-- 顶层表没有上级可清除，按钮常驻但隐藏（原实现是切 display，这里保持同样的 DOM 形状） -->
        <button v-show="scope.showClear" class="btn ghost" title="清除上级的勾选，本表回到全部" @click="clearScope">显示全部</button>
      </div>
    </div>

    <div v-if="chips.length" class="chips">
      <span v-for="c in chips" :key="c.id" :class="c.cls" :title="c.title">
        {{ c.text }}
        <button v-if="c.remove" class="chip-x" @click="c.remove()">✕</button>
      </span>
    </div>

    <div class="pane-stage">
      <div ref="bodyEl" class="pane-body" />
      <!-- 用 v-show 而不是 v-if：原实现是「节点常在，只切 display」，
           保持 DOM 形状一致，也免得空态切换时反复创建销毁覆盖层 -->
      <div v-show="showEmpty" class="empty-overlay">没有匹配的数据</div>
    </div>

    <AppPopover :open="openPop === 'filter'" :rect="popRect" :anchor-el="popAnchor" :width="400" @close="closePop">
      <FilterPanel :fields="schema.fields" :conditions="conditions" @apply="applyConditions" @close="closePop" />
    </AppPopover>

    <AppPopover :open="openPop === 'columns'" :rect="popRect" :anchor-el="popAnchor" :width="260" align="right" @close="closePop">
      <ColumnSettingsPanel :entity="entity" :hidden="hiddenList" @change="onHiddenChange" />
    </AppPopover>

    <AppPopover :open="openPop === 'rules'" :rect="popRect" :anchor-el="popAnchor" :width="420" align="right" @close="closePop">
      <RulesPanel :entity="entity" />
    </AppPopover>

    <ColumnFilterPopover
      v-if="colFilter"
      :entity="entity"
      :field="colFilter.field"
      :rect="colFilter.rect"
      @close="colFilter = null"
      @changed="onColumnFilterChanged"
    />

    <BulkDialog v-if="bulkOpen" :entity="entity" @close="bulkOpen = false" />
  </section>
</template>
