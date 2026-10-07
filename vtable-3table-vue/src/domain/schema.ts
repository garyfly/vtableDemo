/**
 * Schema 层：整个页面的“唯一事实来源”。
 *
 * 三张表的列、每列用哪个小组件渲染/编辑、以及列与列之间的联动规则，
 * 全部由这里声明；表格层 / 数据层 / UI 层都只读 schema，不写死字段。
 * 想加一张表或加一个属性，只需要在这里加一段声明。
 */

import type { DataRow, EntityKey } from './types';

/* ------------------------------------------------------------------ *
 * 小组件（每个属性由独立的小组件控制展示与编辑）
 * ------------------------------------------------------------------ */

export type WidgetKind =
  | 'link' // 编号 + 关联箭头（勾选该行下钻）
  | 'text' // 单行文本
  | 'user' // 头像 + 姓名
  | 'select' // 单选标签
  | 'multiSelect' // 多选标签组
  | 'number' // 数值 + 单位
  | 'money' // 金额（带币种/单位）
  | 'progress' // 进度条
  | 'rating' // 星级
  | 'date' // 日期
  | 'switch'; // 开关（联动驱动方）

export interface FieldOption {
  value: string;
  label: string;
  color: string;
}

export interface FieldSchema {
  field: string;
  title: string;
  widget: WidgetKind;
  /** 列宽（px）。大表必须给定宽度，避免自适应测量 10 万行 */
  width: number;
  /** 编辑态下是否可内联编辑 */
  editable: boolean;
  /** 数字类小组件的参数 */
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  /** select / multiSelect 的候选值 */
  options?: FieldOption[];
  /** 是否参与顶部关键字搜索 */
  searchable?: boolean;
  /** 表头 hover 提示 */
  hint?: string;
  /** 批量操作面板里是否允许“批量设置该字段” */
  bulkEditable?: boolean;
}

/* ------------------------------------------------------------------ *
 * 字段联动规则
 * ------------------------------------------------------------------ */

/** 一条规则对某个字段产生的效果 */
export interface FieldEffect {
  field: string;
  /** 覆盖可见性；不写则不改 */
  visible?: boolean;
  /** 覆盖可编辑性；不写则不改 */
  editable?: boolean;
  /** 覆盖必填性 */
  required?: boolean;
  /** 命中时把值改写为指定值（可以是常量或按行计算） */
  value?: unknown | ((row: DataRow) => unknown);
  /** 展示给人看的原因，会出现在单元格 tooltip 与联动面板里 */
  reason: string;
}

export interface LinkageRule {
  id: string;
  /** 驱动字段 */
  driver: string;
  /** 命中条件 */
  when: (row: DataRow) => boolean;
  /** 人可读的规则描述，例如「未启用自动同步 → 隐藏 同步策略」 */
  label: string;
  /** 联动面板里的短标签 */
  tag: string;
  effects: FieldEffect[];
}

/** 求值后的单字段状态 */
export interface FieldState {
  visible: boolean;
  editable: boolean;
  required: boolean;
  /** 被哪条规则改过，用于 tooltip */
  reason?: string;
  ruleId?: string;
}

export interface EntitySchema {
  key: EntityKey;
  /** 表名 */
  label: string;
  /** 面板标题里的短名 */
  short: string;
  /** 与父表的关联 */
  parent?: { entity: EntityKey; foreignKey: string };
  /** 主键字段 */
  pk: string;
  /** 副标题字段（面包屑 / 选中摘要用） */
  titleField: string;
  fields: FieldSchema[];
  rules: LinkageRule[];
  /** 新建行时的默认值 */
  defaults: () => Record<string, unknown>;
}

export const field = (schema: EntitySchema, name: string): FieldSchema | undefined =>
  schema.fields.find(f => f.field === name);

export const optionOf = (fs: FieldSchema | undefined, value: unknown): FieldOption | undefined =>
  fs?.options?.find(o => o.value === value);

/* ------------------------------------------------------------------ *
 * 公共候选值
 * ------------------------------------------------------------------ */

const person = (name: string, color: string): FieldOption => ({ value: name, label: name, color });

export const PEOPLE: FieldOption[] = [
  person('陈默', '#5B8FF9'),
  person('林清', '#5AD8A6'),
  person('赵汝衡', '#F6BD16'),
  person('孙一鸣', '#E8684A'),
  person('周若涵', '#6DC8EC'),
  person('吴则言', '#9270CA'),
  person('郑亦然', '#FF9D4D'),
  person('何嘉树', '#269A99'),
  person('黄岐', '#FF99C3'),
  person('秦筝', '#5D7092'),
];

const tag = (value: string, label: string, color: string): FieldOption => ({ value, label, color });

export const TAG_POOL: FieldOption[] = [
  tag('key', '关键路径', '#E8684A'),
  tag('risk', '高风险', '#F6BD16'),
  tag('perf', '性能', '#5B8FF9'),
  tag('i18n', '国际化', '#9270CA'),
  tag('legacy', '历史包袱', '#5D7092'),
  tag('gov', '政企', '#269A99'),
  tag('mobile', '移动端', '#FF9D4D'),
  tag('data', '数据治理', '#5AD8A6'),
];

/* ------------------------------------------------------------------ *
 * 表 1：项目
 * ------------------------------------------------------------------ */

const PROJECT_STATUS: FieldOption[] = [
  tag('planning', '规划中', '#5D7092'),
  tag('active', '进行中', '#5B8FF9'),
  tag('paused', '已暂停', '#F6BD16'),
  tag('closed', '已结项', '#5AD8A6'),
];

const SYNC_POLICY: FieldOption[] = [
  tag('realtime', '实时同步', '#5B8FF9'),
  tag('hourly', '每小时', '#6DC8EC'),
  tag('daily', '每日', '#5AD8A6'),
];

export const PROJECT_SCHEMA: EntitySchema = {
  key: 'project',
  label: '项目',
  short: '项目',
  pk: 'id',
  titleField: 'name',
  fields: [
    { field: 'projectNo', title: '项目编号', widget: 'link', width: 132, editable: false, searchable: true, hint: '勾选这一行即可下钻到该项目的任务' },
    { field: 'name', title: '项目名称', widget: 'text', width: 220, editable: true, searchable: true, bulkEditable: false },
    { field: 'owner', title: '负责人', widget: 'user', width: 128, editable: true, options: PEOPLE, searchable: true, bulkEditable: true },
    { field: 'status', title: '状态', widget: 'select', width: 110, editable: true, options: PROJECT_STATUS, bulkEditable: true },
    { field: 'priority', title: '优先级', widget: 'rating', width: 118, editable: true, min: 1, max: 5, bulkEditable: true },
    { field: 'progress', title: '进度', widget: 'progress', width: 150, editable: true, min: 0, max: 100, step: 5, unit: '%', bulkEditable: true },
    { field: 'budget', title: '预算', widget: 'money', width: 138, editable: true, min: 0, max: 1_000_000, precision: 0, unit: '万', bulkEditable: true },
    { field: 'startDate', title: '启动日期', widget: 'date', width: 128, editable: true, bulkEditable: true },
    { field: 'tags', title: '标签', widget: 'multiSelect', width: 190, editable: true, options: TAG_POOL, bulkEditable: true },
    { field: 'autoSync', title: '自动同步', widget: 'switch', width: 110, editable: true, hint: '联动开关：关闭后「同步策略」会被隐藏', bulkEditable: true },
    { field: 'syncPolicy', title: '同步策略', widget: 'select', width: 122, editable: true, options: SYNC_POLICY, bulkEditable: true },
  ],
  rules: [
    {
      id: 'project.no-sync',
      driver: 'autoSync',
      when: row => row.autoSync === false,
      label: '未启用「自动同步」→ 隐藏且清空「同步策略」',
      tag: '自动同步',
      effects: [
        { field: 'syncPolicy', visible: false, editable: false, value: null, reason: '自动同步已关闭' },
      ],
    },
    {
      id: 'project.closed',
      driver: 'status',
      when: row => row.status === 'closed',
      label: '状态为「已结项」→ 进度锁定 100% 且不可编辑、预算只读',
      tag: '已结项',
      effects: [
        { field: 'progress', editable: false, value: 100, reason: '项目已结项，进度自动锁定' },
        { field: 'budget', editable: false, reason: '项目已结项，预算不可再调整' },
      ],
    },
    {
      id: 'project.paused',
      driver: 'status',
      when: row => row.status === 'paused',
      label: '状态为「已暂停」→ 进度不可编辑',
      tag: '已暂停',
      effects: [{ field: 'progress', editable: false, reason: '项目已暂停，进度冻结' }],
    },
    {
      id: 'project.high-priority',
      driver: 'priority',
      when: row => Number(row.priority) >= 4,
      label: '优先级 ≥ 4 星 → 负责人与启动日期必填',
      tag: '高优先级',
      effects: [
        { field: 'owner', required: true, reason: '高优先级项目必须指定负责人' },
        { field: 'startDate', required: true, reason: '高优先级项目必须填写启动日期' },
      ],
    },
  ],
  defaults: () => ({
    projectNo: '',
    name: '未命名项目',
    owner: PEOPLE[0].value,
    status: 'planning',
    priority: 3,
    progress: 0,
    budget: 100,
    startDate: null,
    tags: [],
    autoSync: true,
    syncPolicy: 'daily',
  }),
};

/* ------------------------------------------------------------------ *
 * 表 2：任务
 * ------------------------------------------------------------------ */

const TASK_STAGE: FieldOption[] = [
  tag('todo', '待启动', '#5D7092'),
  tag('dev', '开发中', '#5B8FF9'),
  tag('integration', '联调中', '#6DC8EC'),
  tag('delivered', '已交付', '#5AD8A6'),
  tag('blocked', '已阻塞', '#E8684A'),
];

export const TASK_SCHEMA: EntitySchema = {
  key: 'task',
  label: '任务',
  short: '任务',
  parent: { entity: 'project', foreignKey: 'projectId' },
  pk: 'id',
  titleField: 'title',
  fields: [
    { field: 'taskNo', title: '任务编号', widget: 'link', width: 132, editable: false, searchable: true, hint: '勾选这一行即可下钻到该任务的执行明细' },
    { field: 'title', title: '任务标题', widget: 'text', width: 230, editable: true, searchable: true },
    { field: 'assignee', title: '执行人', widget: 'user', width: 124, editable: true, options: PEOPLE, searchable: true, bulkEditable: true },
    { field: 'stage', title: '阶段', widget: 'select', width: 112, editable: true, options: TASK_STAGE, bulkEditable: true },
    { field: 'priority', title: '优先级', widget: 'rating', width: 116, editable: true, min: 1, max: 5, bulkEditable: true },
    { field: 'progress', title: '进度', widget: 'progress', width: 148, editable: true, min: 0, max: 100, step: 5, unit: '%', bulkEditable: true },
    { field: 'estimate', title: '预估人天', widget: 'number', width: 118, editable: true, min: 0, max: 999, step: 0.5, precision: 1, unit: '人天', bulkEditable: true },
    { field: 'dueDate', title: '截止日期', widget: 'date', width: 124, editable: true, bulkEditable: true },
    { field: 'labels', title: '标签', widget: 'multiSelect', width: 180, editable: true, options: TAG_POOL, bulkEditable: true },
    { field: 'needApproval', title: '需要审批', widget: 'switch', width: 108, editable: true, hint: '联动开关：关闭后「审批人」会被隐藏', bulkEditable: true },
    { field: 'approver', title: '审批人', widget: 'user', width: 124, editable: true, options: PEOPLE, bulkEditable: true },
  ],
  rules: [
    {
      id: 'task.no-approval',
      driver: 'needApproval',
      when: row => row.needApproval === false,
      label: '未启用「需要审批」→ 隐藏且清空「审批人」',
      tag: '需要审批',
      effects: [{ field: 'approver', visible: false, editable: false, value: null, reason: '无需审批' }],
    },
    {
      id: 'task.delivered',
      driver: 'stage',
      when: row => row.stage === 'delivered',
      label: '阶段为「已交付」→ 进度锁定 100%、预估人天只读',
      tag: '已交付',
      effects: [
        { field: 'progress', editable: false, value: 100, reason: '任务已交付，进度自动锁定' },
        { field: 'estimate', editable: false, reason: '任务已交付，预估不可修改' },
      ],
    },
    {
      id: 'task.blocked',
      driver: 'stage',
      when: row => row.stage === 'blocked',
      label: '阶段为「已阻塞」→ 进度只读、标签必填并自动补「高风险」',
      tag: '已阻塞',
      effects: [
        { field: 'progress', editable: false, reason: '任务阻塞中，进度冻结' },
        { field: 'labels', required: true, reason: '阻塞任务必须打标签说明原因' },
        {
          field: 'labels',
          value: (row: DataRow) => {
            const list: string[] = Array.isArray(row.labels) ? row.labels.slice() : [];
            if (!list.includes('risk')) list.unshift('risk');
            return list;
          },
          reason: '阻塞任务自动补「高风险」标签',
        },
      ],
    },
    {
      id: 'task.high-priority',
      driver: 'priority',
      when: row => Number(row.priority) >= 4,
      label: '优先级 ≥ 4 星 → 截止日期必填、标签必填',
      tag: '高优先级',
      effects: [
        { field: 'dueDate', required: true, reason: '高优先级任务必须指定截止日期' },
        { field: 'labels', required: true, reason: '高优先级任务必须打标签' },
      ],
    },
  ],
  defaults: () => ({
    taskNo: '',
    title: '未命名任务',
    assignee: PEOPLE[0].value,
    stage: 'todo',
    priority: 3,
    progress: 0,
    estimate: 5,
    dueDate: null,
    labels: [],
    needApproval: true,
    approver: PEOPLE[1].value,
  }),
};

/* ------------------------------------------------------------------ *
 * 表 3：执行明细
 * ------------------------------------------------------------------ */

const EXEC_TYPE: FieldOption[] = [
  tag('work', '工时', '#5B8FF9'),
  tag('change', '变更', '#9270CA'),
  tag('review', '评审', '#6DC8EC'),
  tag('bug', '缺陷', '#E8684A'),
  tag('release', '发布', '#5AD8A6'),
];

export const EXECUTION_SCHEMA: EntitySchema = {
  key: 'execution',
  label: '执行明细',
  short: '明细',
  parent: { entity: 'task', foreignKey: 'taskId' },
  pk: 'id',
  titleField: 'summary',
  fields: [
    { field: 'execNo', title: '明细编号', widget: 'link', width: 132, editable: false, searchable: true },
    { field: 'summary', title: '摘要', widget: 'text', width: 250, editable: true, searchable: true },
    { field: 'operator', title: '操作人', widget: 'user', width: 120, editable: true, options: PEOPLE, searchable: true, bulkEditable: true },
    { field: 'type', title: '类型', widget: 'select', width: 104, editable: true, options: EXEC_TYPE, bulkEditable: true },
    { field: 'hours', title: '工时', widget: 'number', width: 112, editable: true, min: 0.5, max: 16, step: 0.5, precision: 1, unit: 'h', bulkEditable: true },
    { field: 'quality', title: '质量评分', widget: 'rating', width: 120, editable: true, min: 1, max: 5, bulkEditable: true },
    { field: 'occurredAt', title: '发生日期', widget: 'date', width: 124, editable: true, bulkEditable: true },
    { field: 'labels', title: '标签', widget: 'multiSelect', width: 175, editable: true, options: TAG_POOL, bulkEditable: true },
    { field: 'billable', title: '计费', widget: 'switch', width: 96, editable: true, hint: '联动开关：关闭后「单价 / 金额」会被隐藏', bulkEditable: true },
    { field: 'rate', title: '单价', widget: 'money', width: 118, editable: true, min: 150, max: 900, precision: 0, unit: '元/h', bulkEditable: true },
    { field: 'amount', title: '金额', widget: 'money', width: 128, editable: true, min: 0, max: 10_000_000, precision: 2, unit: '元', bulkEditable: true },
  ],
  rules: [
    {
      id: 'exec.no-billable',
      driver: 'billable',
      when: row => row.billable === false,
      label: '未启用「计费」→ 隐藏且清空「单价 / 金额」',
      tag: '计费',
      effects: [
        { field: 'rate', visible: false, editable: false, value: null, reason: '该明细不计费' },
        { field: 'amount', visible: false, editable: false, value: null, reason: '该明细不计费' },
      ],
    },
    {
      id: 'exec.billable-derived',
      driver: 'billable',
      when: row => row.billable === true,
      label: '启用「计费」→ 补齐默认单价，金额 = 工时 × 单价（自动派生）',
      tag: '金额派生',
      effects: [
        { field: 'rate', value: (row: DataRow) => (row.rate === null || row.rate === undefined ? 300 : row.rate), reason: '计费明细自动补默认单价' },
        {
          field: 'amount',
          value: (row: DataRow) => {
            const rate = row.rate === null || row.rate === undefined ? 300 : Number(row.rate);
            return Math.round(Number(row.hours ?? 0) * rate * 100) / 100;
          },
          reason: '金额由工时 × 单价派生',
        },
      ],
    },
    {
      id: 'exec.bug',
      driver: 'type',
      when: row => row.type === 'bug',
      label: '类型为「缺陷」→ 质量评分必填、标签必填并自动补「高风险」',
      tag: '缺陷',
      effects: [
        { field: 'quality', required: true, reason: '缺陷必须给出质量评分' },
        { field: 'labels', required: true, reason: '缺陷必须打标签' },
        {
          field: 'labels',
          value: (row: DataRow) => {
            const list: string[] = Array.isArray(row.labels) ? row.labels.slice() : [];
            if (!list.includes('risk')) list.unshift('risk');
            return list;
          },
          reason: '缺陷自动补「高风险」标签',
        },
      ],
    },
    {
      id: 'exec.release',
      driver: 'type',
      when: row => row.type === 'release',
      label: '类型为「发布」→ 计费强制关闭（走成本中心）',
      tag: '发布',
      effects: [{ field: 'billable', value: false, reason: '发布类明细不对外计费' }],
    },
  ],
  defaults: () => ({
    execNo: '',
    summary: '未命名明细',
    operator: PEOPLE[0].value,
    type: 'work',
    hours: 4,
    quality: 4,
    occurredAt: null,
    labels: [],
    billable: true,
    rate: 300,
    amount: 1200,
  }),
};

export const SCHEMAS: Record<EntityKey, EntitySchema> = {
  project: PROJECT_SCHEMA,
  task: TASK_SCHEMA,
  execution: EXECUTION_SCHEMA,
};

/* ------------------------------------------------------------------ *
 * 联动求值
 * ------------------------------------------------------------------ */

/**
 * 计算一行里所有字段的最终状态。
 *
 * 规则按声明顺序叠加，后命中的规则覆盖先命中的；`editable` 只可能被**收紧**，
 * 不会被规则重新打开（schema 里 editable:false 的字段永远不可编辑）。
 */
export function evaluateRowState(
  schema: EntitySchema,
  row: DataRow | undefined,
  fallbackEditable = true
): Map<string, FieldState> {
  const state = new Map<string, FieldState>();
  for (const f of schema.fields) {
    state.set(f.field, {
      visible: true,
      editable: f.editable && fallbackEditable,
      required: false,
    });
  }
  if (!row) return state;

  for (const rule of schema.rules) {
    if (!rule.when(row)) continue;
    for (const eff of rule.effects) {
      const cur = state.get(eff.field);
      if (!cur) continue;
      const next: FieldState = { ...cur, reason: eff.reason, ruleId: rule.id };
      if (eff.visible !== undefined) next.visible = eff.visible;
      if (eff.editable !== undefined) next.editable = cur.editable && eff.editable;
      if (eff.required !== undefined) next.required = eff.required;
      state.set(eff.field, next);
    }
  }
  return state;
}

/**
 * 驱动字段变化后，重算所有规则并按规则改写值。
 *
 * 返回需要写回的值补丁（不包含触发字段本身）。
 * 这条路径是幂等的：同样的行算多少次结果都一样，
 * 所以「开关打开 → 值恢复」不需要额外的快照机制。
 */
export function applyRuleValues(
  schema: EntitySchema,
  row: DataRow,
  onlyFields?: Set<string>
): { field: string; value: unknown }[] {
  const patches: { field: string; value: unknown }[] = [];
  const touched = new Set<string>();
  // 先按顺序收集命中规则的 value 效果，后面的覆盖前面的
  const pending = new Map<string, unknown>();
  for (const rule of schema.rules) {
    if (!rule.when(row)) continue;
    for (const eff of rule.effects) {
      if (eff.value === undefined) continue;
      if (onlyFields && !onlyFields.has(eff.field)) continue;
      pending.set(eff.field, typeof eff.value === 'function' ? (eff.value as (r: DataRow) => unknown)(row) : eff.value);
    }
  }
  for (const [f, v] of pending) {
    if (touched.has(f)) continue;
    touched.add(f);
    if (row[f] === v) continue;
    // 数组值要比较内容，否则每次都会产生一个“脏”补丁
    if (Array.isArray(v) && Array.isArray(row[f]) && (v as unknown[]).join('|') === (row[f] as unknown[]).join('|')) continue;
    patches.push({ field: f, value: v });
  }
  return patches;
}

/** 拿一个字段在联动后的状态；找不到就返回“可见可编辑” */
export function fieldState(state: Map<string, FieldState>, f: string): FieldState {
  return state.get(f) ?? { visible: true, editable: true, required: false };
}
