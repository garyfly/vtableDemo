/**
 * 入口。
 */

import './styles.css';
import { bootstrap } from './ui/app';

const root = document.getElementById('app');

if (!root) {
  throw new Error('缺少 #app 挂载点');
}

bootstrap(root).catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  root.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'fatal';
  box.innerHTML = `<h2>页面初始化失败</h2><pre>${String(err instanceof Error ? err.stack ?? err.message : err)}</pre>`;
  root.appendChild(box);
});
