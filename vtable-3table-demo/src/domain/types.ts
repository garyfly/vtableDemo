/**
 * 领域模型与通用类型。
 *
 * 三张表（三层）共用同一套“行”契约：
 *   project（项目） 1 ── n task（任务） 1 ── n execution（执行明细）
 *
 * 行对象是**扁平结构**：VTable 的 field 取值、排序、筛选都直接吃扁平行，
 * 不做嵌套对象解析，10 万行下这是最省的一次取值路径。
 */

/** 三张表的实体标识 */
export type EntityKey = 'project' | 'task' | 'execution';

/** 实体顺序（1 → 2 → 3 的联动方向） */
export const ENTITY_CHAIN: EntityKey[] = ['project', 'task', 'execution'];

export type RowId = string;

/**
 * 一行数据。字段值用 `any` 是刻意的：
 * 列是由 schema 动态驱动的，运行期字段集合不固定，
 * 用 unknown 会让 11 个小组件的渲染/编辑代码充满断言，收益为负。
 */
export interface DataRow {
  /** 主键，形如 `task#000123` */
  id: RowId;
  /** 预拼接的小写检索串，关键字筛选走它，避免每次都遍历 11 个字段 */
  _search: string;
  /** 软删除标记：批量删除不真正 splice 大数组，只打标记再过滤 */
  _deleted?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [field: string]: any;
}

/** 每次批量操作产生的单元格修改 */
export interface CellPatch {
  id: RowId;
  field: string;
  value: unknown;
}

/** 撤销栈里的一条记录：足够把状态推回原样 */
export interface PatchRecord {
  entity: EntityKey;
  label: string;
  before: CellPatch[];
  after: CellPatch[];
}

/** 筛选操作符 */
export type FilterOperator =
  | 'contains'
  | 'notContains'
  | 'eq'
  | 'neq'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'between'
  | 'empty'
  | 'notEmpty'
  | 'in';

/** 单列筛选条件（面板里一行） */
export interface FilterCondition {
  id: string;
  field: string;
  operator: FilterOperator;
  value?: unknown;
  /** between 的第二个端点 */
  value2?: unknown;
  /**
   * 该条件的值域来自哪个实体。三层联动时，
   * 子表可以按父表列筛（例如“按项目状态筛任务”）。
   */
  entity?: EntityKey;
}

/** 每张表当前的查询状态 */
export interface QueryState {
  keyword: string;
  conditions: FilterCondition[];
  sort: { field: string; order: 'asc' | 'desc' } | null;
}

/** 表格可视态：查看 / 编辑 */
export type TableMode = 'view' | 'edit';

export const emptyQueryState = (): QueryState => ({
  keyword: '',
  conditions: [],
  sort: null,
});

/** 分页参数（远程数据源模式使用） */
export interface PageParam {
  index: number;
  size: number;
}

/** 数据源统一返回结构 */
export interface QueryResult<T extends DataRow = DataRow> {
  rows: T[];
  /** 满足条件的总行数（分页模式下 ≠ rows.length） */
  total: number;
  /** 本次查询耗时，用于性能面板 */
  elapsedMs: number;
}
