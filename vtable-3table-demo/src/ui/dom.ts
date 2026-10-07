/**
 * 极简 DOM 工具。
 *
 * 这个页面刻意不引框架：整页只有「工具栏 + 三个表格面板 + 两个弹层」，
 * 用 60 行 helper 就够了，而且能保证 VTable 的 canvas 与 DOM 之间没有中间层，
 * 10 万行下的交互路径最短。
 */

export type Child = Node | string | number | null | undefined | false;

type Props = Record<string, unknown>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v as Partial<CSSStyleDeclaration>);
      else if (k === 'dataset' && typeof v === 'object') Object.assign(el.dataset, v as Record<string, string>);
      else if (k === 'html') el.innerHTML = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'value' && el instanceof HTMLInputElement) el.value = String(v);
      else if (k === 'checked' && el instanceof HTMLInputElement) el.checked = Boolean(v);
      else if (k === 'disabled') (el as HTMLButtonElement).disabled = Boolean(v);
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    parent.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
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

export interface PopoverHandle {
  el: HTMLElement;
  close(): void;
}

export interface AnchorRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** 通用浮层：点击外部关闭，Esc 关闭 */
export function openPopover(anchor: HTMLElement, content: HTMLElement, opts: { width?: number; align?: 'left' | 'right' } = {}): PopoverHandle {
  return openPopoverAt(anchor.getBoundingClientRect(), content, { ...opts, anchorEl: anchor });
}

/**
 * 同上，但锚点是一个矩形而不是 DOM 元素。
 * 表头筛选需要它：表头画在 canvas 上，根本没有对应的 DOM 节点。
 */
export function openPopoverAt(rect: AnchorRect, content: HTMLElement, opts: { width?: number; align?: 'left' | 'right'; anchorEl?: HTMLElement } = {}): PopoverHandle {
  const host = document.createElement('div');
  host.className = 'popover';
  if (opts.width) host.style.width = `${opts.width}px`;
  host.appendChild(content);
  document.body.appendChild(host);

  const width = opts.width ?? 320;
  const left = opts.align === 'right' ? Math.max(8, rect.right - width) : Math.min(rect.left, window.innerWidth - width - 8);
  host.style.left = `${left}px`;
  host.style.top = `${rect.bottom + 6}px`;

  requestAnimationFrame(() => {
    const r = host.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) {
      host.style.top = `${Math.max(8, rect.top - r.height - 6)}px`;
    }
    if (r.right > window.innerWidth - 8) {
      host.style.left = `${Math.max(8, window.innerWidth - r.width - 8)}px`;
    }
  });

  const onDown = (e: MouseEvent) => {
    const t = e.target as Node;
    if (!host.contains(t) && !opts.anchorEl?.contains(t)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close();
  };
  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    host.remove();
  }
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
  }, 0);

  return { el: host, close };
}

/** 居中模态框 */
export function openModal(title: string, body: HTMLElement, footer?: HTMLElement): { close(): void; body: HTMLElement } {
  const backdrop = h('div', { class: 'modal-backdrop' });
  const close = () => backdrop.remove();
  const dialog = h(
    'div',
    { class: 'modal' },
    h(
      'div',
      { class: 'modal-hd' },
      h('b', null, title),
      h('button', { class: 'icon-btn', onclick: close, title: '关闭' }, '✕')
    ),
    h('div', { class: 'modal-bd' }, body),
    footer ? h('div', { class: 'modal-ft' }, footer) : null
  );
  backdrop.appendChild(dialog);
  backdrop.addEventListener('mousedown', e => {
    if (e.target === backdrop) close();
  });
  document.body.appendChild(backdrop);
  return { close, body };
}
