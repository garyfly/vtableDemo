/**
 * 10 万行性能基准。
 *
 * 三块：
 *   A. 滚动流畅度 —— 页内用 rAF 记录每帧间隔，同时从 CDP 灌真实滚轮事件，
 *      统计 FPS、p95 帧耗时、卡顿帧（>50ms）与 Long Task 总时长。
 *   B. 关键路径耗时 —— 导入 / 筛选 / 排序 / 全选 / 展开勾选 / 值域统计。
 *   C. 内存 —— JS 堆占用；并实测「如果把这 10 万行交给 Vue 响应式」要多付多少。
 *
 * 注意：headless Chrome 走的是软件光栅（没有 GPU），FPS 是**下限**，
 * 真机浏览器只会更好。
 *
 * 用法：node tools/bench.mjs [url]
 */

import { launch, sleep } from './cdp.mjs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5277/';
const ROWS = Number(new URL(URL_).searchParams.get('rows') ?? 100_000);
const LABEL = ROWS >= 10_000 ? (ROWS / 10_000) + ' 万' : String(ROWS);
const session = await launch();
const { send, evaluate, goto, waitFor, dispose, consoleErrors, pageErrors } = session;

const rows = [];
const add = (name, value, unit = '', note = '') => rows.push({ name, value, unit, note });

function table() {
  const w = Math.max(...rows.map(r => r.name.length));
  console.log('');
  for (const r of rows) {
    const v = typeof r.value === 'number' ? r.value.toFixed(r.value >= 100 ? 0 : 1) : r.value;
    console.log(`  ${r.name.padEnd(w)}  ${String(v).padStart(10)} ${r.unit.padEnd(6)} ${r.note}`);
  }
}

try {
  await goto(URL_);
  await waitFor('!!window.__vtp?.api?.ready', { label: '表格就绪', timeout: 40_000 });
  await sleep(2000);

  /* ============ A. 滚动流畅度 ============ */

  console.log(`===== A. 滚动流畅度（${LABEL}行，真实滚轮事件）=====`);

  await evaluate(`(() => {
    window.__frames = [];
    window.__longTasks = [];
    try {
      new PerformanceObserver(list => {
        for (const e of list.getEntries()) window.__longTasks.push(e.duration);
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) { /* 不支持就算了 */ }
    window.__rec = true;
    let last = performance.now();
    const tick = () => {
      if (!window.__rec) return;
      const now = performance.now();
      window.__frames.push(now - last);
      last = now;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);

  const box = await evaluate(`(() => { const r = document.querySelector('canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const WHEEL_EVENTS = 240;
  for (let i = 0; i < WHEEL_EVENTS; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 220, modifiers: 0 });
    if (i % 4 === 0) await sleep(8);
  }
  await sleep(500);
  await evaluate('window.__rec = false');

  const scrollStats = await evaluate(`(() => {
    const f = window.__frames.slice(3);
    const sorted = [...f].sort((a, b) => a - b);
    const sum = f.reduce((a, b) => a + b, 0);
    const long = window.__longTasks ?? [];
    return {
      frames: f.length,
      durationMs: sum,
      fps: f.length / (sum / 1000),
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
      max: sorted[sorted.length - 1],
      jank50: f.filter(d => d > 50).length,
      jank100: f.filter(d => d > 100).length,
      longTasks: long.length,
      longTaskMs: long.reduce((a, b) => a + b, 0),
      finalRow: window.__vtp.api.getScrollMetrics().startRow + 1,
      domNodes: document.querySelectorAll('#vtable-body-dom-container > *').length,
    };
  })()`);

  add('滚动帧数', scrollStats.frames, 'frame', `覆盖 ${Math.round(scrollStats.durationMs)}ms`);
  add('平均 FPS', scrollStats.fps, 'fps', 'headless 软件光栅，真机只会更高');
  add('帧间隔 p50', scrollStats.p50, 'ms');
  add('帧间隔 p95', scrollStats.p95, 'ms');
  add('最长帧', scrollStats.max, 'ms');
  add('卡顿帧 >50ms', scrollStats.jank50, 'frame');
  add('卡顿帧 >100ms', scrollStats.jank100, 'frame');
  add('Long Task', scrollStats.longTasks, '次', `总时长 ${scrollStats.longTaskMs.toFixed(0)}ms`);
  add('滚动结束位置', scrollStats.finalRow, '行', `DOM 覆盖层节点 ${scrollStats.domNodes} 个`);
  table();

  /* ============ B. 关键路径耗时 ============ */

  console.log('\n===== B. 关键路径耗时 =====');
  rows.length = 0;

  const timings = await evaluate(`(async () => {
    const a = window.__vtp.api;
    const t = a.table;
    const out = {};
    const view = a.getFilteredData();

    // 1) setRecords（把 10 万行重新灌给表格）
    let t0 = performance.now();
    t.setRecords(view);
    out.setRecords = performance.now() - t0;
    await new Promise(r => requestAnimationFrame(r));

    // 2) 只重画可视区（勾选态变化走的就是这条）
    t0 = performance.now();
    t.renderWithRecreateCells();
    out.repaint = performance.now() - t0;
    await new Promise(r => requestAnimationFrame(r));

    // 3) 全选（模式位翻转 + 一次可视区重画）
    a.clearSelection();
    t0 = performance.now();
    a.selectAll();
    out.selectAll = performance.now() - t0;

    // 4) 展开勾选行（全选态下展开一次 = 10 万长度数组，这是唯一 O(n) 的一步）
    t0 = performance.now();
    const checked = a.getCheckedRows();
    out.expandChecked = performance.now() - t0;
    out.checkedCount = checked.length;
    a.clearSelection();

    // 4) 值域统计（表头筛选弹窗打开时做的那次 O(n)）
    t0 = performance.now();
    const dom = window.__vtp.domainFor ? window.__vtp.domainFor('status') : null;
    out.domain = dom ? dom.ms : -1;

    // 5) 列筛选：单条件
    t0 = performance.now();
    a.setFilter('status', { kind: 'options', values: ['已完成'] });
    out.filter1 = performance.now() - t0;
    out.filter1Scan = a.getLastViewMs();
    out.filter1Rows = a.getFilteredData().length;

    // 6) 列筛选：三条件叠加
    t0 = performance.now();
    a.setFilter('owner', { kind: 'options', values: ['张三', '李四'] });
    a.setFilter('city', { kind: 'options', values: ['北京', '上海'] });
    out.filter3 = performance.now() - t0;
    out.filter3Scan = a.getLastViewMs();
    out.filter3Rows = a.getFilteredData().length;

    // 7) 关键字筛选（全表扫描 + 字符串匹配）
    a.clearFilters();
    t0 = performance.now();
    a.setFilter('customer', { kind: 'text', value: '华信', match: 'contains' });
    out.filterText = performance.now() - t0;
    out.filterTextScan = a.getLastViewMs();
    out.filterTextRows = a.getFilteredData().length;
    a.clearFilters();

    // 8) 排序 10 万行
    t0 = performance.now();
    a.setSort({ field: 'amount', order: 'desc' });
    out.sort = performance.now() - t0;
    a.setSort(null);

    return out;
  })()`);

  add('setRecords ' + LABEL + ' 行', timings.setRecords, 'ms', '列筛选 / 换数据都要走这一步（VTable 自己的开销）');
  add('可视区重画', timings.repaint, 'ms', '勾选态变化走的就是这条');
  add('全选（模式位 + 重画）', timings.selectAll, 'ms', `勾选 ${timings.checkedCount.toLocaleString()} 行`);
  add('展开全部勾选行', timings.expandChecked, 'ms', '只在真的调用 getCheckedRows() 时发生');
  add('列值域统计 ' + LABEL + ' 行', timings.domain, 'ms', '打开表头筛选弹窗时一次 O(n)');
  add('单列筛选：视图扫描', timings.filter1Scan, 'ms', `→ ${timings.filter1Rows.toLocaleString()} 行`);
  add('单列筛选：含 setRecords', timings.filter1, 'ms');
  add('三列叠加：视图扫描', timings.filter3Scan, 'ms', `→ ${timings.filter3Rows.toLocaleString()} 行`);
  add('三列叠加：含 setRecords', timings.filter3, 'ms');
  add('关键字筛选：视图扫描', timings.filterTextScan, 'ms', `→ ${timings.filterTextRows.toLocaleString()} 行`);
  add('关键字筛选：含 setRecords', timings.filterText, 'ms');
  add('排序 ' + LABEL + ' 行（含 setRecords）', timings.sort, 'ms');
  table();

  /* ============ C. 内存 ============ */

  console.log('\n===== C. 内存（JS 堆）=====');
  rows.length = 0;

  // 前面两轮的 GC 垃圾会把基线抬高，所以内存对照重新加载一次页面再测。
  await goto(URL_);
  await waitFor('!!window.__vtp?.api?.ready', { label: '重新加载后表格就绪', timeout: 40_000 });
  await sleep(2500);

  // performance.memory 是分桶刷新的：同一个 task 里连读两次拿到的是同一个值，
  // 所以每次测量都必须单独一次 evaluate（单独一个 task）+ 先 gc。
  const readHeap = async () => {
    await evaluate('typeof globalThis.gc === "function" && globalThis.gc()');
    await sleep(400);
    const a = await evaluate('performance.memory ? performance.memory.usedJSHeapSize : -1');
    await sleep(250);
    const b = await evaluate('performance.memory ? performance.memory.usedJSHeapSize : -1');
    return Math.min(a, b);
  };

  const limit = await evaluate('performance.memory ? performance.memory.jsHeapSizeLimit : -1');
  const baseline = await readHeap();
  add('堆占用（' + LABEL + '行原始数据 + 表格）', (baseline / 1048576) | 0, 'MB', `堆上限 ${((limit / 1048576) | 0)}MB，已 gc`);

  // 对照实验：同样这 10 万行交给 Vue 的 reactive()，并逐行读一遍（逼 Vue 给每行建 Proxy）。
  // 注意不能直接 reactive(window.__vtp.rows) —— 那个数组已经被组件 markRaw 过了，
  // reactive() 会原样返回（这正是「非响应式」的第一道保险），所以这里复制一份**未标记**的。
  const made = await evaluate(`(() => {
    const rows = window.__vtp.rows;
    const { reactive } = window.__vtp.vueReactive ?? {};
    if (!reactive) return false;
    const plain = Array.from(rows);
    const proxyArr = reactive(plain);
    let acc = 0;
    for (let i = 0; i < proxyArr.length; i++) {
      acc += String(proxyArr[i].orderNo).length + proxyArr[i].amount + proxyArr[i].progress;
    }
    window.__reactiveProbe = { proxyArr, acc };
    return true;
  })()`);
  const withProxy = made ? await readHeap() : baseline;
  if (made) {
    add('同一批数据改为 reactive()', (withProxy / 1048576) | 0, 'MB', '逐行读取一次，Vue 为每行建 Proxy');
    add('响应式多付的堆内存', ((withProxy - baseline) / 1048576).toFixed(1), 'MB', `≈ 基线的 ${(((withProxy - baseline) / Math.max(1, baseline)) * 100).toFixed(0)}%`);
  } else {
    add('响应式对照实验', '未启用', '', '页面没有暴露 reactive 探针');
  }

  // 内存只差几 MB，真正贵的是**读**：同样扫一遍 10 万行，走 Proxy 要多花多少时间
  const scan = await evaluate(`(() => {
    const rows = window.__vtp.rows;
    const proxyArr = window.__reactiveProbe?.proxyArr ?? null;
    const N = 6;
    const time = fn => { let best = Infinity; for (let k = 0; k < N; k++) { const t = performance.now(); fn(); best = Math.min(best, performance.now() - t); } return best; };
    const raw = time(() => { let n = 0; for (let i = 0; i < rows.length; i++) if (rows[i].status === '已完成') n++; return n; });
    if (!proxyArr) return { raw, proxy: -1 };
    const proxy = time(() => { let n = 0; for (let i = 0; i < proxyArr.length; i++) if (proxyArr[i].status === '已完成') n++; return n; });
    return { raw, proxy };
  })()`);
  add('扫一遍 ' + LABEL + ' 行（原始对象）', scan.raw, 'ms', '取 6 次最小值');
  if (scan.proxy >= 0) {
    add('扫一遍 ' + LABEL + ' 行（Proxy）', scan.proxy, 'ms', `慢 ${(scan.proxy / Math.max(0.01, scan.raw)).toFixed(1)}×`);
  }

  await evaluate('window.__reactiveProbe = null');
  const released = await readHeap();
  const gapMb = (released - baseline) / 1048576;
  add('对照实验释放后', (released / 1048576) | 0, 'MB', made ? (gapMb < 20 ? `回到基线附近（+${gapMb.toFixed(0)}MB）` : `比基线高 ${gapMb.toFixed(0)}MB —— 大堆下 GC 不一定立刻全回收`) : '');
  table();

  const errs = [...consoleErrors, ...pageErrors];
  console.log(`\n控制台：${errs.length ? errs.slice(0, 5).join(' | ') : '零 error / 零未捕获异常'}`);
} catch (err) {
  console.log(`基准异常：${err.stack ?? err.message}`);
  process.exitCode = 1;
} finally {
  dispose();
}
