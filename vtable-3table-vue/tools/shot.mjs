/**
 * 截图工具：把页面真实渲染结果存成 PNG，用来肉眼对比 Vue 版与命令式版。
 *
 * 用法：node tools/shot.mjs [url] [out.png]
 * 前置：npm run dev 已在 5275 端口跑着。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = process.argv[2] ?? 'http://127.0.0.1:5275/';
const OUT = process.argv[3] ?? 'shot.png';
const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const chromePath = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!chromePath) throw new Error('找不到 Chrome/Edge 可执行文件');

  const profile = mkdtempSync(join(tmpdir(), 'vt-shot-'));
  spawn(
    chromePath,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
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

  let wsUrl = '';
  for (let i = 0; i < 40 && !wsUrl; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error('没有找到 page target');

  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  ws.addEventListener('message', ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1680, height: 1020, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: URL_ });

  /* 等应用挂上调试句柄、三张表都建出 canvas，再多等一会儿让首屏联动跑完 */
  const deadline = Date.now() + 90_000;
  let ready = false;
  while (Date.now() < deadline && !ready) {
    await sleep(300);
    const r = await send('Runtime.evaluate', {
      expression: 'Boolean(window.__vtDemo && document.querySelectorAll(".pane-body canvas").length === 3)',
      returnByValue: true,
    });
    ready = r.result?.value === true;
  }
  if (!ready) throw new Error('等待页面就绪超时');
  await sleep(2500);

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`已保存 ${OUT}`);
  ws.close();
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
