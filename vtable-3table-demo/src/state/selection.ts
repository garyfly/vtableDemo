/**
 * 选择模型。
 *
 * 10 万行下「全选」如果用 `Set` 逐个塞 id，点一下就是 10 万次插入 + 10 万个 id 的内存，
 * 而且每次筛选变化都要重算。这里用**反转集合**解决：
 *
 *   mode = 'include' → 选中的是 set 里的 id
 *   mode = 'exclude' → 选中的是「当前结果集里不在 set 里的 id」
 *
 * 于是「全选 10 万条」变成一次 `set.clear()` + 翻转 mode，O(1)；
 * 取消几条也只是往 set 里加几个 id，不会退化成全量遍历。
 */

import type { DataRow, RowId } from '../domain/types';

export type CheckState = 'checked' | 'unchecked' | 'indeterminate';

export class SelectionModel {
  /** 当前结果集（筛选 / 联动后的行），作为「全选」的论域 */
  private rows: DataRow[] = [];
  private mode: 'include' | 'exclude' = 'include';
  private set = new Set<RowId>();

  private sizeCache = -1;

  /** 结果集变化时调用。只存引用，不拷贝，10 万行下是 O(1) */
  setUniverse(rows: DataRow[]): void {
    this.rows = rows;
    this.sizeCache = -1;
  }

  get universeSize(): number {
    return this.rows.length;
  }

  has(id: RowId): boolean {
    return this.mode === 'include' ? this.set.has(id) : !this.set.has(id);
  }

  /** 返回切换后的状态 */
  toggle(id: RowId): boolean {
    const next = !this.has(id);
    if (this.mode === 'include') {
      if (next) this.set.add(id);
      else this.set.delete(id);
    } else {
      // exclude 模式下「取消选中」= 把 id 加进排除集
      if (next) this.set.delete(id);
      else this.set.add(id);
    }
    this.sizeCache = -1;
    return next;
  }

  setChecked(id: RowId, checked: boolean): void {
    if (this.has(id) !== checked) this.toggle(id);
  }

  /** 全选当前结果集：O(1) */
  selectAll(): void {
    this.mode = 'exclude';
    this.set.clear();
    this.sizeCache = -1;
  }

  /** 清空选择：O(1) */
  clear(): void {
    this.mode = 'include';
    this.set.clear();
    this.sizeCache = -1;
  }

  /** 反选 */
  invert(): void {
    if (this.mode === 'include') {
      // include → exclude，被排除的正好是「原来没选的」
      const excluded = new Set<RowId>();
      for (let i = 0; i < this.rows.length; i++) {
        const id = this.rows[i].id;
        if (!this.set.has(id)) excluded.add(id);
      }
      this.mode = 'exclude';
      this.set = excluded;
    } else {
      // exclude → include，原来被排除的现在变成选中的
      this.mode = 'include';
    }
    this.sizeCache = -1;
  }

  get size(): number {
    if (this.sizeCache >= 0) return this.sizeCache;
    if (this.mode === 'include') {
      this.sizeCache = this.set.size;
    } else {
      // exclude 模式：结果集大小减去被排除的行数（排除集通常很小）
      let n = this.rows.length;
      for (let i = 0; i < this.rows.length; i++) {
        if (this.set.has(this.rows[i].id)) n--;
      }
      this.sizeCache = Math.max(0, n);
    }
    return this.sizeCache;
  }

  get isEmpty(): boolean {
    return this.size === 0;
  }

  /** 是否已选中整个结果集 */
  get isAllSelected(): boolean {
    return this.rows.length > 0 && this.size === this.rows.length;
  }

  get headerState(): CheckState {
    if (this.rows.length === 0 || this.size === 0) return 'unchecked';
    return this.size === this.rows.length ? 'checked' : 'indeterminate';
  }

  /** 展开成真实 id 数组；只有真正要执行批量操作时才调用 */
  ids(): RowId[] {
    if (this.mode === 'include') return Array.from(this.set);
    const out: RowId[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      const id = this.rows[i].id;
      if (!this.set.has(id)) out.push(id);
    }
    return out;
  }

  /** 取选中行对象；批量操作时用 */
  selectedRows(): DataRow[] {
    if (this.mode === 'include') {
      const out: DataRow[] = [];
      for (const row of this.rows) if (this.set.has(row.id)) out.push(row);
      return out;
    }
    const out: DataRow[] = [];
    for (const row of this.rows) if (!this.set.has(row.id)) out.push(row);
    return out;
  }
}
