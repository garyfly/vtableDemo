/**
 * Schema → VTable 列的编译器。
 *
 * 每个数据列都挂一个 customLayout（展示由对应的小组件负责），
 * 编辑态下再挂一个 editor（编辑也由同一个小组件负责）。
 *
 * 这里还额外插了一列「选择列」：它不是 VTable 内置的 checkbox 列，
 * 而是用 customLayout 自己画的。原因见 state/selection.ts ——
 * 10 万行的「全选」必须是 O(1) 的状态翻转，不能落到每一行的 checkbox 状态里。
 */

import { type ColumnDefine, type ListTable } from '@visactor/vtable';
// 类型不在主入口上，从 ts-types 直接取（与运行时无关，编译后会被擦除）
import type { IRowSeriesNumber } from '@visactor/vtable/es/ts-types';
import { DateInputEditor, InputEditor, ListEditor } from '@visactor/vtable-editors';
import { evaluateRowState, PEOPLE, SCHEMAS, type EntitySchema, type FieldSchema, type FieldState } from '../domain/schema';
import type { DataRow, EntityKey, TableMode } from '../domain/types';
import type { AppStore } from '../state/store';
import { add, C, checkbox, funnel, group, rect, text } from './canvas';
import { NumberEditor, RatingEditor, SliderEditor, TagEditor, BlockedEditor, registerEditors, type IEditor } from './editors';
import { renderWidget, type WidgetCtx } from './widgets';

/** 选择列用的伪字段名 */
export const CHECK_FIELD = '__check__';

type Table = ListTable & { getColWidth?(col: number): number; getRowHeight?(row: number): number };

/** customLayout 收到的最小参数集（VTable 实际会多传，这里只声明用得到的） */
interface LayoutArgs {
  table: unknown;
  col: number;
  row: number;
  rect?: { left: number; top: number; width: number; height: number };
}

/* ------------------------------------------------------------------ *
 * 行 / 尺寸工具
 * ------------------------------------------------------------------ */

function rowAt(table: Table, col: number, row: number): DataRow | undefined {
  try {
    return table.getCellOriginRecord(col, row) as DataRow | undefined;
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

function cellSize(table: Table, col: number, row: number, rectLike?: { width?: number; height?: number }): { w: number; h: number } {
  return {
    w: rectLike?.width ?? safeNum(() => table.getColWidth?.(col), 120),
    h: rectLike?.height ?? safeNum(() => table.getRowHeight?.(row), 34),
  };
}

/* ------------------------------------------------------------------ *
 * 联动求值缓存
 * ------------------------------------------------------------------ */

/**
 * 同一行在一次渲染里会被多个列问到状态（可见/可编辑/必填）。
 * 10 万行下如果每列都重新跑一遍规则，滚动会明显掉帧，
 * 所以按 store 版本号做一层行级缓存。
 */
export interface CellMetaCache {
  stateOf(row: DataRow): Map<string, FieldState>;
  invalidate(): void;
}

export function createCellMetaCache(schema: EntitySchema, store: AppStore, entity: EntityKey): CellMetaCache {
  void entity;
  let stamp = -1;
  let map = new Map<string, Map<string, FieldState>>();
  return {
    stateOf(row: DataRow) {
      if (store.version !== stamp) {
        map = new Map();
        stamp = store.version;
      }
      let s = map.get(row.id);
      if (!s) {
        s = evaluateRowState(schema, row, store.editable);
        map.set(row.id, s);
      }
      return s;
    },
    invalidate() {
      stamp = -1;
      map = new Map();
    },
  };
}

/* ------------------------------------------------------------------ *
 * 选择列
 * ------------------------------------------------------------------ */

function buildCheckColumn(store: AppStore, entity: EntityKey): ColumnDefine {
  const rt = store.entities[entity];
  return {
    field: CHECK_FIELD,
    title: '',
    width: 44,
    minWidth: 44,
    headerType: 'text',
    cellType: 'text',
    disableColumnResize: true,
    disableHeaderSelect: true,
    headerCustomLayout: (args: LayoutArgs) => {
      const table = args.table as Table;
      const { w, h } = cellSize(table, args.col, args.row, args.rect);
      const g = group(w, h, 'check-header');
      const size = 16;
      checkbox(g, (w - size) / 2, (h - size) / 2, size, rt.selection.headerState);
      return { rootContainer: g, renderDefault: false };
    },
    customLayout: (args: LayoutArgs) => {
      const table = args.table as Table;
      const { w, h } = cellSize(table, args.col, args.row, args.rect);
      const g = group(w, h, 'check-cell');
      const row = rowAt(table, args.col, args.row);
      if (!row) return { rootContainer: g, renderDefault: false };

      // 勾选行就是下级表的作用域，所以底色之外再给一条左侧色条：
      // 一眼能看出「这两行正在驱动右边的表」
      if (store.rowIsChecked(entity, row.id)) {
        add(g, rect({ x: 0, y: 0, w, h }, C.primarySoft));
        add(g, rect({ x: 0, y: 0, w: 3, h }, C.primary));
      }

      const size = 16;
      checkbox(g, (w - size) / 2, (h - size) / 2, size, rt.selection.has(row.id));
      return { rootContainer: g, renderDefault: false };
    },
  } as unknown as ColumnDefine;
}

/* ------------------------------------------------------------------ *
 * 编辑器工厂：每个列一份实例，选项等参数直接烘进去
 * ------------------------------------------------------------------ */

function editorFor(fs: FieldSchema): IEditor | undefined {
  switch (fs.widget) {
    case 'text':
      return new InputEditor({});
    case 'date':
      return new DateInputEditor({});
    case 'number':
    case 'money':
      return new NumberEditor({ min: fs.min, max: fs.max, step: fs.step, precision: fs.precision, unit: fs.unit, title: `编辑「${fs.title}」` });
    case 'progress':
      return new SliderEditor({ min: fs.min ?? 0, max: fs.max ?? 100, step: fs.step ?? 5, unit: fs.unit, title: `设置「${fs.title}」` });
    case 'rating':
      return new RatingEditor({ max: fs.max ?? 5, title: `设置「${fs.title}」` });
    case 'multiSelect':
      return new TagEditor((fs.options ?? []).map(o => ({ value: o.value, label: o.label, color: o.color })), `选择「${fs.title}」`);
    case 'select':
      return new ListEditor({ values: (fs.options ?? []).map(o => o.value) });
    case 'user':
      return new ListEditor({ values: (fs.options ?? PEOPLE).map(o => o.value) });
    case 'link':
    case 'switch':
      // link 单击下钻、switch 单击切换，都不走编辑器
      return undefined;
    default:
      return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * 主入口
 * ------------------------------------------------------------------ */

export interface BuildColumnsOptions {
  store: AppStore;
  entity: EntityKey;
  mode: TableMode;
  cache: CellMetaCache;
  /** 被「列设置」隐藏的列 */
  hiddenFields?: Set<string>;
}

export function buildColumns(opts: BuildColumnsOptions): ColumnDefine[] {
  const { store, entity, mode, cache } = opts;
  const schema = SCHEMAS[entity];
  const rt = store.entities[entity];
  const hidden = opts.hiddenFields ?? new Set<string>();

  const cols: ColumnDefine[] = [buildCheckColumn(store, entity)];

  for (const fs of schema.fields) {
    const editorInstance = editorFor(fs);

    const resolveState = (table: Table, col: number, row: number): FieldState | undefined => {
      const rowData = rowAt(table, col, row);
      if (!rowData) return undefined;
      return cache.stateOf(rowData).get(fs.field);
    };

    const col: Record<string, unknown> = {
      field: fs.field,
      title: fs.title,
      width: fs.width,
      minWidth: Math.min(80, fs.width),
      maxWidth: 560,
      hide: hidden.has(fs.field),
      headerType: 'text',
      cellType: 'text',
      sort: true,
      headerStyle: {
        textBaseline: 'middle',
        textAlign: 'left',
        padding: { left: 10, right: 8 },
        fontSize: 12,
        fontWeight: 600,
        color: C.textSub,
        bgColor: C.bgSofter,
      },
      headerCustomLayout: (args: LayoutArgs) => {
        const table = args.table as Table;
        const { w, h } = cellSize(table, args.col, args.row, args.rect);
        const g = group(w, h, 'hd');
        // 该列是否正处在筛选态：表头要能一眼看出来
        const filtered = Boolean(store.columnFilterOf(entity, fs.field));
        if (filtered) {
          add(g, rect({ x: 0, y: 0, w, h }, C.primarySoft));
          add(g, rect({ x: 0, y: h - 2, w, h: 2 }, C.primary));
        }
        // 预留排序图标的位置（VTable 自己会画在右侧）
        const reserved = 18;
        add(
          g,
          text(fs.title, 10, h / 2, {
            fontSize: 12,
            fill: filtered ? C.primary : C.textSub,
            bold: true,
            maxWidth: w - 20 - reserved - (filtered ? 12 : 0),
          })
        );
        // 筛选漏斗：用几条递减的横条画，不依赖字体里有没有漏斗字形
        if (filtered) add(g, funnel(w - reserved - 10, h / 2, C.primary));
        else if (fs.hint) add(g, text('ⓘ', w - 30, h / 2, { fontSize: 11, fill: C.textFaint, align: 'right' }));
        return { rootContainer: g, renderDefault: false };
      },
      customLayout: (args: LayoutArgs) => {
        const table = args.table as Table;
        const { w, h } = cellSize(table, args.col, args.row, args.rect);
        const rowData = rowAt(table, args.col, args.row);
        if (!rowData) return { rootContainer: group(w, h), renderDefault: true };

        const state = cache.stateOf(rowData).get(fs.field) ?? { visible: true, editable: true, required: false };
        const ctx: WidgetCtx = {
          fs,
          row: rowData,
          value: rowData[fs.field],
          state,
          editable: mode === 'edit' && state.editable,
          dirty: store.isDirtyCell(entity, rowData.id, fs.field),
          checked: rt.selection.has(rowData.id),
          w,
          h,
        };
        return { rootContainer: renderWidget(fs.widget, ctx), renderDefault: false };
      },
      style: (args: LayoutArgs) => {
        const table = args.table as Table;
        const state = resolveState(table, args.col, args.row);
        if (mode !== 'edit') return { cursor: fs.widget === 'link' ? 'pointer' : 'default' };
        if (!state || !state.visible) return { cursor: 'not-allowed' };
        if (!state.editable) return { cursor: 'default' };
        return { cursor: fs.widget === 'switch' || fs.widget === 'link' ? 'pointer' : 'text' };
      },
    };

    if (mode === 'edit' && editorInstance) {
      col.editor = (args: LayoutArgs) => {
        const table = args.table as Table;
        const rowData = rowAt(table, args.col, args.row);
        if (!rowData) return new BlockedEditor('该单元格当前不可编辑');
        const state = cache.stateOf(rowData).get(fs.field);
        if (!state) return new BlockedEditor('该单元格当前不可编辑');
        if (!state.visible) return new BlockedEditor(state.reason ?? `「${fs.title}」在当前条件下已隐藏，不可编辑`);
        if (!state.editable) return new BlockedEditor(state.reason ?? `「${fs.title}」当前为只读`);
        return editorInstance;
      };
    }

    cols.push(col as unknown as ColumnDefine);
  }

  return cols;
}

/* ------------------------------------------------------------------ *
 * 行号列
 * ------------------------------------------------------------------ */

export function seriesNumberOptions(): IRowSeriesNumber {
  // 字面量必须 as const：ITextStyleOption.textAlign 是联合类型，推断成 string 会不匹配
  const cellStyle = { color: C.textWeak, fontSize: 12, textAlign: 'center' as const, textBaseline: 'middle' as const };
  return {
    width: 58,
    title: '行号',
    format: (_col?: number, row?: number, table?: { columnHeaderLevelCount?: number }) => {
      if (row === undefined) return '';
      const headerCount = safeNum(() => table?.columnHeaderLevelCount, 1);
      return String(row - headerCount + 1);
    },
    headerStyle: { bgColor: C.bgSofter, color: C.textSub, fontSize: 12, textAlign: 'center', textBaseline: 'middle' },
    style: cellStyle,
    disableColumnResize: true,
  };
}

/** 幂等注册自定义编辑器（在创建表格之前调用一次） */
export function setupEditors(): void {
  registerEditors();
}
