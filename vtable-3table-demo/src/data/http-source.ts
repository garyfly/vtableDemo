/**
 * 预留的真实后端数据源。
 *
 * 接口语义与 `MockDataSource` 完全一致，切后端时页面代码零改动：
 *   GET  /api/{entity}?parentId=&keyword=&filters=&sort=&page=&pageSize=
 *   POST /api/{entity}/patch   { patches: [{ id, field, value }] }
 *   POST /api/{entity}/delete  { ids: [...] }
 *
 * 演示环境没有后端，所以任何一次请求失败（网络错误 / 非 2xx）
 * 都会自动降级到内置 mock，并在控制台与页面上标明「已降级」，
 * 不会让页面白屏。
 */

import type { CellPatch, DataRow, EntityKey, QueryResult, RowId } from '../domain/types';
import type { DataSource, EntityStats, QueryRequest } from './datasource';

export interface HttpDataSourceOptions {
  baseUrl?: string;
  fallback: DataSource;
  /** 请求超时，超过就走兜底 */
  timeoutMs?: number;
}

export class HttpDataSource implements DataSource {
  readonly kind = 'http' as const;

  private baseUrl: string;
  private fallback: DataSource;
  private timeoutMs: number;

  /** 是否已经降级到本地 mock */
  degraded = false;
  lastError = '';

  constructor(opts: HttpDataSourceOptions) {
    this.baseUrl = opts.baseUrl ?? '/api';
    this.fallback = opts.fallback;
    this.timeoutMs = opts.timeoutMs ?? 4000;
  }

  async init(onProgress?: (stage: string, ratio: number) => void): Promise<void> {
    try {
      await this.request('GET', `/health`);
      onProgress?.('已连接后端', 1);
    } catch (err) {
      this.markDegraded(err);
      await this.fallback.init(onProgress);
    }
  }

  async query(entity: EntityKey, req: QueryRequest): Promise<QueryResult> {
    if (this.degraded) return this.fallback.query(entity, req);
    const params = new URLSearchParams();
    if (req.parentId !== undefined) params.set('parentId', req.parentId === null ? '__null__' : req.parentId);
    if (req.query.keyword) params.set('keyword', req.query.keyword);
    if (req.query.conditions.length) params.set('filters', JSON.stringify(req.query.conditions));
    if (req.query.sort) params.set('sort', JSON.stringify(req.query.sort));
    if (req.page) {
      params.set('page', String(req.page.index));
      params.set('pageSize', String(req.page.size));
    }
    try {
      const data = await this.request('GET', `/${entity}?${params.toString()}`);
      return { rows: data.rows as DataRow[], total: Number(data.total ?? data.rows?.length ?? 0), elapsedMs: Number(data.elapsedMs ?? 0) };
    } catch (err) {
      this.markDegraded(err);
      return this.fallback.query(entity, req);
    }
  }

  async patch(entity: EntityKey, patches: CellPatch[]): Promise<void> {
    if (this.degraded) return this.fallback.patch(entity, patches);
    try {
      await this.request('POST', `/${entity}/patch`, { patches });
    } catch (err) {
      this.markDegraded(err);
      return this.fallback.patch(entity, patches);
    }
  }

  async remove(entity: EntityKey, ids: RowId[]): Promise<void> {
    if (this.degraded) return this.fallback.remove(entity, ids);
    try {
      await this.request('POST', `/${entity}/delete`, { ids });
    } catch (err) {
      this.markDegraded(err);
      return this.fallback.remove(entity, ids);
    }
  }

  stats(entity: EntityKey): EntityStats {
    return this.fallback.stats(entity);
  }

  getById(entity: EntityKey, id: RowId): DataRow | undefined {
    return this.fallback.getById(entity, id);
  }

  countChildren(entity: EntityKey, parentId: RowId): number {
    return this.fallback.countChildren(entity, parentId);
  }

  private markDegraded(err: unknown): void {
    if (!this.degraded) {
      this.degraded = true;
      // eslint-disable-next-line no-console
      console.warn('[HttpDataSource] 后端不可用，已降级到本地 mock 数据源', err);
    }
    this.lastError = err instanceof Error ? err.message : String(err);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl + path, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${method} ${path} -> HTTP ${res.status}`);
      const ct = res.headers.get('content-type') ?? '';
      if (!ct.includes('application/json')) throw new Error(`${method} ${path} -> 非 JSON 响应`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }
}
