/**
 * 单元格绘制工具箱。
 *
 * VTable 的自定义单元格本质是「往 cell 的 Group 里塞绝对定位的图元」，
 * 官方内置的进度条单元格也是这么写的（见 progress-bar-cell.js）。
 * 这里把常用的图元封装成一组短函数，让 11 个属性小组件只剩下业务表达。
 *
 * 关键性能约束：**每次绘制不做 canvas 文本测量**。
 * 10 万行 × 12 列下，逐格 measureText 会直接吃掉几十毫秒，
 * 所以这里用 CJK 感知的字符宽度估算，误差在标签截断场景下可以接受。
 */

// 图元工厂不在 @visactor/vtable 的主入口上，但 VTable 内部就是从这个模块取用的
// （见 es/scenegraph/group-creater/cell-type/progress-bar-cell.js）。
import { createGroup, createLine, createRect, createSymbol, createText } from '@visactor/vtable/es/vrender';
import type { IGroup, IGraphic } from '@visactor/vtable/es/vrender';

/* ------------------------------------------------------------------ *
 * 调色板
 * ------------------------------------------------------------------ */

export const C = {
  text: '#1D2129',
  textSub: '#4E5969',
  textWeak: '#86909C',
  textFaint: '#C9CDD4',
  border: '#E5E6EB',
  bgSoft: '#F2F3F5',
  bgSofter: '#F7F8FA',
  primary: '#165DFF',
  primarySoft: '#E8F0FF',
  success: '#00B42A',
  successSoft: '#E8FFEA',
  warning: '#FF7D00',
  warningSoft: '#FFF7E8',
  danger: '#F53F3F',
  dangerSoft: '#FFECE8',
  dirty: '#FF7D00',
  dirtySoft: '#FFF7E8',
  selectRow: '#F2F7FF',
  white: '#FFFFFF',
} as const;

/* ------------------------------------------------------------------ *
 * 文本宽度估算 + 截断
 * ------------------------------------------------------------------ */

/** 估算文本像素宽度：CJK / 全角按 1 em，其余按 0.56 em */
export function measureText(text: string, fontSize: number): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) {
    w += text.charCodeAt(i) > 0x2e80 ? fontSize : fontSize * 0.56;
  }
  return w;
}

/** 超宽时截断并加省略号 */
export function ellipsize(text: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0) return '';
  if (measureText(text, fontSize) <= maxWidth) return text;
  const ell = '…';
  const ellW = measureText(ell, fontSize);
  let w = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const cw = text.charCodeAt(i) > 0x2e80 ? fontSize : fontSize * 0.56;
    if (w + cw + ellW > maxWidth) break;
    out += text[i];
    w += cw;
  }
  return out + ell;
}

/* ------------------------------------------------------------------ *
 * 图元
 * ------------------------------------------------------------------ */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function group(width: number, height: number, name?: string): IGroup {
  const g = createGroup({ x: 0, y: 0, width, height, pickable: false }) as IGroup;
  if (name) (g as unknown as { name: string }).name = name;
  return g;
}

export function add(parent: IGroup, child: IGraphic): void {
  (parent as unknown as { addChild: (c: IGraphic) => void }).addChild(child);
}

export function rect(box: Box, fill: string, radius = 0, stroke?: string, lineWidth?: number): IGraphic {
  return createRect({
    x: box.x,
    y: box.y,
    width: Math.max(0, box.w),
    height: Math.max(0, box.h),
    fill,
    cornerRadius: radius,
    stroke,
    lineWidth,
    pickable: false,
  }) as IGraphic;
}

/**
 * 筛选漏斗图标：几条宽度递减的横条。
 * 刻意用图形而不是 "▽"/"⏷" 之类的字符 —— 字体里有没有那个字形不可控，
 * 画出来的才能保证在所有环境下长得一样。
 */
export function funnel(right: number, centerY: number, fill: string): IGraphic {
  const g = group(14, 12, 'funnel');
  const barH = 2;
  const gap = 2;
  const widths = [12, 8, 4];
  const top = centerY - (widths.length * barH + (widths.length - 1) * gap) / 2;
  widths.forEach((w, i) => {
    add(g, rect({ x: right - w, y: top + i * (barH + gap), w, h: barH }, fill, 1));
  });
  return g;
}

export interface TextOpts {
  fontSize?: number;
  fill?: string;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  baseline?: 'top' | 'middle' | 'bottom';
  maxWidth?: number;
  opacity?: number;
}
export function text(content: string, x: number, y: number, opts: TextOpts = {}): IGraphic {
  const fontSize = opts.fontSize ?? 13;
  const shown = opts.maxWidth !== undefined ? ellipsize(content, opts.maxWidth, fontSize) : content;
  return createText({
    x,
    y,
    text: shown,
    fontSize,
    fill: opts.fill ?? C.text,
    fontWeight: opts.bold ? 'bold' : 'normal',
    textAlign: opts.align ?? 'left',
    textBaseline: opts.baseline ?? 'middle',
    opacity: opts.opacity,
    pickable: false,
  }) as IGraphic;
}

export function symbol(type: 'circle' | 'star' | 'triangle' | 'rect' | 'diamond', x: number, y: number, size: number, fill: string, opacity = 1): IGraphic {
  return createSymbol({
    x,
    y,
    symbolType: type,
    size,
    fill,
    opacity,
    pickable: false,
  }) as IGraphic;
}

/** 折线（勾、箭头、分隔线都靠它） */
export function line(points: { x: number; y: number }[], stroke: string, lineWidth = 2): IGraphic {
  return createLine({
    x: 0,
    y: 0,
    points,
    stroke,
    lineWidth,
    lineCap: 'round',
    lineJoin: 'round',
    pickable: false,
  }) as IGraphic;
}

/** 复选框：勾选 / 半选 / 未选 */
export function checkbox(g: IGroup, x: number, y: number, size: number, state: boolean | 'checked' | 'unchecked' | 'indeterminate', disabled = false): void {
  const on = state === true || state === 'checked';
  const half = state === 'indeterminate';
  const active = on || half;
  add(g, rect({ x, y, w: size, h: size }, active ? (disabled ? C.textFaint : C.primary) : C.white, 3, active ? (disabled ? C.textFaint : C.primary) : C.textFaint, 1.5));
  if (on) {
    add(g, line([{ x: x + size * 0.24, y: y + size * 0.52 }, { x: x + size * 0.43, y: y + size * 0.72 }, { x: x + size * 0.77, y: y + size * 0.3 }], C.white, 2));
  } else if (half) {
    add(g, rect({ x: x + size * 0.25, y: y + size / 2 - 1, w: size * 0.5, h: 2 }, C.white));
  }
}

/* ------------------------------------------------------------------ *
 * 组合件
 * ------------------------------------------------------------------ */

/** 圆角标签（状态、单选、多选都用它） */
export function pill(
  parent: IGroup,
  x: number,
  y: number,
  label: string,
  color: string,
  opts: { bg?: string; fontSize?: number; maxWidth?: number; height?: number; bold?: boolean; muted?: boolean } = {}
): number {
  const fontSize = opts.fontSize ?? 12;
  const h = opts.height ?? 20;
  const maxW = opts.maxWidth ?? Infinity;
  const shown = ellipsize(label, Math.max(8, maxW - 14), fontSize);
  const w = Math.min(maxW, measureText(shown, fontSize) + 14);
  add(parent, rect({ x, y: y - h / 2, w, h }, opts.bg ?? color, h / 2, undefined, undefined));
  add(parent, text(shown, x + w / 2, y, { fontSize, fill: opts.muted ? C.textWeak : C.white, align: 'center', bold: opts.bold }));
  return w;
}

/** 描边型标签（多选标签用，比实心更轻） */
export function outlinePill(parent: IGroup, x: number, y: number, label: string, color: string, maxWidth: number): number {
  const fontSize = 11;
  const h = 18;
  const shown = ellipsize(label, Math.max(6, maxWidth - 12), fontSize);
  const w = measureText(shown, fontSize) + 12;
  add(parent, rect({ x, y: y - h / 2, w, h }, hexA(color, 0.12), 4));
  add(parent, text(shown, x + w / 2, y, { fontSize, fill: color, align: 'center' }));
  return w;
}

/** 头像（首字圆形底 + 姓名） */
export function avatar(parent: IGroup, x: number, y: number, name: string, color: string, size = 20, showName = true, maxWidth = 200): void {
  add(parent, symbol('circle', x + size / 2, y, size, color));
  add(parent, text(name.slice(0, 1), x + size / 2, y, { fontSize: size * 0.5, fill: C.white, align: 'center', bold: true }));
  if (showName) add(parent, text(name, x + size + 6, y, { fontSize: 13, fill: C.text, maxWidth: maxWidth - size - 6 }));
}

/** 星级：实心 + 空心叠加 */
export function stars(parent: IGroup, x: number, y: number, value: number, max = 5, size = 13, gap = 2, color = '#FF9A2E'): number {
  for (let i = 0; i < max; i++) {
    const active = i < Math.round(value);
    add(parent, symbol('star', x + i * (size + gap) + size / 2, y, size, active ? color : C.border, active ? 1 : 0.9));
  }
  return max * (size + gap);
}

/** 进度条：底槽 + 前景 + 右侧百分比文本 */
export function progressBar(parent: IGroup, x: number, y: number, w: number, value: number, color: string, opts: { showText?: boolean; height?: number; muted?: boolean } = {}): void {
  const h = opts.height ?? 8;
  const showText = opts.showText ?? true;
  const textW = showText ? 38 : 0;
  const barW = Math.max(10, w - textW);
  const pct = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  add(parent, rect({ x, y: y - h / 2, w: barW, h }, opts.muted ? C.bgSoft : '#EDEFF2', h / 2));
  add(parent, rect({ x, y: y - h / 2, w: Math.max(pct > 0 ? 2 : 0, barW * pct), h }, color, h / 2));
  if (showText) {
    add(parent, text(`${Math.round(pct * 100)}%`, x + barW + 8, y, { fontSize: 12, fill: C.textSub, maxWidth: textW - 4 }));
  }
}

/** 开关：胶囊 + 圆钮 */
export function toggle(parent: IGroup, x: number, y: number, on: boolean, opts: { width?: number; height?: number; disabled?: boolean; onColor?: string } = {}): void {
  const w = opts.width ?? 38;
  const h = opts.height ?? 20;
  const fill = opts.disabled ? C.bgSoft : on ? (opts.onColor ?? C.success) : '#C9CDD4';
  add(parent, rect({ x, y: y - h / 2, w, h }, fill, h / 2));
  const knob = h - 4;
  add(parent, symbol('circle', on ? x + w - knob / 2 - 2 : x + knob / 2 + 2, y, knob, C.white));
}

/* ------------------------------------------------------------------ *
 * 颜色工具
 * ------------------------------------------------------------------ */

/** #RRGGBB + alpha → rgba() */
export function hexA(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** 按百分比取色：低=红 中=橙 高=绿 */
export function progressColor(pct: number): string {
  if (pct >= 100) return C.success;
  if (pct >= 60) return C.primary;
  if (pct >= 30) return C.warning;
  return C.danger;
}

/* ------------------------------------------------------------------ *
 * 数值格式化
 * ------------------------------------------------------------------ */

export function formatNumber(v: unknown, precision = 0): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('zh-CN', { minimumFractionDigits: precision, maximumFractionDigits: precision });
}

export function formatDate(v: unknown): string {
  if (!v) return '—';
  return String(v);
}

export const TAG_COLOR_FALLBACK = C.primary;
