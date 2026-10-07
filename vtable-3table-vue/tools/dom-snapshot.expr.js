/* 用于 docs 对照：把页面外壳的文本与布局 dump 成 JSON。
   用法：VT_EXPR_FILE=dom-snapshot.expr.js node tools/probe.mjs <url>  */
(() => {
  const norm = s => (s ?? '').replace(/\s+/g, ' ').trim();
  const t = sel => norm(document.querySelector(sel)?.textContent);
  const box = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  return {
    bar: t('.app-bar'),
    barButtons: [...document.querySelectorAll('.app-bar .btn')].map(e => `${norm(e.textContent)}${e.disabled ? '[disabled]' : ''}`),
    segs: [...document.querySelectorAll('.app-bar .seg')].map(e => `${norm(e.textContent)}${e.classList.contains('on') ? '[on]' : ''}`),
    scale: norm(document.querySelector('.app-bar .scale')?.textContent) + ' = ' + document.querySelector('.app-bar .scale select')?.value,
    dirtyBadge: t('.dirty-badge'),
    crumbs: t('.crumbs'),
    crumbChips: [...document.querySelectorAll('.crumbs .crumb')].map(e => norm(e.textContent)),
    panes: [...document.querySelectorAll('.pane')].map(p => ({
      hd: norm(p.querySelector('.pane-hd')?.textContent),
      tools: [...p.querySelectorAll('.pane-tools .btn')].map(e => `${norm(e.textContent)}${e.disabled ? '[disabled]' : ''}`),
      chips: [...p.querySelectorAll('.chips .chip')].map(e => `${e.className}|${norm(e.textContent)}`),
      emptyOverlay: getComputedStyle(p.querySelector('.empty-overlay')).display,
      box: box(p),
      bodyBox: box(p.querySelector('.pane-body')),
      canvas: (c => (c ? { w: c.width, h: c.height } : null))(p.querySelector('.pane-body canvas')),
    })),
    status: { text: t('.status-text'), degraded: t('.degraded-badge'), degradedShown: getComputedStyle(document.querySelector('.degraded-badge')).display },
    tables: document.querySelectorAll('.pane-body canvas').length,
  };
})()
