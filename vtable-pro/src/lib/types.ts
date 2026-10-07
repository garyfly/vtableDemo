/**
 * VTablePro 的对外类型契约。
 *
 * 三层数据：
 *   原始全量数据（BulkData，非响应式）
 *     → 列筛选 / 排序后的视图 view（还是同一批行对象的引用）
 *       → VTable 的 records（虚拟滚动只画可视区）
 */

import type { Component } from 'vue';
import type { ListTable } from '@visactor/vtable';

export type RowKey = string | number;

/** 行数据的形状不受限制，只要求能用 rowKey 取到唯一键 */
export type Row = Record<string, any>;

/* ------------------------------------------------------------------ *
 * 列
 * ------------------------------------------------------------------ */

/** 传给列级自定义组件的上下文 */
export interface CellContext<T extends Row = Row> {
  row: T;
  /** 行在「当前筛选结果」里的下标（不是原始数据下标） */
  rowIndex: number;
  /** 行在原始全量数据里的下标（筛选前的下标） */
  sourceIndex: number;
  column: ProColumn<T>;
  table: ListTable;
}

/**
 * 列级自定义组件。
 *
 * 组件不是用 Vue 的模板渲染进 canvas 的 —— canvas 上没有 DOM。
 * 这里走的是 VTable 官方的 DOM 覆盖层：`attribute.vue.element` 里的 VNode
 * 由 VTableVueAttributePlugin 渲染成一个绝对定位的 DOM 节点，跟随滚动复用。
 * 只有声明了 `cell` 的列才会付这份代价，其它列仍然走 canvas 文本快路径。
 */
export interface CellRender<T extends Row = Row> {
  /** 任意导入的 Vue 组件（可以包一层 defineAsyncComponent 做懒加载） */
  component: Component;
  /** 传给组件的 props；默认会注入 { row, rowIndex, column, checked } */
  props?: (ctx: CellContext<T>) => Record<string, unknown>;
  /**
   * 组件内有按钮 / 输入框等交互时必须打开。
   * 覆盖层默认 pointer-events: none（不挡 canvas 的滚轮和点击）。
   */
  interactive?: boolean;
  /** 覆盖层包裹元素的额外行内样式（写死或按单元格算） */
  style?: Record<string, string> | ((ctx: CellContext<T>) => Record<string, string>);
}

export type FilterKind = 'text' | 'options';

export interface ProColumn<T extends Row = Row> {
  field: string;
  title: string;
  width?: number;
  minWidth?: number;
  maxWidth?: number;
  /** 单元格水平对齐（canvas 文本列生效） */
  align?: 'left' | 'center' | 'right';
  /** 是否可排序（默认 true） */
  sortable?: boolean;
  /** 是否挂在表头筛选（默认 true） */
  filterable?: boolean;
  /**
   * 表头筛选的形态：
   *   text    —— 关键字（包含 / 等于 / 前缀）
   *   options —— 取值勾选（选项来自数据里该列的去重值）
   * 不传时按数据的去重值数量自动决定：≤ 200 → options，否则 text。
   */
  filterKind?: FilterKind;
  /** canvas 文本列的显示格式化 */
  format?: (value: unknown, row: T, index: number) => string;
  /** canvas 文本列的动态样式 */
  cellStyle?: (ctx: CellContext<T>) => { color?: string; fontWeight?: string | number } | void;
  /** 该列用哪个组件渲染（不传 = canvas 文本快路径） */
  cell?: CellRender<T>;
  /** 自定义表头组件（不传 = 内置 ProHeaderCell） */
  header?: Component;
  /** 默认隐藏 */
  hidden?: boolean;
  /** 冻结在左侧（勾选列固定冻结） */
  fixed?: 'left';
}

/* ------------------------------------------------------------------ *
 * 筛选 / 排序
 * ------------------------------------------------------------------ */

export interface TextColumnFilter {
  kind: 'text';
  value: string;
  match: 'contains' | 'equals' | 'startsWith';
}

export interface OptionsColumnFilter {
  kind: 'options';
  /** 勾选的取值（字符串化后比较） */
  values: string[];
  /** true = 排除这些取值（"反选"语义） */
  exclude?: boolean;
}

export type ColumnFilter = TextColumnFilter | OptionsColumnFilter;

/** field → filter；null 表示该列没有筛选 */
export type FilterState = Record<string, ColumnFilter | null>;

export interface SortState {
  field: string;
  order: 'asc' | 'desc';
}

/* ------------------------------------------------------------------ *
 * 滚动条计算
 * ------------------------------------------------------------------ */

export interface ScrollMetrics {
  /** 当前滚动位置（内容坐标系） */
  scrollTop: number;
  scrollLeft: number;
  /** 内容总高 / 总宽（含表头） */
  scrollHeight: number;
  scrollWidth: number;
  /** 视口高 / 宽（不含边框） */
  viewHeight: number;
  viewWidth: number;
  /** 可滚动的最大距离 */
  maxScrollTop: number;
  maxScrollLeft: number;
  /** 竖向滚动条轨道高（= 视口高 - 表头高） */
  trackHeight: number;
  /** 计算出来的滑块高（带最小高度保护） */
  thumbHeight: number;
  /** 滑块顶端相对轨道的偏移 */
  thumbTop: number;
  /** 滑块高 / 轨道高，等价于「视口 / 内容」 */
  thumbRatioY: number;
  /** 横向滚动条（表格下方那条） */
  trackWidth: number;
  thumbWidth: number;
  thumbLeft: number;
  /** 虚拟滚动的可视行区间（0 基，相对数据行，不含表头） */
  startRow: number;
  endRow: number;
  /** 数据总行数（筛选后） */
  totalRows: number;
}

/* ------------------------------------------------------------------ *
 * 选择
 * ------------------------------------------------------------------ */

export interface SelectionPayload<T extends Row = Row> {
  count: number;
  /**
   * 按需展开勾选 key / 行对象。
   *
   * 故意做成函数而不是数组：exclude 模式（全选 10 万行）下展开一次就是一次
   * 10 万长度的数组分配，只有真正需要的人（点了「获取勾选行」）才该付这笔钱。
   */
  keys: () => RowKey[];
  rows: () => T[];
}
