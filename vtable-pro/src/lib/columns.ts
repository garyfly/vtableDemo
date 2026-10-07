/**
 * ProColumn[] → VTable ColumnDefine[] 的编译器。
 *
 * 三条路径，按代价从低到高：
 *
 *   1. **canvas 文本列**（默认）：用 customLayout 自己画文本 / 背景。
 *      不产生 DOM，10 万行滚动时只有绘制开销。
 *   2. **canvas 勾选列**：同上，自己画复选框（这样「全选 10 万行」才能是 O(1)
 *      的模式翻转，而不是落到每一行的 checkbox 状态里）。
 *   3. **组件列**（列上声明了 `cell`）：走 VTable 官方的 DOM 覆盖层 ——
 *      `attribute.vue.element` 里的 VNode 由 VTableVueAttributePlugin 渲染成
 *      绝对定位的 DOM，跟随滚动复用。只有显式声明的列付这份代价。
 *
 * 表头统一走第 3 条：表头要能排序 / 筛选，DOM 才能给出 hover、按钮和稳定的
 * 弹窗锚点（canvas 上表头没有 DOM 节点，锚点只能算矩形）。
 */

import { CustomLayout } from '@visactor/vtable';
import type { ColumnDefine } from '@visactor/vtable';
import { h } from 'vue';
import type { Component } from 'vue';
import type { ProBus } from './bus';
import type { BulkData } from './BulkData';
import type { SelectionModel } from './selection';
import { add, C, checkbox, group, rect, text } from './canvasKit';
import type { CellContext, ColumnFilter, ProColumn, Row, SortState } from './types';

/** 勾选列的伪字段名 */
export const CHECK_FIELD = '__check__';

/** 表头 DOM 组件拿到的绑定 */
export interface HeaderBinding {
  bus: ProBus;
  getSort(): SortState | null;
  isFiltered(field: string): boolean;
  filterOf(field: string): ColumnFilter | null;
  toggleSort(field: string): void;
  openFilter(field: string, anchor: HTMLElement): void;
}

export interface ColumnBuildContext<T extends Row> {
  columns: ProColumn<T>[];
  bulk: BulkData<T>;
  selection: SelectionModel;
  selectable: boolean;
  binding: HeaderBinding;
  /** 内置表头组件（由 VTablePro 注入，避免 columns.ts ↔ ProHeaderCell.vue 循环 import） */
  HeaderCell: Component;
}

type LayoutArgs = {
  table: CompileTable;
  col: number;
  row: number;
  rect?: { width: number; height: number };
};

type CompileTable = {
  getCellOriginRecord(col: number, row: number): unknown;
  getColWidth?(col: number): number;
  getRowHeight?(row: number): number;
  bodyDomContainer?: HTMLElement;
  headerDomContainer?: HTMLElement;
};

const ROW_H = 38;
const CHECK_W = 46;
const PAD_X = 10;

export function buildColumns<T extends Row>(ctx: ColumnBuildContext<T>): ColumnDefine[] {
  const cols: ColumnDefine[] = [];
  if (ctx.selectable) cols.push(checkColumn(ctx));
  for (const col of ctx.columns) {
    cols.push(col.cell ? componentColumn(ctx, col) : canvasColumn(ctx, col));
  }
  return cols;
}

/* ------------------------------------------------------------------ *
 * 单元格公共部分
 * ------------------------------------------------------------------ */

function cellSize(table: CompileTable, col: number, row: number, rect?: { width: number; height: number }) {
  const w = rect?.width ?? safeNum(() => table.getColWidth?.(col), 140);
  const h = rect?.height ?? safeNum(() => table.getRowHeight?.(row), ROW_H);
  return { w, h };
}

function rowAt(table: CompileTable, col: number, row: number): Row | undefined {
  try {
    return table.getCellOriginRecord(col, row) as Row | undefined;
  } catch {
    return undefined;
  }
}

function safeNum(fn: () => number | undefined, fallback: number): number {
  try {
    const v = fn();
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

/** 每列的表头：一律用 DOM 组件（客户端的 header 或内置 ProHeaderCell） */
function headerLayout<T extends Row>(ctx: ColumnBuildContext<T>, col: ProColumn<T>, index: number) {
  const Header = col.header ?? ctx.HeaderCell;
  return (args: LayoutArgs) => {
    const table = args.table;
    const { w, h: ch } = cellSize(table, args.col, args.row, args.rect);
    return {
      rootContainer: new CustomLayout.Group({
        width: w,
        height: ch,
        vue: {
          // 稳定的 id：canvas 重建单元格时复用同一个 DOM 容器，不会越滚越多
          id: `hdr_${index}_${col.field}`,
          element: h(Header, { column: col, binding: ctx.binding }),
          // 这两个只是让类型满足 SimpleDomStyleOptions；实际尺寸取自 graphic 本身
          width: w,
          height: ch,
          container: table.headerDomContainer ?? null,
          // 表头是交互区（排序、点漏斗），必须能接收鼠标事件
          pointerEvents: true,
          // 表头背景由 DOM 自己画，canvas 这边不画默认内容
          style: { display: 'flex', alignItems: 'center', background: C.bgSofter },
        },
      }),
      renderDefault: false,
    };
  };
}

/* ------------------------------------------------------------------ *
 * 1. 勾选列（canvas）
 * ------------------------------------------------------------------ */

function checkColumn<T extends Row>(ctx: ColumnBuildContext<T>): ColumnDefine {
  const { selection, bulk } = ctx;
  return {
    field: CHECK_FIELD,
    title: '',
    width: CHECK_W,
    minWidth: CHECK_W,
    maxWidth: CHECK_W,
    disableColumnResize: true,
    disableHeaderSelect: true,
    headerCustomLayout: (args: LayoutArgs) => {
      const { w, h: ch } = cellSize(args.table, args.col, args.row, args.rect);
      const g = group(w, ch, 'check-header');
      const size = 16;
      checkbox(g, (w - size) / 2, (ch - size) / 2, size, selection.headerState);
      return { rootContainer: g, renderDefault: false };
    },
    customLayout: (args: LayoutArgs) => {
      const { w, h: ch } = cellSize(args.table, args.col, args.row, args.rect);
      const g = group(w, ch, 'check-cell');
      const row = rowAt(args.table, args.col, args.row);
      if (!row) return { rootContainer: g, renderDefault: false };
      const checked = selection.has(bulk.keyFor(row as T));
      // 选中行：底色 + 左侧色条，一眼看出工具栏那句「已勾选 N 行」指的是谁
      if (checked) {
        add(g, rect({ x: 0, y: 0, w, h: ch }, C.rowSelected));
        add(g, rect({ x: 0, y: 0, w: 3, h: ch }, C.primary));
      }
      const size = 16;
      checkbox(g, (w - size) / 2, (ch - size) / 2, size, checked);
      return { rootContainer: g, renderDefault: false };
    },
    // 选中行整行淡底：canvas 列由 style 回调给底色，组件列由覆盖层 style 给
    style: (args: { row: number; col: number; table: CompileTable }) => {
      const row = rowAt(args.table, args.col, args.row);
      if (row && selection.has(bulk.keyFor(row as T))) return { bgColor: C.rowSelected };
      return { bgColor: C.white };
    },
  } as unknown as ColumnDefine;
}

/* ------------------------------------------------------------------ *
 * 2. canvas 文本列
 * ------------------------------------------------------------------ */

function canvasColumn<T extends Row>(ctx: ColumnBuildContext<T>, col: ProColumn<T>): ColumnDefine {
  const { selection, bulk } = ctx;
  const align = col.align ?? 'left';
  return {
    field: col.field,
    title: col.title,
    width: col.width ?? 140,
    minWidth: col.minWidth ?? Math.min(80, col.width ?? 140),
    maxWidth: col.maxWidth ?? 520,
    hide: col.hidden,
    headerCustomLayout: headerLayout(ctx, col, indexOf(ctx, col)),
    customLayout: (args: LayoutArgs) => {
      const table = args.table;
      const { w, h: ch } = cellSize(table, args.col, args.row, args.rect);
      const g = group(w, ch, 'text-cell');
      const row = rowAt(table, args.col, args.row);
      if (!row) return { rootContainer: g, renderDefault: false };
      const key = bulk.keyFor(row as T);
      if (selection.has(key)) add(g, rect({ x: 0, y: 0, w, h: ch }, C.rowSelected));

      const raw = row[col.field];
      const shown = col.format ? col.format(raw, row as T, 0) : raw === null || raw === undefined ? '' : String(raw);
      const tint = col.cellStyle?.({ row: row as T, rowIndex: 0, sourceIndex: 0, column: col, table: table as never });
      const x = align === 'right' ? w - PAD_X : align === 'center' ? w / 2 : PAD_X;
      add(
        g,
        text(shown, x, ch / 2, {
          fontSize: 13,
          fill: tint?.color ?? C.text,
          bold: tint?.fontWeight === 'bold' || tint?.fontWeight === 600,
          align,
          maxWidth: w - PAD_X * 2,
        })
      );
      return { rootContainer: g, renderDefault: false };
    },
  } as unknown as ColumnDefine;
}

/* ------------------------------------------------------------------ *
 * 3. 组件列（DOM 覆盖层）
 * ------------------------------------------------------------------ */

function componentColumn<T extends Row>(ctx: ColumnBuildContext<T>, col: ProColumn<T>): ColumnDefine {
  const cell = col.cell!;
  const { selection, bulk } = ctx;
  const idx = indexOf(ctx, col);
  return {
    field: col.field,
    title: col.title,
    width: col.width ?? 180,
    minWidth: col.minWidth ?? 120,
    maxWidth: col.maxWidth ?? 520,
    hide: col.hidden,
    headerCustomLayout: headerLayout(ctx, col, idx),
    customLayout: (args: LayoutArgs) => {
      const table = args.table;
      const { w, h: ch } = cellSize(table, args.col, args.row, args.rect);
      const row = rowAt(table, args.col, args.row) as T | undefined;
      // 行不在视图里（滚动过程中的空档）就交回默认渲染，别让覆盖层残留旧内容
      if (!row) {
        return { rootContainer: new CustomLayout.Group({ width: w, height: ch }), renderDefault: false };
      }
      const checked = selection.has(bulk.keyFor(row));
      const cellCtx: CellContext<T> = {
        row,
        rowIndex: args.row,
        sourceIndex: bulk.sourceIndexOf(bulk.keyFor(row)),
        column: col,
        table: table as never,
      };
      const props = { row, rowIndex: args.row, column: col, checked, ...(cell.props ? cell.props(cellCtx) : {}) };
      const style = typeof cell.style === 'function' ? cell.style(cellCtx) : cell.style;
      return {
        rootContainer: new CustomLayout.Group({
          width: w,
          height: ch,
          vue: {
            id: `cell_${idx}_${args.row}`,
            element: h(cell.component, props),
            width: w,
            height: ch,
            container: table.bodyDomContainer ?? null,
            pointerEvents: cell.interactive ?? false,
            style: {
              display: 'flex',
              alignItems: 'center',
              background: checked ? C.rowSelected : C.white,
              ...(style ?? {}),
            },
          },
        }),
        renderDefault: false,
      };
    },
  } as unknown as ColumnDefine;
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function indexOf<T extends Row>(ctx: ColumnBuildContext<T>, col: ProColumn<T>): number {
  return ctx.columns.indexOf(col);
}

