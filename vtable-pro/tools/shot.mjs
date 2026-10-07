/**
 * 截图：给 README / 交付说明用。
 *   node tools/shot.mjs [url]
 */
import { mkdirSync } from 'node:fs';
import { launch, sleep } from './cdp.mjs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5277/';
const PREFIX = process.env.SHOT_PREFIX ?? '';
mkdirSync('tools/shots', { recursive: true });

const session = await launch({ width: 1720, height: 1080 });
const { evaluate, goto, waitFor, screenshot, dispose, send } = session;

async function clickSel(sel, index = 0) {
  const box = await evaluate(`(() => { const e = document.querySelectorAll(${JSON.stringify(sel)})[${index}]; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!box) throw new Error('找不到 ' + sel);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(300);
}

async function clickCell(col, row) {
  const box = await evaluate(`(() => { const t = window.__vtp.api.table; const r = t.getCellRelativeRect(${col}, ${row}); const cr = t.getElement().getBoundingClientRect(); return { x: cr.left + r.left + r.width / 2, y: cr.top + r.top + r.height / 2 }; })()`);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 1 });
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1, buttons: 0 });
  await sleep(250);
}

try {
  await goto(URL_);
  await waitFor('!!window.__vtp?.api?.ready', { timeout: 40_000 });
  await sleep(2000);

  // 勾几行 + 加一个状态筛选
  for (const row of [1, 2, 6, 7]) await clickCell(1, row);
  await clickSel('.vtp-hd__funnel[data-filter-for="status"]');
  await sleep(300);
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('.vtp-filter__row')];
    const hit = rows.find(r => r.querySelector('.vtp-filter__val').textContent === '已完成');
    hit.querySelector('input').click();
  })()`);
  await sleep(200);
  await clickSel('.vtp-filter .vtp-btn.primary');
  await sleep(600);
  await screenshot('tools/shots/' + PREFIX + '01-overview.png');

  // 打开自绘滚动条 + 跳到 5 万行附近
  await clickSel('[data-act="toggle-scrollbar"]');
  await sleep(400);
  await evaluate('window.__vtp.api.scrollToRow(50000)');
  await sleep(900);
  await screenshot('tools/shots/' + PREFIX + '02-scroll-50k.png');

  // 各列筛选项面板
  await clickSel('[data-act="clear-filters"]');
  await sleep(500);
  await clickSel('.vtp-hd__funnel[data-filter-for="city"]');
  await sleep(500);
  await screenshot('tools/shots/' + PREFIX + '03-column-filter.png');
  console.log('截图已写入 tools/shots/');
} finally {
  dispose();
}
