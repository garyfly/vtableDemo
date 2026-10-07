/**
 * 列筛选。
 *
 * 筛选条件是有结构的（字段 + 操作符 + 值），不是一句自由文本 ——
 * 这样条件才能下推给数据源：mock 实现直接在内存里跑谓词，
 * 换成 HTTP 实现时同一个结构序列化成 query string 就行。
 */

import type { FieldOption, FieldSchema, WidgetKind } from '../domain/schema';
import type { FilterCondition, FilterOperator } from '../domain/types';
import { clear, h } from './dom';

/* ------------------------------------------------------------------ *
 * 操作符
 * ------------------------------------------------------------------ */

const OPERATOR_LABEL: Record<FilterOperator, string> = {
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

function operatorsFor(widget: WidgetKind): FilterOperator[] {
  if (NUMERIC.includes(widget)) return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'];
  if (BOOL.includes(widget)) return ['eq', 'neq', 'empty', 'notEmpty'];
  if (DATE.includes(widget)) return ['eq', 'gte', 'lte', 'between', 'empty', 'notEmpty'];
  if (ENUM.includes(widget)) return ['in', 'eq', 'neq', 'empty', 'notEmpty'];
  if (MULTI.includes(widget)) return ['contains', 'notContains', 'empty', 'notEmpty'];
  return ['contains', 'notContains', 'eq', 'neq', 'empty', 'notEmpty'];
}

function needsValue(op: FilterOperator): boolean {
  return op !== 'empty' && op !== 'notEmpty';
}

function needsSecondValue(op: FilterOperator): boolean {
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
 * 值编辑器
 * ------------------------------------------------------------------ */

function buildValueEditor(fs: FieldSchema | undefined, operator: FilterOperator, initial: unknown, multiple: boolean, onChange: (v: unknown) => void): HTMLElement {
  const widget = fs?.widget ?? 'text';

  if (!needsValue(operator)) {
    const p = h('div', { class: 'field-hint' }, '该操作符不需要填值');
    return p;
  }

  if (exampleOptions(fs, widget) && (operator === 'in' || operator === 'contains' || operator === 'notContains' || operator === 'eq' || operator === 'neq')) {
    const options = exampleOptions(fs, widget)!;
    const wrap = h('div', { class: 'opt-grid' });
    const selected = new Set<string>(Array.isArray(initial) ? (initial as unknown[]).map(String) : initial !== undefined && initial !== null && initial !== '' ? [String(initial)] : []);
    const rerender = () => {
      clear(wrap);
      for (const opt of options) {
        const on = selected.has(opt.value);
        const row = h(
          'label',
          { class: `opt-item${on ? ' on' : ''}` },
          h('input', {
            type: 'checkbox',
            checked: on,
            onchange: (e: Event) => {
              const checked = (e.target as HTMLInputElement).checked;
              if (checked) selected.add(opt.value);
              else selected.delete(opt.value);
              row.classList.toggle('on', checked);
              emit();
            },
          }),
          h('span', { class: 'dot', style: { background: opt.color } }),
          h('span', null, opt.label)
        );
        wrap.appendChild(row);
      }
    };
    const emit = () => {
      const arr = Array.from(selected);
      if (multiple) onChange(arr);
      else onChange(arr[0] ?? '');
    };
    rerender();
    return wrap;
  }

  if (widget === 'switch') {
    const sel = h(
      'select',
      { class: 'input', onchange: (e: Event) => onChange((e.target as HTMLSelectElement).value === 'true') },
      h('option', { value: 'true' }, '已开启'),
      h('option', { value: 'false' }, '已关闭')
    ) as HTMLSelectElement;
    sel.value = initial === false || initial === 'false' ? 'false' : 'true';
    onChange(sel.value === 'true');
    return sel;
  }

  const type = DATE.includes(widget) ? 'date' : NUMERIC.includes(widget) || BOOL.includes(widget) ? 'number' : 'text';
  const unit = fs?.unit ? `（单位 ${fs.unit}）` : '';
  const input = h('input', {
    class: 'input',
    type,
    value: initial === undefined || initial === null ? '' : String(initial),
    step: fs?.step ?? 'any',
    placeholder: `${fs?.title ?? ''}${unit}`,
    oninput: (e: Event) => {
      const raw = (e.target as HTMLInputElement).value;
      if (type === 'number') onChange(raw === '' ? '' : Number(raw));
      else onChange(raw);
    },
  }) as HTMLInputElement;
  return input;
}

function exampleOptions(fs: FieldSchema | undefined, widget: WidgetKind): FieldOption[] | undefined {
  if (!fs?.options || fs.options.length === 0) return undefined;
  if (widget === 'select' || widget === 'user' || widget === 'multiSelect') return fs.options;
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 筛选面板
 * ------------------------------------------------------------------ */

export interface FilterPanelOptions {
  fields: FieldSchema[];
  conditions: FilterCondition[];
  onApply: (conditions: FilterCondition[]) => void;
  onClose: () => void;
}

export function buildFilterPanel(opts: FilterPanelOptions): HTMLElement {
  const draft: FilterCondition[] = opts.conditions.map(c => ({ ...c }));

  const fieldSel = h('select', { class: 'input' }) as HTMLSelectElement;
  for (const f of opts.fields) {
    fieldSel.appendChild(h('option', { value: f.field }, `${f.title}${f.unit ? `（${f.unit}）` : ''}`));
  }

  const opSel = h('select', { class: 'input' }) as HTMLSelectElement;
  const valueHost = h('div', { class: 'value-host' });

  let currentValue: unknown = '';
  let currentValue2: unknown = '';

  const currentField = () => opts.fields.find(f => f.field === fieldSel.value);

  const refreshOperators = () => {
    const fs = currentField();
    const ops = operatorsFor(fs?.widget ?? 'text');
    clear(opSel);
    for (const op of ops) opSel.appendChild(h('option', { value: op }, OPERATOR_LABEL[op]));
    currentValue = '';
    currentValue2 = '';
    refreshValue();
  };

  const refreshValue = () => {
    clear(valueHost);
    const fs = currentField();
    const op = opSel.value as FilterOperator;
    const multiple = op === 'in';
    valueHost.appendChild(
      buildValueEditor(fs, op, currentValue, multiple, v => {
        currentValue = v;
      })
    );
    if (needsSecondValue(op)) {
      valueHost.appendChild(h('div', { class: 'field-hint' }, '至'));
      valueHost.appendChild(
        buildValueEditor(fs, op, currentValue2, false, v => {
          currentValue2 = v;
        })
      );
    }
  };

  fieldSel.onchange = refreshOperators;
  opSel.onchange = refreshValue;
  refreshOperators();

  const listHost = h('div', { class: 'cond-list' });

  const rerenderList = () => {
    clear(listHost);
    if (draft.length === 0) {
      listHost.appendChild(h('div', { class: 'empty-hint' }, '还没有筛选条件'));
      return;
    }
    for (const c of draft) {
      const fs = opts.fields.find(f => f.field === c.field);
      listHost.appendChild(
        h(
          'div',
          { class: 'cond-item' },
          h('span', null, describeCondition(c, opts.fields)),
          h(
            'button',
            {
              class: 'icon-btn',
              title: fs?.hint ?? '移除该条件',
              onclick: () => {
                const i = draft.indexOf(c);
                if (i >= 0) draft.splice(i, 1);
                rerenderList();
              },
            },
            '✕'
          )
        )
      );
    }
  };
  rerenderList();

  const addBtn = h(
    'button',
    {
      class: 'btn pri',
      onclick: () => {
        const op = opSel.value as FilterOperator;
        const cond: FilterCondition = {
          id: `f${Date.now()}${Math.floor(Math.random() * 1000)}`,
          field: fieldSel.value,
          operator: op,
          value: needsValue(op) ? currentValue : undefined,
          value2: needsSecondValue(op) ? currentValue2 : undefined,
        };
        draft.push(cond);
        rerenderList();
      },
    },
    '添加条件'
  );

  const apply = h(
    'button',
    {
      class: 'btn pri',
      onclick: () => {
        opts.onApply(draft.slice());
        opts.onClose();
      },
    },
    `应用筛选${draft.length ? `（${draft.length}）` : ''}`
  );

  const reset = h(
    'button',
    {
      class: 'btn',
      onclick: () => {
        draft.length = 0;
        rerenderList();
      },
    },
    '清空条件'
  );

  return h(
    'div',
    { class: 'filter-panel' },
    h('div', { class: 'filter-sec' }, h('div', { class: 'sec-title' }, '新增条件')),
    h('div', { class: 'filter-grid' }, fieldSel, opSel, valueHost),
    h('div', { class: 'filter-actions' }, addBtn, reset),
    h('div', { class: 'filter-sec' }, h('div', { class: 'sec-title' }, `已添加 ${draft.length} 个条件`)),
    listHost,
    h('div', { class: 'modal-ft-inline' }, apply)
  );
}
