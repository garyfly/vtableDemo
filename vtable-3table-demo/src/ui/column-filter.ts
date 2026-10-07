/**
 * 表头列筛选弹窗。
 *
 * 点表头 → 弹出「只管这一列」的筛选面板，形态跟着列的组件类型走：
 *   - 枚举类（下拉 / 人员 / 标签 / 开关 / 星级 / 进度）
 *       → 勾选式取值列表 + 计数，像 Excel / 飞书那样
 *   - 文本类（文本 / 编号下钻）
 *       → 包含 / 不包含 / 等于 / 不等于 + 输入框
 *   - 数值类（数字 / 金额）→ 等于 / 大于 / 小于 / 介于
 *   - 日期类 → 等于 / 不早于 / 不晚于 / 介于
 *
 * 弹窗里同时提供排序入口（升序 / 降序 / 取消），
 * 因为表头的排序图标很小，不好点。
 *
 * 条件本身仍然走 store.setColumnFilter → 数据源谓词，
 * 所以 10 万行下筛选同样是一次内存扫描，不在前端逐行过滤。
 */

import type { EntitySchema, FieldOption, FieldSchema, WidgetKind } from '../domain/schema';
import { SCHEMAS } from '../domain/schema';
import type { EntityKey, FilterCondition, FilterOperator } from '../domain/types';
import type { AppStore } from '../state/store';
import { clear, h, openPopoverAt, type AnchorRect, type PopoverHandle } from './dom';

/* ------------------------------------------------------------------ *
 * 列类型 → 可用的操作符
 * ------------------------------------------------------------------ */

const ENUM_WIDGETS = new Set<WidgetKind>(['select', 'user', 'switch', 'rating', 'progress', 'multiSelect']);
const NUMERIC_WIDGETS = new Set<WidgetKind>(['number', 'money']);
const DATE_WIDGETS = new Set<WidgetKind>(['date']);

const OP_LABEL: Record<string, string> = {
  contains: '包含',
  notContains: '不包含',
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '不小于',
  lt: '小于',
  lte: '不大于',
  between: '介于',
  empty: '为空',
  notEmpty: '不为空',
  in: '是其中之一',
};

function operatorsFor(widget: WidgetKind): FilterOperator[] {
  if (ENUM_WIDGETS.has(widget)) return ['eq', 'neq', 'empty', 'notEmpty'];
  if (NUMERIC_WIDGETS.has(widget)) return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'];
  if (DATE_WIDGETS.has(widget)) return ['eq', 'gte', 'lte', 'between', 'empty', 'notEmpty'];
  return ['contains', 'notContains', 'eq', 'neq', 'empty', 'notEmpty'];
}

const needsValue = (op: FilterOperator): boolean => op !== 'empty' && op !== 'notEmpty';
const needsValue2 = (op: FilterOperator): boolean => op === 'between';

/* ------------------------------------------------------------------ *
 * 取值 → 显示文案
 * ------------------------------------------------------------------ */

/** 取值列表里那一行显示什么：优先用 schema 里的选项文案和颜色 */
function displayOf(fs: FieldSchema, value: string): { label: string; color?: string } {
  if (value === '') return { label: '（空）' };
  if (fs.widget === 'switch') return { label: value === 'true' ? '已开启' : '已关闭' };
  const opt: FieldOption | undefined = fs.options?.find(o => o.value === value);
  if (opt) return { label: opt.label, color: opt.color };
  if (fs.unit) return { label: `${value}${fs.unit}` };
  return { label: value };
}

/* ------------------------------------------------------------------ *
 * 弹窗
 * ------------------------------------------------------------------ */

export interface ColumnFilterOptions {
  store: AppStore;
  entity: EntityKey;
  field: string;
  /** 表头单元格在页面坐标系里的位置（表头在 canvas 上，没有 DOM 锚点） */
  anchorRect: AnchorRect;
  /** 条件或排序变化后回调，用来刷新表头角标 */
  onChanged: () => void;
  onClose?: () => void;
}

export function openColumnFilter(opts: ColumnFilterOptions): PopoverHandle {
  const { store, entity, field, anchorRect } = opts;
  const schema: EntitySchema = SCHEMAS[entity];
  const fs = schema.fields.find(f => f.field === field);
  if (!fs) throw new Error(`未知列：${entity}.${field}`);

  const existing = store.columnFilterOf(entity, field);
  const enumLike = ENUM_WIDGETS.has(fs.widget);

  const root = h('div', { class: 'col-filter' });
  const handle = openPopoverAt(anchorRect, root, { width: 288, align: 'left' });

  const close = () => {
    handle.close();
    opts.onClose?.();
  };

  /* ---- 头部 ---- */
  root.appendChild(
    h(
      'div',
      { class: 'cf-hd' },
      h('b', null, fs.title),
      h('span', { class: 'cf-sub' }, enumLike ? '勾选要保留的取值' : '设置筛选条件'),
      h('button', { class: 'icon-btn', title: '关闭', onclick: close }, '✕')
    )
  );

  /* ---- 主体 ---- */
  const body = h('div', { class: 'cf-bd' });
  root.appendChild(body);

  /* ---- 底部动作 ---- */
  const applyBtn = h('button', { class: 'btn pri' }, '确定');
  const clearBtn = h('button', { class: 'btn' }, '清除本列筛选');
  const cancelBtn = h('button', { class: 'btn ghost', onclick: close }, '取消');
  root.appendChild(h('div', { class: 'cf-ft' }, clearBtn, h('span', { class: 'spacer' }), cancelBtn, applyBtn));

  /* ================= 枚举类：勾选取值列表 ================= */
  if (enumLike) {
    const selected = new Set<string>();
    let allValues: string[] = [];
    let counts = new Map<string, number>();
    let ready = false;

    const listHost = h('div', { class: 'cf-list' });
    const summary = h('span', { class: 'cf-count' }, '统计中…');
    const searchBox = h('input', { class: 'input compact', type: 'search', placeholder: '在本列取值里搜索…' }) as HTMLInputElement;

    const rerenderList = () => {
      if (!ready) return;
      const q = searchBox.value.trim().toLowerCase();
      clear(listHost);
      const shown = allValues.filter(v => {
        if (!q) return true;
        const d = displayOf(fs, v);
        return v.toLowerCase().includes(q) || d.label.toLowerCase().includes(q);
      });
      if (shown.length === 0) {
        listHost.appendChild(h('div', { class: 'empty-hint' }, '没有匹配的取值'));
      }
      for (const v of shown) {
        const d = displayOf(fs, v);
        const on = selected.has(v);
        const row = h(
          'label',
          { class: `cf-item${on ? ' on' : ''}` },
          h('input', {
            type: 'checkbox',
            checked: on,
            onchange: (e: Event) => {
              const checked = (e.target as HTMLInputElement).checked;
              if (checked) selected.add(v);
              else selected.delete(v);
              row.classList.toggle('on', checked);
              paintSummary();
            },
          }),
          d.color ? h('span', { class: 'dot', style: { background: d.color } }) : null,
          h('span', { class: 'cf-item-label', title: d.label }, d.label),
          h('span', { class: 'cf-item-n' }, counts.get(v)?.toLocaleString('zh-CN') ?? '0')
        );
        listHost.appendChild(row);
      }
    };

    const paintSummary = () => {
      if (!ready) return;
      summary.textContent = selected.size === 0 ? '未选择 = 不筛选' : `已选 ${selected.size} / ${allValues.length}`;
      applyBtn.disabled = false;
    };

    searchBox.oninput = rerenderList;

    body.appendChild(
      h(
        'div',
        { class: 'cf-tools' },
        searchBox,
        h(
          'div',
          { class: 'cf-bulk' },
          h(
            'button',
            {
              class: 'btn tiny',
              onclick: () => {
                // 只全选"当前搜出来"的那些，符合直觉
                const q = searchBox.value.trim().toLowerCase();
                for (const v of allValues) {
                  const d = displayOf(fs, v);
                  if (!q || v.toLowerCase().includes(q) || d.label.toLowerCase().includes(q)) selected.add(v);
                }
                rerenderList();
                paintSummary();
              },
            },
            '全选'
          ),
          h(
            'button',
            {
              class: 'btn tiny',
              onclick: () => {
                selected.clear();
                rerenderList();
                paintSummary();
              },
            },
            '清空'
          )
        )
      )
    );
    body.appendChild(listHost);
    body.appendChild(h('div', { class: 'cf-sum' }, summary));

    /* 先把已有条件回填进勾选状态 */
    const seed = (): void => {
      if (existing && existing.operator === 'in' && Array.isArray(existing.value)) {
        for (const v of existing.value as unknown[]) selected.add(String(v));
      } else if (existing && existing.operator === 'eq') {
        selected.add(String(existing.value));
      }
    };

    // 取值分布是异步算的（要跑一遍数据源），先渲染个"统计中"
    listHost.appendChild(h('div', { class: 'empty-hint' }, '正在统计本列取值…'));
    void store
      .valueCounts(entity, field)
      .then(rows => {
        allValues = rows.map(r => r.value);
        counts = new Map(rows.map(r => [r.value, r.count]));
        ready = true;
        seed();
        applyBtn.disabled = false;
        rerenderList();
        paintSummary();
      })
      .catch(() => {
        ready = true;
        clear(listHost);
        listHost.appendChild(h('div', { class: 'empty-hint' }, '取值统计失败，可直接用「筛选」面板'));
        paintSummary();
      });

    applyBtn.disabled = true;
    applyBtn.onclick = () => {
      if (!ready) return;
      const picked = Array.from(selected);
      // 一个都没勾 / 全勾 = 等价于不筛选
      const cond: FilterCondition | null =
        picked.length === 0 || picked.length === allValues.length
          ? null
          : { id: '', field, operator: 'in', value: picked };
      void store.setColumnFilter(entity, field, cond).then(() => {
        opts.onChanged();
        close();
      });
    };
  } else {
    /* ================= 文本 / 数值 / 日期：操作符 + 值 ================= */
    const ops = operatorsFor(fs.widget);
    const startOp = (existing?.operator && ops.includes(existing.operator) ? existing.operator : ops[0]) as FilterOperator;

    const opSel = h('select', { class: 'input' }) as HTMLSelectElement;
    for (const op of ops) opSel.appendChild(h('option', { value: op }, OP_LABEL[op] ?? op));
    opSel.value = startOp;

    const inputType = DATE_WIDGETS.has(fs.widget) ? 'date' : NUMERIC_WIDGETS.has(fs.widget) ? 'number' : 'text';
    const mkInput = (value: unknown, placeholder: string): HTMLInputElement => {
      const el = h('input', {
        class: 'input',
        type: inputType,
        step: fs.step ?? 'any',
        placeholder,
        value: value === undefined || value === null ? '' : String(value),
      }) as HTMLInputElement;
      return el;
    };
    const v1 = mkInput(existing?.value, `筛选值${fs.unit ? `（${fs.unit}）` : ''}`);
    const v2 = mkInput(existing?.value2, '上限');

    const valueHost = h('div', { class: 'cf-vals' });
    const paintValues = () => {
      clear(valueHost);
      const op = opSel.value as FilterOperator;
      if (!needsValue(op)) {
        valueHost.appendChild(h('div', { class: 'field-hint' }, '该操作符不需要填值'));
        return;
      }
      valueHost.appendChild(v1);
      if (needsValue2(op)) {
        valueHost.appendChild(h('span', { class: 'cf-tilde' }, '~'));
        valueHost.appendChild(v2);
      }
    };
    opSel.onchange = paintValues;
    paintValues();

    body.appendChild(
      h(
        'div',
        { class: 'cf-form' },
        h('label', { class: 'cf-label' }, '条件'),
        opSel,
        h('div', { class: 'cf-label' }, '值'),
        valueHost
      )
    );

    applyBtn.onclick = () => {
      const op = opSel.value as FilterOperator;
      const cond: FilterCondition | null = needsValue(op)
        ? {
            id: '',
            field,
            operator: op,
            value: valueOf(v1, op, fs),
            value2: needsValue2(op) ? valueOf(v2, op, fs) : undefined,
          }
        : { id: '', field, operator: op };
      void store.setColumnFilter(entity, field, cond).then(() => {
        opts.onChanged();
        close();
      });
    };
  }

  /* ---- 排序：表头图标的可点区域太小，这里再给一份 ---- */
  const cur = store.entities[entity].query.sort;
  const isSorted = cur?.field === field;
  const sortRow = h(
    'div',
    { class: 'cf-sort' },
    h('span', { class: 'cf-label' }, '排序'),
    h(
      'button',
      {
        class: `btn tiny${isSorted && cur?.order === 'asc' ? ' pri' : ''}`,
        onclick: () => {
          void store.setSort(entity, { field, order: 'asc' }).then(() => {
            opts.onChanged();
            close();
          });
        },
      },
      '↑ 升序'
    ),
    h(
      'button',
      {
        class: `btn tiny${isSorted && cur?.order === 'desc' ? ' pri' : ''}`,
        onclick: () => {
          void store.setSort(entity, { field, order: 'desc' }).then(() => {
            opts.onChanged();
            close();
          });
        },
      },
      '↓ 降序'
    ),
    isSorted
      ? h(
          'button',
          {
            class: 'btn tiny ghost',
            onclick: () => {
              void store.setSort(entity, null).then(() => {
                opts.onChanged();
                close();
              });
            },
          },
          '取消排序'
        )
      : null
  );
  root.appendChild(sortRow);

  clearBtn.onclick = () => {
    void store.setColumnFilter(entity, field, null).then(() => {
      opts.onChanged();
      close();
    });
  };

  return handle;
}

/** 输入框的值按列类型转一下：数值列转 number，其余保持字符串 */
function valueOf(el: HTMLInputElement, _op: FilterOperator, fs: FieldSchema): unknown {
  const raw = el.value;
  if (raw === '') return '';
  if (NUMERIC_WIDGETS.has(fs.widget)) return Number(raw);
  return raw;
}
