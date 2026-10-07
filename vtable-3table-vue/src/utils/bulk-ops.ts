/**
 * 批量操作的纯逻辑：操作定义 + 补丁生成。
 *
 * 10 万级批量修改的关键不是弹窗本身，而是**改完之后不要整表重载**：
 * 这里只产出 patches，交给 store 统一写回，
 * 表格侧收到的是「cells 变了」而不是「行集变了」，因此只重画可视区。
 *
 * 这些代码原来住在 ui/bulk.ts 里，和 h() 手搓的 DOM 混在一起；
 * 搬到 Vue 版时把它们单独拆出来 —— 没有 DOM 依赖，可以直接单测。
 */

import type { FieldSchema } from '../domain/schema';
import type { CellPatch, DataRow } from '../domain/types';

/* ------------------------------------------------------------------ *
 * 操作定义
 * ------------------------------------------------------------------ */

export type OpKind = 'set' | 'add' | 'mul' | 'clamp' | 'tagAdd' | 'tagRemove' | 'toggle';

export interface OpDef {
  kind: OpKind;
  label: string;
  needsNumber?: boolean;
}

export function opsFor(fs: FieldSchema): OpDef[] {
  switch (fs.widget) {
    case 'number':
    case 'money':
      return [
        { kind: 'set', label: '设为', needsNumber: true },
        { kind: 'add', label: '增加', needsNumber: true },
        { kind: 'mul', label: '乘以', needsNumber: true },
        { kind: 'clamp', label: '上限封顶', needsNumber: true },
      ];
    case 'progress':
    case 'rating':
      return [
        { kind: 'set', label: '设为', needsNumber: true },
        { kind: 'add', label: '增加', needsNumber: true },
        { kind: 'mul', label: '乘以', needsNumber: true },
      ];
    case 'switch':
      return [
        { kind: 'set', label: '设为', needsNumber: false },
        { kind: 'toggle', label: '反转开关', needsNumber: false },
      ];
    case 'multiSelect':
      return [
        { kind: 'tagAdd', label: '追加标签', needsNumber: false },
        { kind: 'tagRemove', label: '移除标签', needsNumber: false },
      ];
    case 'select':
    case 'user':
      return [{ kind: 'set', label: '设为', needsNumber: false }];
    case 'date':
      return [{ kind: 'set', label: '设为', needsNumber: false }];
    default:
      return [{ kind: 'set', label: '设为', needsNumber: false }];
  }
}

/** 生成批量修改的补丁；纯函数，方便单测 */
export function buildBulkPatches(
  fs: FieldSchema,
  op: OpKind,
  operand: unknown,
  rows: DataRow[]
): CellPatch[] {
  const out: CellPatch[] = [];
  for (const r of rows) {
    const cur = r[fs.field];
    let next: unknown = cur;
    switch (op) {
      case 'set':
        next = operand;
        break;
      case 'toggle':
        next = cur !== true;
        break;
      case 'add':
        next = clampField(fs, Number(cur ?? 0) + Number(operand));
        break;
      case 'mul':
        next = clampField(fs, Number(cur ?? 0) * Number(operand));
        break;
      case 'clamp':
        next = Math.min(Number(cur ?? 0), Number(operand));
        break;
      case 'tagAdd': {
        const list: string[] = Array.isArray(cur) ? cur.slice() : [];
        const v = String(operand);
        if (!list.includes(v)) list.push(v);
        next = list;
        break;
      }
      case 'tagRemove': {
        const list: string[] = Array.isArray(cur) ? cur.slice() : [];
        next = list.filter(v => v !== String(operand));
        break;
      }
      default:
        break;
    }
    out.push({ id: r.id, field: fs.field, value: next });
  }
  return out;
}

export function clampField(fs: FieldSchema, v: number): number {
  let n = v;
  if (fs.min !== undefined) n = Math.max(fs.min, n);
  if (fs.max !== undefined) n = Math.min(fs.max, n);
  if (fs.precision !== undefined) n = Number(n.toFixed(fs.precision));
  return n;
}

/** 操作符的中文名，用来拼撤销栈的 label */
export function labelOf(op: OpKind): string {
  return { set: '设置', add: '增加', mul: '乘以', clamp: '封顶', tagAdd: '追加标签', tagRemove: '移除标签', toggle: '反转' }[op];
}

/** 某个字段 × 某个操作符下的默认操作数 */
export function defaultOperand(fs: FieldSchema, op: OpKind): unknown {
  switch (fs.widget) {
    case 'switch':
      return op === 'toggle' ? true : true;
    case 'multiSelect':
      return fs.options?.[0]?.value ?? '';
    case 'select':
    case 'user':
      return fs.options?.[0]?.value ?? '';
    case 'date':
      return new Date().toISOString().slice(0, 10);
    case 'number':
    case 'money':
    case 'progress':
    case 'rating':
      return op === 'mul' ? 1.1 : fs.min ?? 0;
    default:
      return '';
  }
}
