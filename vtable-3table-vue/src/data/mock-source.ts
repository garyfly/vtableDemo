/**
 * 纯前端大数据源：在浏览器里生成 10 万级的三层关联数据，并提供内存查询引擎。
 *
 * 性能设计要点：
 * 1. 行是扁平对象，字段取值零解析成本；
 * 2. 每行预拼一个 `_search` 小写串，关键字筛选退化成一次 `indexOf`；
 * 3. 父级索引（projectId → tasks / taskId → executions）在生成时一次建好，
 *    三级联动勾选时走子级索引，不做全表扫描；
 * 4. 生成过程分片让出主线程，页面能显示进度而不是白屏。
 */

import type { CellPatch, DataRow, EntityKey, QueryResult, QueryState, RowId } from '../domain/types';
import {
  EXECUTION_SCHEMA,
  PEOPLE,
  PROJECT_SCHEMA,
  SCHEMAS,
  TASK_SCHEMA,
  TAG_POOL,
  type EntitySchema,
  type FieldSchema,
  type FieldOption,
} from '../domain/schema';
import type { DataSource, EntityStats, QueryRequest } from './datasource';

/* ------------------------------------------------------------------ *
 * 可配置数据规模
 * ------------------------------------------------------------------ */

export interface DataScale {
  project: number;
  task: number;
  execution: number;
}

/** 默认规模：任务表 10 万行，明细 4 万行，合计约 14.2 万行 */
export const DEFAULT_SCALE: DataScale = {
  project: 2_000,
  task: 100_000,
  execution: 40_000,
};

/** 从 URL 覆盖规模，便于压测：?p=5000&t=200000&e=80000 */
export function scaleFromLocation(search: string): DataScale {
  const q = new URLSearchParams(search);
  const pick = (key: string, fallback: number) => {
    const raw = q.get(key);
    // 注意 Number(null) === 0：参数缺省时必须先判空，否则会被静默压成 0 行
    if (raw === null || raw.trim() === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  };
  return {
    project: pick('p', DEFAULT_SCALE.project),
    task: pick('t', DEFAULT_SCALE.task),
    execution: pick('e', DEFAULT_SCALE.execution),
  };
}

/* ------------------------------------------------------------------ *
 * 确定性伪随机（同样的 seed 每次生成同样的数据，便于复现问题）
 * ------------------------------------------------------------------ */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/* ------------------------------------------------------------------ *
 * 造词池
 * ------------------------------------------------------------------ */

const PROJECT_HEAD = ['数据中台', '智能风控', '统一身份', '订单中心', '结算网关', '客服工作台', '车辆调度', '供应链协同', '营销投放', '内容审核', '设备物联', '财务共享'];
const PROJECT_TAIL = ['一期', '二期', '三期', '重构', '信创迁移', '平台化', '中台化', '国产化改造'];
const ORG = ['华东', '华北', '华南', '西南', '海外', '总部'];
const TASK_VERB = ['搭建', '重构', '优化', '接入', '治理', '联调', '迁移', '压测', '梳理', '下线'];
const TASK_OBJ = ['鉴权链路', '订单模型', '对账任务', '缓存层', '灰度开关', '监控埋点', '数据同步', '报表引擎', '消息队列', '配置中心', '权限模型', '导出服务'];
const EXEC_VERB = ['完成', '提交', '评审', '修复', '回滚', '发布', '补充', '调整'];
const EXEC_OBJ = ['工时填报', '接口联调', '方案评审', '缺陷单 7', '版本发布', '用例补充', '性能调优', '配置变更'];

const pickOne = <T,>(rnd: () => number, arr: T[]): T => arr[Math.floor(rnd() * arr.length) % arr.length];

/** 按权重取 select 选项：前面的更常见 */
function pickOption(rnd: () => number, options: FieldOption[], weights?: number[]): FieldOption {
  if (!weights) {
    const biased = rnd() * rnd(); // 偏向前部
    return options[Math.min(options.length - 1, Math.floor(biased * options.length))];
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let i = 0; i < options.length; i++) {
    r -= weights[i];
    if (r <= 0) return options[i];
  }
  return options[options.length - 1];
}

const pad = (n: number, len: number) => String(n).padStart(len, '0');

const DAY = 86_400_000;
const BASE_TIME = Date.UTC(2024, 0, 1);

function isoDate(offsetDays: number): string {
  return new Date(BASE_TIME + offsetDays * DAY).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ *
 * 按小组件类型生成字段值
 * ------------------------------------------------------------------ */

interface GenContext {
  rnd: () => number;
  index: number;
  prefix: string;
  schema: EntitySchema;
}

function genValue(fs: FieldSchema, ctx: GenContext, row: DataRow): unknown {
  const { rnd, index, prefix } = ctx;
  switch (fs.widget) {
    case 'link':
      return `${prefix}-${pad(index + 1, 6)}`;
    case 'text':
      if (ctx.schema.key === 'project') return `${pickOne(rnd, ORG)}${pickOne(rnd, PROJECT_HEAD)}${pickOne(rnd, PROJECT_TAIL)}`;
      if (ctx.schema.key === 'task') return `${pickOne(rnd, TASK_VERB)}${pickOne(rnd, TASK_OBJ)}${rnd() > 0.7 ? '（' + pickOne(rnd, PROJECT_TAIL) + '）' : ''}`;
      return `${pickOne(rnd, EXEC_VERB)}${pickOne(rnd, EXEC_OBJ)}`;
    case 'user':
      return pickOne(rnd, PEOPLE).value;
    case 'select':
      return pickOption(rnd, fs.options ?? [], fs.field === 'status' ? [3, 4, 1, 2] : undefined).value;
    case 'multiSelect': {
      const pool = fs.options ?? TAG_POOL;
      const n = Math.floor(rnd() * rnd() * 3.2); // 0~2 个为主
      const out: string[] = [];
      for (let i = 0; i < n; i++) {
        const v = pickOne(rnd, pool).value;
        if (!out.includes(v)) out.push(v);
      }
      return out;
    }
    case 'number': {
      const min = fs.min ?? 0;
      const max = fs.max ?? 100;
      const raw = min + rnd() * (max - min);
      const step = fs.step ?? 1;
      const snapped = Math.round(raw / step) * step;
      return Number(snapped.toFixed(fs.precision ?? 0));
    }
    case 'money': {
      const min = fs.min ?? 0;
      const max = fs.max ?? 1000;
      const raw = min + rnd() * rnd() * (max - min);
      return Number(raw.toFixed(fs.precision ?? 0));
    }
    case 'progress': {
      const step = fs.step ?? 5;
      return Math.min(100, Math.floor((rnd() * 100) / step) * step);
    }
    case 'rating': {
      // 1~5 星，权重偏中高，保证星级分布看起来自然
      const weights = [1, 2, 5, 4, 2];
      const total = weights.reduce((a, b) => a + b, 0);
      let r = rnd() * total;
      for (let i = 0; i < weights.length; i++) {
        r -= weights[i];
        if (r <= 0) return i + 1;
      }
      return 5;
    }
    case 'date':
      return isoDate(Math.floor(rnd() * 720) - 180);
    case 'switch':
      return rnd() > (fs.field === 'billable' ? 0.25 : 0.4);
    default:
      break;
  }
  void row;
  return null;
}

/* ------------------------------------------------------------------ *
 * 建表
 * ------------------------------------------------------------------ */

const ID_PREFIX: Record<EntityKey, string> = { project: 'PRJ', task: 'TSK', execution: 'EXC' };

function buildRow(schema: EntitySchema, index: number, rnd: () => number, extra: Partial<DataRow>): DataRow {
  const ctx: GenContext = { rnd, index, prefix: ID_PREFIX[schema.key], schema };
  const row: DataRow = { ...extra, id: '', _search: '' };
  for (const fs of schema.fields) {
    row[fs.field] = genValue(fs, ctx, row);
  }
  row.id = `${ID_PREFIX[schema.key]}#${pad(index + 1, 7)}`;
  // 联动一致性：按 schema 规则把派生值补齐，保证初始数据本身就是自洽的
  normalizeRow(schema, row);
  row._search = buildSearch(schema, row);
  return row;
}

/** 让生成出来的数据也满足联动规则（例如不计费 → 单价/金额为空） */
function normalizeRow(schema: EntitySchema, row: DataRow): void {
  if (schema.key === 'project' && row.autoSync === false) {
    row.syncPolicy = null;
  }
  if (schema.key === 'task') {
    if (row.needApproval === false) row.approver = null;
    if (row.stage === 'delivered') row.progress = 100;
    if (row.needApproval === true && !row.approver) row.approver = pickOne(() => 0.5, PEOPLE).value;
  }
  if (schema.key === 'execution') {
    if (row.type === 'release') row.billable = false;
    if (row.billable === false) {
      row.rate = null;
      row.amount = null;
    } else {
      row.amount = Math.round(Number(row.hours ?? 0) * Number(row.rate ?? 0) * 100) / 100;
    }
  }
}

function buildSearch(schema: EntitySchema, row: DataRow): string {
  const parts: string[] = [];
  for (const fs of schema.fields) {
    if (!fs.searchable) continue;
    const v = row[fs.field];
    if (v === null || v === undefined) continue;
    parts.push(typeof v === 'string' ? v : String(v));
  }
  return parts.join(' ').toLowerCase();
}

/* ------------------------------------------------------------------ *
 * 内存数据源
 * ------------------------------------------------------------------ */

export class MockDataSource implements DataSource {
  readonly kind = 'mock' as const;

  private tables: Record<EntityKey, DataRow[]> = { project: [], task: [], execution: [] };
  private byId: Record<EntityKey, Map<RowId, DataRow>> = {
    project: new Map(),
    task: new Map(),
    execution: new Map(),
  };
  /** 父级 foreignKey 值 → 子行数组 */
  private childIndex: Record<EntityKey, Map<string, DataRow[]>> = {
    project: new Map(),
    task: new Map(),
    execution: new Map(),
  };
  private titleIndex: Record<EntityKey, Map<RowId, string>> = {
    project: new Map(),
    task: new Map(),
    execution: new Map(),
  };

  /** 生成耗时，页面性能面板展示用 */
  genMs = 0;

  /** 每个实体的软删除计数；为 0 时查询走「零条件 + 零删除」快路径 */
  private deletedCount: Record<EntityKey, number> = { project: 0, task: 0, execution: 0 };

  /**
   * 「父级 id 很多」那条扫描路径的 Set 缓存。
   * 按 ids 数组的引用判定失效（勾选一变，SelectionModel.ids() 就换新数组）。
   */
  private scanMemo: { ids: RowId[]; set: Set<RowId> } | null = null;

  constructor(
    private scale: DataScale = DEFAULT_SCALE,
    private seed = 20240601
  ) {}

  async init(onProgress?: (stage: string, ratio: number) => void): Promise<void> {
    const t0 = performance.now();
    const rnd = mulberry32(this.seed);

    /* ---- 表 1：项目 ---- */
    onProgress?.('生成项目数据', 0);
    const projects: DataRow[] = new Array(this.scale.project);
    for (let i = 0; i < this.scale.project; i++) {
      projects[i] = buildRow(PROJECT_SCHEMA, i, rnd, {});
    }
    this.setTable('project', projects);
    await yieldToBrowser();

    /* ---- 表 2：任务（挂到项目下） ---- */
    const tasks: DataRow[] = new Array(this.scale.task);
    const chunk = 10_000;
    for (let i = 0; i < this.scale.task; i++) {
      // 按块分配父级：每个项目拿到的任务数尽量均匀，且同一项目的任务在源数组里连续，
      // 这样三级联动的子级索引命中后是「一段连续内存」，滚动局部性也更好
      const pi = Math.min(projects.length - 1, Math.floor((i * projects.length) / this.scale.task));
      tasks[i] = buildRow(TASK_SCHEMA, i, rnd, { projectId: projects[pi].id });
      if (i % chunk === chunk - 1) {
        onProgress?.('生成任务数据', (i + 1) / this.scale.task);
        await yieldToBrowser();
      }
    }
    this.setTable('task', tasks);
    await yieldToBrowser();

    /* ---- 表 3：执行明细（挂到任务下） ---- */
    const execs: DataRow[] = new Array(this.scale.execution);
    for (let i = 0; i < this.scale.execution; i++) {
      // 明细的父级刻意做成重尾分布：少数任务吃掉大部分明细（比均匀分布更贴近真实），
      // 并且把热点压在前面的任务上，保证「点第一个项目 → 点第一个任务」一定能看到成片的明细。
      // 15% 均匀铺开，避免靠后的项目下钻时永远是空表。
      const hot = rnd() < 0.85;
      const ti = hot ? Math.floor(Math.pow(rnd(), 2.2) * tasks.length) : Math.floor(rnd() * tasks.length);
      const parent = tasks[Math.min(tasks.length - 1, ti)];
      execs[i] = buildRow(EXECUTION_SCHEMA, i, rnd, { taskId: parent.id, projectId: parent.projectId });
      if (i % chunk === chunk - 1) {
        onProgress?.('生成执行明细', (i + 1) / this.scale.execution);
        await yieldToBrowser();
      }
    }
    this.setTable('execution', execs);

    this.genMs = performance.now() - t0;
    onProgress?.('完成', 1);
  }

  private setTable(entity: EntityKey, rows: DataRow[]): void {
    this.tables[entity] = rows;
    const ids = this.byId[entity];
    const titles = this.titleIndex[entity];
    ids.clear();
    titles.clear();
    const foreignKey = SCHEMAS[entity].parent?.foreignKey;
    const index = this.childIndex[entity];
    index.clear();
    for (const row of rows) {
      ids.set(row.id, row);
      titles.set(row.id, String(row[SCHEMAS[entity].titleField] ?? row.id));
      if (foreignKey) {
        const pid = String(row[foreignKey]);
        let bucket = index.get(pid);
        if (!bucket) index.set(pid, (bucket = []));
        bucket.push(row);
      }
    }
  }

  /* ---------------- 查询 ---------------- */

  async query(entity: EntityKey, req: QueryRequest): Promise<QueryResult> {
    const t0 = performance.now();
    const schema = SCHEMAS[entity];
    const source = this.tables[entity];

    let rows: DataRow[];
    if (req.parentIds !== undefined && schema.parent) {
      rows = this.childrenOf(entity, req.parentIds);
    } else {
      rows = source;
    }

    const filtered = filterRows(rows, schema, req.query, this.deletedCount[entity] > 0);
    const sorted = req.query.sort ? sortRows(filtered, req.query.sort) : filtered;

    let out = sorted;
    if (req.page) {
      const start = (req.page.index - 1) * req.page.size;
      out = sorted.slice(start, start + req.page.size);
    }

    return { rows: out, total: sorted.length, elapsedMs: performance.now() - t0 };
  }

  /**
   * 取「这些父级」下的子行 —— 联动收窄的实际执行点。
   *
   * 三条路径是按代价选的，不是随手写的：
   *   1 个父级  → O(1) 索引命中（只勾了一行）
   *   ≤32 个    → 按父级把子数组拼起来，代价 = 命中的子行数
   *   >32 个    → 一次全表扫描 + Set 判定，代价 = 子表行数
   *               （在任务表里全选 10 万行时，10 万次 map 查询比扫 4 万行慢得多）
   *
   * 「首屏默认全勾选」让扫描分支变成了常态（任务表 10 万个父级），
   * 所以按**数组引用**把 Set 记住：SelectionModel.ids() 自带缓存、
   * 勾选没变就一直返回同一个数组，于是这里只有勾选变化后才重建一次。
   */
  private childrenOf(entity: EntityKey, parentIds: RowId[] | null): DataRow[] {
    if (parentIds === null) return [];
    const index = this.childIndex[entity];
    if (parentIds.length === 1) return index.get(parentIds[0]) ?? [];

    if (parentIds.length <= 32) {
      const out: DataRow[] = [];
      for (const pid of parentIds) {
        const bucket = index.get(pid);
        if (!bucket) continue;
        // 不用 push(...bucket)：单个父级下子行可能上万，展开会爆栈
        for (const row of bucket) out.push(row);
      }
      return out;
    }

    const fk = SCHEMAS[entity].parent!.foreignKey;
    if (this.scanMemo?.ids !== parentIds) this.scanMemo = { ids: parentIds, set: new Set(parentIds) };
    const wanted = this.scanMemo.set;
    return this.tables[entity].filter(row => wanted.has(String(row[fk])));
  }

  async patch(entity: EntityKey, patches: CellPatch[]): Promise<void> {
    const table = this.byId[entity];
    for (const p of patches) {
      const row = table.get(p.id);
      if (!row) continue;
      row[p.field] = p.value;
      row._search = buildSearch(SCHEMAS[entity], row);
    }
  }

  async remove(entity: EntityKey, ids: RowId[]): Promise<void> {
    const map = this.byId[entity];
    for (const id of ids) {
      const row = map.get(id);
      // 软删除：10 万行数组不搬家，只在过滤阶段跳过
      if (row && !row._deleted) {
        row._deleted = true;
        this.deletedCount[entity]++;
      }
    }
  }

  stats(entity: EntityKey): EntityStats {
    return { total: this.tables[entity].length, deleted: this.deletedCount[entity] };
  }

  getById(entity: EntityKey, id: RowId): DataRow | undefined {
    return this.byId[entity].get(id);
  }

  countChildren(entity: EntityKey, parentId: RowId): number {
    return this.childIndex[entity].get(parentId)?.length ?? 0;
  }

  /** 面包屑 / 选中摘要用 */
  titleOf(entity: EntityKey, id: RowId): string | undefined {
    return this.titleIndex[entity].get(id);
  }

  /** 导出当前查询为 CSV 时用来同步拿全量 */
  allRows(entity: EntityKey): DataRow[] {
    return this.tables[entity];
  }
}

/* ------------------------------------------------------------------ *
 * 查询引擎（纯函数，两个实现共用）
 * ------------------------------------------------------------------ */

export function filterRows(rows: DataRow[], schema: EntitySchema, query: QueryState, hasDeleted = true): DataRow[] {
  const kw = query.keyword.trim().toLowerCase();
  const conds = query.conditions.filter(c => isConditionUsable(c));
  if (!kw && conds.length === 0) {
    // 快路径：无任何条件时不构造新数组，直接返回原引用（10 万行下省一次全量拷贝）
    return hasDeleted ? rows.filter(r => !r._deleted) : rows;
  }

  const out: DataRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row._deleted) continue;
    if (kw && !row._search.includes(kw)) continue;
    let ok = true;
    for (let c = 0; c < conds.length; c++) {
      if (!matchCondition(row, schema, conds[c])) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(row);
  }
  return out;
}

function isConditionUsable(c: { operator: string; value?: unknown; value2?: unknown }): boolean {
  switch (c.operator) {
    case 'empty':
    case 'notEmpty':
      return true;
    case 'between':
      return c.value !== undefined && c.value !== '' && c.value2 !== undefined && c.value2 !== '';
    default:
      return c.value !== undefined && c.value !== '' && !(Array.isArray(c.value) && c.value.length === 0);
  }
}

function matchCondition(row: DataRow, schema: EntitySchema, cond: { field: string; operator: string; value?: unknown; value2?: unknown }): boolean {
  const fs = schema.fields.find(f => f.field === cond.field);
  const raw = row[cond.field];

  if (cond.operator === 'empty') return raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0);
  if (cond.operator === 'notEmpty') return !(raw === null || raw === undefined || raw === '' || (Array.isArray(raw) && raw.length === 0));

  const numeric = fs ? NUMERIC_WIDGETS.has(fs.widget) : false;
  const arr = Array.isArray(raw) ? (raw as string[]) : null;

  switch (cond.operator) {
    case 'contains':
      if (arr) return arr.includes(String(cond.value));
      return String(raw ?? '').toLowerCase().includes(String(cond.value).toLowerCase());
    case 'notContains':
      if (arr) return !arr.includes(String(cond.value));
      return !String(raw ?? '').toLowerCase().includes(String(cond.value).toLowerCase());
    case 'in': {
      const list = Array.isArray(cond.value) ? (cond.value as unknown[]).map(String) : [String(cond.value)];
      if (arr) return arr.some(v => list.includes(v));
      return list.includes(String(raw));
    }
    case 'eq':
      if (arr) return arr.length === 1 && String(arr[0]) === String(cond.value);
      return numeric ? Number(raw) === Number(cond.value) : String(raw) === String(cond.value);
    case 'neq':
      if (arr) return !(arr.length === 1 && String(arr[0]) === String(cond.value));
      return numeric ? Number(raw) !== Number(cond.value) : String(raw) !== String(cond.value);
    case 'gt':
      return numeric ? Number(raw) > Number(cond.value) : String(raw ?? '') > String(cond.value);
    case 'gte':
      return numeric ? Number(raw) >= Number(cond.value) : String(raw ?? '') >= String(cond.value);
    case 'lt':
      return numeric ? Number(raw) < Number(cond.value) : String(raw ?? '') < String(cond.value);
    case 'lte':
      return numeric ? Number(raw) <= Number(cond.value) : String(raw ?? '') <= String(cond.value);
    case 'between': {
      const v = numeric ? Number(raw) : String(raw ?? '');
      const a = numeric ? Number(cond.value) : String(cond.value);
      const b = numeric ? Number(cond.value2) : String(cond.value2);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      return v >= lo && v <= hi;
    }
    default:
      return true;
  }
}

const NUMERIC_WIDGETS = new Set(['number', 'money', 'progress', 'rating']);

export function sortRows(rows: DataRow[], sort: { field: string; order: 'asc' | 'desc' }): DataRow[] {
  const dir = sort.order === 'asc' ? 1 : -1;
  // 复制后再排，避免把数据源自身的数组顺序打乱
  return rows.slice().sort((a, b) => dir * compareValue(a[sort.field], b[sort.field]));
}

function compareValue(a: unknown, b: unknown): number {
  const aEmpty = a === null || a === undefined || a === '';
  const bEmpty = b === null || b === undefined || b === '';
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return -1;
  if (bEmpty) return 1;
  if (Array.isArray(a) || Array.isArray(b)) {
    const av = Array.isArray(a) ? a.join(',') : String(a);
    const bv = Array.isArray(b) ? b.join(',') : String(b);
    return av < bv ? -1 : av > bv ? 1 : 0;
  }
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  const an = Number(a);
  const bn = Number(b);
  if (!Number.isNaN(an) && !Number.isNaN(bn) && String(a).trim() !== '' && String(b).trim() !== '') return an - bn;
  const as = String(a);
  const bs = String(b);
  return as < bs ? -1 : as > bs ? 1 : 0;
}
