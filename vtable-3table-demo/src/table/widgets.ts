/**
 * 11 个属性小组件。
 *
 * 每个属性（列）由独立的小组件负责**展示**与**编辑**：
 *   render()   —— 画成什么样（customLayout）
 *   editor     —— 编辑态双击用什么编辑器
 *   onClick    —— 哪些组件单击就直接生效（开关、编号下钻）
 *   toText()   —— 复制 / 导出 CSV 时的纯文本
 *
 * 联动规则求值出来的 FieldState（可见 / 可编辑 / 必填）在这里统一生效，
 * 组件本身不需要知道规则细节：
 *   - visible = false  → 画成灰色占位「—」，并把原因挂在 tooltip 上
 *   - editable = false → 画成只读样式（弱化、无 hover 提示）
 *   - required = true  → 空值时给红色提示
 */

import type { IGroup } from '@visactor/vtable/es/vrender';
import type { DataRow } from '../domain/types';
import { optionOf, type FieldOption, type FieldSchema, type FieldState, type WidgetKind } from '../domain/schema';
import { add, avatar, C, ellipsize, formatDate, formatNumber, group, hexA, measureText, outlinePill, pill, progressBar, progressColor, rect, stars, text, toggle } from './canvas';

export interface WidgetCtx {
  fs: FieldSchema;
  row: DataRow;
  value: unknown;
  /** 联动求值后的字段状态 */
  state: FieldState;
  /** 全局编辑态 && 该字段联动后仍可编辑 */
  editable: boolean;
  /** 该单元格有未保存修改 */
  dirty: boolean;
  /** 该行被复选框选中 */
  checked: boolean;
  /** 该行是当前聚焦行（三级联动的锚点） */
  focused: boolean;
  w: number;
  h: number;
}

export interface Widget {
  kind: WidgetKind;
  /** 单击是否直接产生副作用（不再走双击编辑） */
  directClick?: 'toggle' | 'drilldown';
  render(g: IGroup, ctx: WidgetCtx): void;
  /** 复制 / 导出用文本 */
  toText(fs: FieldSchema, value: unknown): string;
}

const PAD = 10;

/* ------------------------------------------------------------------ *
 * 公共装饰
 * ------------------------------------------------------------------ */

function background(g: IGroup, ctx: WidgetCtx): void {
  if (ctx.checked) add(g, rect({ x: 0, y: 0, w: ctx.w, h: ctx.h }, C.primarySoft));
  else if (ctx.focused) add(g, rect({ x: 0, y: 0, w: ctx.w, h: ctx.h }, C.selectRow));
  if (ctx.dirty) {
    // 未保存修改：右上角一个小三角
    add(g, rect({ x: ctx.w - 6, y: 0, w: 6, h: 6 }, C.dirty));
  }
}

/** 联动隐藏：灰掉的占位符，而不是把列删掉（列还在，只是这行不适用） */
function renderHidden(g: IGroup, ctx: WidgetCtx): void {
  add(g, text('—', PAD, ctx.h / 2, { fontSize: 13, fill: C.textFaint, maxWidth: ctx.w - PAD * 2 }));
  if (ctx.w > 70) {
    add(g, text('已隐藏', ctx.w - PAD, ctx.h / 2, { fontSize: 11, fill: C.textFaint, align: 'right' }));
  }
}

function optionStyle(ctx: WidgetCtx): FieldOption | undefined {
  return optionOf(ctx.fs, ctx.value);
}

/* ------------------------------------------------------------------ *
 * 1. link —— 编号 + 下钻
 * ------------------------------------------------------------------ */

const linkWidget: Widget = {
  kind: 'link',
  directClick: 'drilldown',
  render(g, ctx) {
    background(g, ctx);
    const label = String(ctx.value ?? '');
    const maxW = ctx.w - PAD * 2 - 14;
    add(g, text(label, PAD, ctx.h / 2, { fontSize: 13, fill: C.primary, maxWidth: maxW, bold: true }));
    // 右向 chevron，提示可下钻
    const cx = PAD + Math.min(maxW, measureText(label, 13)) + 8;
    add(g, rect({ x: cx, y: ctx.h / 2 - 1.5, w: 5, h: 1.6 }, C.primary));
    add(g, rect({ x: cx + 3.4, y: ctx.h / 2 - 4, w: 1.6, h: 5 }, C.primary));
    add(g, rect({ x: cx + 3.4, y: ctx.h / 2 + 1, w: 1.6, h: 5 }, C.primary));
  },
  toText: (_fs, v) => String(v ?? ''),
};

/* ------------------------------------------------------------------ *
 * 2. text —— 单行文本
 * ------------------------------------------------------------------ */

const textWidget: Widget = {
  kind: 'text',
  render(g, ctx) {
    background(g, ctx);
    const s = ctx.value === null || ctx.value === undefined || ctx.value === '' ? '' : String(ctx.value);
    if (!s) {
      add(g, text(ctx.state.required ? '必填' : '—', PAD, ctx.h / 2, { fontSize: 12, fill: ctx.state.required ? C.danger : C.textFaint }));
      return;
    }
    add(g, text(s, PAD, ctx.h / 2, { fontSize: 13, fill: ctx.editable ? C.text : C.textSub, maxWidth: ctx.w - PAD * 2 }));
  },
  toText: (_fs, v) => String(v ?? ''),
};

/* ------------------------------------------------------------------ *
 * 3. user —— 头像 + 姓名
 * ------------------------------------------------------------------ */

const userWidget: Widget = {
  kind: 'user',
  render(g, ctx) {
    background(g, ctx);
    const name = ctx.value ? String(ctx.value) : '';
    if (!name) {
      add(g, text(ctx.state.required ? '必填' : '—', PAD, ctx.h / 2, { fontSize: 12, fill: ctx.state.required ? C.danger : C.textFaint }));
      return;
    }
    const opt = optionOf(ctx.fs, name);
    avatar(g, PAD, ctx.h / 2, name, opt?.color ?? C.primary, 20, true, ctx.w - PAD);
  },
  toText: (_fs, v) => String(v ?? ''),
};

/* ------------------------------------------------------------------ *
 * 4. select —— 单选标签
 * ------------------------------------------------------------------ */

const selectWidget: Widget = {
  kind: 'select',
  render(g, ctx) {
    background(g, ctx);
    if (ctx.value === null || ctx.value === undefined || ctx.value === '') {
      add(g, text(ctx.state.required ? '必填' : '—', PAD, ctx.h / 2, { fontSize: 12, fill: ctx.state.required ? C.danger : C.textFaint }));
      return;
    }
    const opt = optionStyle(ctx);
    pill(g, PAD, ctx.h / 2, opt?.label ?? String(ctx.value), opt?.color ?? C.primary, {
      maxWidth: ctx.w - PAD * 2,
      height: 22,
      bg: ctx.editable ? undefined : hexA(opt?.color ?? C.primary, 0.55),
    });
  },
  toText(fs, v) {
    return optionOf(fs, v)?.label ?? String(v ?? '');
  },
};

/* ------------------------------------------------------------------ *
 * 5. multiSelect —— 多选标签组
 * ------------------------------------------------------------------ */

const multiSelectWidget: Widget = {
  kind: 'multiSelect',
  render(g, ctx) {
    background(g, ctx);
    const list = Array.isArray(ctx.value) ? (ctx.value as string[]) : [];
    if (list.length === 0) {
      add(g, text(ctx.state.required ? '必填' : '—', PAD, ctx.h / 2, { fontSize: 12, fill: ctx.state.required ? C.danger : C.textFaint }));
      return;
    }
    const maxRight = ctx.w - PAD;
    let x = PAD;
    let shown = 0;
    for (let i = 0; i < list.length; i++) {
      const opt = optionOf(ctx.fs, list[i]);
      const label = opt?.label ?? list[i];
      const color = opt?.color ?? C.primary;
      const need = measureText(label, 11) + 12 + (shown > 0 ? 4 : 0);
      // 预留「+N」的位置
      const reserve = i < list.length - 1 ? 34 : 0;
      if (x + need + reserve > maxRight) break;
      x += shown > 0 ? 4 : 0;
      x += outlinePill(g, x, ctx.h / 2, label, color, maxRight - x) + 0;
      shown++;
    }
    const rest = list.length - shown;
    if (rest > 0) {
      if (shown > 0) x += 4;
      add(g, text(`+${rest}`, Math.min(x, maxRight - 20), ctx.h / 2, { fontSize: 11, fill: C.textWeak, maxWidth: 30 }));
    }
  },
  toText(fs, v) {
    const list = Array.isArray(v) ? (v as string[]) : [];
    return list.map(x => optionOf(fs, x)?.label ?? x).join('、');
  },
};

/* ------------------------------------------------------------------ *
 * 6. number —— 数值 + 单位
 * ------------------------------------------------------------------ */

const numberWidget: Widget = {
  kind: 'number',
  render(g, ctx) {
    background(g, ctx);
    if (ctx.value === null || ctx.value === undefined || ctx.value === '') {
      add(g, text(ctx.state.required ? '必填' : '—', ctx.w - PAD, ctx.h / 2, { fontSize: 12, fill: ctx.state.required ? C.danger : C.textFaint, align: 'right' }));
      return;
    }
    const precision = ctx.fs.precision ?? 0;
    const numStr = formatNumber(ctx.value, precision);
    const unit = ctx.fs.unit ? ` ${ctx.fs.unit}` : '';
    const unitW = unit ? measureText(unit, 11) : 0;
    add(g, text(numStr, ctx.w - PAD - unitW, ctx.h / 2, { fontSize: 13, fill: ctx.editable ? C.text : C.textSub, align: 'right', maxWidth: ctx.w - PAD * 2 - unitW }));
    if (unit) add(g, text(unit, ctx.w - PAD, ctx.h / 2, { fontSize: 11, fill: C.textWeak, align: 'right' }));
  },
  toText(fs, v) {
    if (v === null || v === undefined || v === '') return '';
    return `${formatNumber(v, fs.precision ?? 0)}${fs.unit ?? ''}`;
  },
};

/* ------------------------------------------------------------------ *
 * 7. money —— 金额
 * ------------------------------------------------------------------ */

const moneyWidget: Widget = {
  kind: 'money',
  render(g, ctx) {
    background(g, ctx);
    if (ctx.value === null || ctx.value === undefined || ctx.value === '') {
      add(g, text('—', ctx.w - PAD, ctx.h / 2, { fontSize: 12, fill: C.textFaint, align: 'right' }));
      return;
    }
    const precision = ctx.fs.precision ?? 0;
    const numStr = `¥${formatNumber(ctx.value, precision)}`;
    const unit = ctx.fs.unit ?? '';
    const unitW = unit ? measureText(unit, 11) + 4 : 0;
    add(g, text(numStr, ctx.w - PAD - unitW, ctx.h / 2, { fontSize: 13, fill: ctx.editable ? C.text : C.textSub, align: 'right', maxWidth: ctx.w - PAD * 2 - unitW }));
    if (unit) add(g, text(unit, ctx.w - PAD, ctx.h / 2, { fontSize: 11, fill: C.textWeak, align: 'right' }));
  },
  toText(fs, v) {
    if (v === null || v === undefined || v === '') return '';
    return `¥${formatNumber(v, fs.precision ?? 0)}${fs.unit ?? ''}`;
  },
};

/* ------------------------------------------------------------------ *
 * 8. progress —— 进度条
 * ------------------------------------------------------------------ */

const progressWidget: Widget = {
  kind: 'progress',
  render(g, ctx) {
    background(g, ctx);
    if (ctx.value === null || ctx.value === undefined || ctx.value === '') {
      add(g, text('—', PAD, ctx.h / 2, { fontSize: 12, fill: C.textFaint }));
      return;
    }
    const v = Number(ctx.value);
    progressBar(g, PAD, ctx.h / 2, ctx.w - PAD * 2, v, ctx.editable ? progressColor(v) : C.textWeak, { height: 8 });
  },
  toText: (_fs, v) => (v === null || v === undefined ? '' : `${Number(v)}%`),
};

/* ------------------------------------------------------------------ *
 * 9. rating —— 星级
 * ------------------------------------------------------------------ */

const ratingWidget: Widget = {
  kind: 'rating',
  render(g, ctx) {
    background(g, ctx);
    if (ctx.value === null || ctx.value === undefined || ctx.value === '') {
      add(g, text('—', PAD, ctx.h / 2, { fontSize: 12, fill: C.textFaint }));
      return;
    }
    const v = Number(ctx.value);
    const size = 13;
    const gap = 3;
    const used = stars(g, PAD + size / 2, ctx.h / 2, v, ctx.fs.max ?? 5, size, gap, ctx.editable ? '#FF9A2E' : '#D9B98A');
    void used;
    if (ctx.w > 110) {
      add(g, text(`${v}`, PAD + 5 * (size + gap) + 6, ctx.h / 2, { fontSize: 11, fill: C.textWeak }));
    }
  },
  toText: (_fs, v) => (v === null || v === undefined ? '' : `${v} 星`),
};

/* ------------------------------------------------------------------ *
 * 10. date —— 日期
 * ------------------------------------------------------------------ */

const TODAY = () => new Date().toISOString().slice(0, 10);

const dateWidget: Widget = {
  kind: 'date',
  render(g, ctx) {
    background(g, ctx);
    if (!ctx.value) {
      add(g, text(ctx.state.required ? '必填' : '—', PAD, ctx.h / 2, { fontSize: 12, fill: ctx.state.required ? C.danger : C.textFaint }));
      return;
    }
    const s = formatDate(ctx.value);
    const overdue = s < TODAY();
    add(g, text(s, PAD, ctx.h / 2, { fontSize: 13, fill: overdue ? C.warning : ctx.editable ? C.text : C.textSub }));
  },
  toText: (_fs, v) => (v ? String(v) : ''),
};

/* ------------------------------------------------------------------ *
 * 11. switch —— 开关（联动驱动方）
 * ------------------------------------------------------------------ */

const switchWidget: Widget = {
  kind: 'switch',
  directClick: 'toggle',
  render(g, ctx) {
    background(g, ctx);
    const on = ctx.value === true;
    const showLabel = ctx.w > 96;
    toggle(g, PAD, ctx.h / 2, on, { width: 36, height: 20, disabled: !ctx.editable, onColor: on ? C.success : undefined });
    if (showLabel) {
      add(g, text(on ? '已开启' : '已关闭', PAD + 44, ctx.h / 2, { fontSize: 12, fill: on ? C.success : C.textWeak, maxWidth: ctx.w - PAD - 48 }));
    }
  },
  toText: (_fs, v) => (v === true ? '已开启' : '已关闭'),
};

/* ------------------------------------------------------------------ *
 * 注册表
 * ------------------------------------------------------------------ */

export const WIDGETS: Record<WidgetKind, Widget> = {
  link: linkWidget,
  text: textWidget,
  user: userWidget,
  select: selectWidget,
  multiSelect: multiSelectWidget,
  number: numberWidget,
  money: moneyWidget,
  progress: progressWidget,
  rating: ratingWidget,
  date: dateWidget,
  switch: switchWidget,
};

export function renderWidget(kind: WidgetKind, ctx: WidgetCtx): IGroup {
  const g = group(ctx.w, ctx.h, `w-${kind}`);
  if (!ctx.state.visible) {
    renderHidden(g, ctx);
    return g;
  }
  (WIDGETS[kind] ?? textWidget).render(g, ctx);
  return g;
}

export function widgetText(fs: FieldSchema, value: unknown): string {
  return (WIDGETS[fs.widget] ?? textWidget).toText(fs, value);
}

/** 编辑态的样式提示：必填未填 / 只读 */
export function stateHint(ctx: WidgetCtx): string {
  if (!ctx.state.visible) return ctx.state.reason ?? '该属性在当前条件下被隐藏';
  if (ctx.state.required && (ctx.value === null || ctx.value === undefined || ctx.value === '')) return ctx.state.reason ?? '必填';
  if (!ctx.state.editable) return ctx.state.reason ?? '该属性当前不可编辑';
  return '';
}

export { ellipsize, PAD };
