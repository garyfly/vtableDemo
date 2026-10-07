<script setup lang="ts">
/**
 * VTablePro —— 基于 @visactor/vtable 的虚拟滚动表格组件。
 *
 * 六条需求分别落在：
 *   ① 虚拟滚动           → VTable 的 ListTable（固定行高，只画可视区）
 *   ② 全量导入 + 非响应式 → BulkData（toRaw + markRaw，只存引用，不建索引除非要用）
 *   ③ 列级自定义组件      → 列上声明 `cell`，走 DOM 覆盖层（VTableVueAttributePlugin）
 *   ④ 滚动条计算          → computeScrollMetrics()（滑块尺寸 / 位置 / 可视行区间）
 *   ⑤ 工具栏取勾选行      → inject 拿到句柄，点按钮时才把勾选展开成数组
 *   ⑥ 每列独立表头筛选    → 表头是 DOM 组件，点漏斗开 ColumnFilterPopover
 *
 * 状态管理刻意用「tick 计数 + 命令式 store」，而不是把数据塞进 Vue 响应式：
 * 10 万个行对象一旦被递归代理，内存与 GC 都不可接受（见 BulkData 注释）。
 * 需要让模板知道的事（计数、筛选状态、滚动几何）都是小对象，放 ref 里没问题。
 */
import { computed, getCurrentInstance, onBeforeUnmount, onMounted, provide, ref, shallowRef, watch } from 'vue';
import { ListTable } from '@visactor/vtable';
import type { ColumnDefine } from '@visactor/vtable';
import { VTableVueAttributePlugin } from '@visactor/vue-vtable/es/components/custom/vtable-vue-attribute-plugin';

import { BulkData } from './BulkData';
import { SelectionModel } from './selection';
import { ProBus } from './bus';
import { applyFilters, applySort, describeFilter, hasActiveFilter } from './filters';
import { buildColumns, CHECK_FIELD, type HeaderBinding } from './columns';
import { computeScrollMetrics, scrollToProgress as scrollByProgress } from './scroll';
import { PRO_TABLE_KEY, type ProTableApi } from './context';
import type { ColumnFilter, FilterState, ProColumn, Row, RowKey, ScrollMetrics, SelectionPayload, SortState } from './types';
import ProHeaderCell from './ProHeaderCell.vue';
import ProToolbar from './ProToolbar.vue';
import ProScrollbar from './ProScrollbar.vue';
import ColumnFilterPopover from './ColumnFilterPopover.vue';
import './styles.css';

const props = withDefaults(
  defineProps<{
    columns: ProColumn[];
    /** 全量原始数据（内部不会放进 Vue 响应式） */
    data: Row[];
    /** 行唯一键字段名或取值函数 */
    rowKey?: string | ((row: Row) => RowKey);
    height?: number | string;
    rowHeight?: number;
    headerHeight?: number;
    selectable?: boolean;
    /** 用自绘滚动条替代 canvas 上那条 */
    customScrollbar?: boolean;
    emptyText?: string;
    /** 受控勾选：只在传了它的时候才会 emit update:selectedKeys */
    selectedKeys?: RowKey[];
  }>(),
  {
    rowKey: 'id',
    height: 620,
    rowHeight: 38,
    headerHeight: 42,
    selectable: true,
    customScrollbar: false,
    emptyText: '没有匹配的数据',
  }
);

const emit = defineEmits<{
  (e: 'update:selectedKeys', keys: RowKey[]): void;
  (e: 'selection-change', payload: SelectionPayload): void;
  (e: 'filter-change', filters: FilterState): void;
  (e: 'sort-change', sort: SortState | null): void;
  (e: 'scroll', metrics: ScrollMetrics): void;
  (e: 'row-click', payload: { row: Row; rowIndex: number; column: ProColumn }): void;
  (e: 'selection-query', rows: Row[]): void;
  (e: 'update:customScrollbar', on: boolean): void;
}>();

/* ------------------------------------------------------------------ *
 * 非响应式内核
 * ------------------------------------------------------------------ */

const keyOf = (row: Row): RowKey => {
  const k = props.rowKey;
  if (typeof k === 'function') return k(row);
  const v = row?.[k];
  return v === undefined || v === null ? '' : (v as RowKey);
};

const bulk = new BulkData<Row>({ keyOf });
const selection = new SelectionModel();
const bus = new ProBus();
let table: ListTable | null = null;

/* ------------------------------------------------------------------ *
 * 响应式外壳（只放小对象 / 计数）
 * ------------------------------------------------------------------ */

const mounted = ref(false);
const totalCount = ref(0);
const filteredCount = ref(0);
const selectedCount = ref(0);
const allSelected = ref(false);
const viewMs = ref(0);
const metrics = ref<ScrollMetrics | null>(null);
const filters = shallowRef<FilterState>({});
const sort = shallowRef<SortState | null>(null);
const customScrollbar = ref(props.customScrollbar);
const popover = ref<{ field: string; anchor: HTMLElement } | null>(null);

const hostEl = ref<HTMLDivElement | null>(null);
const rootEl = ref<HTMLDivElement | null>(null);

const indeterminate = computed(() => selectedCount.value > 0 && !allSelected.value);

const chips = computed(() =>
  props.columns
    .filter(c => hasActiveFilter(filters.value[c.field]))
    .map(c => ({ field: c.field, title: c.title, text: describeFilter(filters.value[c.field]!) }))
);

const popoverColumn = computed(() => (popover.value ? props.columns.find(c => c.field === popover.value!.field) ?? null : null));

/* ------------------------------------------------------------------ *
 * 核心：视图重算 + 灌给表格
 * ------------------------------------------------------------------ */

let view: Row[] = [];

function rebuildView(): void {
  const filtered = applyFilters(bulk.rows, filters.value);
  const sorted = applySort(filtered.view, sort.value);
  view = sorted;
  bulk.setView(sorted);
  selection.setUniverseSize(sorted.length);
  filteredCount.value = sorted.length;
  viewMs.value = filtered.ms ?? 0;
}

function pushRecords(): void {
  if (!table) return;
  // setRecords 自己会重建场景图（含自定义布局），不需要再补一次 renderWithRecreateCells ——
  // 那会把这 10 万行的重灌成本翻倍。表头是 DOM 组件，靠 bus 的 header-sync 消息同步状态。
  table.setRecords(view);
  syncSelectionCount();
  scheduleMetrics();
  bus.emit('data');
}

function syncSelectionCount(): void {
  selectedCount.value = selection.size;
  allSelected.value = selection.isAllSelected;
}

/* ------------------------------------------------------------------ *
 * 表头绑定（排序 / 筛选）
 * ------------------------------------------------------------------ */

const binding: HeaderBinding = {
  bus,
  getSort: () => sort.value,
  isFiltered: field => hasActiveFilter(filters.value[field]),
  filterOf: field => filters.value[field] ?? null,
  toggleSort(field) {
    const cur = sort.value;
    const next: SortState | null = !cur || cur.field !== field ? { field, order: 'asc' } : cur.order === 'asc' ? { field, order: 'desc' } : null;
    sort.value = next;
    rebuildView();
    pushRecords();
    bus.emit('header-sync');
    emit('sort-change', next);
  },
  openFilter(field, anchor) {
    popover.value = { field, anchor };
  },
};

/* ------------------------------------------------------------------ *
 * 选择
 * ------------------------------------------------------------------ */

function afterSelectionChange(): void {
  syncSelectionCount();
  if (table) {
    // 勾选列的复选框 / 选中行底色都画在 canvas 上，必须让它重画可视区
    table.renderWithRecreateCells();
  }
  bus.emit('header-sync');
  bus.emit('selection');
  emit('selection-change', {
    count: selection.size,
    // 故意做成 getter：exclude 模式下展开一次就是 10 万长度的数组，
    // 不需要的人不该为它付钱
    keys: () => selection.keysOf(view, keyOf),
    rows: () => selection.rowsOf(view, keyOf) as Row[],
  });
  if (props.selectedKeys !== undefined) {
    emit('update:selectedKeys', selection.keysOf(view, keyOf));
  }
}

function toggleRow(row: Row): void {
  selection.toggle(keyOf(row));
  afterSelectionChange();
}

function selectAll(): void {
  if (selection.isAllSelected) selection.clear();
  else selection.selectAll();
  afterSelectionChange();
}

function invertSelection(): void {
  // 反选 = 「当前视图里没被选中的」；include / exclude 两种模式用同一个公式
  const next: RowKey[] = [];
  for (let i = 0; i < view.length; i++) {
    const k = keyOf(view[i]);
    if (!selection.has(k)) next.push(k);
  }
  selection.replaceWith(next, view.length);
  afterSelectionChange();
}

function clearSelection(): void {
  selection.clear();
  afterSelectionChange();
}

/* ------------------------------------------------------------------ *
 * 滚动条计算
 * ------------------------------------------------------------------ */

let metricsScheduled = false;
function scheduleMetrics(): void {
  if (metricsScheduled || !table) return;
  metricsScheduled = true;
  requestAnimationFrame(() => {
    metricsScheduled = false;
    if (!table) return;
    const m = computeScrollMetrics(table);
    metrics.value = m;
    emit('scroll', m);
  });
}

function onScrollToProgress(p: number): void {
  if (!table) return;
  scrollByProgress(table, p, 'y');
}

/* ------------------------------------------------------------------ *
 * 对外句柄
 * ------------------------------------------------------------------ */

const api: ProTableApi = {
  get table() {
    return table;
  },
  get ready() {
    return mounted.value;
  },
  setData(rows) {
    bulk.setRows(rows);
    rebuildView();
    pushRecords();
  },
  getData: () => bulk.rows as Row[],
  getFilteredData: () => view,
  getLastViewMs: () => viewMs.value,
  get filteredCount() {
    return filteredCount.value;
  },
  get totalCount() {
    return totalCount.value;
  },
  getCheckedRows: () => selection.rowsOf(view, keyOf) as Row[],
  getCheckedKeys: () => selection.keysOf(view, keyOf),
  getSelectionCount: () => selection.size,
  isChecked: k => selection.has(k),
  setChecked(k, checked) {
    selection.setChecked(k, checked);
    afterSelectionChange();
  },
  selectAll,
  invertSelection,
  clearSelection,
  setFilter(field, filter) {
    const next: FilterState = { ...filters.value };
    if (filter) next[field] = filter;
    else delete next[field];
    filters.value = next;
    rebuildView();
    pushRecords();
    bus.emit('header-sync');
    emit('filter-change', next);
  },
  getFilters: () => ({ ...filters.value }),
  clearFilters() {
    filters.value = {};
    rebuildView();
    pushRecords();
    bus.emit('header-sync');
    emit('filter-change', {});
  },
  setSort(s) {
    sort.value = s;
    rebuildView();
    pushRecords();
    bus.emit('header-sync');
    emit('sort-change', s);
  },
  getSort: () => sort.value,
  getColumnDomain: field => bulk.domain(field),
  scrollToRow(index) {
    if (!table) return;
    const headerCount = table.columnHeaderLevelCount ?? 1;
    table.scrollToCell({ col: 0, row: headerCount + Math.max(0, index) });
  },
  scrollToTop() {
    table?.setScrollTop?.(0);
    scheduleMetrics();
  },
  getScrollMetrics: () => (table ? computeScrollMetrics(table) : emptyMetrics()),
  scrollToProgress: onScrollToProgress,
  subscribe: fn => bus.on(e => fn(e.topic)),
};

provide(PRO_TABLE_KEY, api);
// 直接把句柄对象暴露出去（保留 getter，父组件拿到的 `table` / `ready` 是实时的）
defineExpose(api);

/* ------------------------------------------------------------------ *
 * 生命周期
 * ------------------------------------------------------------------ */

/**
 * 主题：默认滚动条 / 自绘滚动条两种形态只差 scrollStyle。
 *
 * padding 特意调小：DOM 覆盖层落位在单元格的**内容盒**上（也就是被 padding 缩进后的
 * 那一块），表头列宽本来就窄，留着默认的 16px 左右内边距会把标题挤掉。
 * body 的内边距直接归零，交给每个自定义组件自己控制。
 */
function buildTheme(customSb: boolean) {
  return {
    underlayBackgroundColor: '#fff',
    defaultStyle: { borderColor: '#f0f1f3', borderLineWidth: [0, 0, 1, 0], fontSize: 13, color: '#1d2129' },
    headerStyle: {
      bgColor: '#f7f8fa',
      color: '#4e5969',
      fontSize: 12,
      fontWeight: 600,
      borderColor: '#e5e6eb',
      borderLineWidth: [0, 0, 1, 0],
      padding: [0, 4, 0, 4],
    },
    bodyStyle: {
      bgColor: '#fff',
      color: '#1d2129',
      fontSize: 13,
      borderColor: '#f0f1f3',
      borderLineWidth: [0, 0, 1, 0],
      padding: [0, 0, 0, 0],
      hover: { cellBgColor: '#f7f9fc' },
    },
    frameStyle: { borderColor: '#e5e6eb', borderLineWidth: 0, innerBorder: false },
    scrollStyle: customSb ? { visible: 'none' as const } : { visible: 'scrolling' as const, scrollSliderColor: '#d0d3d9', width: 8, hoverOn: true },
  };
}

function createTable(): void {
  const el = hostEl.value;
  if (!el) return;

  bulk.setRows(props.data);
  rebuildView();
  totalCount.value = bulk.total;

  const columns: ColumnDefine[] = buildColumns({
    columns: props.columns,
    bulk,
    selection,
    selectable: props.selectable,
    binding,
    HeaderCell: ProHeaderCell,
  });

  table = new ListTable(el, {
    records: view,
    columns,

    /* 尺寸全部固定：heightMode/widthMode 一旦自适应，10 万行要逐行测量 */
    widthMode: 'standard',
    heightMode: 'standard',
    defaultRowHeight: props.rowHeight,
    defaultHeaderRowHeight: props.headerHeight,
    defaultColWidth: 140,
    autoFillWidth: true,
    autoWrapText: false,
    enableLineBreak: false,
    animationAppear: false,
    overscrollBehavior: 'none',
    // 百万行级：VTable 内部对「可操作记录数」有个上限保护，这里直接放到 1000 万
    maxOperatableRecordCount: 10_000_000,
    resizeTime: 20,

    rowSeriesNumber: {
      width: 62,
      title: '#',
      format: (_col?: number, row?: number, t?: { columnHeaderLevelCount?: number }) => {
        const headerCount = t?.columnHeaderLevelCount ?? 1;
        return row === undefined ? '' : String(row - headerCount + 1);
      },
      headerStyle: { bgColor: '#f7f8fa', color: '#86909c', fontSize: 12, textAlign: 'center', textBaseline: 'middle' },
      style: { color: '#86909c', fontSize: 12, textAlign: 'center', textBaseline: 'middle' },
      disableColumnResize: true,
    },

    // 行号列 + 勾选列固定在左侧
    frozenColCount: 1 + (props.selectable ? 1 : 0),

    // 自定义 DOM 覆盖层的挂载容器由 core 创建（bodyDomContainer 等）
    customConfig: {
      createReactContainer: true,
      forceComputeAllRowHeight: false,
      limitContentHeight: true,
      scrollEventAlwaysTrigger: false,
    },

    theme: buildTheme(customScrollbar.value),
  });

  /* ---- 注册 Vue 覆盖层插件（必须在表格实例创建之后） ---- */
  const instance = getCurrentInstance();
  const stage = (table as unknown as { scenegraph: { stage: { pluginService: { register(p: unknown): void } } } }).scenegraph.stage;
  stage.pluginService.register(new VTableVueAttributePlugin(instance?.appContext));

  bindTableEvents();
  syncSelectionCount();
  scheduleMetrics();
  mounted.value = true;
}

function bindTableEvents(): void {
  if (!table) return;
  const t = table;

  t.on('click_cell', args => {
    const headerCount = t.columnHeaderLevelCount ?? 1;
    const isHeader = args.row < headerCount;
    const field = String((args as unknown as { field?: string }).field ?? '');

    if (field === CHECK_FIELD) {
      if (isHeader) {
        selectAll();
      } else {
        const row = safeRow(t, args.col, args.row);
        if (row) toggleRow(row);
      }
      return;
    }
    if (isHeader) return;

    const row = safeRow(t, args.col, args.row);
    if (!row) return;
    const column = props.columns.find(c => c.field === field);
    if (column) emit('row-click', { row, rowIndex: args.row - headerCount, column });
  });

  t.on('scroll', () => scheduleMetrics());
  t.on('resize_column_end', () => scheduleMetrics());
  t.on('after_render', () => scheduleMetrics());
}

function safeRow(t: ListTable, col: number, row: number): Row | undefined {
  try {
    return t.getCellOriginRecord(col, row) as Row | undefined;
  } catch {
    return undefined;
  }
}

function emptyMetrics(): ScrollMetrics {
  return {
    scrollTop: 0,
    scrollLeft: 0,
    scrollHeight: 0,
    scrollWidth: 0,
    viewHeight: 0,
    viewWidth: 0,
    maxScrollTop: 0,
    maxScrollLeft: 0,
    trackHeight: 0,
    thumbHeight: 0,
    thumbTop: 0,
    thumbRatioY: 1,
    trackWidth: 0,
    thumbWidth: 0,
    thumbLeft: 0,
    startRow: 0,
    endRow: 0,
    totalRows: 0,
  };
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  createTable();
  if (typeof ResizeObserver !== 'undefined' && hostEl.value) {
    resizeObserver = new ResizeObserver(() => {
      const t = table as unknown as { resize?: () => void };
      t?.resize?.();
      scheduleMetrics();
    });
    resizeObserver.observe(hostEl.value);
  }
});

onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
  try {
    table?.release();
  } catch {
    /* release 失败不影响卸载 */
  }
  table = null;
  mounted.value = false;
});

/* ------------------------------------------------------------------ *
 * 监听
 * ------------------------------------------------------------------ */

// 只比较引用：绝不能写成 deep watch —— 那会递归遍历 10 万行
watch(
  () => props.data,
  rows => api.setData(rows)
);

watch(
  () => props.columns,
  () => {
    if (!table) return;
    table.updateColumns(
      buildColumns({ columns: props.columns, bulk, selection, selectable: props.selectable, binding, HeaderCell: ProHeaderCell })
    );
    table.renderWithRecreateCells();
    bus.emit('header-sync');
  }
);

watch(
  () => props.customScrollbar,
  on => {
    customScrollbar.value = on;
  }
);

watch(customScrollbar, on => {
  if (!table) return;
  // 换成自绘滚动条时，把 canvas 上那条藏掉（否则两条会打架）
  (table as unknown as { updateTheme(t: unknown): void }).updateTheme(buildTheme(on));
  scheduleMetrics();
});

/* ------------------------------------------------------------------ *
 * 模板用的小工具
 * ------------------------------------------------------------------ */

const rootStyle = computed(() => ({ height: typeof props.height === 'number' ? `${props.height}px` : props.height }));

function onApplyFilter(filter: ColumnFilter | null): void {
  const field = popover.value?.field;
  popover.value = null;
  if (field) api.setFilter(field, filter);
}

function onQuerySelection(rows: unknown[]): void {
  emit('selection-query', rows as Row[]);
}

function onToggleScrollbar(on: boolean): void {
  customScrollbar.value = on;
  emit('update:customScrollbar', on);
}
</script>

<template>
  <div ref="rootEl" class="vtp-root" :style="rootStyle" data-vtable-pro>
    <ProToolbar
      :total="totalCount"
      :filtered="filteredCount"
      :selected="selectedCount"
      :all-selected="allSelected"
      :indeterminate="indeterminate"
      :chips="chips"
      :view-ms="viewMs"
      :metrics="metrics"
      :custom-scrollbar="customScrollbar"
      @select-all="selectAll"
      @invert="invertSelection"
      @clear-selection="clearSelection"
      @clear-filters="api.clearFilters()"
      @remove-filter="f => api.setFilter(f, null)"
      @query-selection="onQuerySelection"
      @toggle-scrollbar="onToggleScrollbar"
      @scroll-to="onScrollToProgress"
    >
      <template #left><slot name="toolbar-left" /></template>
      <template #actions><slot name="toolbar-actions" /></template>
      <template #right><slot name="toolbar-right" /></template>
    </ProToolbar>

    <div ref="hostEl" class="vtp-body" />

    <ProScrollbar v-if="customScrollbar && metrics" :metrics="metrics" @scroll-to="onScrollToProgress" />

    <div v-if="mounted && filteredCount === 0" class="vtp-empty">{{ emptyText }}</div>

    <ColumnFilterPopover
      v-if="popover && popoverColumn"
      :column="popoverColumn"
      :filter="filters[popover.field] ?? null"
      :bulk="bulk"
      :anchor="popover.anchor"
      @apply="onApplyFilter"
      @close="popover = null"
    />
  </div>
</template>
