/**
 * 极简 CDP 客户端（无第三方依赖，只用 Node 内置 fetch / WebSocket）。
 *
 * 与 `vtable-3table-vue/tools/probe.mjs` 里的那套是同一份思路，抽出来给
 * probe.mjs / bench.mjs 共用：启动 headless Chrome、连上 page target、
 * Runtime.evaluate 取值、截图、收集 console error。
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export function findChrome() {
  const hit = CHROME_CANDIDATES.find(p => existsSync(p));
  if (!hit) throw new Error('找不到 Chrome/Edge 可执行文件');
  return hit;
}

/**
 * 打开 headless Chrome 并连上第一个 page target。
 * @param {{ width?: number, height?: number, extraArgs?: string[] }} [opts]
 */
export async function launch(opts = {}) {
  const profile = mkdtempSync(join(tmpdir(), 'vtpro-'));
  const child = spawn(
    findChrome(),
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      '--hide-scrollbars',
      '--disable-extensions',
      '--remote-allow-origins=*',
      '--remote-debugging-port=0',
      '--disable-dev-shm-usage',
      '--js-flags=--expose-gc',
      `--user-data-dir=${profile}`,
      `--window-size=${opts.width ?? 1680},${opts.height ?? 1020}`,
      ...(opts.extraArgs ?? []),
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  const portFile = join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(120);
    if (existsSync(portFile)) port = Number(readFileSync(portFile, 'utf8').split('\n')[0]);
  }
  if (!port) throw new Error('Chrome 没有暴露调试端口');

  let wsUrl = '';
  for (let i = 0; i < 60 && !wsUrl; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
    wsUrl = list.find(t => t.type === 'page')?.webSocketDebuggerUrl ?? '';
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error('没有找到 page target');

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
      if (msg.error) reject(new Error(msg.error.message));
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

  const send = (method, params = {}, timeout = 120_000) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, timeout);
    });

  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  await send('Performance.enable');

  /** 在页面里求值；expr 必须是「表达式」字符串，返回值需可 JSON 序列化 */
  async function evaluate(expr, { awaitPromise = true } = {}) {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (r.exceptionDetails) {
      throw new Error(`页面求值异常：${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  async function goto(url) {
    const loaded = new Promise(resolve => {
      const onMsg = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.method === 'Page.loadEventFired') {
          ws.removeEventListener('message', onMsg);
          resolve('load');
        }
      };
      ws.addEventListener('message', onMsg);
      // 页面里一旦有死循环，load 事件就永远不来；这里兜个底，别把探针挂死
      setTimeout(() => {
        ws.removeEventListener('message', onMsg);
        resolve('timeout');
      }, 45_000);
    });
    await send('Page.navigate', { url });
    const how = await loaded;
    if (how === 'timeout') {
      const state = await evaluate('document.readyState').catch(() => 'unknown');
      if (state !== 'complete') console.warn(`[cdp] 等待 load 事件超时（readyState=${state}），页面可能卡住了`);
    }
  }

  async function waitFor(expr, { timeout = 30_000, interval = 120, label = expr } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        if (await evaluate(expr)) return true;
      } catch {
        /* 页面还没准备好，继续等 */
      }
      await sleep(interval);
    }
    throw new Error(`等待超时：${label}`);
  }

  async function screenshot(file) {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  function dispose() {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* ignore */
    }
  }

  return { send, evaluate, goto, waitFor, screenshot, dispose, consoleErrors, pageErrors };
}
