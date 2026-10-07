/// <reference types="vite/client" />

/**
 * 调试钩子的类型：控制台 / tools/probe.mjs 通过它拿到
 * store、三个面板句柄（含 VTable 实例）与规则求值器。
 *
 * 形状与命令式版本保持一致，探针脚本不需要改动。
 */

import type { AppStore } from './state/store';
import type { PanelHandle } from './composables/panel-registry';
import type { SCHEMAS, evaluateRowState } from './domain/schema';

declare global {
  interface Window {
    __vtDemo?: {
      store: AppStore;
      panels: PanelHandle[];
      sourceMode: 'mock' | 'http';
      schemas: typeof SCHEMAS;
      evaluateRowState: typeof evaluateRowState;
    };
  }
}

export {};
