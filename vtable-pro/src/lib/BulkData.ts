/**
 * BulkData —— 「全量导入 + 非响应式」的落点。
 *
 * 需求里最要命的一条是「十万行原始数据导入进来，内部别用响应式去管它」。
 * 这里对应三件事：
 *
 *  1. 行对象永远不进 `ref` / `reactive`：`setRows()` 会先 `toRaw()` 再 `markRaw()`，
 *     即使调用方传进来的是 `ref([...]).value`（已经是 Proxy），也只留原始对象。
 *     Vue 的响应式系统一旦递归代理 10 万个对象，光 Proxy 就是十万个，
 *     内存和 GC 都是灾难，而且每次读属性都多一层。
 *  2. 视图（筛选 / 排序结果）只存**引用**，不拷贝行对象：
 *     10 万行的数组拷贝本身不贵，贵的是「每行再复制一份」。
 *  3. 索引 / 去重值域都是**按需**构建并缓存的：
 *     不筛选就不建值域，不按 key 查就不建 Map。
 *
 * 对外只暴露同步方法，没有任何响应式钩子 —— 组件那边用 tick 计数驱动 UI 更新，
 * 而不是把这份数据塞进 Vue 的依赖图。
 */

import { markRaw, toRaw } from 'vue';
import type { Row, RowKey } from './types';

export interface DomainEntry {
  /** 原始取值（保留类型，用于回填 UI） */
  value: unknown;
  /** 字符串化后的取值（比较 / 去重都用它） */
  text: string;
  /** 出现次数 */
  count: number;
}

export interface DomainResult {
  entries: DomainEntry[];
  /** 去重值数量超上限被截断时为 true（此时表头筛选应退回关键字模式） */
  truncated: boolean;
  /** 统计耗时（ms），表头筛选弹窗里会显示 */
  ms: number;
}

export interface BulkDataOptions<T extends Row> {
  /** 取唯一键；默认读 `id` */
  keyOf?: (row: T) => RowKey;
  /** 值域统计的去重上限，超过就截断（默认 5000） */
  domainLimit?: number;
}

export class BulkData<T extends Row = Row> {
  /** 原始全量数据（已 markRaw） */
  private _rows: T[] = [];
  /** 当前视图：筛选 / 排序后的行引用数组 */
  private _view: T[] = [];
  private keyOf: (row: T) => RowKey;
  private domainLimit: number;

  private viewIndex: Map<RowKey, number> | null = null;
  private rowIndex: Map<RowKey, number> | null = null;
  private domains = new Map<string, DomainResult>();
  /** 数据版本号：换数据 / 视图变化都会 bump，用来让各种缓存失效 */
  private _version = 0;

  constructor(opts: BulkDataOptions<T> = {}) {
    this.keyOf = opts.keyOf ?? ((row: T) => row.id as RowKey);
    this.domainLimit = opts.domainLimit ?? 5000;
  }

  /* ------------------------------ 导入 ------------------------------ */

  /**
   * 全量导入原始数据。
   *
   * 注意这里**不遍历数据**：10 万行的导入应该是 O(1) 的引用交接，
   * 遍历留给真正需要的时候（建索引、算值域、筛选）。
   */
  setRows(rows: readonly T[]): void {
    // toRaw：调用方可能把 ref 里的 Proxy 数组直接递进来
    // markRaw：把「别再代理它」写死在对象上，后续任何 reactive() 都会跳过
    const raw = markRaw(toRaw(rows)) as T[];
    this._rows = raw;
    this._view = raw;
    this.invalidate();
  }

  /** 用筛选 / 排序后的结果替换视图（只换引用，不碰原始数据） */
  setView(view: readonly T[]): void {
    this._view = view as T[];
    this.viewIndex = null;
    this._version++;
  }

  /** 原地修改了行数据（比如内联编辑）后调用，只失效缓存 */
  invalidate(): void {
    this.viewIndex = null;
    this.rowIndex = null;
    this.domains.clear();
    this._version++;
  }

  /* ------------------------------ 读取 ------------------------------ */

  get rows(): readonly T[] {
    return this._rows;
  }

  get view(): readonly T[] {
    return this._view;
  }

  get total(): number {
    return this._rows.length;
  }

  get viewCount(): number {
    return this._view.length;
  }

  get version(): number {
    return this._version;
  }

  /** 视图里第 i 行 */
  at(viewIndexPos: number): T | undefined {
    return this._view[viewIndexPos];
  }

  keyFor(row: T): RowKey {
    return this.keyOf(row);
  }

  /**
   * 建「视图下标」索引：按 key 查行在视图里的位置。
   * 10 万行的 Map 构建约 10~20ms，只在真的要按 key 定位时才建。
   */
  private ensureViewIndex(): Map<RowKey, number> {
    if (this.viewIndex) return this.viewIndex;
    const m = new Map<RowKey, number>();
    for (let i = 0; i < this._view.length; i++) m.set(this.keyOf(this._view[i]), i);
    this.viewIndex = m;
    return m;
  }

  /** 兼容原始数据下标的索引（导出「原始第几行」这类场景用） */
  private ensureRowIndex(): Map<RowKey, number> {
    if (this.rowIndex) return this.rowIndex;
    const m = new Map<RowKey, number>();
    for (let i = 0; i < this._rows.length; i++) m.set(this.keyOf(this._rows[i]), i);
    this.rowIndex = m;
    return m;
  }

  /** key → 视图下标；不存在返回 -1 */
  viewIndexOf(key: RowKey): number {
    const idx = this.ensureViewIndex().get(key);
    return idx === undefined ? -1 : idx;
  }

  /** key → 原始数据下标；不存在返回 -1 */
  sourceIndexOf(key: RowKey): number {
    const idx = this.ensureRowIndex().get(key);
    return idx === undefined ? -1 : idx;
  }

  /** key → 视图里的行对象 */
  rowByKey(key: RowKey): T | undefined {
    const i = this.viewIndexOf(key);
    return i < 0 ? undefined : this._view[i];
  }

  /* --------------------------- 值域统计 --------------------------- */

  /**
   * 统计某列在当前**视图**上的去重取值与出现次数（表头筛选弹窗的数据源）。
   * 一次 O(n) 遍历，结果按出现次数降序；超过 domainLimit 直接截断并标记。
   */
  domain(field: string): DomainResult {
    const hit = this.domains.get(field);
    if (hit) return hit;

    const t0 = performance.now();
    const counts = new Map<string, number>();
    const sample = new Map<string, unknown>();
    let truncated = false;

    for (let i = 0; i < this._view.length; i++) {
      const v = (this._view[i] as Row)[field];
      const text = v === null || v === undefined ? '' : String(v);
      const seen = counts.get(text);
      if (seen === undefined) {
        if (counts.size >= this.domainLimit) {
          truncated = true;
          continue;
        }
        counts.set(text, 1);
        sample.set(text, v);
      } else {
        counts.set(text, seen + 1);
      }
    }

    const entries: DomainEntry[] = new Array(counts.size);
    let i = 0;
    for (const [text, count] of counts) entries[i++] = { value: sample.get(text), text, count };
    entries.sort((a, b) => b.count - a.count || (a.text < b.text ? -1 : a.text > b.text ? 1 : 0));

    const res: DomainResult = { entries, truncated, ms: performance.now() - t0 };
    this.domains.set(field, res);
    return res;
  }
}
