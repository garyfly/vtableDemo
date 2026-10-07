/**
 * 规模曲线：同一套页面在 10 万 / 100 万 / 200 万 / 500 万行下的表现。
 *
 * 每个量级单独开一次页面，测：首屏就绪时间、堆占用、DOM 节点数、
 * 滚轮滚动 FPS、单列筛选扫描、全选、展开勾选行。
 *
 * 用法：node tools/scale.mjs [baseUrl] [rows,rows,...]
 */

import { launch, sleep } from './cdp.mjs';

const BASE = process.argv[2] ?? 'http://127.0.0.1:5277/';
const SIZES = (process.argv[3] ?? '100000,1000000,2000000').split(',').map(Number);

const out = [];

for (const n of SIZES) {
  const url = `${BASE}${BASE.includes('?') ? '&' : '?'}rows=${n}`;
  const session = await launch();
  const { send, evaluate, goto, waitFor, dispose, consoleErrors, pageErrors } = session;
  const t0 = Date.now();
  let row;
  try {
    await goto(url);
    await waitFor('!!window.__vtp?.api?.ready', { label: `${n} 行就绪`, timeout: 120_000 });
    // 等两帧，确保首屏画完
    await evaluate('new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))');
    const readyMs = Date.now() - t0;
    await sleep(1200);

    const base = await evaluate(`(() => ({
      heap: performance.memory ? performance.memory.usedJSHeapSize : -1,
      domNodes: document.querySelectorAll('#vtable-body-dom-container > *').length,
      total: document.querySelector('[data-stat="total"]')?.textContent ?? '',
    }))()`);

    // 筛选扫描
    const scan = await evaluate(`(() => {
      const a = window.__vtp.api;
      const t = performance.now();
      a.setFilter('status', { kind: 'options', values: ['已完成'] });
      const ms = performance.now() - t;
      const viewMs = a.getLastViewMs();
      const kept = a.getFilteredData().length;
      a.clearFilters();
      return { ms, viewMs, kept };
    })()`);
    await sleep(800);

    // 全选 + 展开
    const sel = await evaluate(`(() => {
      const a = window.__vtp.api;
      let t = performance.now();
      a.selectAll();
      const selectAllMs = performance.now() - t;
      t = performance.now();
      const rows = a.getCheckedRows();
      const expandMs = performance.now() - t;
      a.clearSelection();
      return { selectAllMs, expandMs, count: rows.length };
    })()`);
    await sleep(600);

    // 滚轮滚动 3 秒，页内记帧
    await evaluate(`(() => {
      window.__f = [];
      window.__rec = true;
      let last = performance.now();
      const tick = () => { if (!window.__rec) return; const now = performance.now(); window.__f.push(now - last); last = now; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })()`);
    const box = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    const until = Date.now() + 3200;
    while (Date.now() < until) {
      for (let i = 0; i < 8; i++) await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 260, modifiers: 0 });
      await sleep(10);
    }
    await sleep(300);
    const fps = await evaluate(`(() => {
      window.__rec = false;
      const f = window.__f.slice(3);
      const sum = f.reduce((a, b) => a + b, 0);
      const sorted = [...f].sort((a, b) => a - b);
      return { frames: f.length, fps: f.length / (sum / 1000), p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1], jank: f.filter(d => d > 50).length };
    })()`);

    const heapAfter = await evaluate('performance.memory ? performance.memory.usedJSHeapSize : -1');
    const errs = [...consoleErrors, ...pageErrors];
    row = {
      rows: n,
      readyMs,
      heapMB: Math.round(Math.max(base.heap, heapAfter) / 1048576),
      domNodes: base.domNodes,
      fps: fps.fps,
      p95: fps.p95,
      maxFrame: fps.max,
      jank: fps.jank,
      scanMs: scan.viewMs,
      filterTotalMs: scan.ms,
      selectAllMs: sel.selectAllMs,
      expandMs: sel.expandMs,
      errors: errs.length,
    };
  } catch (err) {
    row = { rows: n, failed: String(err.message).slice(0, 90) };
  } finally {
    dispose();
  }
  out.push(row);
  const r = out[out.length - 1];
  console.log(`— ${n.toLocaleString('en-US')} 行 —`);
  console.log(r.failed ? `   失败：${r.failed}` : `   首屏 ${r.readyMs}ms · 堆 ${r.heapMB}MB · DOM ${r.domNodes} 个 · ${r.fps.toFixed(1)} FPS (p95 ${r.p95.toFixed(1)}ms, 最长 ${r.maxFrame.toFixed(1)}ms, >50ms ${r.jank} 帧) · 筛选扫描 ${r.scanMs.toFixed(1)}ms · 全选 ${r.selectAllMs.toFixed(1)}ms · 展开 ${r.expandMs.toFixed(1)}ms · error ${r.errors}`);
}

console.log('\n| 行数 | 首屏就绪 | 堆占用 | 覆盖层 DOM | 滚动 FPS | p95 帧 | >50ms 帧 | 筛选扫描 | 全选 | 展开勾选行 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of out) {
  if (r.failed) {
    console.log(`| ${r.rows.toLocaleString('en-US')} | 失败：${r.failed} | | | | | | | | |`);
    continue;
  }
  console.log(
    `| ${r.rows.toLocaleString('en-US')} | ${r.readyMs}ms | ${r.heapMB}MB | ${r.domNodes} | ${r.fps.toFixed(1)} | ${r.p95.toFixed(1)}ms | ${r.jank} | ${r.scanMs.toFixed(1)}ms | ${r.selectAllMs.toFixed(0)}ms | ${r.expandMs.toFixed(0)}ms |`
  );
}
