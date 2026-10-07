/**
 * 数据访问抽象层。
 *
 * 页面只依赖 `DataSource` 这一个接口：
 *   - `MockDataSource`  —— 纯前端 10 万级内存数据（默认，开箱即跑）
 *   - `HttpDataSource`  —— 预留的真实后端分页接口，网络不可用时自动兜底到 mock
 *
 * 因为接口是按「父级 + 查询条件 + 分页」建模的，切到后端时
 * 表格层的联动/筛选/批量保存代码一行都不用改。
 */

import type { CellPatch, DataRow, EntityKey, PageParam, QueryResult, QueryState, RowId } from '../domain/types';

/** 一次查询请求 */
export interface QueryRequest {
  /**
   * 父级 id 约束。
   * - `undefined`  → 不按父级过滤（三级联动里“未选中上级，展示全部”）
   * - `null`       → 明确查询「无父级」的行
   * - `string`     → 查询该父级下的子行
   */
  parentId?: string | null;
  query: QueryState;
  /** 传了就走服务端分页语义；不传则返回全部命中行交给 VTable 虚拟滚动 */
  page?: PageParam | null;
}

export interface EntityStats {
  total: number;
  deleted: number;
}

export interface DataSource {
  readonly kind: 'mock' | 'http';
  /**
   * 后端不可用、当前实际在读本地兜底数据时为 true。
   * UI 必须把它显示出来 —— 否则用户会以为看到的是真实数据。
   */
  readonly degraded?: boolean;
  /** 最近一次失败原因，用于在界面上说明为什么降级 */
  readonly lastError?: string;
  /** 数据装载（mock 生成 / 后端预热），onProgress 用于页面加载进度 */
  init(onProgress?: (stage: string, ratio: number) => void): Promise<void>;
  query(entity: EntityKey, req: QueryRequest): Promise<QueryResult>;
  /** 批量写回（保存编辑） */
  patch(entity: EntityKey, patches: CellPatch[]): Promise<void>;
  /** 批量软删除 */
  remove(entity: EntityKey, ids: RowId[]): Promise<void>;
  stats(entity: EntityKey): EntityStats;
  /** 同步取单行；仅内存实现支持，HTTP 实现返回 undefined */
  getById(entity: EntityKey, id: RowId): DataRow | undefined;
  /** 取一个父级下子行的总数（面板上显示「关联 N 条」） */
  countChildren(entity: EntityKey, parentId: RowId): number;
}
