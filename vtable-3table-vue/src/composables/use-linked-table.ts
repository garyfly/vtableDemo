/**
 * 表格挂载 / 卸载。
 *
 * VTable 是纯命令式的 canvas 库，没有 Vue 绑定，也不需要：
 *   onMounted  → new LinkedTable(容器)
 *   onBeforeUnmount → destroy() / release()
 *
 * 注意 LinkedTable 的订阅（store → setRecords / renderWithRecreateCells）
 * 仍然由它自己持有，Vue 只负责生死。
 */

import { onBeforeUnmount, onMounted, shallowRef, type Ref, type ShallowRef } from 'vue';
import type { AppStore } from '../state/store';
import type { EntityKey } from '../domain/types';
import { LinkedTable } from '../table/linked-table';
import type { AnchorRect } from '../utils/format';

export interface UseLinkedTableOptions {
  store: AppStore;
  entity: EntityKey;
  /** 分页模式：每页条数（不传 = 全量交给虚拟滚动） */
  perPage?: number | null;
  /** 点了某个数据列的表头（rect 是视口坐标，表头在 canvas 上没有 DOM 节点） */
  onHeaderClick?: (field: string, rect: AnchorRect) => void;
  /** 实例就绪（挂载后立刻触发），用于把实例登记进调试句柄 */
  onReady?: (linked: LinkedTable) => void;
}

export function useLinkedTable(container: Ref<HTMLElement | null>, opts: UseLinkedTableOptions): ShallowRef<LinkedTable | null> {
  const linked = shallowRef<LinkedTable | null>(null);

  onMounted(() => {
    const el = container.value;
    if (!el) return;
    linked.value = new LinkedTable({
      container: el,
      store: opts.store,
      entity: opts.entity,
      perPage: opts.perPage ?? null,
      onHeaderClick: opts.onHeaderClick,
    });
    opts.onReady?.(linked.value);
  });

  onBeforeUnmount(() => {
    linked.value?.destroy();
    linked.value = null;
  });

  return linked;
}
