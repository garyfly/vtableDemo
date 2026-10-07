/**
 * 选择模型（反向集合）。
 *
 * 10 万行下「全选」如果逐行塞 id，点一下就是 10 万次 Set 插入 + 10 万条 id 常驻内存，
 * 每次筛选变化还要重算。这里用反转集合：
 *
 *   mode = 'include' → 选中的是 set 里的 key
 *   mode = 'exclude' → 选中的是「当前视图里不在 set 里的 key」
 *
 * 「全选 10 万行」= 清空 set + 翻转 mode，O(1)、零额外内存；
 * 「全选后取消 3 行」= set 里加 3 个 key，不会退化。
 *
 * 同一个模型同时驱动：勾选列画法、表头全选态、工具栏计数、getCheckedRows()。
 */

import type { Row, RowKey } from './types';

export type CheckState = 'checked' | 'unchecked' | 'indeterminate';

export class SelectionModel {
  private mode: 'include' | 'exclude' = 'include';
  private set = new Set<RowKey>();
  private universeSize = 0;

  private sizeCache = -1;
  /** ids() 的展开结果缓存：exclude 模式下算一次是一次全量扫描 */
  private keysCache: RowKey[] | null = null;

  /** 结果集换了（筛选 / 换数据）→ 只更新论域大小，不做任何遍历 */
  setUniverseSize(n: number): void {
    this.universeSize = n;
    this.sizeCache = -1;
    this.keysCache = null;
  }

  get universe(): number {
    return this.universeSize;
  }

  has(key: RowKey): boolean {
    return this.mode === 'include' ? this.set.has(key) : !this.set.has(key);
  }

  /** 返回切换后的选中态 */
  toggle(key: RowKey): boolean {
    const next = !this.has(key);
    if (this.mode === 'include') {
      if (next) this.set.add(key);
      else this.set.delete(key);
    } else {
      // exclude 模式下「取消选中」= 把这个 key 放进排除集
      if (next) this.set.delete(key);
      else this.set.add(key);
    }
    this.sizeCache = -1;
    this.keysCache = null;
    return next;
  }

  setChecked(key: RowKey, checked: boolean): void {
    if (this.has(key) !== checked) this.toggle(key);
  }

  /** 全选当前视图：O(1) */
  selectAll(): void {
    this.mode = 'exclude';
    this.set.clear();
    this.sizeCache = -1;
    this.keysCache = null;
  }

  /** 清空：O(1) */
  clear(): void {
    this.mode = 'include';
    this.set.clear();
    this.sizeCache = -1;
    this.keysCache = null;
  }

  get modeName(): 'include' | 'exclude' {
    return this.mode;
  }

  get size(): number {
    if (this.sizeCache >= 0) return this.sizeCache;
    if (this.mode === 'include') {
      this.sizeCache = this.set.size;
    } else {
      // exclude 模式：论域大小 - 被排除的 key 数（排除集通常很小）
      this.sizeCache = Math.max(0, this.universeSize - this.set.size);
    }
    return this.sizeCache;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  get isAllSelected(): boolean {
    return this.universeSize > 0 && this.size === this.universeSize;
  }

  get headerState(): CheckState {
    if (this.universeSize === 0 || this.size === 0) return 'unchecked';
    return this.size === this.universeSize ? 'checked' : 'indeterminate';
  }

  /**
   * 展开成真实 key 数组（导出、批量操作、跨表联动用）。
   * 返回的是内部数组，调用方只读；exclude 模式下需要扫一遍视图。
   */
  keysOf(view: readonly Row[], keyOf: (row: Row) => RowKey): RowKey[] {
    if (this.keysCache) return this.keysCache;
    if (this.mode === 'include') {
      this.keysCache = Array.from(this.set);
      return this.keysCache;
    }
    const out: RowKey[] = [];
    for (let i = 0; i < view.length; i++) {
      const k = keyOf(view[i]);
      if (!this.set.has(k)) out.push(k);
    }
    this.keysCache = out;
    return out;
  }

  /** 取选中行对象（工具栏「获取勾选行」走这条） */
  rowsOf(view: readonly Row[], keyOf: (row: Row) => RowKey): Row[] {
    const out: Row[] = [];
    for (let i = 0; i < view.length; i++) {
      const row = view[i];
      if (this.has(keyOf(row))) out.push(row);
    }
    return out;
  }

  /** 用于把 key 列表灌回模型（受控用法） */
  replaceWith(keys: readonly RowKey[], universeSize: number): void {
    this.mode = 'include';
    this.set = new Set(keys);
    this.universeSize = universeSize;
    this.sizeCache = -1;
    this.keysCache = null;
  }
}
