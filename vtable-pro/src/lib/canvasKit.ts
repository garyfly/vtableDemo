/**
 * canvas 单元格绘制工具箱（只保留组件真正用得到的那几个图元）。
 *
 * VTable 的自定义单元格本质是「往 cell 的 Group 里塞绝对定位的图元」。
 * 走 canvas 的列不产生任何 DOM，10 万行滚动时是纯绘制开销，所以除了必须用
 * 真组件（按钮 / 输入框 / 复杂交互）的列，其它列都留在这条快路径上。
 *
 * 性能约束：**不做 canvas 文本测量**，用 CJK 感知的宽度估算代替。
 */

import { createGroup, createLine, createRect, createText } from '@visactor/vtable/es/vrender';
import type { IGraphic, IGroup } from '@visactor/vtable/es/vrender';

export const C = {
  text: '#1D2129',
  textSub: '#4E5969',
  textWeak: '#86909C',
  textFaint: '#C9CDD4',
  border: '#E5E6EB',
  line: '#F0F1F3',
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
  rowSelected: '#F2F7FF',
  white: '#FFFFFF',
} as const;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function measureText(text: string, fontSize: number): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) w += text.charCodeAt(i) > 0x2e80 ? fontSize : fontSize * 0.56;
  return w;
}

export function ellipsize(text: string, maxWidth: number, fontSize: number): string {
  if (maxWidth <= 0) return '';
  if (measureText(text, fontSize) <= maxWidth) return text;
  const ellW = measureText('…', fontSize);
  let w = 0;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const cw = text.charCodeAt(i) > 0x2e80 ? fontSize : fontSize * 0.56;
    if (w + cw + ellW > maxWidth) break;
    out += text[i];
    w += cw;
  }
  return out + '…';
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

export interface TextOpts {
  fontSize?: number;
  fill?: string;
  bold?: boolean;
  align?: 'left' | 'center' | 'right';
  maxWidth?: number;
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
    textBaseline: 'middle',
    pickable: false,
  }) as IGraphic;
}

export function line(points: { x: number; y: number }[], stroke: string, lineWidth = 2): IGraphic {
  return createLine({ x: 0, y: 0, points, stroke, lineWidth, lineCap: 'round', lineJoin: 'round', pickable: false }) as IGraphic;
}

/** 复选框：勾选 / 半选 / 未选 */
export function checkbox(g: IGroup, x: number, y: number, size: number, state: boolean | 'checked' | 'unchecked' | 'indeterminate'): void {
  const on = state === true || state === 'checked';
  const half = state === 'indeterminate';
  const active = on || half;
  add(g, rect({ x, y, w: size, h: size }, active ? C.primary : C.white, 3, active ? C.primary : C.textFaint, 1.5));
  if (on) {
    add(g, line([{ x: x + size * 0.24, y: y + size * 0.52 }, { x: x + size * 0.43, y: y + size * 0.72 }, { x: x + size * 0.77, y: y + size * 0.3 }], C.white, 2));
  } else if (half) {
    add(g, rect({ x: x + size * 0.25, y: y + size / 2 - 1, w: size * 0.5, h: 2 }, C.white));
  }
}

/** 筛选漏斗：三条递减横条（用图形而非字形，避免字体缺字） */
export function funnel(right: number, centerY: number, fill: string): IGraphic {
  const g = group(14, 12, 'funnel');
  const barH = 2;
  const gap = 2;
  const widths = [12, 8, 4];
  const top = centerY - (widths.length * barH + (widths.length - 1) * gap) / 2;
  widths.forEach((w, i) => add(g, rect({ x: right - w, y: top + i * (barH + gap), w, h: barH }, fill, 1)));
  return g;
}

/** 排序箭头（上下两个三角，用四条线拼出来） */
export function sortCaret(x: number, centerY: number, fill: string, dir: 'asc' | 'desc' | null): IGraphic {
  const g = group(10, 16, 'caret');
  const upColor = dir === 'asc' ? fill : C.textFaint;
  const downColor = dir === 'desc' ? fill : C.textFaint;
  add(g, line([{ x: x, y: centerY - 6 }, { x: x + 4, y: centerY - 1 }, { x: x - 4, y: centerY - 1 }, { x, y: centerY - 6 }], upColor, 1.5));
  add(g, line([{ x: x, y: centerY + 6 }, { x: x + 4, y: centerY + 1 }, { x: x - 4, y: centerY + 1 }, { x, y: centerY + 6 }], downColor, 1.5));
  return g;
}
