/**
 * 无人值守的渲染回归探针。
 *
 * 用 Chrome DevTools Protocol 打开页面，读取页面的真实状态并做断言：
 *  1. 三个面板都建出了 canvas，且 canvas 上真的画了东西（像素墨迹比例）；
 *  2. 每个表格的列标题、单元格值能通过 VTable 的公开 API 读出来；
 *  3. 三级联动的行数收敛方向正确（父级聚焦后子级行数应当减少）；
 *  4. 控制台没有 error / 未捕获异常。
 *
 * 用法：node tools/probe.mjs [url]
 * 前置：npm run dev 已在 5273 端口跑着。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5273/';
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

function findChrome() {
  const hit = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!hit) throw new Error('找不到 Chrome/Edge 可执行文件');
  return hit;
}

async function main() {
  const profile = mkdtempSync(join(tmpdir(), 'vt-probe-'));
  const chrome = spawn(
    findChrome(),
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--disable-extensions',
      '--remote-allow-origins=*',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--window-size=1680,1020',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const portFile = join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(120);
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  }
  if (!port) throw new Error('Chrome 没有暴露调试端口');

  /* ---- 找到页面 target ---- */
  let wsUrl = '';
  for (let i = 0; i < 40 && !wsUrl; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error('没有找到 page target');

  /* ---- 极简 CDP 客户端 ---- */
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  const consoleErrors = [];
  const pageErrors = [];

  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(`${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
      consoleErrors.push(`[${msg.params.type}] ${msg.params.args.map(a => a.value ?? a.description ?? a.type).join(' ')}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push(d.exception?.description ?? d.text);
    }
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 60_000);
    });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  await send('Page.navigate', { url: URL_ });

  /* ---- 等应用把 window.__vtDemo 挂上去 ---- */
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    await sleep(400);
    try {
      const r = await send('Runtime.evaluate', { expression: 'Boolean(window.__vtDemo && document.querySelectorAll(".pane-body canvas").length === 3)', returnByValue: true });
      ready = r.result?.value === true;
    } catch {
      /* 页面还在导航中 */
    }
  }
  if (!ready) throw new Error('等待页面就绪超时（__vtDemo 未出现）');

  const evalJson = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`页面内求值失败：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  };

  // 让首屏的聚焦联动跑完
  await sleep(1500);

  /* 临时调试：VT_EXPR 给出表达式时直接求值并打印，跳过断言。
     表达式较长时用 VT_EXPR_FILE 指向一个文件，免得被 shell 的引号规则咬到。 */
  const debugExpr = process.env.VT_EXPR_FILE
    ? readFileSync(process.env.VT_EXPR_FILE, 'utf8')
    : process.env.VT_EXPR;
  if (debugExpr) {
    console.log(JSON.stringify(await evalJson(debugExpr), null, 2));
    ws.close();
    chrome.kill();
    process.exit(0);
  }

  const SNAPSHOT = `(() => {
    const { store, panels } = window.__vtDemo;
    const ink = (canvas) => {
      const ctx = canvas.getContext('2d');
      const { width: w, height: h } = canvas;
      if (!w || !h) return { w, h, ratio: 0 };
      const d = ctx.getImageData(0, 0, w, h).data;
      let nonWhite = 0, n = 0;
      for (let i = 0; i < d.length; i += 4 * 29) {
        n++;
        if (d[i] < 246 || d[i + 1] < 246 || d[i + 2] < 246) nonWhite++;
      }
      return { w, h, ratio: +(nonWhite / n).toFixed(4) };
    };
    return {
      panels: panels.map((p) => {
        const t = p.linked.table;
        const canvas = p.el.querySelector('.pane-body canvas');
        const headers = [];
        for (let c = 0; c < Math.min(t.colCount, 14); c++) {
          const v = t.getCellValue(c, 0);
          headers.push(Array.isArray(v) ? v.map(x => x.text ?? '').join('') : String(v ?? ''));
        }
        const rt = store.entities[p.entity];
        return {
          entity: p.entity,
          colCount: t.colCount,
          rowCount: t.rowCount,
          headerLevelCount: t.columnHeaderLevelCount,
          headers,
          canvas: canvas ? ink(canvas) : null,
          rows: rt.rows.length,
          total: rt.total,
          selected: rt.selection.size,
          focused: rt.focusedId,
          queryMs: +rt.lastQueryMs.toFixed(1),
        };
      }),
      mode: store.mode,
      dirty: store.dirtyCount(),
      status: document.querySelector('.status-text')?.textContent ?? '',
      crumbs: [...document.querySelectorAll('.crumbs .crumb')].map(e => e.textContent.replace(/\\s+/g, ' ').trim()),
      overlays: [...document.querySelectorAll('.empty-overlay')].map(e => getComputedStyle(e).display),
      fatal: Boolean(document.querySelector('.fatal')),
    };
  })()`;

  /* ---------------- 阶段 A：首屏（自动聚焦第一个项目 / 第一个任务） ---------------- */
  const A = await evalJson(SNAPSHOT);

  /* ---------------- 阶段 B：清除聚焦 → 全量 10 万级 ---------------- */
  const Bms = await evalJson(`(async () => {
    const s = window.__vtDemo.store;
    const t0 = performance.now();
    await s.clearFocus('project');
    return +(performance.now() - t0).toFixed(0);
  })()`);
  await sleep(1200);
  const B = await evalJson(SNAPSHOT);

  /* ---------------- 阶段 D：10 万行全选（必须是 O(1)） ---------------- */
  const D = await evalJson(`(() => {
    const s = window.__vtDemo.store;
    const rt = s.entities.task;
    const t0 = performance.now();
    rt.selection.selectAll();
    const ms = +(performance.now() - t0).toFixed(2);
    s.notifySelection('task');
    return { ms, size: rt.selection.size, rows: rt.rows.length, all: rt.selection.isAllSelected, header: rt.selection.headerState };
  })()`);
  await sleep(1200);

  /* ---------------- 阶段 E：10 万行关键字筛选 ---------------- */
  const E = await evalJson(`(async () => {
    const s = window.__vtDemo.store;
    const rt = s.entities.task;
    const before = rt.rows.length;
    const sample = rt.rows[Math.min(7, rt.rows.length - 1)];
    const kw = String(sample.title ?? sample.taskNo ?? '').slice(0, 4);
    const t0 = performance.now();
    await s.setKeyword('task', kw);
    return { kw, before, rows: rt.rows.length, total: rt.total, ms: +(performance.now() - t0).toFixed(0) };
  })()`);
  await sleep(800);

  /* ---------------- 阶段 E2：条件筛选 + 排序 ---------------- */
  const E2 = await evalJson(`(async () => {
    const s = window.__vtDemo.store;
    const rt = s.entities.task;
    const before = rt.rows.length;
    await s.setKeyword('task', '');
    await s.setConditions('task', [{ id: 'probe1', field: 'stage', operator: 'in', value: ['blocked'] }]);
    const blocked = rt.rows.length;
    const onlyBlocked = rt.rows.every(r => r.stage === 'blocked');
    await s.setSort('task', { field: 'progress', order: 'desc' });
    let sorted = true;
    for (let i = 1; i < Math.min(rt.rows.length, 200); i++) if (Number(rt.rows[i - 1].progress) < Number(rt.rows[i].progress)) sorted = false;
    await s.resetQuery('task');
    return { before, blocked, onlyBlocked, sorted, restored: rt.rows.length };
  })()`);
  await sleep(800);

  /* ---------------- 阶段 C：重新逐级下钻 ---------------- */
  const Cms = await evalJson(`(async () => {
    const s = window.__vtDemo.store;
    s.entities.task.selection.clear();
    s.entities.execution.selection.clear();
    const t0 = performance.now();
    await s.focusRow('project', s.entities.project.rows[0].id);
    const t = s.entities.task.rows[0];
    if (t) await s.focusRow('task', t.id);
    return +(performance.now() - t0).toFixed(0);
  })()`);
  await sleep(900);
  const C = await evalJson(SNAPSHOT);

  /* ---------------- 阶段 F：联动派生 + 脏标记 + 撤销 ---------------- */
  const F = await evalJson(`(() => {
    const s = window.__vtDemo.store;
    const rt = s.entities.task;
    const row = rt.rows.find(r => r.stage !== 'delivered');
    const id = row.id;
    const before = { stage: row.stage, progress: row.progress, dirty: s.dirtyCount('task') };
    s.editCell('task', id, 'stage', 'delivered', '探针：改为已交付');
    const after = { stage: row.stage, progress: row.progress, dirty: s.dirtyCount('task'), fields: [...s.dirtyFieldsOf('task', id)] };
    const canUndo = s.canUndo;
    s.undo();
    const undone = { stage: row.stage, progress: row.progress, dirty: s.dirtyCount('task') };
    return { id, before, after, canUndo, undone };
  })()`);
  await sleep(500);

  /* ---------------- 阶段 G：查看态 ---------------- */
  const G = await evalJson(`(() => {
    const s = window.__vtDemo.store;
    s.setMode('view');
    const t = window.__vtDemo.panels[1].linked.table;
    const hasEditor = t.isHasEditorDefine(3, 2);
    s.setMode('edit');
    const hasEditorEdit = t.isHasEditorDefine(3, 2);
    return { view: hasEditor, edit: hasEditorEdit };
  })()`);
  await sleep(400);

  /* ---------------- 阶段 H：手写 DOM 工具栏冒烟 ---------------- */
  const H = await evalJson(`(async () => {
    const pane = document.querySelector('.pane-task');
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const probe = async (text, sel) => {
      const el = [...pane.querySelectorAll('.pane-tools .btn')].find(e => e.textContent.trim() === text);
      if (!el) { out[text] = '找不到按钮'; return; }
      el.click();
      await wait(40); // openPopover 的 Esc 监听是 setTimeout(0) 挂上的，必须等一拍
      out[text] = document.querySelector(sel) ? 'ok' : '没有弹出 ' + sel;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(40);
    };
    await probe('筛选', '.filter-panel');
    await probe('列设置', '.col-list');
    await probe('联动规则', '.rule-list');
    out.leftover = Boolean(document.querySelector('.popover'));
    return out;
  })()`);
  await sleep(200);

  /* 批量操作弹窗需要先有选中行 */
  const H2 = await evalJson(`(() => {
    const s = window.__vtDemo.store;
    const rt = s.entities.task;
    rt.selection.setChecked(rt.rows[0].id, true);
    rt.selection.setChecked(rt.rows[1].id, true);
    s.notifySelection('task');
    return { selected: rt.selection.size };
  })()`);
  await sleep(400);
  const H3 = await evalJson(`(() => {
    const pane = document.querySelector('.pane-task');
    const out = {};
    const bulk = [...pane.querySelectorAll('.pane-tools .btn')].find(e => e.textContent.trim() === '批量操作');
    out.buttonDisabled = bulk ? bulk.disabled : 'missing';
    if (bulk && !bulk.disabled) {
      bulk.click();
      const modal = document.querySelector('.modal');
      out.modal = Boolean(modal);
      out.modalTitle = modal ? modal.querySelector('.modal-hd b')?.textContent : '';
      out.hasOpRow = Boolean(modal && modal.querySelector('.op-row .op-item'));
      out.hasSummary = Boolean(modal && modal.querySelector('.bulk-summary'));
      if (modal) modal.querySelector('.modal-hd .icon-btn')?.click();
      out.closed = !document.querySelector('.modal');
    }
    // 顶部工具栏的使用说明
    const help = [...document.querySelectorAll('.app-bar .btn')].find(e => e.textContent.trim() === '使用说明');
    help?.click();
    out.help = Boolean(document.querySelector('.help-list'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return out;
  })()`);
  await sleep(300);

  /* ---------------- 阶段 I：编辑器往返（真实 DOM 编辑器 → VTable → store） ---------------- */
  const I = await evalJson(`(async () => {
    const s = window.__vtDemo.store;
    const t = window.__vtDemo.panels[1].linked.table;
    const out = {};
    const wait = (ms) => new Promise(r => setTimeout(r, ms));

    // 星级列（第 6 列）在编辑态应当弹出 .dsh-pop
    const starCol = 6;
    let row = -1;
    for (let r = 1; r <= 25 && row < 0; r++) {
      t.startEditCell(starCol, r);
      await wait(30);
      if (document.querySelector('.dsh-pop .dsh-star')) row = r;
      else t.cancelEditCell();
    }
    out.starRow = row;
    if (row < 0) { out.error = '没有找到可编辑的星级单元格'; return out; }

    const rec = t.getCellOriginRecord(starCol, row);
    const before = Number(rec.priority);
    const target = before === 4 ? 5 : 4;
    const stars = [...document.querySelectorAll('.dsh-pop .dsh-star')];
    out.starCount = stars.length;
    stars[target - 1].click();
    await wait(400);
    out.before = before;
    out.after = Number(rec.priority);
    out.target = target;
    out.popClosed = !document.querySelector('.dsh-pop');
    out.dirty = s.dirtyCount('task');

    // 撤销这一笔，保持后面的断言干净
    s.undo();
    await wait(300);
    out.undone = Number(rec.priority);

    // Esc 取消：滑块编辑器改了值但按 Esc，数据不应变化
    const progCol = 7;
    let prow = -1;
    for (let r = 1; r <= 25 && prow < 0; r++) {
      t.startEditCell(progCol, r);
      await wait(30);
      if (document.querySelector('.dsh-pop .dsh-range')) prow = r;
      else t.cancelEditCell();
    }
    out.sliderRow = prow;
    if (prow >= 0) {
      const prec = t.getCellOriginRecord(progCol, prow);
      const pbefore = Number(prec.progress);
      const range = document.querySelector('.dsh-pop .dsh-range');
      range.value = '7';
      range.dispatchEvent(new Event('input', { bubbles: true }));
      await wait(60);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await wait(250);
      out.sliderBefore = pbefore;
      out.sliderAfter = Number(prec.progress);
      out.sliderPopClosed = !document.querySelector('.dsh-pop');
    }
    return out;
  })()`);
  await sleep(400);

  /* ---------------- 阶段 J：真实画布点击（合成 pointer 事件） ----------------
     要点（都是踩出来的）：
       * 只发 pointerdown + pointerup，不要再补 MouseEvent('click')：vrender 的
         normalizeToPointerData 会丢掉纯 MouseEvent，多这一下反而让本次点击失效。
       * 必须点在单元格"中心"：贴着列边界会命中 VTable 的列宽拖拽区，
         isResizeCol() 变真 → shouldSkipClickCell → click_cell 根本不发。
       * 画布只有 ~168px 高，只有前 3 行真的在可视区内，点第 5 行会落到下面的 DIV 上。
  */
  const J = await evalJson(`(async () => {
    const s = window.__vtDemo.store;
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const out = {};
    const panelOf = (e) => window.__vtDemo.panels.find(p => p.entity === e);
    let pid = 100;

    // 把某一列横向滚进可视区。
    // 三张表左右并排后每屏只有 ~550px，靠右的列默认在可视区外，
    // getCellRelativeRect 会给出负数，点上去自然什么都不会发生。
    const scrollColIntoView = async (entity, col, row = 1) => {
      const t = panelOf(entity).linked.table;
      const c = panelOf(entity).el.querySelector('.pane-body canvas');
      const cr = c.getBoundingClientRect();
      const abs = t.getCellRect(col, row);
      if (abs.right > cr.width || abs.left < 0) {
        t.setScrollLeft(Math.max(0, abs.right - cr.width + 12));
        await wait(350);
      }
      return t.getCellRelativeRect(col, row);
    };

    const clickCell = (entity, col, row) => {
      const t = panelOf(entity).linked.table;
      const c = panelOf(entity).el.querySelector('.pane-body canvas');
      const cr = c.getBoundingClientRect();
      // getCellRelativeRect = 视口坐标（含横向滚动偏移）；getCellRect 是内容坐标，会点偏
      const b = t.getCellRelativeRect(col, row);
      const x = cr.left + (b.left + b.right) / 2, y = cr.top + (b.top + b.bottom) / 2;
      if (x < cr.left || x > cr.right || y < cr.top || y > cr.bottom) {
        return 'out-of-canvas(' + Math.round(x) + ',' + Math.round(y) + ')';
      }
      const B = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window };
      const id = pid++;
      c.dispatchEvent(new PointerEvent('pointerdown', { ...B, pointerId: id, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }));
      c.dispatchEvent(new PointerEvent('pointerup', { ...B, pointerId: id, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 }));
      return null;
    };

    /* 1) 项目表：点第 2 行的标题格 → 任务表应联动收敛 */
    s.clearFocus('project');
    await wait(800);
    const projTable = panelOf('project').linked.table;
    const projRecord = projTable.getCellOriginRecord(3, 2);
    out.cascade = { clickedId: projRecord.id, beforeTasks: s.entities.task.rows.length, err: clickCell('project', 3, 2) };
    await wait(900);
    out.cascade.afterFocused = s.entities.project.focusedId;
    out.cascade.afterTasks = s.entities.task.rows.length;
    out.cascade.allBelongToParent = s.entities.task.rows.every(r => r.projectId === projRecord.id);

    /* 2) 任务表：点选择列的复选框 → 只勾中那一行 */
    s.entities.task.selection.clear();
    s.notifySelection('task');
    await wait(300);
    const taskTable = panelOf('task').linked.table;
    const cbRecord = taskTable.getCellOriginRecord(1, 3);
    out.checkbox = { err: clickCell('task', 1, 3) };
    await wait(400);
    out.checkbox.size = s.entities.task.selection.size;
    out.checkbox.rowChecked = s.entities.task.selection.has(cbRecord.id);
    out.checkbox.otherChecked = s.entities.task.rows.filter(r => r.id !== cbRecord.id && s.entities.task.selection.has(r.id)).length;
    clickCell('task', 1, 3);
    await wait(400);
    out.checkbox.afterSecondClick = s.entities.task.selection.size;

    /* 3) 任务表：点「需要审批」开关 → 值翻转 + 后续属性被联动清空 */
    const swCol = 11, swRow = 1;
    await scrollColIntoView('task', swCol, swRow); // 三屏并排后这列在可视区外
    const swRecord = taskTable.getCellOriginRecord(swCol, swRow);
    const swId = swRecord.id;
    out.switchClick = { id: swId, before: { needApproval: swRecord.needApproval, approver: swRecord.approver, dirty: s.dirtyCount('task') }, err: clickCell('task', swCol, swRow) };
    await wait(700);
    out.switchClick.after = { needApproval: swRecord.needApproval, approver: swRecord.approver, dirty: s.dirtyCount('task') };
    out.switchClick.status = s.statusText;
    // 开关本身 + 被联动清空的「审批人」都应当记为未保存
    out.switchClick.dirtyFields = { needApproval: s.isDirtyCell('task', swId, 'needApproval'), approver: s.isDirtyCell('task', swId, 'approver') };

    /* 4) 明细表：点一行 → 聚焦到该明细（末级只聚焦，不再有下级） */
    const execTable = panelOf('execution').linked.table;
    if (execTable.rowCount > 1) {
      const exRecord = execTable.getCellOriginRecord(3, 1);
      out.execFocus = { err: clickCell('execution', 3, 1), expected: exRecord ? exRecord.id : null };
      await wait(500);
      out.execFocus.focused = s.entities.execution.focusedId;
    }
    return out;
  })()`);
  await sleep(500);

  /* ---------------- 阶段 K：开关类属性对后续属性的显隐 / 只读控制 ---------------- */
  const K = await evalJson(`(() => {
    const { evaluateRowState, schemas } = window.__vtDemo;
    const s = window.__vtDemo.store;
    const pick = (entity, pred) => s.entities[entity].rows.find(pred);
    const stateOf = (entity, row) => {
      const m = evaluateRowState(schemas[entity], row);
      const o = {};
      for (const [k, v] of m) o[k] = { visible: v.visible, editable: v.editable, required: v.required };
      return o;
    };
    const out = {};

    // task：需要审批 = false → approver 隐藏且只读
    const off = pick('task', r => r.needApproval === false) || s.entities.task.rows[0];
    out.approvalOff = { row: { needApproval: off.needApproval }, state: stateOf('task', off) };
    const on = pick('task', r => r.needApproval === true);
    out.approvalOn = on ? { row: { needApproval: on.needApproval }, state: stateOf('task', on) } : null;

    // project：自动同步 = false → syncPolicy 隐藏
    const ps = pick('project', r => r.autoSync === false) || s.entities.project.rows[0];
    out.syncOff = { row: { autoSync: ps.autoSync }, state: stateOf('project', ps) };

    // task：已交付 → 进度只读（值锁 100）
    const delivered = pick('task', r => r.stage === 'delivered');
    out.delivered = delivered ? { row: { stage: delivered.stage, progress: delivered.progress }, state: stateOf('task', delivered) } : null;

    // execution：不计费 → rate / amount 隐藏；计费 → 可见但由规则派生
    const noBill = pick('execution', r => r.billable === false);
    out.noBillable = noBill ? { row: { billable: noBill.billable }, state: stateOf('execution', noBill) } : null;
    const bill = pick('execution', r => r.billable === true);
    out.billable = bill ? { row: { billable: bill.billable, hours: bill.hours, rate: bill.rate, amount: bill.amount }, state: stateOf('execution', bill) } : null;

    // 规则表本身
    out.ruleCounts = { project: schemas.project.rules.length, task: schemas.task.rules.length, execution: schemas.execution.rules.length };
    return out;
  })()`);

  /* ---------------- 阶段 L：数据源告警在界面上的呈现 ---------------- */
  const L = await evalJson(`(() => {
    const badge = document.querySelector('.degraded-badge');
    return {
      exists: Boolean(badge),
      shown: badge ? badge.classList.contains('on') : null,
      text: badge ? badge.textContent : '',
      storeDegraded: window.__vtDemo.store.degraded,
      sourceKind: window.__vtDemo.sourceMode,
    };
  })()`);

  /* ---------------- 阶段 M：三屏并排 + 表头列筛选 ---------------- */
  const M = await evalJson(`(async () => {
    const P = e => window.__vtDemo.panels.find(p => p.entity === e);
    const s = window.__vtDemo.store;
    const wait = ms => new Promise(r => setTimeout(r, ms));
    s.clearFocus('project');
    await wait(600);

    const panel = P('task');
    const t = panel.linked.table;
    const c = panel.el.querySelector('.pane-body canvas');
    const cr = c.getBoundingClientRect();
    const out = {};

    out.panes = [...document.querySelectorAll('.pane')].map(p => {
      const r = p.getBoundingClientRect();
      return { entity: p.dataset.entity, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    });

    const clickAt = async (x, y) => {
      const B = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window };
      const id = Math.floor(Math.random() * 1e5) + 1000;
      c.dispatchEvent(new PointerEvent('pointerdown', { ...B, pointerId: id, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }));
      c.dispatchEvent(new PointerEvent('pointerup', { ...B, pointerId: id, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 }));
      await wait(90);
    };
    const colOf = f => { for (let i = 0; i < t.colCount; i++) if (t.getHeaderField(i, 0) === f) return i; return -1; };
    const clickHeader = async f => {
      const col = colOf(f);
      // 前面的阶段可能把表横向滚走了，先把这一列拉回可视区（冻结列宽 102）
      let b = t.getCellRelativeRect(col, 0);
      if (b.left < 102 || b.right > cr.width) {
        t.setScrollLeft(Math.max(0, t.getScrollLeft() + b.left - 118));
        await wait(400);
        b = t.getCellRelativeRect(col, 0);
      }
      await clickAt(cr.left + (b.left + b.right) / 2, cr.top + (b.top + b.bottom) / 2);
      await wait(700);
    };

    // 三屏并排后每屏只有 ~553px，「阶段」列默认在可视区外，先藏掉前面两个宽列
    panel.linked.setHiddenFields(new Set(['taskNo', 'title']));
    await wait(700);

    await clickHeader('stage');
    const pop = document.querySelector('.col-filter');
    const itemEls = pop ? [...pop.querySelectorAll('.cf-item')] : [];
    out.header = {
      popupOpened: Boolean(pop),
      popupTitle: pop ? pop.querySelector('.cf-hd b').textContent : null,
      sub: pop ? pop.querySelector('.cf-sub').textContent : null,
      items: itemEls.map(el => ({ label: el.querySelector('.cf-item-label').textContent, n: el.querySelector('.cf-item-n').textContent, on: el.classList.contains('on') })),
      showAllValue: itemEls.length >= 3,
      summary: pop ? pop.querySelector('.cf-count').textContent : null,
    };

    const before = s.entities.task.rows.length;
    const idx = out.header.items.findIndex(i => Number(String(i.n).replace(/,/g, '')) > 0);
    out.pickedLabel = idx >= 0 ? out.header.items[idx].label : null;
    if (idx >= 0 && pop) {
      pop.querySelectorAll('.cf-item input')[idx].click();
      await wait(200);
      [...pop.querySelectorAll('.cf-ft .btn')].find(b => b.textContent === '确定').click();
      await wait(1600);
    }
    const cond = s.columnFilterOf('task', 'stage');
    out.apply = {
      before,
      after: s.entities.task.rows.length,
      cond: cond ? { field: cond.field, operator: cond.operator, value: cond.value, id: cond.id } : null,
      allMatch: Boolean(cond && Array.isArray(cond.value) && s.entities.task.rows.length > 0 && s.entities.task.rows.every(r => cond.value.map(String).includes(String(r.stage)))),
      popupClosed: !document.querySelector('.col-filter'),
    };

    await clickHeader('stage');
    const pop2 = document.querySelector('.col-filter');
    out.reopen = {
      pickedBack: pop2 ? [...pop2.querySelectorAll('.cf-item')].some(el => el.classList.contains('on')) : false,
      summary: pop2 ? pop2.querySelector('.cf-count').textContent : null,
    };
    if (pop2) pop2.querySelector('.cf-ft .btn').click(); // 清除本列筛选
    await wait(1500);
    out.cleared = { cond: s.columnFilterOf('task', 'stage') ?? null, rows: s.entities.task.rows.length };

    // 文本列走的是另一条分支：操作符 + 输入框
    // （先把上面为了腾出可视区而藏掉的列放回来）
    panel.linked.setHiddenFields(new Set());
    await wait(500);
    await clickHeader('title');
    const pop3 = document.querySelector('.col-filter');
    out.text = {
      ops: pop3 ? [...pop3.querySelectorAll('.cf-form select option')].map(o => o.textContent) : [],
      hasInput: Boolean(pop3 && pop3.querySelector('.cf-vals input')),
      hasList: Boolean(pop3 && pop3.querySelector('.cf-list')),
    };
    if (pop3) pop3.querySelector('.cf-hd .icon-btn').click();
    await wait(300);

    return out;
  })()`);

  const Z = await evalJson(SNAPSHOT);

  const out = Z;
  const report = { initial: A, full: B, selectAll: D, filter: E, filterAndSort: E2, drilled: C, linkage: F, modeSwitch: G, toolbar: { ...H, ...H2, ...H3 }, editors: I, clicks: J, fieldRules: K, layout: M.panes, columnFilter: { header: M.header, apply: M.apply, reopen: M.reopen, cleared: M.cleared, text: M.text }, timingsMs: { unFocus: Bms, drillDown: Cms } };

  /* ---- 断言 ---- */
  const checks = [];
  const push = (ok, label, detail = '') => checks.push({ ok, label, detail });
  const P = s => s.panels;

  push(!A.fatal, '页面没有进入兜底错误页');
  push(P(A).length === 3, '三张表都挂载了', `${P(A).length}`);
  for (const p of P(A)) {
    push(p.canvas !== null && p.canvas.ratio > 0.02, `[${p.entity}] canvas 上确实画了内容（首屏）`, `墨迹 ${(p.canvas?.ratio * 100).toFixed(1)}% @ ${p.canvas?.w}x${p.canvas?.h}`);
    push(p.headers.length > 5 && p.headers.some(h => h.length > 0), `[${p.entity}] 列标题可读`, JSON.stringify(p.headers.slice(0, 12)));
  }
  push(P(A)[0].headers.filter(Boolean).length >= 11, '每个数据列都由独立小组件承载（≥11 个属性列）', `${P(A)[0].headers.filter(Boolean).length} 列`);
  push(P(A)[1].rowCount > 1 && P(A)[1].rows === 50, '首屏：点项目后任务表收敛为该项目下的 50 条', `任务 ${P(A)[1].rows}`);
  push(P(A)[2].rows > 0, '首屏：点任务后明细表有数据', `明细 ${P(A)[2].rows}`);

  const fullT = P(B).map(p => p.rows);
  push(B.panels[1].rows === 100000, '清除聚焦后任务表拿下全量 10 万行', `任务 ${fullT[1]}`);
  push(B.panels[2].rows === 40000, '清除聚焦后明细表拿下全量 4 万行', `明细 ${fullT[2]}`);
  push(B.panels[1].rowCount === 100001, 'VTable 的 rowCount 与数据一致（含表头）', `rowCount ${P(B)[1].rowCount}`);
  push(B.panels[1].canvas.ratio > 0.02, '10 万行下 canvas 仍只画可视区且内容正常', `墨迹 ${(P(B)[1].canvas.ratio * 100).toFixed(1)}%`);
  push(Bms < 8000, '10 万行 setRecords 在可接受时间内完成', `${Bms}ms`);
  push(P(B)[1].colCount === 13, '列数 = 行号 + 选择列 + 11 个属性', `${P(B)[1].colCount} 列`);

  push(P(C)[1].rows === 50 && P(C)[2].rows > 0, '再次逐级下钻仍然收敛', `任务 ${P(C)[1].rows} / 明细 ${P(C)[2].rows}`);
  push(P(C)[2].rows < P(B)[2].rows, '明细表随任务聚焦而收窄', `${P(B)[2].rows} → ${P(C)[2].rows}`);

  push(D.size === D.rows && D.rows === 100000, '10 万行全选后选中数等于结果集大小', `${D.size} / ${D.rows}`);
  push(D.ms < 5, '全选是 O(1) 模式翻转（<5ms）', `${D.ms}ms`);
  push(D.all === true && D.header === 'checked', '表头复选框状态为全选', `header=${D.header}`);
  const dPanel = Z.panels[1];
  push(dPanel.selected <= dPanel.rows, '选中的行全部落在当前结果集内', `选中 ${dPanel.selected} / 结果集 ${dPanel.rows}`);

  push(E.rows < E.before && E.rows > 0, '10 万行关键字筛选能显著收窄结果集', `关键字「${E.kw}」：${E.before} → ${E.rows}`);
  push(E.ms < 1500, '10 万行关键字筛选在 1.5s 内', `${E.ms}ms`);

  push(E2.blocked > 0 && E2.blocked < E.before, '条件筛选（阶段 ∈ blocked）生效', `${E2.before} → ${E2.blocked}`);
  push(E2.onlyBlocked, '条件筛选结果全部满足条件');
  push(E2.sorted, '排序下推到数据源且结果有序');
  push(E2.restored === E.before, '重置查询后行数完整恢复', `${E2.restored} / ${E.before}`);

  push(F.after.stage === 'delivered' && F.after.progress === 100, '联动规则自动派生：改为「已交付」→ 进度被锁到 100', `progress ${F.before.progress} → ${F.after.progress}`);
  push(F.after.fields.includes('stage') && F.after.fields.includes('progress'), '两个字段都被记为未保存修改', JSON.stringify(F.after.fields));
  push(F.canUndo && F.undone.stage === F.before.stage && F.undone.progress === F.before.progress, '撤销能同时还原被派生的字段', `stage ${F.undone.stage} / progress ${F.undone.progress}`);
  push(F.undone.dirty === F.before.dirty, '撤销后脏计数回到原值', `${F.before.dirty} → ${F.undone.dirty}`);

  push(G.view === false && G.edit === true, '查看态不下发编辑器，编辑态才有', `查看态 ${G.view} / 编辑态 ${G.edit}`);
  push(Z.panels[1].headers.join('|') === A.panels[1].headers.join('|'), '切换编辑态不破坏列结构');

  for (const [label, sel] of [['筛选', '.filter-panel'], ['列设置', '.col-list'], ['联动规则', '.rule-list']]) {
    push(H[label] === 'ok', `面板「${label}」能正常弹出`, H[label]);
  }
  push(H.leftover === false, '弹层关闭后不残留 DOM', `leftover=${H.leftover}`);
  push(H3.buttonDisabled === false, '有选中行时「批量操作」可用', `选中 ${H2.selected} 行`);
  push(H3.modal === true && H3.hasOpRow && H3.hasSummary, '批量操作弹窗结构完整', `${H3.modalTitle} / 操作项 ${H3.hasOpRow} / 摘要 ${H3.hasSummary}`);
  push(H3.closed === true, '批量操作弹窗可以关闭');
  push(H3.help === true, '「使用说明」能弹出');

  push(I.starRow >= 1, '编辑器能在真实单元格上启动（星级）', `第 ${I.starRow} 行`);
  push(I.starCount === 5, '星级编辑器渲染出 5 颗星', `${I.starCount} 颗`);
  push(I.after === I.target && I.after !== I.before, '点星即提交，且值经由 VTable 落到 store', `${I.before} → ${I.after}`);
  push(I.popClosed === true, '提交后编辑器浮层自动关闭');
  push(I.dirty === 1, '这次编辑被记为 1 处未保存修改', `${I.dirty}`);
  push(I.undone === I.before, '撤销后单元格回到原值', `${I.undone}`);
  push(I.sliderBefore === I.sliderAfter, '滑块编辑器按 Esc 取消，数据不变', `${I.sliderBefore} → ${I.sliderAfter}`);
  push(I.sliderPopClosed === true, 'Esc 后滑块浮层关闭');

  /* ---- 阶段 J：真实点击 ---- */
  push(!J.cascade.err && !J.checkbox.err && !J.switchClick.err && !(J.execFocus && J.execFocus.err), '所有点击目标都落在可点击区域内', 'ok');
  push(J.cascade.afterFocused === J.cascade.clickedId, '点画布上的行 → 该行成为聚焦行', `${J.cascade.clickedId}`);
  push(J.cascade.afterTasks === 50 && J.cascade.allBelongToParent, '点项目行 → 任务表收敛为该项目的关联项', `${J.cascade.beforeTasks} → ${J.cascade.afterTasks}，全部归属正确：${J.cascade.allBelongToParent}`);
  push(J.checkbox.size === 1 && J.checkbox.rowChecked && J.checkbox.otherChecked === 0, '点画布上的复选框 → 只勾中那一行', `选中 ${J.checkbox.size}`);
  push(J.checkbox.afterSecondClick === 0, '再点一次取消勾选', `${J.checkbox.afterSecondClick}`);
  push(J.switchClick.after.needApproval === !J.switchClick.before.needApproval, '单击开关单元格直接切换', `${J.switchClick.before.needApproval} → ${J.switchClick.after.needApproval}`);
  push(J.switchClick.after.dirty > J.switchClick.before.dirty, '开关单击被记为未保存修改', `${J.switchClick.before.dirty} → ${J.switchClick.after.dirty}`);
  push(J.switchClick.dirtyFields.needApproval === true && J.switchClick.dirtyFields.approver === true, '开关本身和它联动清空的「审批人」都进了未保存列表', JSON.stringify(J.switchClick.dirtyFields));
  push(/联动|影响|审批|规则/.test(J.switchClick.status), '切换后在状态栏说明触发了哪条联动', J.switchClick.status);
  push(!J.execFocus || J.execFocus.focused === J.execFocus.expected, '点末级表的一行只做聚焦', JSON.stringify(J.execFocus ?? {}));

  /* ---- 阶段 K：字段级联动状态 ---- */
  const kOff = K.approvalOff.state.approver;
  push(kOff && kOff.visible === false && kOff.editable === false, '「需要审批」关闭 → 「审批人」被隐藏且只读', JSON.stringify(kOff));
  if (K.approvalOn) {
    const kOn = K.approvalOn.state.approver;
    push(kOn && kOn.visible === true, '「需要审批」开启 → 「审批人」恢复可见', JSON.stringify(kOn));
  } else {
    push(false, '「需要审批」开启 → 「审批人」恢复可见', '样本里找不到开启的行');
  }
  push(K.syncOff.state.syncPolicy && K.syncOff.state.syncPolicy.visible === false, '「自动同步」关闭 → 「同步策略」被隐藏', JSON.stringify(K.syncOff.state.syncPolicy));
  if (K.delivered) {
    push(K.delivered.state.progress && K.delivered.state.progress.editable === false, '「已交付」→ 「进度」变只读', JSON.stringify(K.delivered.state.progress));
    push(Number(K.delivered.row.progress) === 100, '「已交付」→ 「进度」被派生为 100', String(K.delivered.row.progress));
  }
  if (K.noBillable) {
    push(K.noBillable.state.rate && K.noBillable.state.rate.visible === false, '「不计费」→ 「单价」被隐藏', JSON.stringify(K.noBillable.state.rate));
    push(K.noBillable.state.amount && K.noBillable.state.amount.visible === false, '「不计费」→ 「金额」被隐藏', JSON.stringify(K.noBillable.state.amount));
  }
  if (K.billable) {
    push(K.billable.state.amount && K.billable.state.amount.visible === true, '「计费」开启 → 「金额」恢复可见', JSON.stringify(K.billable.state.amount));
    const expect = Math.round(Number(K.billable.row.hours ?? 0) * Number(K.billable.row.rate ?? 0) * 100) / 100;
    push(Math.abs(Number(K.billable.row.amount) - expect) < 0.02, '「计费」开启 → 金额 = 工时 × 单价', `${K.billable.row.amount} vs ${expect}`);
  }
  push(K.ruleCounts.project >= 3 && K.ruleCounts.task >= 3 && K.ruleCounts.execution >= 3, '三张表都声明了多条联动规则', JSON.stringify(K.ruleCounts));

  push(L.storeDegraded === false && L.shown === false, 'mock 模式下不显示降级告警', `source=${L.sourceKind} degraded=${L.storeDegraded} shown=${L.shown}`);

  /* ---- 阶段 M：三屏并排 + 表头列筛选 ---- */
  const px = M.panes;
  push(px.length === 3, '页面上是三张表', `${px.length} 张`);
  push(px[0].y === px[1].y && px[1].y === px[2].y && px[0].x < px[1].x && px[1].x < px[2].x,
    '三张表左右并排（横着分三屏）', px.map(p => `${p.entity}@${p.x},${p.y} ${p.w}×${p.h}`).join(' | '));
  push(px.every(p => Math.abs(p.w - px[0].w) <= 1), '三屏等宽', px.map(p => p.w).join('/'));
  push(M.header.popupOpened === true && M.header.popupTitle === '阶段', '点表头弹出该列的筛选弹窗', `${M.header.popupTitle} / ${M.header.sub}`);
  push(M.header.items.length >= 3 && M.header.items.every(i => i.n !== undefined && i.label),
    '弹窗列出该列的去重取值与计数', M.header.items.map(i => `${i.label}:${i.n}`).join(' '));
  push(M.header.showAllValue === true, '取值统计不包含该列自身已生效的筛选（能重新放宽范围）', M.header.summary);
  push(M.apply.cond && M.apply.cond.field === 'stage' && M.apply.cond.operator === 'in' && M.apply.cond.id === 'col:stage',
    '确定后写入「只筛这一列」的条件', JSON.stringify(M.apply.cond));
  push(M.apply.after < M.apply.before && M.apply.allMatch, '表格只剩符合该值的行', `${M.apply.before} → ${M.apply.after}，全部命中：${M.apply.allMatch}`);
  push(M.apply.popupClosed === true, '确定后弹窗自动关闭');
  push(M.reopen.pickedBack === true, '重新打开弹窗会回填已选中的取值', M.reopen.summary);
  push(M.cleared.cond === null && M.cleared.rows === M.apply.before, '「清除本列筛选」恢复全部行', JSON.stringify(M.cleared.cond));
  push(M.text.ops.length >= 3 && M.text.hasInput === true, '文本列的弹窗走「操作符 + 值」而不是取值列表', M.text.ops.join('/'));

  push(consoleErrors.filter(e => e.startsWith('[error]')).length === 0, '控制台无 error', consoleErrors.join(' | ') || '干净');
  push(pageErrors.length === 0, '无未捕获异常', pageErrors.join(' | ') || '干净');

  console.log(JSON.stringify(report, null, 2));
  console.log('\n================ 断言 ================');
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? `  —  ${c.detail}` : ''}`);
  const failed = checks.filter(c => !c.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} 通过`);

  ws.close();
  chrome.kill();
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* Windows 上偶尔文件占用，忽略 */
  }
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error('探针失败:', err);
  process.exit(2);
});
