/**
 * 一张「联动大表」的 VTable 封装。
 *
 * 它把 VTable 的命令式 API 收敛成 store 的订阅者：
 *   数据变了   → setRecords
 *   值变了     → renderWithRecreateCells（只重建可视区的单元格）
 *   选中变了   → renderWithRecreateCells
 *   编辑态变了 → updateColumns
 *
 * 10 万行的关键取舍：
 *   1. heightMode/widthMode 固定为 standard，行高列宽全部给死值。
 *      一旦开成 adaptive/autoHeight，VTable 要测量每一行，10 万行直接卡死；
 *   2. 不做逐格 canvas 文本测量（见 table/canvas.ts）；
 *   3. 全选 / 反选只翻转 SelectionModel 的模式位，不遍历数据；
 *   4. 用户内联编辑写回来时先回滚 VTable 自己写进 row 的值，再走 store 的唯一写路径，
 *      保证联动派生、脏标记、撤销栈一个都不漏。
 */

import { ListTable } from '@visactor/vtable';
import { SCHEMAS } from '../domain/schema';
import type { DataRow, EntityKey } from '../domain/types';
import type { AppStore } from '../state/store';
import { C } from './canvas';
import { buildColumns, CHECK_FIELD, createCellMetaCache, seriesNumberOptions, setupEditors, type CellMetaCache } from './columns';
import { showToast } from './editors';

export interface LinkedTableOptions {
  container: HTMLElement;
  store: AppStore;
  entity: EntityKey;
  /** 分页模式：每页条数（不传 = 全量交给虚拟滚动） */
  perPage?: number | null;
  /**
   * 点了某个数据列的表头。
   * 传 rect 而不是 DOM 元素：表头画在 canvas 上，没有对应的 DOM 节点。
   */
  onHeaderClick?: (field: string, rect: { left: number; top: number; right: number; bottom: number }) => void;
}

export interface TableStats {
  total: number;
  showing: number;
  selected: number;
  queryMs: number;
}

export class LinkedTable {
  readonly table: ListTable;
  readonly entity: EntityKey;

  private store: AppStore;
  private cache: CellMetaCache;
  private hiddenFields = new Set<string>();
  private unsubs: (() => void)[] = [];
  private renderScheduled = false;
  private destroyed = false;
  private pageSize: number | null;
  private onHeaderClick: LinkedTableOptions['onHeaderClick'];

  constructor(opts: LinkedTableOptions) {
    this.store = opts.store;
    this.entity = opts.entity;
    this.pageSize = opts.perPage ?? null;
    this.onHeaderClick = opts.onHeaderClick;
    setupEditors();

    const schema = SCHEMAS[this.entity];
    const rt = this.store.entities[this.entity];
    this.cache = createCellMetaCache(schema, this.store, this.entity);

    this.table = new ListTable(opts.container, {
      records: rt.rows,
      columns: buildColumns({
        store: this.store,
        entity: this.entity,
        mode: this.store.mode,
        cache: this.cache,
        hiddenFields: this.hiddenFields,
      }),

      /* ---- 尺寸：全部固定，避免 10 万行的测量开销 ---- */
      widthMode: 'standard',
      heightMode: 'standard',
      defaultRowHeight: 36,
      defaultHeaderRowHeight: 40,
      defaultColWidth: 120,
      autoFillWidth: true,
      autoWrapText: false,
      enableLineBreak: false,

      rowSeriesNumber: seriesNumberOptions(),
      frozenColCount: 2, // 行号 + 选择列
      overscrollBehavior: 'none',
      animationAppear: false,
      maxOperatableRecordCount: 1_000_000,
      resizeTime: 20,

      pagination: this.pageSize
        ? { perPageCount: this.pageSize, currentPage: 1, totalCount: rt.total }
        : undefined,

      /* ---- 交互 ---- */
      editCellTrigger: ['doubleclick'],
      keyboardOptions: {
        copySelected: true,
        pasteValueToCell: false,
        selectAllOnCtrlA: true,
        moveFocusCellOnTab: true,
        editCellOnEnter: true,
      },
      select: {
        highlightMode: 'row',
        headerSelectMode: 'inline',
        disableDragSelect: true,
        blankAreaClickDeselect: true,
        outsideClickDeselect: false,
      },
      hover: { highlightMode: 'row' },
      tooltip: { isShowOverflowTextTooltip: true, renderMode: 'html' },

      customConfig: {
        // 大面积固定行高，禁止按内容撑高
        forceComputeAllRowHeight: false,
        limitContentHeight: true,
        scrollEventAlwaysTrigger: false,
      },

      theme: {
        underlayBackgroundColor: C.white,
        defaultStyle: { borderColor: '#F0F1F3', borderLineWidth: [0, 0, 1, 0], fontSize: 13, color: C.text },
        headerStyle: {
          bgColor: C.bgSofter,
          color: C.textSub,
          fontSize: 12,
          fontWeight: 600,
          borderColor: C.border,
          borderLineWidth: [0, 0, 1, 0],
          textAlign: 'left',
          textBaseline: 'middle',
          padding: [0, 8, 0, 10],
        },
        bodyStyle: {
          bgColor: C.white,
          color: C.text,
          fontSize: 13,
          borderColor: '#F0F1F3',
          borderLineWidth: [0, 0, 1, 0],
          hover: { cellBgColor: '#F7F9FC' },
          select: { cellBgColor: C.selectRow },
        },
        frameStyle: { borderColor: C.border, borderLineWidth: 0, innerBorder: false },
        scrollStyle: { visible: 'scrolling', scrollSliderColor: '#D0D3D9', width: 8, hoverOn: true },
      },
    });

    this.bindStore();
    this.bindTable();
  }

  /* ------------------------------------------------------------ *
   * 数据 → 表格
   * ------------------------------------------------------------ */

  private bindStore(): void {
    const { store, entity } = this;
    this.unsubs.push(
      store.on('data', e => {
        if (e && e !== entity) return;
        const rt = store.entities[entity];
        this.cache.invalidate();
        // setRecords 会换掉整份数据源，分页模式下同步总条数
        if (this.pageSize) {
          this.table.updatePagination({ perPageCount: this.pageSize, currentPage: 1, totalCount: rt.total });
        }
        this.table.setRecords(rt.rows);
      })
    );
    this.unsubs.push(
      store.on('cells', e => {
        if (e && e !== entity) return;
        this.cache.invalidate();
        this.scheduleRender();
      })
    );
    this.unsubs.push(
      store.on('selection', e => {
        if (e && e !== entity) return;
        this.cache.invalidate();
        this.scheduleRender();
      })
    );
    this.unsubs.push(
      store.on('mode', () => {
        // 查看态直接不带 editor，比在编辑函数里返回 undefined 更干净
        this.table.updateColumns(
          buildColumns({
            store,
            entity,
            mode: store.mode,
            cache: this.cache,
            hiddenFields: this.hiddenFields,
          })
        );
        this.scheduleRender();
      })
    );
  }

  /** 合并同一帧内的多次重绘请求 */
  private scheduleRender(): void {
    if (this.renderScheduled || this.destroyed) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (this.destroyed) return;
      this.table.renderWithRecreateCells();
    });
  }

  /* ------------------------------------------------------------ *
   * 表格事件 → store
   * ------------------------------------------------------------ */

  private bindTable(): void {
    const { store, entity } = this;
    const schema = SCHEMAS[entity];
    const rt = store.entities[entity];

    this.table.on('click_cell', args => {
      const row = args.row;
      const col = args.col;
      const field = String((args as unknown as { field?: string }).field ?? '');
      const isHeader = row < headerLevels(this.table);

      /* --- 表头：全选 / 列筛选 --- */
      if (isHeader) {
        if (field === CHECK_FIELD) {
          if (rt.selection.isAllSelected) rt.selection.clear();
          else rt.selection.selectAll();
          store.setStatus(
            rt.selection.isEmpty
              ? '已清空勾选'
              : `已全选当前结果集 ${rt.selection.size} 条（筛选变更后自动跟随）`
          );
          // 勾选变了 → 下级跟着收窄，统一走 store 的唯一入口
          void store.selectionChanged(entity);
          return;
        }
        // 行号列 / 选择列之外的任何数据列，点表头都打开该列的筛选弹窗
        if (field && schema.fields.some(f => f.field === field) && this.onHeaderClick) {
          // 必须用 getCellRelativeRect：getCellRect 返回的是「内容坐标系」，
          // 不含横向滚动偏移。三屏并排后每屏只有 ~550px，横向滚动是常态，
          // 用内容坐标会把弹窗锚到错误的位置。
          const r = this.table.getCellRelativeRect(col, row);
          const cr = this.table.getElement().getBoundingClientRect();
          if (r.right > 0 && r.left < cr.width) {
            this.onHeaderClick(field, {
              left: cr.left + r.left,
              top: cr.top + r.top,
              right: cr.left + r.right,
              bottom: cr.top + r.bottom,
            });
          }
        }
        return;
      }

      const rowData = safeRecord(this.table, col, row);
      if (!rowData) return;

      /* --- 行内复选框：勾选就是联动本身 --- */
      if (field === CHECK_FIELD) {
        rt.selection.toggle(rowData.id);
        store.setStatus(rt.selection.isEmpty ? '已取消勾选' : `已勾选 ${rt.selection.size} 条`);
        void store.selectionChanged(entity);
        return;
      }

      /* 注意这里**不再**用行点击去驱动联动：
         点击只做本行的事（下面按组件类型分派），下钻完全由勾选决定。
         早先「点哪一行下级就跟着变」会让「想双击编辑」和「想下钻」互相打架。 */
      const fs = schema.fields.find(f => f.field === field);
      if (!fs) return;
      const state = this.cache.stateOf(rowData).get(fs.field);
      const editable = store.editable && (state?.editable ?? false) && (state?.visible ?? true);

      /* --- 开关类：单击直接切换（联动从这里被触发） --- */
      if (fs.widget === 'switch') {
        if (!editable) {
          showToast(state?.reason ?? `「${fs.title}」当前不可修改`, 'warn');
          return;
        }
        const next = rowData[fs.field] !== true;
        store.editCell(entity, rowData.id, fs.field, next, `切换「${fs.title}」`);
        announceLinkage(store, entity, rowData, fs.field, next, fs.title);
        return;
      }

      /* --- 其它组件：单击即进入编辑（编辑态） --- */
      if (editable && CLICK_TO_EDIT.has(fs.widget)) {
        this.table.startEditCell(col, row);
      }
    });

    /* --- 内联编辑写回 --- */
    this.table.on('change_cell_value', args => {
      const field = String(args.field ?? '');
      if (!field || field === CHECK_FIELD) return;
      const recordIndex = typeof args.recordIndex === 'number' ? args.recordIndex : -1;
      const rowData = recordIndex >= 0 ? (rt.rows[recordIndex] as DataRow | undefined) : safeRecord(this.table, args.col, args.row);
      if (!rowData) return;

      // 关键：此刻 VTable 已经把它写进了 row，所以 row[field] 就是新值。
      // 「改动前的值」只能从 args.rawValue 拿（VTable 在写入前抓的快照）。
      const raw = args.rawValue;
      if (sameValue(raw, args.changedValue)) return; // 确实没变化
      rowData[field] = raw; // 先回滚 VTable 的旁路写入

      const fs = schema.fields.find(f => f.field === field);
      store.editCell(entity, rowData.id, field, args.changedValue, `编辑「${fs?.title ?? field}」`);
      if (fs?.widget === 'switch') announceLinkage(store, entity, rowData, field, args.changedValue, fs.title);
    });

    /* --- 排序：拦下 VTable 的默认排序，交给数据源 --- */
    this.table.on('sort_click', args => {
      const order = args.order === 'asc' || args.order === 'ASC' ? 'asc' : args.order === 'desc' || args.order === 'DESC' ? 'desc' : null;
      const sort = order ? { field: String(args.field), order: order as 'asc' | 'desc' } : null;
      void store.setSort(entity, sort);
      // executeSort = false：只更新表头图标，实际排序由数据源完成
      this.table.updateSortState(sort ? { field: args.field, order: order as 'asc' | 'desc' } : null, false);
      return false;
    });

    /* --- 双击进入编辑：不再顺带聚焦（联动由勾选驱动，编辑不需要改联动） --- */
  }

  /* ------------------------------------------------------------ *
   * 对外操作
   * ------------------------------------------------------------ */

  setHiddenFields(fields: Set<string>): void {
    this.hiddenFields = fields;
    this.rebuildColumns();
  }

  /** 重建列定义（列隐藏、表头筛选角标等都靠它刷新） */
  rebuildColumns(): void {
    this.table.updateColumns(
      buildColumns({
        store: this.store,
        entity: this.entity,
        mode: this.store.mode,
        cache: this.cache,
        hiddenFields: this.hiddenFields,
      })
    );
    this.scheduleRender();
  }

  get hidden(): Set<string> {
    return this.hiddenFields;
  }

  stats(): TableStats {
    const rt = this.store.entities[this.entity];
    return {
      total: rt.total,
      showing: rt.rows.length,
      selected: rt.selection.size,
      queryMs: rt.lastQueryMs,
    };
  }

  /** 滚动到某一行（联动定位用） */
  scrollToRowIndex(index: number): void {
    try {
      this.table.scrollToCell({ col: 0, row: headerLevels(this.table) + index });
    } catch {
      /* 忽略：行不在当前结果集里 */
    }
  }

  destroy(): void {
    this.destroyed = true;
    for (const u of this.unsubs) u();
    this.unsubs = [];
    try {
      this.table.release();
    } catch {
      /* release 失败不影响页面卸载 */
    }
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

const CLICK_TO_EDIT = new Set(['select', 'multiSelect', 'user', 'rating', 'date', 'progress', 'number', 'money']);

function headerLevels(table: ListTable): number {
  const n = (table as unknown as { columnHeaderLevelCount?: number }).columnHeaderLevelCount;
  return typeof n === 'number' && n > 0 ? n : 1;
}

function safeRecord(table: ListTable, col: number, row: number): DataRow | undefined {
  try {
    return table.getCellOriginRecord(col, row) as DataRow | undefined;
  } catch {
    return undefined;
  }
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  return false;
}

/** 开关切换后，把「影响了哪些属性」直接告诉用户，联动不再是个黑盒 */
function announceLinkage(store: AppStore, entity: EntityKey, row: DataRow, driver: string, value: unknown, title: string): void {
  const schema = SCHEMAS[entity];
  const fired = schema.rules.filter(r => r.driver === driver && r.when(row));
  void value;
  if (fired.length === 0) {
    store.setStatus(`「${title}」已切换，未触发其它属性联动`);
    return;
  }
  const parts = fired.map(r => r.label).join('；');
  store.setStatus(`「${title}」已切换 → ${parts}`);
}
