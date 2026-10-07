/**
 * 应用状态中心。
 *
 * 负责三件事：
 *  1. 三层数据的查询与联动（谁选了什么 → 下级表查什么）；
 *  2. 所有写操作的唯一入口（单元格编辑 / 批量操作 / 删除），
 *     在这里统一做联动派生、脏数据登记、撤销栈；
 *  3. 用 topic 事件通知 UI：行集变了 / 只是单元格值变了 / 选中变了 / 编辑态变了。
 *
 * UI 层（工具栏、面板、表格）只订阅事件，不互相调用。
 */

import { applyRuleValues, SCHEMAS, type EntitySchema } from '../domain/schema';
import type { CellPatch, DataRow, EntityKey, FilterCondition, PatchRecord, QueryState, RowId, TableMode } from '../domain/types';
// 纯函数、与框架无关：面包屑上的「已勾选 N 项」要和面板头部一样带千分位
import { num } from '../utils/format';
import { emptyQueryState } from '../domain/types';
import type { DataSource, QueryRequest } from '../data/datasource';
import { SelectionModel } from './selection';

/** 列筛选条件的 id 前缀：用来和「筛选」面板里的条件区分开 */
export const COLUMN_FILTER_PREFIX = 'col:';

/** 某一列的筛选条件 id */
export const columnFilterId = (field: string): string => `${COLUMN_FILTER_PREFIX}${field}`;

export type StoreTopic = 'data' | 'cells' | 'selection' | 'mode' | 'dirty' | 'query' | 'status';

export interface EntityRuntime {
  key: EntityKey;
  schema: EntitySchema;
  /** 当前展示的行（筛选 + 排序后）。与数据源内的行对象是同一引用 */
  rows: DataRow[];
  /** 命中总行数（分页模式下会大于 rows.length） */
  total: number;
  query: QueryState;
  selection: SelectionModel;
  /**
   * 本表要按哪些父级收窄 —— 由**上一级表的勾选**推导，不在这里存状态。
   *
   * 命令式版本这里放的是 `focusedId`（点哪一行就下钻）；改成勾选驱动之后
   * 锚点变成了「上级勾选的集合」，单一 id 表达不了了，
   * 于是「谁勾了什么」只存在于上级的 SelectionModel 里，见 parentScopeOf()。
   * 好处是不会有第二份需要同步的状态：勾选一变，下级必然跟着变。
   */
  lastQueryMs: number;
  loading: boolean;
}

interface DirtyCell {
  id: RowId;
  field: string;
  from: unknown;
  to: unknown;
}

type Handler = (entity?: EntityKey) => void;

export class AppStore {
  readonly entities: Record<EntityKey, EntityRuntime>;

  mode: TableMode = 'view';

  /** 后端数据源当前是否已降级（HTTP 模式网络失败时） */
  degraded = false;

  /** 降级原因，界面上用来解释「为什么看到的是本地数据」 */
  sourceError = '';

  private dirty = new Map<EntityKey, Map<string, DirtyCell>>();
  /**
   * 已保存值快照，键是 `${id}\0${field}`。
   * 只记录被改动过的单元格（不是全表 15 万个格子），
   * 有了它「脏」就可以随时由 `当前值 !== 已保存值` 重算出来，
   * 撤销 / 重做 / 回滚都自动保持一致，不需要维护方向性。
   */
  private saved = new Map<EntityKey, Map<string, unknown>>();
  private undoStack: PatchRecord[] = [];
  private redoStack: PatchRecord[] = [];

  private handlers = new Map<StoreTopic, Set<Handler>>();

  /** 状态栏的一句话 */
  statusText = '';

  /**
   * 数据版本号。行集变化或单元格值变化时自增，
   * 表格层的联动求值缓存靠它判断是否过期。
   */
  private _version = 0;

  get version(): number {
    return this._version;
  }

  private bumpVersion(): void {
    this._version++;
  }

  constructor(readonly source: DataSource) {
    const mk = (key: EntityKey): EntityRuntime => ({
      key,
      schema: SCHEMAS[key],
      rows: [],
      total: 0,
      query: emptyQueryState(),
      selection: new SelectionModel(),
      lastQueryMs: 0,
      loading: false,
    });
    this.entities = { project: mk('project'), task: mk('task'), execution: mk('execution') };
    for (const key of Object.keys(this.entities) as EntityKey[]) {
      this.dirty.set(key, new Map());
      this.saved.set(key, new Map());
    }
  }

  /* ------------------------------------------------------------ *
   * 事件
   * ------------------------------------------------------------ */

  on(topic: StoreTopic, handler: Handler): () => void {
    let set = this.handlers.get(topic);
    if (!set) this.handlers.set(topic, (set = new Set()));
    set.add(handler);
    return () => set!.delete(handler);
  }

  private emit(topic: StoreTopic, entity?: EntityKey): void {
    const set = this.handlers.get(topic);
    if (!set) return;
    for (const h of set) h(entity);
  }

  /* ------------------------------------------------------------ *
   * 初始化 / 查询
   * ------------------------------------------------------------ */

  async init(onProgress?: (stage: string, ratio: number) => void): Promise<void> {
    await this.source.init(onProgress);
    await Promise.all([this.refresh('project'), this.refresh('task'), this.refresh('execution')]);
    this.emit('data');
    this.emit('selection');
  }

  /**
   * 某张表要按哪些父级收窄 —— 直接读上一级表的勾选集合。
   *
   * 不额外缓存：SelectionModel.ids() 自带按变更失效的缓存，
   * 所以这里在 exclude 模式（全选 10 万）下也不会每次刷新都重扫一遍。
   */
  private parentScopeOf(entity: EntityKey): RowId[] | null | undefined {
    const parent = SCHEMAS[entity].parent;
    if (!parent) return undefined;
    const ids = this.entities[parent.entity].selection.ids();
    // 上级一行都没勾 → 不约束，展示全部
    return ids.length > 0 ? ids : undefined;
  }

  async refresh(entity: EntityKey): Promise<void> {
    const rt = this.entities[entity];
    rt.loading = true;
    this.emit('status', entity);
    const req: QueryRequest = {
      parentIds: this.parentScopeOf(entity),
      query: rt.query,
    };
    const res = await this.source.query(entity, req);
    rt.rows = res.rows;
    rt.total = res.total;
    rt.lastQueryMs = res.elapsedMs;
    rt.loading = false;
    rt.selection.setUniverse(res.rows);
    // 每次查询后同步兜底状态：HTTP 模式连不上后端时要让界面明说
    this.degraded = this.source.degraded === true;
    this.sourceError = this.source.lastError ?? '';
    this.bumpVersion();
    this.emit('data', entity);
    this.emit('selection', entity);
    this.emit('status', entity);
    const follow = this.followAllSelected(entity);
    if (follow) await follow;
  }

  /**
   * 「全选」是**跟随结果集**的语义（exclude 模式）：查询条件一变，
   * 被勾选的行就换了一批。这时下级必须跟着重新收窄，
   * 否则明细表会一直停在上一批上级行的并集上 —— 看起来就像筛选没生效。
   *
   * 返回 null 表示不需要额外动作（末级表，或当前不是全选态）。
   */
  private followAllSelected(entity: EntityKey): Promise<void> | null {
    if (entity === 'execution') return null;
    if (!this.entities[entity].selection.isAllSelected) return null;
    return this.rescopeFrom(entity);
  }

  /** 三级联动刷新：本项目及其所有下级 */
  private async refreshFrom(entity: EntityKey): Promise<void> {
    await this.refresh(entity);
    if (entity === 'task') await this.refresh('execution');
  }

  async setKeyword(entity: EntityKey, keyword: string): Promise<void> {
    this.entities[entity].query.keyword = keyword;
    this.emit('query', entity);
    await this.refresh(entity);
  }

  async setConditions(entity: EntityKey, conditions: QueryState['conditions']): Promise<void> {
    this.entities[entity].query.conditions = conditions;
    this.emit('query', entity);
    await this.refresh(entity);
  }

  async setSort(entity: EntityKey, sort: QueryState['sort']): Promise<void> {
    this.entities[entity].query.sort = sort;
    this.emit('query', entity);
    await this.refresh(entity);
  }

  /* ------------------------------------------------------------ *
   * 列筛选（表头点开的那种）
   *
   * 列筛选和「筛选」面板里的条件共用 rt.query.conditions，
   * 靠 id 前缀区分：列筛选的 id 固定是 `col:<field>`。
   * 这样两者可以叠加，又能各自独立替换 / 清除。
   * ------------------------------------------------------------ */

  /** 该列当前是否有筛选条件 */
  columnFilterOf(entity: EntityKey, field: string): FilterCondition | undefined {
    return this.entities[entity].query.conditions.find(c => c.id === columnFilterId(field));
  }

  /** 该表有多少列处在筛选态（表头 / 工具条的角标用） */
  columnFilterCount(entity: EntityKey): number {
    return this.entities[entity].query.conditions.filter(c => c.id.startsWith(COLUMN_FILTER_PREFIX)).length;
  }

  /** 设置或清除某一列的筛选（cond 传 null 表示清除） */
  async setColumnFilter(entity: EntityKey, field: string, cond: FilterCondition | null): Promise<void> {
    const id = columnFilterId(field);
    const rest = this.entities[entity].query.conditions.filter(c => c.id !== id);
    await this.setConditions(entity, cond ? [...rest, { ...cond, id }] : rest);
  }

  /**
   * 某列在当前查询下的取值分布 —— 用于列筛选弹窗里的勾选项。
   *
   * 注意要把**该列自己的条件排除掉**再统计，否则用户筛完之后再打开弹窗，
   * 就只剩已选中的那一个值，没法把范围放宽回来。
   */
  async valueCounts(entity: EntityKey, field: string): Promise<{ value: string; count: number }[]> {
    const rt = this.entities[entity];
    const id = columnFilterId(field);
    const conditions = rt.query.conditions.filter(c => c.id !== id);
    const res = await this.source.query(entity, {
      parentIds: this.parentScopeOf(entity),
      query: { ...rt.query, conditions },
    });
    const counts = new Map<string, number>();
    for (const row of res.rows) {
      const raw = row[field];
      const keys = Array.isArray(raw)
        ? (raw as unknown[]).map(String)
        : [raw === null || raw === undefined || raw === '' ? '' : String(raw)];
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    return Array.from(counts, ([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
  }

  async resetQuery(entity: EntityKey): Promise<void> {
    this.entities[entity].query = emptyQueryState();
    this.emit('query', entity);
    await this.refresh(entity);
  }

  /* ------------------------------------------------------------ *
   * 联动：勾选驱动
   *
   * 「上级勾了哪些行」直接决定下级看到什么：
   *   项目表勾选 A、B   → 任务表只显示 A、B 下的任务（并集）
   *   任务表勾选 T1、T2 → 明细表只显示 T1、T2 的执行明细
   *   一行都没勾        → 不约束，下级展示全部
   *
   * 注意：点击一行**不再**触发联动。点击只做本行的事（点开关翻转、点其它格进编辑），
   * 因为「看一眼」和「以它为条件下钻」是两件事，混在一起会让人误以为页面在自己乱跳。
   * 勾选（多选）才是下钻意图的显式表达，也顺带支持了「勾几行看几行」。
   * ------------------------------------------------------------ */

  /**
   * 勾选变化的唯一入口：广播 → 清掉下级勾选 → 按新作用域刷新下级。
   *
   * 表格里的复选框、表头全选、面板上的全选 / 反选 / 清空都走这里。
   * 之所以要统一走一条路：只有在这里才能保证
   * 「表格高亮、面板计数、下级收窄」三处永远同步。
   */
  async selectionChanged(entity: EntityKey): Promise<void> {
    this.bumpVersion();
    this.emit('selection', entity);
    await this.rescopeFrom(entity);
  }

  /** 清空某张表的勾选（面板「清空选择」「显示全部」、面包屑上的 ✕ 都走这里） */
  async clearSelection(entity: EntityKey): Promise<void> {
    this.entities[entity].selection.clear();
    await this.selectionChanged(entity);
  }

  /**
   * 上级勾选变了之后，下级必须重新收窄。
   *
   * 下级自己的勾选一律清空：它的结果集已经换了一批行，
   * 旧勾选指向的行很可能根本不在新结果里，留着会变成一个指向虚空的作用域。
   */
  private async rescopeFrom(entity: EntityKey): Promise<void> {
    if (entity === 'project') {
      this.entities.task.selection.clear();
      this.entities.execution.selection.clear();
      await this.refreshFrom('task');
    } else if (entity === 'task') {
      this.entities.execution.selection.clear();
      await this.refresh('execution');
    }
  }

  /**
   * 面包屑：每一级「勾了什么」，只列出真的有勾选的层级。
   * 单行勾选显示它的标题，多行显示「已勾选 N 项」。
   */
  breadcrumb(): { entity: EntityKey; ids: RowId[]; count: number; title: string }[] {
    const out: { entity: EntityKey; ids: RowId[]; count: number; title: string }[] = [];
    for (const key of ['project', 'task', 'execution'] as EntityKey[]) {
      const ids = this.entities[key].selection.ids();
      if (ids.length === 0) continue;
      out.push({ entity: key, ids, count: ids.length, title: this.selectionTitle(key, ids) });
    }
    return out;
  }

  /** 勾选摘要：单行给标题，多行给数量 */
  selectionTitle(entity: EntityKey, ids: RowId[]): string {
    const rt = this.entities[entity];
    if (ids.length === 1) {
      const row = this.source.getById(entity, ids[0]) ?? rt.rows.find(r => r.id === ids[0]);
      return String(row?.[rt.schema.titleField] ?? ids[0]);
    }
    return `已勾选 ${num(ids.length)} 项`;
  }

  /* ------------------------------------------------------------ *
   * 编辑态 / 查看态
   * ------------------------------------------------------------ */

  setMode(mode: TableMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.emit('mode');
  }

  get editable(): boolean {
    return this.mode === 'edit';
  }

  /* ------------------------------------------------------------ *
   * 写操作
   * ------------------------------------------------------------ */

  /**
   * 修改一个单元格，并同步应用 schema 里的联动派生值。
   *
   * 所有写路径（内联编辑、开关点击、批量操作、规则回填）都汇聚到这里，
   * 保证脏数据登记和撤销栈不会漏记。
   */
  private writeCell(rt: EntityRuntime, row: DataRow, field: string, value: unknown, out: CellPatch[], beforeMap: Map<string, unknown>): void {
    const before = row[field];
    const key = `${row.id}\u0000${field}`;
    // 首个写入者负责记录「改之前」的值。派生字段也要记，
    // 否则撤销时拿不到它的原值、会把单元格写成 undefined。
    if (!beforeMap.has(key)) beforeMap.set(key, before);
    if (sameValue(before, value)) return;
    row[field] = value;
    out.push({ id: row.id, field, value });

    // 联动派生：只有值型效果会改写数据，显隐/只读不影响数据
    const derived = applyRuleValues(rt.schema, row);
    for (const d of derived) {
      if (d.field === field) continue; // 用户刚改的字段不被规则覆盖
      const dKey = `${row.id}\u0000${d.field}`;
      if (!beforeMap.has(dKey)) beforeMap.set(dKey, row[d.field]);
      if (sameValue(row[d.field], d.value)) continue;
      row[d.field] = d.value;
      out.push({ id: row.id, field: d.field, value: d.value });
    }
    row._search = rebuildSearch(rt.schema, row);
  }

  /**
   * 应用一批单元格修改。
   *
   * @param opts.record     是否登记到撤销栈（回滚/撤销自身的回放不登记）
   * @param opts.trackDirty 是否重算脏数据（回滚时自己清，不重算）
   */
  applyPatches(
    entity: EntityKey,
    patches: CellPatch[],
    label: string,
    opts: { record?: boolean; trackDirty?: boolean } = {}
  ): void {
    if (patches.length === 0) return;
    const { record = true, trackDirty = true } = opts;
    const rt = this.entities[entity];
    const beforeMap = new Map<string, unknown>();
    const after: CellPatch[] = [];

    for (const p of patches) {
      const row = this.source.getById(entity, p.id) ?? rt.rows.find(r => r.id === p.id);
      if (!row) continue;
      this.writeCell(rt, row, p.field, p.value, after, beforeMap);
    }
    if (after.length === 0) return;

    if (trackDirty) this.recomputeDirty(entity, after, beforeMap);
    this.bumpVersion();

    if (record) {
      this.undoStack.push({
        entity,
        label,
        before: after.map(p => ({ id: p.id, field: p.field, value: beforeMap.get(`${p.id}\u0000${p.field}`) })),
        after,
      });
      if (this.undoStack.length > 200) this.undoStack.shift();
      this.redoStack.length = 0;
    }

    this.emit('cells', entity);
    this.emit('dirty', entity);
    void label;
  }

  /** 由「当前值 vs 已保存值」重算脏数据，方向永远正确 */
  private recomputeDirty(entity: EntityKey, changed: CellPatch[], beforeMap: Map<string, unknown>): void {
    const dirtyMap = this.dirty.get(entity)!;
    const savedMap = this.saved.get(entity)!;
    for (const p of changed) {
      const key = `${p.id}\u0000${p.field}`;
      // 没有保存过快照的单元格，第一次修改前的值就是「已保存值」
      const savedValue = savedMap.has(key) ? savedMap.get(key) : beforeMap.get(key);
      if (!savedMap.has(key)) savedMap.set(key, savedValue);
      if (sameValue(savedValue, p.value)) {
        dirtyMap.delete(key);
        // 已经回到保存时的值，快照也没必要留着
        if (dirtyMap.size === 0 && !this.hasOtherDirty(entity, key)) savedMap.delete(key);
      } else {
        dirtyMap.set(key, { id: p.id, field: p.field, from: savedValue, to: p.value });
      }
    }
  }

  private hasOtherDirty(entity: EntityKey, exceptKey: string): boolean {
    const map = this.dirty.get(entity)!;
    for (const k of map.keys()) if (k !== exceptKey) return true;
    return false;
  }

  /** 单行单字段编辑（内联编辑器 / 开关直接点击） */
  editCell(entity: EntityKey, id: RowId, field: string, value: unknown, label = '编辑单元格'): void {
    this.applyPatches(entity, [{ id, field, value }], label);
  }

  /** 批量：把选中行的某字段统一设为某值 */
  bulkSetField(entity: EntityKey, field: string, value: unknown, label?: string): number {
    const rt = this.entities[entity];
    const rows = rt.selection.selectedRows();
    const patches: CellPatch[] = rows.map(r => ({ id: r.id, field, value: resolveBulkValue(value, r, field) }));
    this.applyPatches(entity, patches, label ?? `批量设置「${field}」`);
    this.setStatus(`已批量修改 ${patches.length} 行 · ${field}`);
    return patches.length;
  }

  /** 批量：数值字段按公式批量计算 */
  bulkCompute(entity: EntityKey, field: string, op: 'set' | 'add' | 'mul' | 'clamp', operand: number, label?: string): number {
    const rt = this.entities[entity];
    const rows = rt.selection.selectedRows();
    const patches: CellPatch[] = [];
    for (const r of rows) {
      const cur = Number(r[field] ?? 0);
      let next = cur;
      if (op === 'set') next = operand;
      else if (op === 'add') next = cur + operand;
      else if (op === 'mul') next = cur * operand;
      else next = Math.min(Math.max(cur, 0), operand);
      const fs = rt.schema.fields.find(f => f.field === field);
      if (fs?.min !== undefined) next = Math.max(fs.min, next);
      if (fs?.max !== undefined) next = Math.min(fs.max, next);
      if (fs?.precision !== undefined) next = Number(next.toFixed(fs.precision));
      patches.push({ id: r.id, field, value: next });
    }
    this.applyPatches(entity, patches, label ?? `批量计算「${field}」`);
    this.setStatus(`已批量计算 ${patches.length} 行 · ${field}`);
    return patches.length;
  }

  /** 批量：给多选字段追加 / 移除标签 */
  bulkTag(entity: EntityKey, field: string, tagValue: string, action: 'add' | 'remove'): number {
    const rt = this.entities[entity];
    const rows = rt.selection.selectedRows();
    const patches: CellPatch[] = rows.map(r => {
      const cur: string[] = Array.isArray(r[field]) ? r[field].slice() : [];
      let next = cur;
      if (action === 'add' && !cur.includes(tagValue)) next = [...cur, tagValue];
      if (action === 'remove') next = cur.filter(v => v !== tagValue);
      return { id: r.id, field, value: next };
    });
    this.applyPatches(entity, patches, `批量${action === 'add' ? '追加' : '移除'}标签`);
    return patches.length;
  }

  /** 批量删除（软删除） */
  async deleteSelected(entity: EntityKey): Promise<number> {
    const rt = this.entities[entity];
    const ids = rt.selection.ids();
    if (ids.length === 0) return 0;
    await this.source.remove(entity, ids);
    rt.selection.clear();
    this.setStatus(`已删除 ${ids.length} 行（可从数据源恢复）`);
    await this.refresh(entity);
    // 勾选被清空了，下级的作用域也跟着消失 —— 必须一起刷，否则明细表还停在旧收窄上
    await this.rescopeFrom(entity);
    return ids.length;
  }

  /* ------------------------------------------------------------ *
   * 保存 / 撤销 / 回滚
   * ------------------------------------------------------------ */

  dirtyCount(entity?: EntityKey): number {
    if (entity) return this.dirty.get(entity)!.size;
    let n = 0;
    for (const m of this.dirty.values()) n += m.size;
    return n;
  }

  dirtyFieldsOf(entity: EntityKey, id: RowId): Set<string> {
    const out = new Set<string>();
    const map = this.dirty.get(entity)!;
    for (const cell of map.values()) if (cell.id === id) out.add(cell.field);
    return out;
  }

  /** 单格脏判断：O(1)，单元格渲染每帧都会调用 */
  isDirtyCell(entity: EntityKey, id: RowId, field: string): boolean {
    return this.dirty.get(entity)!.has(`${id}\u0000${field}`);
  }

  /** 行是否被勾选（供选择列之外的单元格画整行高亮） */
  rowIsChecked(entity: EntityKey, id: RowId): boolean {
    return this.entities[entity].selection.has(id);
  }

  async save(): Promise<void> {
    let savedCount = 0;
    for (const entity of Object.keys(this.entities) as EntityKey[]) {
      const map = this.dirty.get(entity)!;
      if (map.size === 0) continue;
      const savedMap = this.saved.get(entity)!;
      const patches: CellPatch[] = [];
      for (const cell of map.values()) {
        patches.push({ id: cell.id, field: cell.field, value: cell.to });
        // 保存后这一格就有了新的「已保存值」，脏标记随之清空
        savedMap.set(`${cell.id}\u0000${cell.field}`, cell.to);
      }
      await this.source.patch(entity, patches);
      savedCount += patches.length;
      map.clear();
      this.emit('dirty', entity);
    }
    this.setStatus(savedCount ? `已保存 ${savedCount} 处修改` : '没有需要保存的修改');
  }

  /** 丢弃未保存修改，把值还原到最近一次保存的状态 */
  revertAll(): void {
    let n = 0;
    for (const entity of Object.keys(this.entities) as EntityKey[]) {
      const map = this.dirty.get(entity)!;
      if (map.size === 0) continue;
      const patches: CellPatch[] = [];
      for (const cell of map.values()) patches.push({ id: cell.id, field: cell.field, value: cell.from });
      n += patches.length;
      map.clear();
      // trackDirty=false：回滚后本来就是干净的，不需要重算
      this.applyPatches(entity, patches, '回滚未保存修改', { record: false, trackDirty: false });
      this.emit('dirty', entity);
    }
    this.setStatus(n ? `已回滚 ${n} 处未保存修改` : '没有可回滚的修改');
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const rec = this.undoStack.pop();
    if (!rec) return;
    const redo = this.redoStack;
    this.applyPatches(rec.entity, rec.before, rec.label, { record: false });
    // applyPatches 不会动 redo 栈，这里显式补上被撤销的这一条
    redo.push(rec);
    this.setStatus(`已撤销：${rec.label}`);
  }

  redo(): void {
    const rec = this.redoStack.pop();
    if (!rec) return;
    this.applyPatches(rec.entity, rec.after, rec.label, { record: false });
    this.undoStack.push(rec);
    this.setStatus(`已重做：${rec.label}`);
  }

  setStatus(text: string): void {
    this.statusText = text;
    this.emit('status');
  }
}

/* ------------------------------------------------------------------ *
 * 工具
 * ------------------------------------------------------------------ */

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => v === b[i]);
  if (a === null && b === undefined) return true;
  if (a === undefined && b === null) return true;
  return false;
}

/** 批量赋值时，值可以是常量，也可以是按行计算的函数 */
function resolveBulkValue(value: unknown, row: DataRow, field: string): unknown {
  return typeof value === 'function' ? (value as (r: DataRow, f: string) => unknown)(row, field) : value;
}

/** 重算关键字检索串 */
function rebuildSearch(schema: EntitySchema, row: DataRow): string {
  const parts: string[] = [];
  for (const f of schema.fields) {
    if (!f.searchable) continue;
    const v = row[f.field];
    if (v === null || v === undefined) continue;
    parts.push(typeof v === 'string' ? v : String(v));
  }
  return parts.join(' ').toLowerCase();
}
