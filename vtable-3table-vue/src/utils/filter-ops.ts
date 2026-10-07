/**
 * 列筛选的纯逻辑（与 DOM 无关）。
 *
 * 筛选条件是有结构的（字段 + 操作符 + 值），不是一句自由文本 ——
 * 这样条件才能下推给数据源：mock 实现直接在内存里跑谓词，
 * 换成 HTTP 实现时同一个结构序列化成 query string 就行。
 *
 * 命令式版本里这些函数和一堆 DOM 辅助函数一起住在 ui/filters.ts；
 * Vue 版把纯函数抽到这里，组件（FilterPanel.vue）只表达「渲染成什么」。
 */

import type { FieldOption, FieldSchema, WidgetKind } from '../domain/schema';
import type { FilterCondition, FilterOperator } from '../domain/types';

/* ------------------------------------------------------------------ *
 * 操作符
 * ------------------------------------------------------------------ */

export const OPERATOR_LABEL: Record<FilterOperator, string> = {
  contains: '包含',
  notContains: '不包含',
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '大于等于',
  lt: '小于',
  lte: '小于等于',
  between: '介于',
  empty: '为空',
  notEmpty: '不为空',
  in: '是其中之一',
};

const NUMERIC: WidgetKind[] = ['number', 'money', 'progress', 'rating'];
const ENUM: WidgetKind[] = ['select', 'user'];
const MULTI: WidgetKind[] = ['multiSelect'];
const DATE: WidgetKind[] = ['date'];
const BOOL: WidgetKind[] = ['switch'];

/** 某类小组件可用的操作符集合。widget 决定「能给这个字段提什么问题」 */
export function operatorsFor(widget: WidgetKind): FilterOperator[] {
  if (NUMERIC.includes(widget)) return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'];
  if (BOOL.includes(widget)) return ['eq', 'neq', 'empty', 'notEmpty'];
  if (DATE.includes(widget)) return ['eq', 'gte', 'lte', 'between', 'empty', 'notEmpty'];
  if (ENUM.includes(widget)) return ['in', 'eq', 'neq', 'empty', 'notEmpty'];
  if (MULTI.includes(widget)) return ['contains', 'notContains', 'empty', 'notEmpty'];
  return ['contains', 'notContains', 'eq', 'neq', 'empty', 'notEmpty'];
}

export function needsValue(op: FilterOperator): boolean {
  return op !== 'empty' && op !== 'notEmpty';
}

export function needsSecondValue(op: FilterOperator): boolean {
  return op === 'between';
}

/* ------------------------------------------------------------------ *
 * 条件摘要（chips 里显示）
 * ------------------------------------------------------------------ */

export function describeCondition(cond: FilterCondition, fields: FieldSchema[]): string {
  const fs = fields.find(f => f.field === cond.field);
  const label = fs?.title ?? cond.field;
  const op = OPERATOR_LABEL[cond.operator] ?? cond.operator;
  if (!needsValue(cond.operator)) return `${label} ${op}`;

  const render = (v: unknown): string => {
    if (v === null || v === undefined || v === '') return '空';
    if (Array.isArray(v)) {
      const arr = v as unknown[];
      if (fs?.options) return arr.map(x => fs.options?.find(o => o.value === x)?.label ?? String(x)).join(' / ');
      return arr.map(String).join(' / ');
    }
    if (fs?.options) return fs.options.find(o => o.value === String(v))?.label ?? String(v);
    if (fs?.widget === 'switch' || typeof v === 'boolean') return v === true || v === 'true' ? '开启' : '关闭';
    if (fs?.unit) return `${v}${fs.unit}`;
    return String(v);
  };

  if (needsSecondValue(cond.operator)) return `${label} ${op} ${render(cond.value)} ~ ${render(cond.value2)}`;
  return `${label} ${op} ${render(cond.value)}`;
}

/* ------------------------------------------------------------------ *
 * 值编辑器选型（原 buildValueEditor 的分支判断，渲染留给组件）
 * ------------------------------------------------------------------ */

/** 可以下拉勾选的字段：select / user / multiSelect，且带了候选值 */
export function exampleOptions(fs: FieldSchema | undefined, widget: WidgetKind): FieldOption[] | undefined {
  if (!fs?.options || fs.options.length === 0) return undefined;
  if (widget === 'select' || widget === 'user' || widget === 'multiSelect') return fs.options;
  return undefined;
}

/** 会用到候选值列表的那几个操作符 */
const OPTION_OPERATORS: FilterOperator[] = ['in', 'contains', 'notContains', 'eq', 'neq'];

export type ValueEditorKind =
  | 'none' // 该操作符不需要填值
  | 'options' // 候选值勾选列表
  | 'switch' // 已开启 / 已关闭
  | 'input'; // 普通输入框

/** 该字段 + 该操作符应该渲染哪种值编辑器（分支顺序与 buildValueEditor 一致） */
export function valueEditorKind(fs: FieldSchema | undefined, op: FilterOperator): ValueEditorKind {
  const widget = fs?.widget ?? 'text';
  if (!needsValue(op)) return 'none';
  if (exampleOptions(fs, widget) && OPTION_OPERATORS.includes(op)) return 'options';
  if (widget === 'switch') return 'switch';
  return 'input';
}

/** 普通输入框的 input type */
export function valueInputType(fs: FieldSchema | undefined): 'date' | 'number' | 'text' {
  const widget = fs?.widget ?? 'text';
  if (DATE.includes(widget)) return 'date';
  if (NUMERIC.includes(widget) || BOOL.includes(widget)) return 'number';
  return 'text';
}
