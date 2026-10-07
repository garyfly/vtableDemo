/**
 * store ↔ Vue 响应式的桥。
 *
 * AppStore 是命令式的：它只提供 `on(topic, handler)` 事件，没有响应式依赖收集。
 * Vue 侧不去改 store（那会让 10 万行的写路径背上 Proxy 开销），
 * 而是用一个「心跳计数器」把事件翻译成响应式信号：
 *
 *     store.emit('cells') ──▶ tick.value++ ──▶ computed 重新求值 ──▶ DOM 补丁
 *
 * 表格本身（canvas）依然走 LinkedTable 自己的订阅，不经过 Vue 的渲染管线，
 * 所以 10 万行下的重绘路径和命令式版本完全一致。
 */

import { inject, onScopeDispose, provide, ref, type InjectionKey, type Ref } from 'vue';
import type { AppStore, StoreTopic } from '../state/store';
import type { EntityKey } from '../domain/types';

const STORE_KEY: InjectionKey<AppStore> = Symbol('vt:store');

export function provideStore(store: AppStore): AppStore {
  provide(STORE_KEY, store);
  return store;
}

export function useStore(): AppStore {
  const store = inject(STORE_KEY);
  if (!store) throw new Error('useStore() 必须在 App 的 provide 作用域内调用');
  return store;
}

/** 订阅一组 topic，返回每次事件自增的计数器；组件卸载时自动退订 */
export function useStoreTick(topics: StoreTopic[], accept?: (entity?: EntityKey) => boolean): Ref<number> {
  const store = useStore();
  const tick = ref(0);
  const unsubs = topics.map(topic =>
    store.on(topic, entity => {
      if (accept && !accept(entity)) return;
      tick.value++;
    })
  );
  onScopeDispose(() => {
    for (const u of unsubs) u();
  });
  return tick;
}

/**
 * 单表面板的那组 topic：本表相关的事件才唤醒。
 *
 * 刻意**不含** 'cells'：单元格级改动只影响表格自己的重绘（LinkedTable 直接订阅），
 * 面板头部没必要重算 —— 尤其 "联动生效" 那个 chip 要抽样扫 3000 行规则。
 * 联动改成勾选驱动之后也**不含** 'focus'（这个 topic 已经不存在了）：
 * 作用域由 'selection' 表达。
 */
export function useEntityTick(entity: EntityKey): Ref<number> {
  return useStoreTick(['data', 'selection', 'query', 'mode', 'status'], e => !e || e === entity);
}
