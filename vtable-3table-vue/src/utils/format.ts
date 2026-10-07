/**
 * 与框架无关的小工具：格式化 + 防抖 + 锚点矩形。
 *
 * 命令式版本里这些住在 ui/dom.ts（和 h() 混在一起）；
 * Vue 版不再需要 h()，把纯函数单独留在这里。
 */

/** 浮层锚点矩形。表头画在 canvas 上，没有 DOM 节点，只能传 rect */
export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 毫秒格式化：>1000 显示成秒 */
export function ms(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(v < 10 ? 1 : 0)}ms`;
}

/** 千分位 */
export function num(v: number): string {
  return v.toLocaleString('zh-CN');
}

/** 防抖 */
export function debounce<T extends (...args: never[]) => void>(fn: T, wait: number): T {
  let timer = 0;
  return ((...args: never[]) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), wait);
  }) as T;
}
