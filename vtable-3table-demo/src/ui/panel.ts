/**
 * 单张表的面板：标题 / 作用域面包屑 / 搜索 / 筛选 / 选择 / 批量操作 / 列设置 / 联动说明。
 *
 * 三张表共用这一个类，行为差异全部来自 schema —— 面板本身不认识任何具体字段。
 */

import { SCHEMAS, type EntitySchema } from '../domain/schema';
import type { EntityKey, FilterCondition } from '../domain/types';
import type { AppStore } from '../state/store';
import { LinkedTable } from '../table/linked-table';
import { openBulkDialog } from './bulk';
import { openColumnFilter } from './column-filter';
import { clear, debounce, h, num, openPopover } from './dom';
import { buildFilterPanel, describeCondition } from './filters';

export interface TablePanelOptions {
  store: AppStore;
  entity: EntityKey;
  index: number;
  perPage?: number | null;
}

export class TablePanel {
  readonly el: HTMLElement;
  readonly linked: LinkedTable;
  readonly entity: EntityKey;

  private store: AppStore;
  private schema: EntitySchema;
  private unsubs: (() => void)[] = [];

  private scopeLabel: HTMLElement;
  private countLabel: HTMLElement;
  private selectedLabel: HTMLElement;
  private chipsRow: HTMLElement;
  private body: HTMLElement;
  private emptyOverlay: HTMLElement;
  private searchInput: HTMLInputElement;
  private filterBtn: HTMLButtonElement;
  private bulkBtn: HTMLButtonElement;
  private clearScopeBtn: HTMLButtonElement;
  private ruleHitCache: { version: number; hits: { tag: string; label: string; count: number }[] } | null = null;

  constructor(opts: TablePanelOptions) {
    this.store = opts.store;
    this.entity = opts.entity;
    this.schema = SCHEMAS[opts.entity];

    this.scopeLabel = h('span', { class: 'scope' });
    this.countLabel = h('span', { class: 'metric' });
    this.selectedLabel = h('span', { class: 'metric accent' });
    this.chipsRow = h('div', { class: 'chips' });
    this.body = h('div', { class: 'pane-body' });
    this.emptyOverlay = h('div', { class: 'empty-overlay' }, '没有匹配的数据');

    this.searchInput = h('input', {
      class: 'search',
      type: 'search',
      placeholder: `搜索${this.schema.label}…`,
      oninput: debounce((e: Event) => {
        void this.store.setKeyword(this.entity, (e.target as HTMLInputElement).value);
      }, 260),
    }) as HTMLInputElement;

    this.filterBtn = h('button', { class: 'btn', onclick: () => this.openFilters() }, '筛选') as HTMLButtonElement;

    this.bulkBtn = h('button', { class: 'btn', onclick: () => openBulkDialog({ store: this.store, entity: this.entity, schema: this.schema }) }, '批量操作') as HTMLButtonElement;

    this.clearScopeBtn = h('button', { class: 'btn ghost', onclick: () => void this.store.clearFocus(this.entity), title: '清除本表聚焦，下级回到全部' }, '显示全部');

    this.el = h(
      'section',
      { class: `pane pane-${opts.entity}`, dataset: { entity: opts.entity } },
      h(
        'div',
        { class: 'pane-hd' },
        h('span', { class: 'pane-idx' }, String(opts.index)),
        h('span', { class: 'pane-title' }, this.schema.label),
        this.scopeLabel,
        h('span', { class: 'spacer' }),
        this.countLabel,
        this.selectedLabel,
        h(
          'div',
          { class: 'pane-tools' },
          this.searchInput,
          this.filterBtn,
          h('button', { class: 'btn', onclick: () => this.selectAll() }, '全选'),
          h('button', { class: 'btn', onclick: () => this.invert() }, '反选'),
          h('button', { class: 'btn', onclick: () => this.clearSelection() }, '清空选择'),
          this.bulkBtn,
          h('button', { class: 'btn', onclick: (e: Event) => this.openColumns(e.currentTarget as HTMLElement) }, '列设置'),
          h('button', { class: 'btn', onclick: (e: Event) => this.openRules(e.currentTarget as HTMLElement) }, '联动规则'),
          this.clearScopeBtn
        )
      ),
      this.chipsRow,
      h('div', { class: 'pane-stage' }, this.body, this.emptyOverlay)
    );

    this.linked = new LinkedTable({
      container: this.body,
      store: this.store,
      entity: this.entity,
      perPage: opts.perPage ?? null,
      onHeaderClick: (field, rect) => this.openColumnFilter(field, rect),
    });

    this.bind();
    this.refreshChrome();
  }

  /* ------------------------------------------------------------ *
   * 订阅
   * ------------------------------------------------------------ */

  private bind(): void {
    const e = this.entity;
    this.unsubs.push(
      this.store.on('data', x => {
        if (x === e || x === undefined) this.refreshChrome();
      })
    );
    this.unsubs.push(
      this.store.on('selection', x => {
        if (x === e || x === undefined) this.refreshChrome();
      })
    );
    this.unsubs.push(this.store.on('focus', () => this.refreshChrome()));
    this.unsubs.push(this.store.on('query', x => {
      if (x === e || x === undefined) this.refreshChrome();
    }));
    this.unsubs.push(this.store.on('mode', () => this.refreshChrome()));
    this.unsubs.push(this.store.on('status', () => this.refreshChrome()));
  }

  /* ------------------------------------------------------------ *
   * 头部信息 + 条件 chips
   * ------------------------------------------------------------ */

  private refreshChrome(): void {
    const rt = this.store.entities[this.entity];
    const stats = this.linked.stats();

    /* 作用域：上级聚焦了什么 */
    const parent = this.schema.parent;
    if (parent) {
      const up = this.store.entities[parent.entity];
      if (up.focusedId) {
        const row = this.store.source.getById(parent.entity, up.focusedId);
        const title = row ? String(row[SCHEMAS[parent.entity].titleField] ?? up.focusedId) : up.focusedId;
        this.scopeLabel.textContent = `← ${SCHEMAS[parent.entity].short}：${title}`;
        this.scopeLabel.className = 'scope on';
        this.clearScopeBtn.style.display = '';
      } else {
        this.scopeLabel.textContent = `← 未选择${SCHEMAS[parent.entity].short}，展示全部`;
        this.scopeLabel.className = 'scope';
        this.clearScopeBtn.style.display = 'none';
      }
    } else {
      this.scopeLabel.textContent = '顶层';
      this.scopeLabel.className = 'scope';
      this.clearScopeBtn.style.display = 'none';
    }

    const filtered = rt.query.keyword || rt.query.conditions.length > 0;
    this.countLabel.textContent = filtered || stats.showing !== stats.total
      ? `${num(stats.showing)} / ${num(stats.total)} 条 · 查询 ${stats.queryMs < 1 ? '<1' : stats.queryMs.toFixed(0)}ms`
      : `${num(stats.total)} 条 · 查询 ${stats.queryMs < 1 ? '<1' : stats.queryMs.toFixed(0)}ms`;

    this.selectedLabel.textContent = stats.selected > 0 ? `已选 ${num(stats.selected)}` : '';
    this.selectedLabel.style.display = stats.selected > 0 ? '' : 'none';

    this.filterBtn.textContent = rt.query.conditions.length ? `筛选 (${rt.query.conditions.length})` : '筛选';
    this.filterBtn.classList.toggle('pri', rt.query.conditions.length > 0);
    this.bulkBtn.disabled = stats.selected === 0 || !this.store.editable;
    this.bulkBtn.title = !this.store.editable ? '查看态下不可批量修改' : stats.selected === 0 ? '请先勾选要修改的行' : `对已选 ${num(stats.selected)} 行执行批量操作`;

    this.emptyOverlay.style.display = stats.showing === 0 && !rt.loading ? '' : 'none';

    this.renderChips();
  }

  private renderChips(): void {
    const rt = this.store.entities[this.entity];
    clear(this.chipsRow);
    const fields = this.schema.fields;

    if (rt.query.keyword) {
      this.chipsRow.appendChild(
        h(
          'span',
          { class: 'chip' },
          `关键字：${rt.query.keyword}`,
          h('button', { class: 'chip-x', onclick: () => { this.searchInput.value = ''; void this.store.setKeyword(this.entity, ''); } }, '✕')
        )
      );
    }

    for (const c of rt.query.conditions) {
      this.chipsRow.appendChild(
        h(
          'span',
          { class: 'chip' },
          describeCondition(c, fields),
          h('button', { class: 'chip-x', onclick: () => void this.removeCondition(c) }, '✕')
        )
      );
    }

    if (rt.query.sort) {
      const fs = fields.find(f => f.field === rt.query.sort?.field);
      this.chipsRow.appendChild(
        h(
          'span',
          { class: 'chip sort' },
          `排序：${fs?.title ?? rt.query.sort.field} ${rt.query.sort.order === 'asc' ? '↑' : '↓'}`,
          h('button', { class: 'chip-x', onclick: () => void this.store.setSort(this.entity, null) }, '✕')
        )
      );
    }

    /* 联动命中统计：当前结果集里有多少行被规则改写了属性 */
    const ruleHits = this.countRuleHits();
    if (ruleHits.length) {
      this.chipsRow.appendChild(
        h(
          'span',
          { class: 'chip linkage', title: ruleHits.map(r => r.label).join('\n') },
          `联动生效：${ruleHits.slice(0, 2).map(r => r.tag).join(' / ')}${ruleHits.length > 2 ? ` 等 ${ruleHits.length} 条` : ''}`
        )
      );
    }

    if (this.store.editable) {
      this.chipsRow.appendChild(h('span', { class: 'chip edit' }, '编辑态：双击单元格编辑，开关单击即可切换'));
    }

    this.chipsRow.style.display = this.chipsRow.childElementCount ? '' : 'none';
  }

  /**
   * 统计当前结果集中各规则的命中行数。
   *
   * 只抽样前 3000 行做趋势提示；结果按 store.version 缓存，
   * 否则每次状态栏刷新（选中、编辑、筛选都会触发）都要重扫一遍规则。
   */
  private countRuleHits(): { tag: string; label: string; count: number }[] {
    const v = this.store.version;
    if (this.ruleHitCache && this.ruleHitCache.version === v) return this.ruleHitCache.hits;
    const rt = this.store.entities[this.entity];
    const sample = Math.min(rt.rows.length, 3000);
    const hits = new Map<string, { tag: string; label: string; count: number }>();
    for (let i = 0; i < sample; i++) {
      const row = rt.rows[i];
      for (const rule of this.schema.rules) {
        if (!rule.when(row)) continue;
        const cur = hits.get(rule.id) ?? { tag: rule.tag, label: rule.label, count: 0 };
        cur.count++;
        hits.set(rule.id, cur);
      }
    }
    const sorted = Array.from(hits.values())
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);
    this.ruleHitCache = { version: v, hits: sorted };
    return sorted;
  }

  /* ------------------------------------------------------------ *
   * 操作
   * ------------------------------------------------------------ */

  private selectAll(): void {
    const rt = this.store.entities[this.entity];
    rt.selection.selectAll();
    this.store.setStatus(`${this.schema.label}：已全选当前结果集 ${num(rt.selection.size)} 条`);
    this.store.notifySelection(this.entity);
  }

  private invert(): void {
    const rt = this.store.entities[this.entity];
    rt.selection.invert();
    this.store.setStatus(`${this.schema.label}：已反选，当前选中 ${num(rt.selection.size)} 条`);
    this.store.notifySelection(this.entity);
  }

  private clearSelection(): void {
    const rt = this.store.entities[this.entity];
    rt.selection.clear();
    this.store.setStatus(`${this.schema.label}：已清空选择`);
    this.store.notifySelection(this.entity);
  }

  private async removeCondition(target: FilterCondition): Promise<void> {
    const rt = this.store.entities[this.entity];
    await this.store.setConditions(
      this.entity,
      rt.query.conditions.filter(c => c.id !== target.id)
    );
  }

  private openFilters(): void {
    const rt = this.store.entities[this.entity];
    const anchor = this.filterBtn;
    let closeFn = () => undefined as void;
    const panel = buildFilterPanel({
      fields: this.schema.fields,
      conditions: rt.query.conditions,
      onApply: conds => {
        void this.store.setConditions(this.entity, conds);
      },
      onClose: () => closeFn(),
    });
    const handle = openPopover(anchor, panel, { width: 400 });
    closeFn = () => handle.close();
  }

  /** 点表头 → 打开「只管这一列」的筛选弹窗 */
  private openColumnFilter(field: string, rect: { left: number; top: number; right: number; bottom: number }): void {
    openColumnFilter({
      store: this.store,
      entity: this.entity,
      field,
      anchorRect: rect,
      // 条件或排序变过之后，表头的漏斗角标要重画
      onChanged: () => {
        this.linked.rebuildColumns();
        this.refreshChrome();
      },
    });
  }

  private openColumns(anchor: HTMLElement): void {
    const hidden = new Set(this.linked.hidden);
    const list = h('div', { class: 'col-list' });
    const rerender = () => {
      clear(list);
      for (const f of this.schema.fields) {
        list.appendChild(
          h(
            'label',
            { class: 'opt-item' },
            h('input', {
              type: 'checkbox',
              checked: !hidden.has(f.field),
              onchange: (e: Event) => {
                if ((e.target as HTMLInputElement).checked) hidden.delete(f.field);
                else hidden.add(f.field);
                this.linked.setHiddenFields(new Set(hidden));
              },
            }),
            h('span', null, f.title),
            h('span', { class: 'muted' }, f.widget)
          )
        );
      }
    };
    rerender();
    const content = h(
      'div',
      { class: 'pop-panel' },
      h('div', { class: 'sec-title' }, '列显示'),
      list,
      h('div', { class: 'pop-actions' }, h('button', { class: 'btn', onclick: () => { this.linked.setHiddenFields(new Set()); } }, '全部显示'))
    );
    openPopover(anchor, content, { width: 260, align: 'right' });
  }

  private openRules(anchor: HTMLElement): void {
    const content = h(
      'div',
      { class: 'pop-panel wide' },
      h('div', { class: 'sec-title' }, `${this.schema.label} · 属性联动规则`),
      h(
        'div',
        { class: 'rule-list' },
        ...this.schema.rules.map(r =>
          h(
            'div',
            { class: 'rule-item' },
            h('span', { class: 'rule-tag' }, r.tag),
            h('div', null, h('div', { class: 'rule-label' }, r.label), h('div', { class: 'rule-meta' }, `驱动字段：${r.driver} · 影响 ${r.effects.length} 个属性`))
          )
        )
      ),
      h('div', { class: 'pop-note' }, '规则是「行级」的：同一列在不同行上可以同时是可见、隐藏或只读。被隐藏的属性会渲染成灰色占位符，双击会给出原因而不是静默失败。')
    );
    openPopover(anchor, content, { width: 420, align: 'right' });
  }

  setEditableChrome(): void {
    this.refreshChrome();
  }

  destroy(): void {
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.linked.destroy();
  }
}
