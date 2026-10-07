/**
 * 批量操作面板。
 *
 * 10 万级批量修改的关键不是弹窗本身，而是**改完之后不要整表重载**：
 * 这里只产出 patches，交给 store 统一写回，
 * 表格侧收到的是「cells 变了」而不是「行集变了」，因此只重画可视区。
 */

import type { EntitySchema, FieldSchema } from '../domain/schema';
import type { CellPatch, DataRow, EntityKey } from '../domain/types';
import type { AppStore } from '../state/store';
import { append, clear, h, num, openModal } from './dom';

/* ------------------------------------------------------------------ *
 * 操作定义
 * ------------------------------------------------------------------ */

type OpKind = 'set' | 'add' | 'mul' | 'clamp' | 'tagAdd' | 'tagRemove' | 'toggle';

interface OpDef {
  kind: OpKind;
  label: string;
  needsNumber?: boolean;
}

function opsFor(fs: FieldSchema): OpDef[] {
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

function clampField(fs: FieldSchema, v: number): number {
  let n = v;
  if (fs.min !== undefined) n = Math.max(fs.min, n);
  if (fs.max !== undefined) n = Math.min(fs.max, n);
  if (fs.precision !== undefined) n = Number(n.toFixed(fs.precision));
  return n;
}

/* ------------------------------------------------------------------ *
 * 弹窗
 * ------------------------------------------------------------------ */

export interface BulkDialogOptions {
  store: AppStore;
  entity: EntityKey;
  schema: EntitySchema;
}

export function openBulkDialog(opts: BulkDialogOptions): void {
  const { store, entity, schema } = opts;
  const rt = store.entities[entity];
  const selectedRows = rt.selection.selectedRows();
  const fields = schema.fields.filter(f => f.editable && f.bulkEditable !== false);
  if (fields.length === 0) return;

  let currentField: FieldSchema = fields[0];
  let currentOp: OpKind = opsFor(currentField)[0].kind;
  let operand: unknown = defaultOperand(currentField, currentOp);

  const fieldSel = h('select', { class: 'input' }) as HTMLSelectElement;
  for (const f of fields) fieldSel.appendChild(h('option', { value: f.field }, f.title));
  fieldSel.value = currentField.field;

  const opHost = h('div', { class: 'op-row' });
  const operandHost = h('div', { class: 'operand-host' });

  const refreshOperand = () => {
    operand = defaultOperand(currentField, currentOp);
    const editor = buildOperandEditor(currentField, currentOp, operand, v => {
      operand = v;
    });
    operandHost.replaceChildren(editor);
  };

  const refreshOps = () => {
    const ops = opsFor(currentField);
    currentOp = ops[0].kind;
    opHost.replaceChildren(
      ...ops.map(o =>
        h(
          'label',
          { class: `op-item${o.kind === currentOp ? ' on' : ''}` },
          h('input', {
            type: 'radio',
            name: 'bulk-op',
            checked: o.kind === currentOp,
            onchange: () => {
              currentOp = o.kind;
              opHost.querySelectorAll('.op-item').forEach(el => el.classList.remove('on'));
              (opHost.querySelectorAll('.op-item')[ops.indexOf(o)] as HTMLElement)?.classList.add('on');
              refreshOperand();
            },
          }),
          h('span', null, o.label)
        )
      )
    );
    refreshOperand();
  };

  fieldSel.onchange = () => {
    currentField = fields.find(f => f.field === fieldSel.value) ?? fields[0];
    refreshOps();
  };
  refreshOps();

  const summary = h('div', { class: 'bulk-summary' });
  const renderSummary = () => {
    const n = rt.selection.size;
    clear(summary);
    append(summary, [
      h('b', null, num(n)),
      ' 行将被修改',
      n === 0 ? h('span', { class: 'warn' }, '（当前没有选中任何行，请先勾选）') : null,
      n > 50_000 ? h('span', { class: 'warn' }, '（数据量较大，将生成等量单元格补丁，可通过「撤销」整体回退）') : null,
    ]);
  };
  renderSummary();

  const body = h(
    'div',
    { class: 'bulk-body' },
    h('div', { class: 'field-row' }, h('label', { class: 'field-label' }, '目标属性'), h('div', { class: 'field-control' }, fieldSel)),
    h('div', { class: 'field-row' }, h('label', { class: 'field-label' }, '操作'), h('div', { class: 'field-control' }, opHost)),
    h('div', { class: 'field-row' }, h('label', { class: 'field-label' }, '值'), h('div', { class: 'field-control' }, operandHost)),
    h('div', { class: 'bulk-note' }, '联动提示：被 schema 规则约束的属性（例如「已交付」任务的进度）在写回时会自动重新求值，批量改也不会绕过规则。'),
    summary
  );

  const run = () => {
    const patches = buildBulkPatches(currentField, currentOp, operand, selectedRows);
    store.applyPatches(entity, patches, `批量${labelOf(currentOp)}「${currentField.title}」`);
    store.setStatus(`已批量修改 ${patches.length} 行 · ${currentField.title}（可撤销）`);
  };

  const apply = h(
    'button',
    {
      class: 'btn pri',
      onclick: () => {
        if (rt.selection.isEmpty) {
          store.setStatus('请先勾选要修改的行');
          return;
        }
        run();
        modal.close();
      },
    },
    '执行'
  );

  const modal = openModal(`批量操作 · ${schema.label}`, body, h('div', { class: 'modal-ft-row' }, h('button', { class: 'btn', onclick: () => modal.close() }, '取消'), apply));
  void renderSummary;
}

function labelOf(op: OpKind): string {
  return { set: '设置', add: '增加', mul: '乘以', clamp: '封顶', tagAdd: '追加标签', tagRemove: '移除标签', toggle: '反转' }[op];
}

function defaultOperand(fs: FieldSchema, op: OpKind): unknown {
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

function buildOperandEditor(fs: FieldSchema, op: OpKind, initial: unknown, onChange: (v: unknown) => void): HTMLElement {
  if (op === 'toggle') return h('div', { class: 'field-hint' }, '把每一行的开关取反');

  if (fs.widget === 'switch') {
    const sel = h('select', { class: 'input', onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value === 'true') }, h('option', { value: 'true' }, '已开启'), h('option', { value: 'false' }, '已关闭')) as HTMLSelectElement;
    sel.value = initial === false ? 'false' : 'true';
    return sel;
  }

  if (fs.options && fs.options.length > 0) {
    const sel = h('select', { class: 'input', onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
    for (const o of fs.options) sel.appendChild(h('option', { value: o.value }, o.label));
    sel.value = String(initial ?? '');
    return sel;
  }

  const numeric = ['number', 'money', 'progress', 'rating'].includes(fs.widget);
  const type = fs.widget === 'date' ? 'date' : numeric ? 'number' : 'text';
  const input = h('input', {
    class: 'input',
    type,
    value: String(initial ?? ''),
    step: fs.step ?? 'any',
    placeholder: fs.unit ? `单位：${fs.unit}` : '',
    oninput: (e: Event) => {
      const raw = (e.target as HTMLInputElement).value;
      onChange(type === 'number' ? (raw === '' ? 0 : Number(raw)) : raw);
    },
  });
  return input;
}
