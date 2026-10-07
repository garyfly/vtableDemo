/**
 * 无人值守回归探针：用 CDP 打开页面，读真实状态做断言。
 *
 * 覆盖需求里的每一条：
 *   虚拟滚动（10 万行） / 非响应式全量导入 / 列级自定义组件 /
 *   滚动条几何计算 / 工具栏取勾选行 / 每列表头独立筛选。
 *
 * 用法：node tools/probe.mjs [url]
 * 前置：npm run dev 已经在 5277 跑着（探针期间别改源文件，HMR 会整页重载）。
 */

import { launch, sleep } from './cdp.mjs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5277/';
// 行数跟着 URL 参数走：node tools/probe.mjs 'http://127.0.0.1:5277/?rows=1000000'
const ROWS = Number(new URL(URL_).searchParams.get('rows') ?? 100_000);
const ROWS_TEXT = ROWS.toLocaleString('en-US');
const LABEL = ROWS >= 10_000 ? `${ROWS / 10_000} 万` : String(ROWS);

let pass = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? `  — ${detail}` : ''}`);
  } else {
    failures.push(name);
    console.log(`FAIL  ${name}${detail ? `  — ${detail}` : ''}`);
  }
}

const session = await launch();
const { send, evaluate, goto, waitFor, screenshot, dispose, consoleErrors, pageErrors } = session;

/* ------------------------------------------------------------------ *
 * 交互工具
 * ------------------------------------------------------------------ */

/** 真实鼠标点击（DOM 覆盖层必须用真事件才能验证 pointer-events） */
async function realClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(220);
}

async function clickSelector(sel, index = 0) {
  const box = await evaluate(`(() => {
    const els = document.querySelectorAll(${JSON.stringify(sel)});
    const el = els[${index}];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  if (!box) throw new Error(`找不到元素：${sel}[${index}]`);
  await realClick(box.x, box.y);
}

/** 点 canvas 上的某个单元格（表头行号为 0；数据行从 1 开始） */
async function clickCell(col, row) {
  const box = await evaluate(`(() => {
    const t = window.__vtp.api.table;
    const r = t.getCellRelativeRect(${col}, ${row});
    const cr = t.getElement().getBoundingClientRect();
    return { x: cr.left + r.left + r.width / 2, y: cr.top + r.top + r.height / 2 };
  })()`);
  await realClick(box.x, box.y);
}

const text = sel => evaluate(`(document.querySelector(${JSON.stringify(sel)})?.textContent ?? '').trim()`);
const count = sel => evaluate(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const api = expr => evaluate(`(() => { const a = window.__vtp.api; return ${expr}; })()`);

/** 字段名 → canvas 列号（col 0 是行号列，1 是勾选列，数据列从 2 开始） */
async function colOf(field) {
  return evaluate(`(() => {
    const t = window.__vtp.api.table;
    for (let c = 0; c < t.colCount; c++) {
      const d = t.getBodyColumnDefine(c, 1);
      if (d && d.field === ${JSON.stringify(field)}) return c;
    }
    return -1;
  })()`);
}

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

try {
  await goto(URL_);
  await waitFor('!!window.__vtp?.api?.ready', { label: '表格挂载完成', timeout: 40_000 });
  await sleep(1800);

  const COL_COUNT = await evaluate('window.__vtp.api.table.colCount');
  const ROW_SERIES = 1; // 行号列占 col 0
  const CHECK_COL = 1;

  console.log('\n===== A. 首屏 / 虚拟滚动 / 非响应式 =====');

  const ink = await evaluate(`(() => {
    const c = document.querySelector('canvas');
    const ctx = c.getContext('2d');
    const w = c.width, h = c.height;
    const data = ctx.getImageData(0, 0, w, Math.min(h, 400)).data;
    let painted = 0, total = 0;
    for (let i = 0; i < data.length; i += 4) { total++; if (data[i + 3] > 0 && !(data[i] > 250 && data[i+1] > 250 && data[i+2] > 250)) painted++; }
    return { ratio: painted / total, w, h };
  })()`);
  check('首屏：canvas 真的画了东西', ink.ratio > 0.02, `墨迹 ${(ink.ratio * 100).toFixed(1)}%`);

  const total = await api('a.getData().length');
  check(`首屏：全量导入 ${LABEL}行`, total === ROWS, `getData().length = ${total}`);
  check('首屏：工具栏统计正确', (await text('[data-stat="total"]')).includes(ROWS_TEXT), await text('[data-stat="total"]'));

  const ev = await api('a && window.__vtp.evidence');
  check(
    '非响应式：数组与行对象都不是 Proxy',
    ev.arrayIsReactive === false && ev.arrayIsProxy === false && ev.rowIsProxy === false && ev.hasReactiveFlag === false,
    JSON.stringify(ev)
  );

  const hdCount = await count('.vtp-hd');
  const dataCols = await evaluate('window.__vtp.dataColumns');
  // 功能断言：每个「完全可见」的数据列，其中线位置命中的必须是本列自己的 DOM 表头。
  // （不可见的列不渲染 DOM 表头 —— 列方向也有虚拟化，这是预期行为）
  const covered = await evaluate(`(() => {
    const t = window.__vtp.api.table;
    const cr = t.getElement().getBoundingClientRect();
    const y = cr.top + t.getRowHeight(0) / 2;
    const miss = [];
    let total = 0;
    for (let c = 2; c < 2 + ${dataCols}; c++) {
      const r = t.getCellRelativeRect(c, 0);
      if (!(r.left >= 0 && r.right <= t.tableNoFrameWidth)) continue;
      total++;
      const el = document.elementFromPoint(cr.left + r.left + r.width / 2, y);
      const hd = el && el.closest ? el.closest('.vtp-hd') : null;
      const field = t.getBodyColumnDefine(c, 1) && t.getBodyColumnDefine(c, 1).field;
      if (!hd || hd.dataset.field !== field) miss.push(field);
    }
    return { total, miss };
  })()`);
  check(
    '表头：每个完全可见的数据列都被本列的 DOM 表头覆盖',
    covered.total >= 5 && covered.miss.length === 0,
    `${covered.total} 个完全可见列全部命中（页面里共 ${hdCount} 个表头 / ${dataCols} 个数据列，横向也有虚拟化）`
  );

  const funnelCount = await count('.vtp-hd__funnel');
  const filterableCols = await evaluate('window.__vtp.filterableColumns');
  check('表头：每列都有独立的筛选入口', funnelCount === filterableCols, `漏斗按钮 ${funnelCount} 个 = 可筛选列数 ${filterableCols}`);

  const domCells = await evaluate(`document.querySelector('#vtable-body-dom-container').childElementCount`);
  const visibleRows = await api('a.getScrollMetrics().endRow - a.getScrollMetrics().startRow + 1');
  const perRow = domCells / visibleRows;
  check(
    '组件列：只有声明了 cell 的列产生 DOM',
    perRow > 4 && perRow < 6.5,
    `可视 ${visibleRows} 行 × 5 个组件列 ≈ ${domCells} 个 DOM 节点（其它 8 列走 canvas）`
  );
  check('虚拟滚动：DOM 节点数与 10 万行无关', domCells < 200, `${domCells} 个节点（若全量渲染会是 50 万+）`);

  const m0 = await api('a.getScrollMetrics()');
  check('滚动条计算：滑块 / 轨道几何有值', m0.thumbHeight >= 28 && m0.trackHeight > 400, `滑块 ${m0.thumbHeight}px / 轨道 ${m0.trackHeight}px`);
  check('滚动条计算：可视行区间来自虚拟滚动', m0.startRow === 0 && m0.endRow >= 10 && m0.totalRows === ROWS, `行 ${m0.startRow + 1}–${m0.endRow + 1} / ${m0.totalRows}`);

  const expectedThumb = await api('(() => { const t = a.table; const bodyContent = t.getAllRowsHeight() - t.getRowHeight(0); return Math.max(28, (a.getScrollMetrics().trackHeight / bodyContent) * a.getScrollMetrics().trackHeight); })()');
  check('滚动条计算：滑块高度符合公式', Math.abs(m0.thumbHeight - expectedThumb) <= 1.5, `实际 ${m0.thumbHeight} / 公式 ${expectedThumb.toFixed(1)}`);

  console.log('\n===== B. 全选（O(1) 模式位）与工具栏取勾选行 =====');

  const t0 = Date.now();
  await clickCell(CHECK_COL, 0); // 表头复选框
  const selectMs = Date.now() - t0;
  const selectedAll = await api('a.getSelectionCount()');
  check(`全选：${LABEL}行勾选是一次模式翻转`, selectedAll === ROWS, `${selectMs}ms`);
  check('全选：工具栏计数跟着变', (await text('[data-stat="selected"]')).includes(ROWS_TEXT), await text('[data-stat="selected"]'));

  await clickSelector('[data-act="query"]');
  const q1 = await api('window.__vtp.lastQuery ? window.__vtp.lastQuery.count : -1');
  const qText = await text('[data-query-count]');
  check(`工具栏「获取勾选行」：拿到 ${LABEL}行`, q1 === ROWS, qText);
  const previewMatches = await evaluate(`(() => {
    const first = document.querySelector('.rows li code')?.textContent ?? '';
    return first === window.__vtp.rows[0].orderNo;
  })()`);
  check('工具栏取到的行就是原始数据里的行', previewMatches, '预览首条 = 原始第 1 行');

  await clickSelector('[data-act="invert"]');
  check('反选：全选后反选 → 0 行', (await api('a.getSelectionCount()')) === 0, `勾选 ${await api('a.getSelectionCount()')}`);

  await clickSelector('[data-act="select-all"]');
  check(`再点全选 → 回到 ${LABEL}行`, (await api('a.getSelectionCount()')) === ROWS);
  await clickSelector('[data-act="clear"]');
  check('清空勾选 → 0', (await api('a.getSelectionCount()')) === 0);

  console.log('\n===== C. 单行勾选 =====');

  await clickCell(CHECK_COL, 1);
  const c1 = await api('a.getCheckedRows().map(r => r.orderNo)');
  const expectRow1 = await evaluate('window.__vtp.rows[0].orderNo');
  check('勾选第 1 行：拿到的是正确的行对象', c1.length === 1 && c1[0] === expectRow1, `勾选 ${JSON.stringify(c1)}`);

  await clickCell(CHECK_COL, 2);
  const c2 = await api('a.getCheckedRows().map(r => r.orderNo)');
  check('勾选第 2 行：累计 2 行', c2.length === 2, JSON.stringify(c2));
  await clickCell(CHECK_COL, 2);
  check('再点一次取消勾选', (await api('a.getSelectionCount()')) === 1);

  console.log('\n===== D. 每列表头独立筛选（取值型） =====');

  await clickSelector('.vtp-hd__funnel[data-filter-for="status"]');
  await sleep(250);
  const optionRows = await count('.vtp-filter__row');
  check('打开「状态」列筛选弹窗', optionRows === 5, `取值列表 ${optionRows} 项`);

  // 勾选「已完成」
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.vtp-filter__row')];
    const hit = rows.find(r => r.querySelector('.vtp-filter__val').textContent === '已完成');
    hit.querySelector('input').click();
  })()`);
  await sleep(150);
  await clickSelector('.vtp-filter .vtp-btn.primary');
  await sleep(400);

  const expectDone = await evaluate(`window.__vtp.rows.filter(r => r.status === '已完成').length`);
  const afterStatus = await api('a.getFilteredData().length');
  check('筛选「状态 = 已完成」：行数收敛正确', afterStatus === expectDone, `${afterStatus} / 预期 ${expectDone}`);
  const renderedOk = await evaluate(`(() => {
    const pills = [...document.querySelectorAll('.vtp-cell-status__pill')].map(e => e.textContent);
    const names = [...document.querySelectorAll('.vtp-cell-owner__name')].map(e => e.textContent);
    return { pills: pills.length, allDone: pills.length > 0 && pills.every(t => t === '已完成'), names: names.length };
  })()`);
  check(
    '筛选后真正画出来的单元格也是筛选结果（不是只改了内存里的视图）',
    renderedOk.allDone && renderedOk.pills === renderedOk.names,
    `列表现场 ${renderedOk.pills} 个状态标签全部是「已完成」，与 ${renderedOk.names} 个负责人单元格对齐`
  );
  check('筛选后表头进入筛选态', await evaluate(`document.querySelector('.vtp-hd[data-field="status"]').classList.contains('is-filtered')`));
  check('筛选后工具栏出现该列 chip', (await count('[data-filter-chip="status"]')) === 1, await text('[data-filter-chip="status"]'));

  // 叠加第二列
  await clickSelector('.vtp-hd__funnel[data-filter-for="owner"]');
  await sleep(250);
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.vtp-filter__row')];
    for (const name of ['张三', '李四']) {
      const hit = rows.find(r => r.querySelector('.vtp-filter__val').textContent === name);
      if (hit) hit.querySelector('input').click();
    }
  })()`);
  await sleep(150);
  await clickSelector('.vtp-filter .vtp-btn.primary');
  await sleep(400);

  const expectBoth = await evaluate(`window.__vtp.rows.filter(r => r.status === '已完成' && (r.owner === '张三' || r.owner === '李四')).length`);
  const afterBoth = await api('a.getFilteredData().length');
  check('两列独立筛选可以叠加（AND）', afterBoth === expectBoth, `${afterBoth} / 预期 ${expectBoth}`);
  check('两个 chip 同时存在', (await count('[data-filter-chip]')) === 2);

  // 移除 status 的 chip
  await clickSelector('[data-filter-chip="status"] .vtp-chip__x');
  await sleep(400);
  const expectOwnerOnly = await evaluate(`window.__vtp.rows.filter(r => r.owner === '张三' || r.owner === '李四').length`);
  check('移除单列筛选只影响该列', (await api('a.getFilteredData().length')) === expectOwnerOnly, `${await api('a.getFilteredData().length')} / 预期 ${expectOwnerOnly}`);

  await clickSelector('[data-act="clear-filters"]');
  await sleep(400);
  check(`清除全部筛选 → 回到 ${LABEL}行`, (await api('a.getFilteredData().length')) === ROWS);

  console.log('\n===== E. 每列表头独立筛选（关键字型） =====');

  await clickSelector('.vtp-hd__funnel[data-filter-for="customer"]');
  await sleep(250);
  const hasTextInput = await count('.vtp-filter__input');
  check('取值太多的列自动退回关键字模式', hasTextInput === 1 && (await count('.vtp-filter__list')) === 0);
  await evaluate(`(() => {
    const el = document.querySelector('.vtp-filter__input');
    el.value = '华信';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
  await clickSelector('.vtp-filter .vtp-btn.primary');
  await sleep(500);
  const expectKw = await evaluate(`window.__vtp.rows.filter(r => r.customer.includes('华信')).length`);
  const gotKw = await api('a.getFilteredData().length');
  check('关键字筛选命中数正确', gotKw === expectKw, `${gotKw} / 预期 ${expectKw}`);
  const allHit = await api(`a.getFilteredData().slice(0, 200).every(r => String(r.customer).includes('华信'))`);
  check('关键字筛选结果抽样校验通过', allHit === true);

  // 空结果：覆盖层要出来（重新打开弹窗，输入一个不可能命中的关键字）
  await clickSelector('.vtp-hd__funnel[data-filter-for="customer"]');
  await sleep(250);
  await evaluate(`(() => {
    const el = document.querySelector('.vtp-filter__input');
    el.value = '不存在的客户zzz';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(150);
  await clickSelector('.vtp-filter .vtp-btn.primary');
  await sleep(500);
  check('筛选到 0 行时显示空态，且 DOM 覆盖层被清空', (await api('a.getFilteredData().length')) === 0 && (await count('.vtp-empty')) === 1 && (await count('#vtable-body-dom-container > *')) < 5, `空态 ${await count('.vtp-empty')} 个，残留覆盖层 ${await count('#vtable-body-dom-container > *')} 个`);

  await clickSelector('[data-filter-chip="customer"] .vtp-chip__x');
  await sleep(400);

  console.log('\n===== F. 排序 =====');

  await clickSelector('.vtp-hd[data-field="amount"] .vtp-hd__title');
  await sleep(500);
  const asc = await api('a.getFilteredData()[0].amount');
  // 注意用 reduce 而不是 Math.min(...arr)：百万行时展开会爆调用栈
  const minAmount = await evaluate('window.__vtp.rows.reduce((m, r) => (r.amount < m ? r.amount : m), Infinity)');
  check('点表头升序：首行是最小值', asc === minAmount, `${asc} vs ${minAmount}`);

  await clickSelector('.vtp-hd[data-field="amount"] .vtp-hd__title');
  await sleep(500);
  const desc = await api('a.getFilteredData()[0].amount');
  const maxAmount = await evaluate('window.__vtp.rows.reduce((m, r) => (r.amount > m ? r.amount : m), -Infinity)');
  check('再点一次降序：首行是最大值', desc === maxAmount, `${desc} vs ${maxAmount}`);

  await clickSelector('.vtp-hd[data-field="amount"] .vtp-hd__title');
  await sleep(500);
  const backFirst = await api('a.getFilteredData()[0].id');
  check('第三次点击取消排序，顺序回到原始顺序', backFirst === 1, `首行 id = ${backFirst}`);

  console.log('\n===== G. 滚动 / 滚动条计算 / 横向滚动与冻结列 =====');

  const MID = Math.floor(ROWS / 2);
  await api(`(a.scrollToRow(${MID}), 0)`);
  await sleep(700);
  const m1 = await api('a.getScrollMetrics()');
  check(`跳到第 ${MID.toLocaleString('en-US')} 行：可视区间命中`, m1.startRow <= MID && m1.endRow >= MID, `行 ${m1.startRow + 1}–${m1.endRow + 1}`);
  const progress = m1.maxScrollTop > 0 ? m1.scrollTop / m1.maxScrollTop : 0;
  check('滚动进度约为 50%', Math.abs(progress - 0.5) < 0.03, `${(progress * 100).toFixed(1)}%`);
  const expectThumbTop = Math.round(progress * (m1.trackHeight - m1.thumbHeight));
  check('滑块偏移 = 进度 × 可滑动距离', Math.abs(m1.thumbTop - expectThumbTop) <= 2, `实际 ${m1.thumbTop} / 公式 ${expectThumbTop}`);

  const ownerInDom = await evaluate(`[...document.querySelectorAll('.vtp-cell-owner__name')].map(e => e.textContent)`);
  const ownersAround = await api(`a.getFilteredData().slice(${Math.max(0, m1.startRow - 2)}, ${m1.endRow + 3}).map(r => r.owner)`);
  const allKnown = ownerInDom.length > 0 && ownerInDom.every(t => ownersAround.includes(t));
  check('滚动后 DOM 覆盖层内容 = 当前可视区的行', allKnown, `DOM ${ownerInDom.length} 个头像，全部落在可视行范围内`);

  // 横向滚动：冻结列留在原地，非冻结列的 DOM 表头要和 canvas 单元格对齐
  const frozenBefore = await api('a.table.getCellRelativeRect(1, 1).left');
  await api('(a.table.setScrollLeft(600), 0)');
  await sleep(700);
  const frozenAfter = await api('a.table.getCellRelativeRect(1, 1).left');
  const align = await evaluate(`(() => {
    const t = window.__vtp.api.table;
    const cr = t.getElement().getBoundingClientRect();
    const checked = [];
    for (const hd of document.querySelectorAll('.vtp-hd')) {
      const field = hd.dataset.field;
      let col = -1;
      for (let c = 0; c < t.colCount; c++) { const d = t.getBodyColumnDefine(c, 1); if (d && d.field === field) { col = c; break; } }
      if (col < 0) continue;
      // 覆盖层落在单元格的「内容盒」上（被 padding 缩进），所以比中心而不是比外框
      const r = t.getCellRelativeRect(col, 0);
      const dom = hd.getBoundingClientRect();
      checked.push({
        field,
        dCenter: Math.abs(cr.left + r.left + r.width / 2 - (dom.left + dom.width / 2)),
        inside: dom.left >= cr.left + r.left - 1 && dom.right <= cr.left + r.right + 1,
      });
    }
    return { checked, maxCenter: Math.max(...checked.map(c => c.dCenter)), allInside: checked.every(c => c.inside) };
  })()`);
  check('横向滚动：冻结列位置不变', Math.abs(frozenAfter - frozenBefore) < 2, `冻结列 left ${frozenBefore} → ${frozenAfter}`);
  check(
    '横向滚动：DOM 表头仍对准各自的列（中心重合、且不越界到邻列）',
    align.checked.length >= 5 && align.maxCenter <= 2 && align.allInside,
    `${align.checked.length} 列，最大中心偏差 ${align.maxCenter.toFixed(1)}px，全部落在本列范围内：${align.allInside}`
  );
  await api('(a.table.setScrollLeft(0), a.scrollToTop(), 0)');
  await sleep(600);

  console.log('\n===== H. 自绘滚动条（用计算结果驱动） =====');

  await clickSelector('[data-act="toggle-scrollbar"]');
  await sleep(600);
  check('开启自绘滚动条后出现滑块', (await count('[data-custom-scrollbar]')) === 1);
  const sbThumb = await evaluate(`(() => { const el = document.querySelector('.vtp-sb__thumb'); return el ? Math.round(el.getBoundingClientRect().height) : -1; })()`);
  const m2 = await api('a.getScrollMetrics()');
  check('自绘滑块高度 = 计算出来的滑块高度', Math.abs(sbThumb - m2.thumbHeight) <= 2, `DOM ${sbThumb} / 计算 ${m2.thumbHeight}`);

  // 把滑块拖到底
  const drag = await evaluate(`(() => { const r = document.querySelector('.vtp-sb__thumb').getBoundingClientRect(); const t = document.querySelector('.vtp-sb').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, bottom: t.bottom - 4 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: drag.x, y: drag.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: drag.x, y: drag.bottom, button: 'left', buttons: 1 });
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: drag.x, y: drag.bottom, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(600);
  const m3 = await api('a.getScrollMetrics()');
  check('拖动自绘滚动条到底 → 表格停在最后一行', m3.endRow === ROWS - 1 && m3.scrollTop / Math.max(1, m3.maxScrollTop) > 0.98, `行 ${m3.startRow + 1}–${m3.endRow + 1}, 进度 ${((m3.scrollTop / Math.max(1, m3.maxScrollTop)) * 100).toFixed(1)}%`);
  await clickSelector('[data-act="toggle-scrollbar"]');
  await sleep(400);

  console.log('\n===== I. 组件列的真实交互（pointer-events） =====');

  // 操作列在最右边，先横向滚到底让它的覆盖层渲染出来
  await api('(a.table.setScrollLeft(1e6), a.scrollToTop(), 0)');
  await sleep(900);
  const actionBtn = await evaluate(`(() => {
    const el = document.querySelector('.vtp-cell-actions__btn[data-action="view"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  check('操作列（interactive:true）渲染出了可点击按钮', !!actionBtn);
  if (actionBtn) {
    await realClick(actionBtn.x, actionBtn.y);
    const click = await api('window.__vtp.lastClick');
    check('真实鼠标点击命中覆盖层里的按钮', String(click).startsWith('查看 SO-2026-'), String(click));
  }

  console.log('\n===== J. 重新导入数据 =====');

  await clickSelector('[data-act="reload"]');
  await sleep(1200);
  const afterReload = await api('a.getData().length');
  const stillNonReactive = await api('window.__vtp.evidence.arrayIsReactive === false && window.__vtp.evidence.rowIsProxy === false');
  check(`重新导入一批 ${LABEL}行后仍是非响应式`, afterReload === ROWS && stillNonReactive === true, `rows=${afterReload}`);

  await screenshot('tools/probe-page.png');

  console.log('\n===== K. 控制台 =====');
  const errs = [...consoleErrors, ...pageErrors];
  check('控制台零 error / 零未捕获异常', errs.length === 0, errs.slice(0, 5).join(' | '));
} catch (err) {
  failures.push(`探针异常：${err.message}`);
  console.log(`\n探针异常：${err.stack ?? err.message}`);
} finally {
  console.log(`\n结果：${pass} 通过 / ${failures.length} 失败`);
  if (failures.length) console.log(`失败项：\n - ${failures.join('\n - ')}`);
  dispose();
  process.exit(failures.length ? 1 : 0);
}
