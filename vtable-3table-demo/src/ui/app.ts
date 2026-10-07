/**
 * 应用外壳：加载进度、全局工具栏、三级面包屑、三个表格面板、状态栏。
 */

import { HttpDataSource } from '../data/http-source';
import { DEFAULT_SCALE, MockDataSource, scaleFromLocation, type DataScale } from '../data/mock-source';
import { SCHEMAS, evaluateRowState } from '../domain/schema';
import { ENTITY_CHAIN, type TableMode } from '../domain/types';
import { AppStore } from '../state/store';
import { TablePanel } from './panel';
import { clear, h, ms, num, openPopover } from './dom';

/* ------------------------------------------------------------------ *
 * 数据源装配
 * ------------------------------------------------------------------ */

export interface BootstrapResult {
  store: AppStore;
  panels: TablePanel[];
}

function createSource(scale: DataScale): { store: AppStore; mode: 'mock' | 'http' } {
  const params = new URLSearchParams(location.search);
  const wantHttp = params.get('ds') === 'http';
  const mock = new MockDataSource(scale);
  if (wantHttp) {
    // 演示环境没有后端：请求失败会自动降级到 mock，并在工具栏标出来
    const http = new HttpDataSource({ baseUrl: params.get('api') ?? '/api', fallback: mock });
    return { store: new AppStore(http), mode: 'http' };
  }
  return { store: new AppStore(mock), mode: 'mock' };
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */

export async function bootstrap(root: HTMLElement): Promise<BootstrapResult> {
  const scale = scaleFromLocation(location.search);
  const { store, mode: sourceMode } = createSource(scale);

  /* ---- 加载页 ---- */
  const bar = h('div', { class: 'load-bar' }, h('i', { style: { width: '0%' } }));
  const stage = h('div', { class: 'load-stage' }, '正在生成数据…');
  const loading = h(
    'div',
    { class: 'loading' },
    h('div', { class: 'loading-card' }, h('div', { class: 'loading-title' }, 'VTable 三表联动 · 10 万级'), stage, bar, h('div', { class: 'loading-hint' }, `目标规模：项目 ${num(scale.project)} / 任务 ${num(scale.task)} / 明细 ${num(scale.execution)}`))
  );
  root.appendChild(loading);

  const t0 = performance.now();
  await store.init((s, ratio) => {
    stage.textContent = s;
    (bar.firstElementChild as HTMLElement).style.width = `${Math.round(Math.max(0, Math.min(1, ratio)) * 100)}%`;
  });
  const bootMs = performance.now() - t0;
  loading.remove();

  /* ---- 骨架 ---- */
  const shell = h('div', { class: 'app' });
  const crumbs = h('div', { class: 'crumbs' });
  const panes = h('main', { class: 'panes' });
  const statusText = h('span', { class: 'status-text' });
  const statusPerf = h('span', { class: 'status-perf' });
  const degradedBadge = h('span', { class: 'degraded-badge' });
  const statusBar = h('footer', { class: 'status-bar' }, statusText, h('span', { class: 'spacer' }), degradedBadge, statusPerf);
  const appBar = buildAppBar(store, scale, sourceMode, bootMs);

  shell.append(appBar.el, crumbs, panes, statusBar);
  root.appendChild(shell);

  /* ---- 三个面板 ---- */
  const panels = ENTITY_CHAIN.map((entity, i) => new TablePanel({ store, entity, index: i + 1 }));
  for (const p of panels) panes.appendChild(p.el);

  /* ---- 面包屑 / 状态栏 ---- */
  const renderCrumbs = () => {
    clear(crumbs);
    const trail = store.breadcrumb();
    crumbs.appendChild(h('span', { class: 'crumb-label' }, '当前联动路径'));
    crumbs.appendChild(chip('全部' + SCHEMAS.project.label, trail.length === 0, () => void store.clearFocus('project')));
    for (const step of trail) {
      crumbs.appendChild(h('span', { class: 'crumb-arrow' }, '›'));
      crumbs.appendChild(
        h(
          'span',
          { class: 'crumb' },
          h('b', null, SCHEMAS[step.entity].short),
          h('span', null, step.title),
          h('button', { class: 'chip-x', title: `清除「${step.title}」的聚焦`, onclick: () => void store.clearFocus(step.entity) }, '✕')
        )
      );
    }
    const hint =
      trail.length === 0
        ? '点击第 1 张表的任意一行，第 2 张表会自动收起为该项目的关联任务'
        : trail.length === 1
          ? '继续点击第 2 张表的任意一行，第 3 张表会展示该任务的执行明细'
          : '已下钻到最细粒度；清除任一级即可回到上层视图';
    crumbs.appendChild(h('span', { class: 'crumb-hint' }, hint));
  };

  const renderStatus = () => {
    statusText.textContent = store.statusText || '就绪';
    const totals = ENTITY_CHAIN.map(e => `${SCHEMAS[e].short} ${num(store.entities[e].rows.length)}/${num(store.entities[e].total)}`).join('　');
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const memText = mem ? `　JS 堆 ${(mem.usedJSHeapSize / 1024 / 1024).toFixed(0)} MB` : '';
    statusPerf.textContent = `${totals}　启动 ${ms(bootMs)}${memText}`;
    // 后端连不上时，界面必须明说自己正在展示本地兜底数据
    degradedBadge.className = `degraded-badge${store.degraded ? ' on' : ''}`;
    degradedBadge.textContent = store.degraded
      ? `⚠ 后端不可用，当前展示的是本地兜底数据${store.sourceError ? `（${store.sourceError}）` : ''}`
      : '';
  };

  applyMode(store, panels, appBar.modeButtons);
  store.on('focus', renderCrumbs);
  store.on('data', renderStatus);
  store.on('status', renderStatus);
  store.on('mode', () => applyMode(store, panels, appBar.modeButtons));
  store.on('dirty', () => appBar.refreshDirty(store));

  renderCrumbs();
  renderStatus();

  /* 调试钩子：控制台里可以直接拿到 store、三个表格实例和规则求值器，
     配合 tools/probe.mjs 做无人值守的渲染回归检查。 */
  (window as unknown as { __vtDemo?: unknown }).__vtDemo = {
    store,
    panels,
    sourceMode,
    schemas: SCHEMAS,
    evaluateRowState,
  };

  /* 默认进入编辑态，方便直接体验联动 */
  store.setMode('edit');

  /* 首屏默认聚焦第一个项目，把三段联动关系一次性展示出来 */
  const first = store.entities.project.rows[0];
  if (first) {
    void store.focusRow('project', first.id).then(() => {
      const task = store.entities.task.rows[0];
      if (task) return store.focusRow('task', task.id);
      return undefined;
    });
  }

  return { store, panels };
}

/* ------------------------------------------------------------------ *
 * 全局工具栏
 * ------------------------------------------------------------------ */

interface AppBarHandle {
  el: HTMLElement;
  modeButtons: { view: HTMLButtonElement; edit: HTMLButtonElement };
  refreshDirty(store: AppStore): void;
}

function buildAppBar(store: AppStore, scale: DataScale, sourceMode: 'mock' | 'http', bootMs: number): AppBarHandle {
  const dirtyBadge = h('span', { class: 'dirty-badge' });

  const viewBtn = h('button', { class: 'seg', onclick: () => store.setMode('view') }, '查看态') as HTMLButtonElement;
  const editBtn = h('button', { class: 'seg', onclick: () => store.setMode('edit') }, '编辑态') as HTMLButtonElement;

  const saveBtn = h('button', { class: 'btn pri', onclick: () => void store.save() }, '保存修改') as HTMLButtonElement;
  const revertBtn = h('button', { class: 'btn', onclick: () => store.revertAll() }, '回滚') as HTMLButtonElement;
  const undoBtn = h('button', { class: 'btn', onclick: () => store.undo() }, '撤销') as HTMLButtonElement;
  const redoBtn = h('button', { class: 'btn', onclick: () => store.redo() }, '重做') as HTMLButtonElement;

  const refreshDirty = (s: AppStore) => {
    const n = s.dirtyCount();
    dirtyBadge.textContent = n ? `${num(n)} 处未保存` : '无未保存修改';
    dirtyBadge.className = `dirty-badge${n ? ' on' : ''}`;
    saveBtn.disabled = n === 0;
    revertBtn.disabled = n === 0;
    undoBtn.disabled = !s.canUndo;
    redoBtn.disabled = !s.canRedo;
  };
  refreshDirty(store);
  // 撤销 / 重做可能产生「零变化」的补丁（值本来就相等），此时 store 不会广播，
  // 所以点完按钮各自补一次刷新，避免按钮态滞后
  const thenRefresh = (fn: () => void) => () => {
    fn();
    refreshDirty(store);
  };
  undoBtn.onclick = thenRefresh(() => store.undo());
  redoBtn.onclick = thenRefresh(() => store.redo());

  /* 规模切换：重新生成数据需要重载页面 */
  const scaleSel = h('select', { class: 'input compact' }) as HTMLSelectElement;
  const presets: { label: string; v: DataScale }[] = [
    { label: '小 · 6 千行', v: { project: 200, task: 5_000, execution: 1_000 } },
    { label: '中 · 3 万行', v: { project: 1_000, task: 25_000, execution: 5_000 } },
    { label: '大 · 14 万行（默认）', v: DEFAULT_SCALE },
    { label: '超大 · 30 万行', v: { project: 3_000, task: 200_000, execution: 100_000 } },
  ];
  for (const p of presets) {
    const value = `${p.v.project}-${p.v.task}-${p.v.execution}`;
    scaleSel.appendChild(h('option', { value }, p.label));
    if (p.v.project === scale.project && p.v.task === scale.task && p.v.execution === scale.execution) scaleSel.value = value;
  }
  scaleSel.onchange = () => {
    const [p, t, e] = scaleSel.value.split('-');
    const params = new URLSearchParams(location.search);
    params.set('p', p);
    params.set('t', t);
    params.set('e', e);
    location.search = params.toString();
  };

  const dsNote = sourceMode === 'http' ? '数据源：HTTP（未连上后端会自动降级到本地 mock）' : '数据源：本地 mock（可切换为 HTTP 预留接口）';

  const helpBtn = h(
    'button',
    {
      class: 'btn',
      onclick: (e: Event) => openHelp(e.currentTarget as HTMLElement),
    },
    '使用说明'
  ) as HTMLButtonElement;

  const el = h(
    'header',
    { class: 'app-bar' },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'VT'), h('div', null, h('div', { class: 'brand-title' }, 'VTable 三表联动 · 10 万级数据'), h('div', { class: 'brand-sub' }, `启动耗时 ${ms(bootMs)}　${dsNote}`))),
    h('div', { class: 'spacer' }),
    h('div', { class: 'seg-group' }, viewBtn, editBtn),
    h('div', { class: 'btn-group' }, saveBtn, revertBtn, undoBtn, redoBtn),
    dirtyBadge,
    h('div', { class: 'grow' }),
    h('label', { class: 'scale' }, '数据规模', scaleSel),
    helpBtn
  );

  return { el, modeButtons: { view: viewBtn, edit: editBtn }, refreshDirty };
}

function applyMode(store: AppStore, panels: TablePanel[], buttons: { view: HTMLButtonElement; edit: HTMLButtonElement }): void {
  const mode: TableMode = store.mode;
  buttons.view.classList.toggle('on', mode === 'view');
  buttons.edit.classList.toggle('on', mode === 'edit');
  for (const p of panels) p.setEditableChrome();
}

/* ------------------------------------------------------------------ *
 * 帮助
 * ------------------------------------------------------------------ */

function openHelp(anchor: HTMLElement): void {
  const content = h(
    'div',
    { class: 'pop-panel wide' },
    h('div', { class: 'sec-title' }, '这个页面演示了什么'),
    h(
      'ol',
      { class: 'help-list' },
      h('li', null, h('b', null, '三级联动'), '：点第 1 张表任一行 → 第 2 张表收敛为该项目的关联任务；再点任务 → 第 3 张表展示该任务的执行明细。每级都可「显示全部」回到上层视图。'),
      h('li', null, h('b', null, '10 万级'), '：默认任务表 10 万行、明细 4 万行。全选是 O(1) 的模式位翻转，筛选是一次带索引前缀的内存谓词扫描，滚动由 VTable 虚拟化，只渲染可视区。'),
      h('li', null, h('b', null, '每个属性一个小组件'), '：11 种小组件分别负责展示与编辑（编号下钻 / 文本 / 头像 / 单选 / 多选标签 / 数值 / 金额 / 进度条 / 星级 / 日期 / 开关）。'),
      h('li', null, h('b', null, '编辑态 / 查看态'), '：查看态下不下发编辑器，属性联动仍在工作（只是全部只读）。'),
      h('li', null, h('b', null, '属性间联动'), '：开关类属性会控制后续属性的显隐、只读与必填，并自动清空/派生值。点面板上的「联动规则」可以看到当前表的全部规则。'),
      h('li', null, h('b', null, '批量操作'), '：对选中集批量设置 / 计算 / 打标签 / 删除，全部走同一条写路径，支持撤销、重做与整体回滚。'),
      h('li', null, h('b', null, '数据源可替换'), '：页面只依赖 DataSource 接口，换 URL 参数 ?ds=http 即可切到预留的 HTTP 分页实现（无后端时自动降级）。')
    ),
    h('div', { class: 'pop-note' }, '快捷键：双击单元格进入编辑；编辑态下单击开关直接切换；Esc 取消编辑；Ctrl+A 选择单元格区域。')
  );
  openPopover(anchor, content, { width: 520, align: 'right' });
}

/* ------------------------------------------------------------------ *
 * 便捷
 * ------------------------------------------------------------------ */

function chip(label: string, active: boolean, onclick: () => void): HTMLElement {
  return h('button', { class: `crumb chip-btn${active ? ' on' : ''}`, onclick }, label);
}
