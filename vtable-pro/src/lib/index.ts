/**
 * VTablePro 对外的公共入口。
 *
 * 用法：
 *   import { VTablePro, useProTable, defineProColumns } from './lib';
 *
 *   <VTablePro :columns="columns" :data="rows" :height="640" selectable>
 *     <template #toolbar-actions>
 *       <button @click="onExport">导出勾选行</button>
 *     </template>
 *   </VTablePro>
 *
 *   const api = useProTable()          // 在插槽内部
 *   api.getCheckedRows()               // 需要时才展开勾选行
 */

export { default as VTablePro } from './VTablePro.vue';
export { default as ProToolbar } from './ProToolbar.vue';
export { default as ProHeaderCell } from './ProHeaderCell.vue';
export { default as ProScrollbar } from './ProScrollbar.vue';
export { default as ColumnFilterPopover } from './ColumnFilterPopover.vue';

export { BulkData } from './BulkData';
export { SelectionModel } from './selection';
export { ProBus } from './bus';
export { applyFilters, applySort, buildPredicate, hasActiveFilter, describeFilter, resolveFilterKind } from './filters';
export { computeScrollMetrics, scrollToProgress } from './scroll';
export { buildColumns, CHECK_FIELD } from './columns';
export { PRO_TABLE_KEY, useProTable, tryUseProTable } from './context';

export type { ProTableApi } from './context';
export type {
  CellContext,
  CellRender,
  ColumnFilter,
  FilterState,
  OptionsColumnFilter,
  ProColumn,
  Row,
  RowKey,
  ScrollMetrics,
  SelectionPayload,
  SortState,
  TextColumnFilter,
} from './types';
