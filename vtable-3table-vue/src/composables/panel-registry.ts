/**
 * 面板注册表。
 *
 * 三张表的面板是三个 <TablePane> 组件实例，但外部（状态栏、调试探针）需要拿到
 * 「面板句柄」：它的 DOM 根、它持有的 LinkedTable（进而拿到 VTable 的 canvas）。
 *
 * 用 provide/inject 传一个注册器，子组件挂载时登记、卸载时撤销，
 * 顺序天然与 DOM 顺序一致 —— 这正好和命令式版本里 `panels` 数组的语义一致。
 */

import { inject, provide, type InjectionKey } from 'vue';
import type { EntityKey } from '../domain/types';
import type { LinkedTable } from '../table/linked-table';

export interface PanelHandle {
  entity: EntityKey;
  /** 面板根元素（.pane） */
  el: HTMLElement;
  /** VTable 封装；很可能在挂载瞬间才被赋值，所以用 getter 暴露 */
  readonly linked: LinkedTable | null;
}

interface Registry {
  register(handle: PanelHandle): () => void;
  all(): PanelHandle[];
}

const REGISTRY_KEY: InjectionKey<Registry> = Symbol('vt:panel-registry');

export function providePanelRegistry(): Registry {
  const handles: PanelHandle[] = [];
  const registry: Registry = {
    register(handle) {
      handles.push(handle);
      return () => {
        const i = handles.indexOf(handle);
        if (i >= 0) handles.splice(i, 1);
      };
    },
    all: () => handles.slice(),
  };
  provide(REGISTRY_KEY, registry);
  return registry;
}

export function usePanelRegistry(): Registry {
  const r = inject(REGISTRY_KEY);
  if (!r) throw new Error('usePanelRegistry() 必须在 App 的 provide 作用域内调用');
  return r;
}
