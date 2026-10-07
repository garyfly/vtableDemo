/**
 * 组件内部的极简事件总线。
 *
 * 为什么需要它：表头是渲染在 canvas 上方 DOM 覆盖层里的 Vue 组件，
 * 它的「排序状态 / 是否在筛选中」这些 UI 状态，靠 canvas 重绘去驱动是不可靠的
 * （canvas 没重绘，DOM 里的表头就不知道状态变了）。所以状态变化时由控制器
 * 广播一条消息，表头组件自己更新 —— 不依赖 canvas 何时重绘。
 */

export type BusTopic = 'header-sync' | 'scroll' | 'selection' | 'data';

export interface BusEvent {
  topic: BusTopic;
}

export class ProBus {
  private listeners = new Set<(e: BusEvent) => void>();

  on(fn: (e: BusEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(topic: BusTopic): void {
    for (const fn of this.listeners) fn({ topic });
  }
}
