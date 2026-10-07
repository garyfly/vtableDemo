/** 冒烟：页面能不能起来、表格有没有画出来、有没有报错。 */
import { launch, sleep } from './cdp.mjs';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5277/';
const session = await launch();
const { evaluate, goto, waitFor, screenshot, dispose, consoleErrors, pageErrors } = session;

try {
  await goto(URL_);
  await waitFor('!!document.querySelector("canvas")', { label: 'canvas 出现', timeout: 30_000 });
  await sleep(2500);

  const info = await evaluate(`(() => {
    const q = s => document.querySelector(s);
    return {
      canvas: document.querySelectorAll('canvas').length,
      headers: document.querySelectorAll('.vtp-hd').length,
      headerTitles: [...document.querySelectorAll('.vtp-hd__title')].map(e => e.textContent).slice(0, 6),
      cellDomNodes: document.querySelectorAll('[class^="vtp-cell-"]').length,
      toolbar: !!q('.vtp-bar'),
      stats: q('[data-stat="total"]')?.textContent ?? null,
      scrollMetrics: q('[data-metrics]')?.textContent ?? null,
      containers: [...document.querySelectorAll('.table-component-container')].map(c => ({ id: c.id, n: c.childElementCount })),
      bodyText: document.body.innerText.slice(0, 200),
    };
  })()`);
  console.log(JSON.stringify(info, null, 2));
  await screenshot('tools/smoke.png');
} finally {
  const errs = [...consoleErrors, ...pageErrors];
  console.log(errs.length ? `控制台/异常：\n${errs.slice(0, 12).join('\n')}` : '控制台零 error / 零未捕获异常');
  dispose();
}
