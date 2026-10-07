/**
 * 组件对外暴露的命令式句柄 + provide/inject 约定。
 *
 * 工具栏（以及工具栏插槽里的业务按钮）要能拿到「当前勾选了哪些行」，
 * 又不想把 10 万行塞进 Vue 的响应式系统，所以走这个句柄：
 * 需要时调 `getCheckedRows()`，拿到的就是行对象的引用数组。
 */

import { inject, type InjectionKey } from 'vue';
import type { ListTable } from '@visactor/vtable';
import type { DomainResult } from './BulkData';
import type { ColumnFilter, FilterState, RowKey, Row, ScrollMetrics, SortState } from './types';
import type { BusTopic } from './bus';

export interface ProTableApi<T extends Row = Row> {
  /** 底层 VTable 实例（逃生舱） */
  readonly table: ListTable | null;
  /** 是否已经挂载完成 */
  readonly ready: boolean;

  /* 数据 */
  setData(rows: readonly T[]): void;
  getData(): readonly T[];
  /** 当前筛选 / 排序后的视图 */
  getFilteredData(): readonly T[];
  /**
   * 上一次视图重算（筛选 + 排序扫描）花的毫秒数。
   * 注意它**不含**把结果灌回表格的 setRecords —— 那一步是 VTable 自己的开销。
   */
  getLastViewMs(): number;
  /** 视图行数（筛选后） */
  readonly filteredCount: number;
  /** 原始全量行数 */
  readonly totalCount: number;

  /* 选择 */
  getCheckedRows(): T[];
  getCheckedKeys(): RowKey[];
  getSelectionCount(): number;
  isChecked(key: RowKey): boolean;
  setChecked(key: RowKey, checked: boolean): void;
  selectAll(): void;
  invertSelection(): void;
  clearSelection(): void;

  /* 列筛选 / 排序 */
  setFilter(field: string, filter: ColumnFilter | null): void;
  getFilters(): FilterState;
  clearFilters(): void;
  setSort(sort: SortState | null): void;
  getSort(): SortState | null;
  /** 某列在当前视图上的去重取值统计（表头筛选弹窗的数据源，一次 O(n) + 缓存） */
  getColumnDomain(field: string): DomainResult;

  /* 滚动 */
  scrollToRow(viewIndex: number): void;
  scrollToTop(): void;
  /** 滚动条几何计算（滑块尺寸 / 位置 / 可视行区间） */
  getScrollMetrics(): ScrollMetrics;
  scrollToProgress(progress: number, axis?: 'x' | 'y'): void;

  /** 内部状态变化的订阅；返回取消函数 */
  subscribe(fn: (topic: BusTopic) => void): () => void;
}

export const PRO_TABLE_KEY: InjectionKey<ProTableApi> = Symbol('VTablePro');

/** 在工具栏 / 插槽内容里取到表格句柄 */
export function useProTable<T extends Row = Row>(): ProTableApi<T> {
  const api = inject(PRO_TABLE_KEY, null);
  if (!api) {
    throw new Error('useProTable() 只能在 <VTablePro> 的插槽或工具栏内部使用');
  }
  return api as ProTableApi<T>;
}

/** 软版本：拿不到就返回 null（比如组件外部的调试代码） */
export function tryUseProTable<T extends Row = Row>(): ProTableApi<T> | null {
  return inject(PRO_TABLE_KEY, null) as ProTableApi<T> | null;
}
