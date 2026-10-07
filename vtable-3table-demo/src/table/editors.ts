/**
 * 自定义单元格编辑器。
 *
 * VTable 的编辑器契约（对齐 @visactor/vtable-editors 的 IEditor）：
 *   onStart(ctx)  → 把 DOM 挂到 ctx.container 上，用 ctx.referencePosition.rect 定位
 *   用户确认    → 调用 ctx.endEdit()，VTable 随后读 getValue() 写回数据
 *   结束时      → VTable 调 onEnd()，这里负责摘掉 DOM 和事件
 *
 * register.editor(name, instance) 注册的是**实例**，全局复用，
 * 所以所有状态都必须在 onStart 里重置，不能留在字段上跨单元格串味。
 *
 * 这里只实现内置编辑器覆盖不到的小组件：
 *   NumberEditor（数值/金额）、SliderEditor（进度）、RatingEditor（星级）、TagEditor（多选标签）
 * 文本 / 单选 / 人员 / 日期直接用官方 InputEditor / ListEditor / DateInputEditor。
 */

import { DateInputEditor, InputEditor, ListEditor, type EditContext, type IEditor, type RectProps } from '@visactor/vtable-editors';

export const EDITOR_NAMES = {
  text: 'demo-text',
  number: 'demo-number',
  date: 'demo-date',
  select: 'demo-select',
  user: 'demo-user',
  tags: 'demo-tags',
  rating: 'demo-rating',
  slider: 'demo-slider',
} as const;

/* ------------------------------------------------------------------ *
 * 弹层基类
 * ------------------------------------------------------------------ */

const POPOVER_CSS = `
.dsh-pop{position:absolute;z-index:30;background:#fff;border:1px solid #E5E6EB;border-radius:8px;
  box-shadow:0 6px 20px rgba(29,33,41,.14);font:13px/1.5 -apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;
  color:#1D2129;overflow:hidden;user-select:none}
.dsh-pop-hd{padding:8px 12px;border-bottom:1px solid #F2F3F5;color:#4E5969;font-size:12px;display:flex;justify-content:space-between;gap:12px;align-items:center}
.dsh-pop-hd b{color:#1D2129;font-weight:600}
.dsh-pop-bd{padding:10px 12px;max-height:260px;overflow:auto}
.dsh-pop-ft{padding:8px 12px;border-top:1px solid #F2F3F5;display:flex;justify-content:flex-end;gap:8px}
.dsh-opt{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}
.dsh-opt:hover{background:#F2F3F5}
.dsh-opt[data-on="1"]{background:#E8F0FF;color:#165DFF;font-weight:600}
.dsh-dot{width:8px;height:8px;border-radius:50%;flex:none}
.dsh-check{width:15px;height:15px;border:1px solid #C9CDD4;border-radius:3px;flex:none;display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff}
.dsh-check[data-on="1"]{background:#165DFF;border-color:#165DFF}
.dsh-btn{border:1px solid #E5E6EB;background:#fff;border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;color:#4E5969}
.dsh-btn:hover{border-color:#165DFF;color:#165DFF}
.dsh-btn.pri{background:#165DFF;border-color:#165DFF;color:#fff}
.dsh-input{width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #E5E6EB;border-radius:6px;font-size:13px;outline:none}
.dsh-input:focus{border-color:#165DFF}
.dsh-range{width:100%;accent-color:#165DFF}
.dsh-row{display:flex;align-items:center;gap:10px}
.dsh-val{min-width:56px;text-align:right;font-weight:600;color:#165DFF;font-variant-numeric:tabular-nums}
.dsh-star{cursor:pointer;font-size:22px;line-height:1;color:#E5E6EB;transition:color .1s}
.dsh-star[data-on="1"]{color:#FF9A2E}
.dsh-esc{color:#86909C;font-size:11px}
`;

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected) return;
  const el = document.createElement('style');
  el.textContent = POPOVER_CSS;
  document.head.appendChild(el);
  styleInjected = true;
}

/** 弹层编辑器基类：负责定位、外部点击关闭、Esc 取消、DOM 回收 */
abstract class PopoverEditor implements IEditor {
  protected el: HTMLDivElement | null = null;
  protected value: unknown = null;
  protected original: unknown = null;
  protected cancelled = false;
  protected endEditCb: (() => void) | null = null;

  private onDocDown = (e: MouseEvent) => {
    if (this.el && !this.el.contains(e.target as Node)) this.commit();
  };
  private onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      this.cancelled = true;
      e.stopPropagation();
      this.commit();
    }
  };

  protected abstract title(): string;
  protected abstract buildBody(body: HTMLDivElement): void;
  /** 是否需要底部「确定 / 取消」栏（多选、滑块需要，单选不需要） */
  protected needsFooter(): boolean {
    return false;
  }

  onStart(ctx: EditContext): void {
    injectStyle();
    this.value = ctx.value;
    this.original = ctx.value;
    this.cancelled = false;
    this.endEditCb = ctx.endEdit;

    const el = document.createElement('div');
    el.className = 'dsh-pop';

    const hd = document.createElement('div');
    hd.className = 'dsh-pop-hd';
    hd.innerHTML = `<b>${escapeHtml(this.title())}</b><span class="dsh-esc">Esc 取消</span>`;
    el.appendChild(hd);

    const body = document.createElement('div');
    body.className = 'dsh-pop-bd';
    el.appendChild(body);
    this.buildBody(body);

    if (this.needsFooter()) {
      const ft = document.createElement('div');
      ft.className = 'dsh-pop-ft';
      const cancel = document.createElement('button');
      cancel.className = 'dsh-btn';
      cancel.textContent = '取消';
      cancel.onclick = () => {
        this.cancelled = true;
        this.commit();
      };
      const ok = document.createElement('button');
      ok.className = 'dsh-btn pri';
      ok.textContent = '确定';
      ok.onclick = () => this.commit();
      ft.append(cancel, ok);
      el.appendChild(ft);
    }

    ctx.container.appendChild(el);
    this.el = el;
    this.adjustPosition(ctx.referencePosition.rect);

    // 让弹层拿到焦点，Esc 才生效
    el.tabIndex = -1;
    requestAnimationFrame(() => el.focus());

    setTimeout(() => {
      document.addEventListener('mousedown', this.onDocDown, true);
      document.addEventListener('keydown', this.onKey, true);
    }, 0);
  }

  protected commit(): void {
    // 必须先取出回调再拆 DOM：teardown 会把 endEditCb 置空，
    // 顺序反了的话 endEditCb?.() 就是空操作，值永远提交不出去。
    const end = this.endEditCb;
    this.teardown();
    end?.();
  }

  adjustPosition(rect: RectProps): void {
    if (!this.el) return;
    const gap = 2;
    this.el.style.minWidth = `${Math.max(rect.width, 180)}px`;
    this.el.style.left = `${rect.left}px`;
    const below = rect.top + rect.height + gap;
    this.el.style.top = `${below}px`;
    // 贴到视口底部时向上翻转
    requestAnimationFrame(() => {
      if (!this.el) return;
      const r = this.el.getBoundingClientRect();
      if (r.bottom > window.innerHeight - 4 && rect.top - r.height - gap > 0) {
        this.el.style.top = `${rect.top - r.height - gap}px`;
      }
      const parent = this.el.parentElement;
      if (parent) {
        const pw = parent.getBoundingClientRect().width;
        const left = Number.parseFloat(this.el.style.left) || 0;
        if (left + r.width > pw) this.el.style.left = `${Math.max(0, pw - r.width)}px`;
      }
    });
  }

  getValue(): unknown {
    return this.cancelled ? this.original : this.value;
  }

  isEditorElement(target: HTMLElement): boolean {
    return !!this.el && (this.el === target || this.el.contains(target));
  }

  targetIsOnEditor(target: HTMLElement): boolean {
    return this.isEditorElement(target);
  }

  validateValue(): boolean {
    return true;
  }

  getInputElement(): HTMLElement {
    return this.el as HTMLElement;
  }

  private teardown(): void {
    document.removeEventListener('mousedown', this.onDocDown, true);
    document.removeEventListener('keydown', this.onKey, true);
    if (this.el?.parentNode) this.el.parentNode.removeChild(this.el);
    this.el = null;
    this.endEditCb = null;
  }

  onEnd(): void {
    this.teardown();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

/* ------------------------------------------------------------------ *
 * 数值 / 金额编辑器
 * ------------------------------------------------------------------ */

export interface NumberEditorConfig {
  min?: number;
  max?: number;
  step?: number;
  precision?: number;
  unit?: string;
  title?: string;
}

export class NumberEditor implements IEditor {
  private el: HTMLInputElement | null = null;
  private endEditCb: (() => void) | null = null;
  private original: number | null = null;
  private current: number | null = null;
  private handlers: { type: string; fn: EventListener }[] = [];

  constructor(private cfg: NumberEditorConfig = {}) {}

  private clamp(v: number): number {
    let n = v;
    if (this.cfg.min !== undefined) n = Math.max(this.cfg.min, n);
    if (this.cfg.max !== undefined) n = Math.min(this.cfg.max, n);
    if (this.cfg.precision !== undefined) n = Number(n.toFixed(this.cfg.precision));
    return n;
  }

  onStart(ctx: EditContext): void {
    this.handlers = [];
    this.endEditCb = ctx.endEdit;
    this.original = ctx.value === null || ctx.value === undefined || ctx.value === '' ? null : Number(ctx.value);
    this.current = this.original;

    const input = document.createElement('input');
    input.className = 'dsh-input';
    input.type = 'number';
    input.style.position = 'absolute';
    input.style.padding = '4px 8px';
    input.style.width = '100%';
    input.style.boxSizing = 'border-box';
    input.style.height = '100%';
    input.style.border = '2px solid #165DFF';
    input.style.borderRadius = '4px';
    input.style.background = '#fff';
    input.style.outline = 'none';
    if (this.cfg.step !== undefined) input.step = String(this.cfg.step);
    if (this.cfg.min !== undefined) input.min = String(this.cfg.min);
    if (this.cfg.max !== undefined) input.max = String(this.cfg.max);
    input.value = this.original === null ? '' : String(this.original);
    if (this.cfg.unit) input.title = `单位：${this.cfg.unit}`;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.stopPropagation();
        this.endEditCb?.();
      } else if (e.key === 'Escape') {
        this.current = this.original;
        this.endEditCb?.();
      }
      // 数字框里按方向键不应该移动表格选区
      if (e.key.startsWith('Arrow')) e.stopPropagation();
    };
    input.addEventListener('keydown', onKey as EventListener);
    this.handlers.push({ type: 'keydown', fn: onKey as EventListener });
    const onWheel = (e: WheelEvent) => e.preventDefault();
    input.addEventListener('wheel', onWheel as EventListener);
    this.handlers.push({ type: 'wheel', fn: onWheel as EventListener });
    const onInput = () => {
      const n = Number(input.value);
      this.current = input.value === '' || Number.isNaN(n) ? null : this.clamp(n);
    };
    input.addEventListener('input', onInput);
    this.handlers.push({ type: 'input', fn: onInput as EventListener });

    ctx.container.appendChild(input);
    this.el = input;
    this.adjustPosition(ctx.referencePosition.rect);
    input.focus();
    input.select();
  }

  adjustPosition(rect: RectProps): void {
    if (!this.el) return;
    this.el.style.left = `${rect.left - 1}px`;
    this.el.style.top = `${rect.top - 1}px`;
    this.el.style.width = `${rect.width + 2}px`;
    this.el.style.height = `${rect.height + 2}px`;
  }

  getValue(): number | null {
    if (this.el) {
      const raw = this.el.value;
      const n = Number(raw);
      return raw === '' || Number.isNaN(n) ? null : this.clamp(n);
    }
    return this.current;
  }

  getInputElement(): HTMLElement {
    return this.el as HTMLElement;
  }

  isEditorElement(target: HTMLElement): boolean {
    return target === this.el;
  }

  validateValue(): boolean {
    return true;
  }

  onEnd(): void {
    if (this.el) {
      for (const h of this.handlers) this.el.removeEventListener(h.type, h.fn);
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
    }
    this.handlers = [];
    this.el = null;
    this.endEditCb = null;
  }
}

/* ------------------------------------------------------------------ *
 * 进度滑块编辑器
 * ------------------------------------------------------------------ */

export class SliderEditor extends PopoverEditor {
  constructor(private cfg: { min: number; max: number; step: number; unit?: string; title?: string }) {
    super();
  }

  protected override title(): string {
    return this.cfg.title ?? '设置数值';
  }

  protected override buildBody(body: HTMLDivElement): void {
    const row = document.createElement('div');
    row.className = 'dsh-row';
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'dsh-range';
    input.min = String(this.cfg.min);
    input.max = String(this.cfg.max);
    input.step = String(this.cfg.step);
    const start = Number(this.value);
    input.value = String(Number.isFinite(start) ? start : this.cfg.min);
    const label = document.createElement('span');
    label.className = 'dsh-val';
    const render = () => {
      label.textContent = `${input.value}${this.cfg.unit ?? ''}`;
      this.value = Number(input.value);
    };
    input.addEventListener('input', render);
    render();
    row.append(input, label);
    body.appendChild(row);

    // 常用档位，10 万行批量改的时候比拖滑块快
    const quick = document.createElement('div');
    quick.style.cssText = 'display:flex;gap:6px;margin-top:10px;flex-wrap:wrap';
    for (const v of [0, 25, 50, 75, 100]) {
      if (v < this.cfg.min || v > this.cfg.max) continue;
      const b = document.createElement('button');
      b.className = 'dsh-btn';
      b.textContent = `${v}${this.cfg.unit ?? ''}`;
      b.onclick = () => {
        input.value = String(v);
        render();
      };
      quick.appendChild(b);
    }
    body.appendChild(quick);
  }

  protected override needsFooter(): boolean {
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * 星级编辑器
 * ------------------------------------------------------------------ */

export class RatingEditor extends PopoverEditor {
  constructor(private cfg: { max: number; title?: string }) {
    super();
  }

  protected override title(): string {
    return this.cfg.title ?? '设置星级';
  }

  protected override buildBody(body: HTMLDivElement): void {
    const row = document.createElement('div');
    row.className = 'dsh-row';
    row.style.gap = '4px';
    const starEls: HTMLSpanElement[] = [];
    const current = Number(this.value);

    const paint = (n: number) => {
      starEls.forEach((s, i) => s.setAttribute('data-on', i < n ? '1' : '0'));
    };

    for (let i = 1; i <= this.cfg.max; i++) {
      const s = document.createElement('span');
      s.className = 'dsh-star';
      s.textContent = '★';
      s.onmouseenter = () => paint(i);
      s.onclick = () => {
        this.value = i;
        // 星级点一下就该结束，不需要再点确定
        this.commit();
      };
      starEls.push(s);
      row.appendChild(s);
    }
    row.onmouseleave = () => paint(Number(this.value));
    paint(Number.isFinite(current) ? current : 0);
    body.appendChild(row);

    const clear = document.createElement('button');
    clear.className = 'dsh-btn';
    clear.textContent = '清空';
    clear.style.marginTop = '10px';
    clear.onclick = () => {
      this.value = null;
      this.commit();
    };
    body.appendChild(clear);
  }
}

/* ------------------------------------------------------------------ *
 * 多选标签编辑器
 * ------------------------------------------------------------------ */

export interface TagOption {
  value: string;
  label: string;
  color: string;
}

export class TagEditor extends PopoverEditor {
  private selected: string[] = [];

  constructor(private options: TagOption[], private titleText = '选择标签') {
    super();
  }

  protected override title(): string {
    return this.titleText;
  }

  protected override needsFooter(): boolean {
    return true;
  }

  protected override buildBody(body: HTMLDivElement): void {
    this.selected = Array.isArray(this.value) ? (this.value as string[]).slice() : [];
    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px';

    const render = () => {
      list.textContent = '';
      for (const opt of this.options) {
        const on = this.selected.includes(opt.value);
        const row = document.createElement('div');
        row.className = 'dsh-opt';
        row.setAttribute('data-on', on ? '1' : '0');
        const check = document.createElement('span');
        check.className = 'dsh-check';
        check.setAttribute('data-on', on ? '1' : '0');
        check.textContent = on ? '✓' : '';
        const dot = document.createElement('span');
        dot.className = 'dsh-dot';
        dot.style.background = opt.color;
        const label = document.createElement('span');
        label.textContent = opt.label;
        row.append(check, dot, label);
        row.onclick = () => {
          if (this.selected.includes(opt.value)) this.selected = this.selected.filter(v => v !== opt.value);
          else this.selected = [...this.selected, opt.value];
          render();
        };
        list.appendChild(row);
      }
      this.value = this.selected.slice();
    };
    render();
    body.appendChild(list);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:10px';
    const all = document.createElement('button');
    all.className = 'dsh-btn';
    all.textContent = '全选';
    all.onclick = () => {
      this.selected = this.options.map(o => o.value);
      render();
    };
    const none = document.createElement('button');
    none.className = 'dsh-btn';
    none.textContent = '清空';
    none.onclick = () => {
      this.selected = [];
      render();
    };
    actions.append(all, none);
    body.appendChild(actions);
  }
}

/* ------------------------------------------------------------------ *
 * 被联动规则拦下的编辑器
 * ------------------------------------------------------------------ */

/**
 * 当某个属性被联动规则置为「隐藏 / 只读」时，双击不应该静默无反应 ——
 * 那会让人以为是 bug。这个编辑器不修改任何值，只弹一条说明就结束，
 * getValue() 原样返回旧值，因此写回路径上是空操作。
 */
export class BlockedEditor implements IEditor {
  private original: unknown = null;

  constructor(private reason: string) {}

  onStart(ctx: EditContext): void {
    this.original = ctx.value;
    showToast(this.reason, 'warn');
    ctx.endEdit();
  }

  getValue(): unknown {
    return this.original;
  }

  onEnd(): void {
    /* 无 DOM 需要回收 */
  }

  validateValue(): boolean {
    return true;
  }
}

/* ------------------------------------------------------------------ *
 * 轻量 toast
 * ------------------------------------------------------------------ */

let toastHost: HTMLDivElement | null = null;
let toastTimer = 0;

export function showToast(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  injectStyle();
  if (!toastHost) {
    toastHost = document.createElement('div');
    toastHost.style.cssText = 'position:fixed;left:50%;bottom:34px;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none';
    document.body.appendChild(toastHost);
  }
  const el = document.createElement('div');
  const bg = kind === 'error' ? '#F53F3F' : kind === 'warn' ? '#FF7D00' : '#1D2129';
  el.style.cssText = `background:${bg};color:#fff;padding:8px 16px;border-radius:8px;font-size:13px;box-shadow:0 6px 20px rgba(0,0,0,.18);max-width:520px`;
  el.textContent = message;
  toastHost.appendChild(el);
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    el.style.transition = 'opacity .2s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 220);
  }, 2200);
}

/* ------------------------------------------------------------------ *
 * 注册
 * ------------------------------------------------------------------ */

import { register } from '@visactor/vtable';

let registered = false;

/** 幂等注册所有自定义编辑器（列定义里会用具体实例覆盖这些名字） */
export function registerEditors(): void {
  if (registered) return;
  registered = true;
  register.editor(EDITOR_NAMES.text, new InputEditor({}));
  register.editor(EDITOR_NAMES.date, new DateInputEditor({}));
  register.editor(EDITOR_NAMES.number, new NumberEditor({}));
  register.editor(EDITOR_NAMES.slider, new SliderEditor({ min: 0, max: 100, step: 5, unit: '%' }));
  register.editor(EDITOR_NAMES.rating, new RatingEditor({ max: 5 }));
  register.editor(EDITOR_NAMES.tags, new TagEditor([]));
  register.editor(EDITOR_NAMES.select, new ListEditor({ values: [] }));
  register.editor(EDITOR_NAMES.user, new ListEditor({ values: [] }));
}

export type { IEditor, RectProps, EditContext };
