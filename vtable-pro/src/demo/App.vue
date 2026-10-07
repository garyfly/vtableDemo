<script setup lang="ts">
/**
 * 演示页。
 *
 * 关键点：`rows` 是一个**普通数组**，不是 ref / reactive ——
 * 10 万行原始数据以引用的形式一次性交给 <VTablePro>，中间没有任何拷贝、
 * 也没有任何 Proxy 包装。页面右侧的「非响应式证据」实时显示这一点。
 */
import { computed, isProxy, isReactive, reactive, ref } from 'vue';
import { VTablePro, type FilterState, type Row, type ScrollMetrics, type SortState } from '../lib';
import { makeColumns } from './columns';
import { makeRows, type OrderRow } from './data';

/**
 * 行数可以用 URL 参数覆盖：`?rows=1000000`。
 * 探针 / 基准脚本就是靠它把同一套断言跑到不同量级上的。
 */
const params = new URLSearchParams(location.search);
const ROW_COUNT = Math.max(1, Math.min(5_000_000, Number(params.get('rows')) || 100_000));

/* ---- 原始数据：一次性构造，非响应式 ---- */
let rows: OrderRow[] = makeRows(ROW_COUNT);
const dataVersion = ref(1);

const columns = makeColumns(onRowAction);

const pro = ref<InstanceType<typeof VTablePro> | null>(null);
const customScrollbar = ref(false);

const lastQuery = ref<{ count: number; rows: Row[]; at: number } | null>(null);
const lastClick = ref<string>('');
const lastFilter = ref<string>('无');
const lastSort = ref<string>('无');
const metrics = ref<ScrollMetrics | null>(null);

/* ---- 非响应式证据 ---- */
const evidence = computed(() => {
  void dataVersion.value;
  const first = rows[0];
  return {
    rows: rows.length,
    arrayIsReactive: isReactive(rows),
    arrayIsProxy: isProxy(rows),
    rowIsProxy: isProxy(first),
    hasReactiveFlag: Object.prototype.hasOwnProperty.call(rows as object, '__v_reactive') || Object.prototype.hasOwnProperty.call(rows as object, '__v_raw'),
  };
});

function onRowAction({ action, row }: { action: 'view' | 'edit'; row: Record<string, any> }): void {
  lastClick.value = `${action === 'view' ? '查看' : '编辑'} ${row.orderNo}（${row.customer}）`;
}

function onSelectionQuery(payload: Row[]): void {
  lastQuery.value = { count: payload.length, rows: payload, at: Date.now() };
}

function onRowClick(payload: { row: Row; rowIndex: number }): void {
  lastClick.value = `点击第 ${(payload.rowIndex + 1).toLocaleString()} 行 · ${payload.row.orderNo}`;
}

function onScroll(m: ScrollMetrics): void {
  metrics.value = m;
}

function onFilterChange(f: FilterState): void {
  lastFilter.value = Object.keys(f).length ? Object.keys(f).join(' + ') : '无';
}

function onSortChange(s: SortState | null): void {
  lastSort.value = s ? `${s.field} ${s.order === 'asc' ? '升序' : '降序'}` : '无';
}

/** 演示：从组件 ref 句柄里取勾选行（和工具栏自带按钮等价） */
function queryViaRef(): void {
  const api = pro.value;
  if (!api) return;
  const t0 = performance.now();
  const list = api.getCheckedRows();
  const ms = performance.now() - t0;
  lastQuery.value = { count: list.length, rows: list, at: Date.now() };
  lastClick.value = `ref 句柄展开 ${list.length.toLocaleString()} 行用了 ${ms.toFixed(1)}ms`;
}

function jumpToMiddle(): void {
  pro.value?.scrollToRow(50_000);
}

function reloadData(): void {
  rows = makeRows(ROW_COUNT, 20261006 + dataVersion.value);
  dataVersion.value++;
  pro.value?.setData(rows);
}

const metricsText = computed(() => {
  const m = metrics.value;
  if (!m) return '—';
  const pct = m.maxScrollTop > 0 ? (m.scrollTop / m.maxScrollTop) * 100 : 0;
  return `${m.thumbHeight}/${m.trackHeight}px · ${pct.toFixed(1)}% · 行 ${(m.startRow + 1).toLocaleString()}–${(m.endRow + 1).toLocaleString()} / ${m.totalRows.toLocaleString()}`;
});

const previewRows = computed(() => (lastQuery.value ? lastQuery.value.rows.slice(0, 5) : []));

/* ------------------------------------------------------------------ *
 * 调试钩子：自动化探针（tools/probe.mjs）就靠它读真实状态做断言
 * ------------------------------------------------------------------ */
(window as unknown as Record<string, unknown>).__vtp = {
  get api() {
    return pro.value;
  },
  get rows() {
    return rows;
  },
  get metrics() {
    return metrics.value;
  },
  get lastQuery() {
    return lastQuery.value;
  },
  get lastClick() {
    return lastClick.value;
  },
  get evidence() {
    return evidence.value;
  },
  rowCount: ROW_COUNT,
  dataColumns: columns.length,
  filterableColumns: columns.filter(c => c.filterable !== false).length,
  domainFor: (field: string) => pro.value?.getColumnDomain(field),
  // 基准里的对照组用：同样一批数据交给 reactive() 要付多少内存
  vueReactive: { reactive },
};
</script>

<template>
  <div class="page">
    <header class="page__hd">
      <h1>VTablePro · {{ (ROW_COUNT / 10000).toLocaleString('zh-CN') }} 万行虚拟滚动表格组件</h1>
      <p>
        Vue 3 + TypeScript + <code>@visactor/vtable</code>。全量导入原始数据、内部非响应式；
        列可以使用导入的自定义组件；每列表头独立筛选；工具栏可直接取到勾选行；滚动条几何由组件计算。
      </p>
    </header>

    <VTablePro
      ref="pro"
      :columns="columns"
      :data="rows"
      :height="660"
      :row-height="38"
      :header-height="42"
      :custom-scrollbar="customScrollbar"
      selectable
      @update:custom-scrollbar="on => (customScrollbar = on)"
      @selection-query="onSelectionQuery"
      @row-click="onRowClick"
      @filter-change="onFilterChange"
      @sort-change="onSortChange"
      @scroll="onScroll"
    >
      <template #toolbar-actions>
        <button class="vtp-btn" data-act="ref-query" @click="queryViaRef">取勾选行（ref 句柄）</button>
        <button class="vtp-btn" data-act="jump" @click="jumpToMiddle">跳到第 5 万行</button>
        <button class="vtp-btn" data-act="reload" @click="reloadData">重新导入数据</button>
      </template>
    </VTablePro>

    <section class="cards">
      <div class="card">
        <h3>工具栏拿到的勾选行</h3>
        <p v-if="!lastQuery" class="muted">
          点工具栏的「获取勾选行」，或先勾几行再点。展开动作只在点击那一刻发生 —— 勾选状态平时只是一个模式位加一小组 key。
        </p>
        <template v-else>
          <p data-query-count>勾选 <b>{{ lastQuery.count.toLocaleString() }}</b> 行，前 {{ previewRows.length }} 条：</p>
          <ul class="rows">
            <li v-for="r in previewRows" :key="String(r.id)">
              <code>{{ r.orderNo }}</code> · {{ r.customer }} · {{ r.owner }} · {{ r.status }}
            </li>
          </ul>
        </template>
      </div>

      <div class="card">
        <h3>非响应式证据</h3>
        <ul class="kv">
          <li>原始行数：<b>{{ evidence.rows.toLocaleString() }}</b></li>
          <li><code>isReactive(rows)</code>：<b data-ev="reactive">{{ evidence.arrayIsReactive }}</b></li>
          <li><code>isProxy(rows)</code>：<b data-ev="proxy">{{ evidence.arrayIsProxy }}</b></li>
          <li><code>isProxy(rows[0])</code>：<b data-ev="rowproxy">{{ evidence.rowIsProxy }}</b></li>
          <li>数组上挂着 <code>__v_reactive/__v_raw</code>：<b data-ev="flag">{{ evidence.hasReactiveFlag }}</b></li>
        </ul>
      </div>

      <div class="card">
        <h3>滚动条计算 / 交互</h3>
        <ul class="kv">
          <li>滑块/轨道 · 进度 · 可视行：<b data-metrics>{{ metricsText }}</b></li>
          <li>最近筛选：<b data-last-filter>{{ lastFilter }}</b></li>
          <li>最近排序：<b data-last-sort>{{ lastSort }}</b></li>
          <li>最近交互：<b data-last-click>{{ lastClick || '—' }}</b></li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style>
body {
  margin: 0;
  background: #f7f8fa;
  font-family: system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
  color: #1d2129;
}
.page {
  max-width: 1660px;
  margin: 0 auto;
  padding: 16px 16px 40px;
}
.page__hd h1 {
  margin: 4px 0 6px;
  font-size: 20px;
}
.page__hd p {
  margin: 0 0 14px;
  color: #4e5969;
  font-size: 13px;
  line-height: 1.7;
}
.page__hd code {
  background: #eef0f3;
  padding: 1px 4px;
  border-radius: 3px;
}
.cards {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  margin-top: 14px;
}
.card {
  background: #fff;
  border: 1px solid #e5e6eb;
  border-radius: 8px;
  padding: 12px 14px;
}
.card h3 {
  margin: 0 0 8px;
  font-size: 13px;
}
.card .muted {
  color: #86909c;
  font-size: 12px;
  line-height: 1.7;
}
.rows {
  margin: 6px 0 0;
  padding-left: 18px;
  font-size: 12px;
  color: #4e5969;
  line-height: 1.9;
}
.rows code {
  color: #165dff;
}
.kv {
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: 12px;
  color: #4e5969;
  line-height: 2;
}
.kv b {
  color: #1d2129;
  font-variant-numeric: tabular-nums;
}
.page__switch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}
</style>
