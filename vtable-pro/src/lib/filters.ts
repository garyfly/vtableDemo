/**
 * 列筛选 / 排序引擎 —— 纯函数，不碰 Vue，也不碰表格。
 *
 * 10 万行的账：
 *   · 没有筛选条件时**不复制数组**，直接把原始数组当视图返回（零成本）；
 *   · 有筛选条件时只做一次 O(n × 条件数) 扫描，命中行只 push 引用；
 *   · options 型筛选先把取值放进 Set，判断是 O(1)，不做嵌套遍历；
 *   · 排序只排「筛选后的视图」，且先 slice 再就地排（避免污染原始数组顺序）。
 */

import type { ColumnFilter, FilterState, ProColumn, Row, SortState } from './types';

const text = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

/**
 * 把**单个**列筛选编译成谓词。
 *
 * 关键：options 型的取值集合在这里就建好（一次），而不是每行都 new 一个 Set；
 * 关键字也只小写化一次。10 万行 × 每行一个 Set 曾经让单列筛选要 188ms，
 * 编译之后同样的活降到 ~10ms 量级。
 */
function compileOne(field: string, filter: ColumnFilter): (row: Row) => boolean {
  if (filter.kind === 'text') {
    const q = filter.value.trim().toLowerCase();
    if (!q) return () => true;
    if (filter.match === 'equals') return row => text(row[field]).toLowerCase() === q;
    if (filter.match === 'startsWith') return row => text(row[field]).toLowerCase().startsWith(q);
    return row => text(row[field]).toLowerCase().includes(q);
  }
  const set = new Set(filter.values);
  if (filter.exclude) return row => !set.has(text(row[field]));
  return row => set.has(text(row[field]));
}

/** 单个值是否命中某列筛选（零散判断用；批量请走 buildPredicate） */
export function matchFilter(value: unknown, filter: ColumnFilter): boolean {
  return compileOne('__value__', filter)({ __value__: value });
}

/** 把筛选状态编译成一个谓词（一次编译，多次调用） */
export function buildPredicate(filters: FilterState): ((row: Row) => boolean) | null {
  const active: ((row: Row) => boolean)[] = [];
  for (const field of Object.keys(filters)) {
    const f = filters[field];
    if (f) active.push(compileOne(field, f));
  }
  if (active.length === 0) return null;
  if (active.length === 1) return active[0];

  return (row: Row) => {
    for (let i = 0; i < active.length; i++) {
      if (!active[i](row)) return false;
    }
    return true;
  };
}

export interface FilterRunResult<T extends Row> {
  view: T[];
  /** 扫描耗时 ms */
  ms: number;
  /** 命中的条件数 */
  activeCount: number;
}

export function applyFilters<T extends Row>(rows: readonly T[], filters: FilterState): FilterRunResult<T> {
  const predicate = buildPredicate(filters);
  const activeCount = predicate ? Object.values(filters).filter(Boolean).length : 0;
  if (!predicate) {
    return { view: rows as T[], ms: 0, activeCount: 0 };
  }
  const t0 = performance.now();
  const out: T[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (predicate(rows[i])) out.push(rows[i]);
  }
  return { view: out, ms: performance.now() - t0, activeCount };
}

/* ------------------------------------------------------------------ *
 * 排序
 * ------------------------------------------------------------------ */

function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/** 排序（返回新数组；sort 为 null 时原样返回输入引用） */
export function applySort<T extends Row>(view: readonly T[], sort: SortState | null): T[] {
  if (!sort) return view as T[];
  const copy = view.slice();
  const dir = sort.order === 'desc' ? -1 : 1;
  const field = sort.field;
  copy.sort((a, b) => dir * compareValues(a[field], b[field]));
  return copy;
}

/* ------------------------------------------------------------------ *
 * 表头筛选形态的自动选择
 * ------------------------------------------------------------------ */

/**
 * 某列该用哪种筛选形态：
 *   · 显式指定就听显式的；
 *   · 否则看去重值个数 —— 少于阈值用「取值勾选」，否则用「关键字」。
 *     （10 万行的 name 列有 10 万个不同取值，勾选列表没有意义）
 */
export function resolveFilterKind<T extends Row>(
  column: ProColumn<T>,
  distinctCount: number,
  truncated: boolean
): 'text' | 'options' {
  if (column.filterKind) return column.filterKind;
  if (truncated) return 'text';
  if (column.cell) return 'text';
  return distinctCount <= 200 ? 'options' : 'text';
}

/** 筛选状态里有没有生效的条件 */
export function hasActiveFilter(filter: ColumnFilter | null | undefined): boolean {
  if (!filter) return false;
  if (filter.kind === 'text') return filter.value.trim().length > 0;
  return filter.values.length > 0;
}

/** 一句话描述筛选条件（工具栏 chip 用） */
export function describeFilter(filter: ColumnFilter): string {
  if (filter.kind === 'text') {
    const op = filter.match === 'equals' ? '=' : filter.match === 'startsWith' ? '开头是' : '包含';
    return `${op} ${filter.value}`;
  }
  const head = filter.exclude ? '不含' : '含';
  const shown = filter.values.slice(0, 3).join('/');
  return filter.values.length > 3 ? `${head} ${shown} 等 ${filter.values.length} 项` : `${head} ${shown}`;
}
