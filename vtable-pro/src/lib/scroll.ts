/**
 * 滚动条计算。
 *
 * VTable 自己会在 canvas 上画滚动条，但业务侧经常需要「另一条滚动条」：
 * 比如把进度映射到页面顶部的一个进度条、做「跳到 60% 位置」、或者在外层容器
 * 上放一条自绘滑块。这些都需要把表格内部的滚动状态换算成几何量，公式就在这儿：
 *
 *   轨道高 trackHeight = 视口高 - 表头高
 *   内容高 bodyContent  = 全部行高 - 表头高
 *   滑块比 ratio        = min(1, 轨道高 / 内容高)      ← 滑块高 / 轨道高
 *   滑块高 thumbHeight  = max(最小滑块高, ratio × 轨道高)
 *   可滑动距离 travel   = 轨道高 - 滑块高
 *   滚动进度 progress   = scrollTop / maxScrollTop
 *   滑块偏移 thumbTop   = progress × travel
 *
 * 全部来自 VTable 的公开读数（getAllRowsHeight / tableNoFrameHeight / scrollTop /
 * getBodyVisibleRowRange），不依赖任何私有字段。
 */

import type { ListTable } from '@visactor/vtable';
import type { ScrollMetrics } from './types';

export interface ScrollMetricsOptions {
  /** 滑块最小高度 / 宽度，避免内容极长时滑块细到看不见（默认 28） */
  minThumb?: number;
}

type Scrollable = ListTable & {
  setScrollTop?: (n: number) => void;
  setScrollLeft?: (n: number) => void;
  getFrozenColsWidth?: () => number;
  getRightFrozenColsWidth?: () => number;
  getBottomFrozenRowsHeight?: () => number;
};

export function computeScrollMetrics(table: ListTable, opts: ScrollMetricsOptions = {}): ScrollMetrics {
  const t = table as Scrollable;
  const minThumb = opts.minThumb ?? 28;

  const headerCount = t.columnHeaderLevelCount ?? 1;
  let headerHeight = 0;
  for (let r = 0; r < headerCount; r++) headerHeight += safeHeight(t, r);
  const bottomFrozenHeight = safe(() => t.getBottomFrozenRowsHeight?.() ?? 0, 0);

  const contentHeight = safe(() => t.getAllRowsHeight(), t.tableNoFrameHeight);
  const contentWidth = safe(() => t.getAllColsWidth(), t.tableNoFrameWidth);
  const viewHeight = t.tableNoFrameHeight;
  const viewWidth = t.tableNoFrameWidth;

  const maxScrollTop = Math.max(0, contentHeight - viewHeight);
  const maxScrollLeft = Math.max(0, contentWidth - viewWidth);

  const scrollTop = clamp(t.scrollTop ?? 0, 0, maxScrollTop);
  const scrollLeft = clamp(t.scrollLeft ?? 0, 0, maxScrollLeft);

  /* ---- 竖向：轨道 = 视口 - 表头 - 底部冻结行 ---- */
  const trackHeight = Math.max(0, viewHeight - headerHeight - bottomFrozenHeight);
  const bodyContentHeight = Math.max(0, contentHeight - headerHeight - bottomFrozenHeight);
  const thumbRatioY = bodyContentHeight <= 0 ? 1 : Math.min(1, trackHeight / bodyContentHeight);
  const thumbHeight = Math.max(minThumb, Math.round(thumbRatioY * trackHeight));
  const travelY = Math.max(0, trackHeight - thumbHeight);
  const progressY = maxScrollTop > 0 ? scrollTop / maxScrollTop : 0;
  const thumbTop = Math.round(progressY * travelY);

  /* ---- 横向：轨道 = 视口 - 左侧冻结列 ---- */
  const frozenW = safe(() => t.getFrozenColsWidth?.() ?? 0, 0);
  const rightFrozenW = safe(() => t.getRightFrozenColsWidth?.() ?? 0, 0);
  const trackWidth = Math.max(0, viewWidth - frozenW - rightFrozenW);
  const bodyContentWidth = Math.max(0, contentWidth - frozenW - rightFrozenW);
  const thumbRatioX = bodyContentWidth <= 0 ? 1 : Math.min(1, trackWidth / bodyContentWidth);
  const thumbWidth = Math.max(minThumb, Math.round(thumbRatioX * trackWidth));
  const travelX = Math.max(0, trackWidth - thumbWidth);
  const progressX = maxScrollLeft > 0 ? scrollLeft / maxScrollLeft : 0;
  const thumbLeft = Math.round(progressX * travelX);

  /* ---- 虚拟滚动当前画了哪一段 ---- */
  let startRow = 0;
  let endRow = Math.max(0, (t.recordsCount ?? 0) - 1);
  try {
    const range = t.getBodyVisibleRowRange();
    startRow = clamp(range.rowStart - headerCount, 0, Math.max(0, (t.recordsCount ?? 1) - 1));
    endRow = clamp(range.rowEnd - headerCount, startRow, Math.max(0, (t.recordsCount ?? 1) - 1));
  } catch {
    /* 表格还没布局完，忽略 */
  }

  return {
    scrollTop,
    scrollLeft,
    scrollHeight: contentHeight,
    scrollWidth: contentWidth,
    viewHeight,
    viewWidth,
    maxScrollTop,
    maxScrollLeft,
    trackHeight,
    thumbHeight,
    thumbTop,
    thumbRatioY,
    trackWidth,
    thumbWidth,
    thumbLeft,
    startRow,
    endRow,
    totalRows: t.recordsCount ?? 0,
  };
}

/** 按进度（0~1）滚动；进度来自自绘滚动条的拖拽 */
export function scrollToProgress(table: ListTable, progress: number, axis: 'y' | 'x' = 'y'): void {
  const t = table as Scrollable;
  const m = computeScrollMetrics(table);
  const p = clamp(progress, 0, 1);
  if (axis === 'y') t.setScrollTop?.(Math.round(p * m.maxScrollTop));
  else t.setScrollLeft?.(Math.round(p * m.maxScrollLeft));
}

function safe(fn: () => number, fallback: number): number {
  try {
    const v = fn();
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}

function safeHeight(table: ListTable, row: number): number {
  return safe(() => table.getRowHeight(row), table.defaultRowHeight ?? 40);
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}
