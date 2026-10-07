# VTable 三表联动 · 10 万级数据（Vue 3 + TypeScript）

`../vtable-3table-demo` 的 **Vue 3 + TypeScript 重写版**（原工程不在本仓库内，是本地同级目录，保留它是为了两版对照）：页面外观与能力完全一样（三级联动、10 万行、11 种属性小组件、编辑态/查看态、批量操作、列筛选、联动规则），表格内核仍然是 `@visactor/vtable`。

**唯一两处行为差异都是刻意的**：三级联动从「点击某一行下钻」改成「**勾选**某一行（可多行）下钻」，首屏默认从「聚焦第一行」改成「前两张表全勾选」。都见 §2。原工程保持不动，方便两版对照。

```bash
npm install
npm run dev        # http://127.0.0.1:5275/
npm run typecheck  # vue-tsc --noEmit
npm run build      # vue-tsc --noEmit && vite build
npm run probe      # 无人值守渲染回归探针（需 dev server 在跑）
```

---

## 1. 这次重写改了什么、没改什么

分层与命令式版本一致，**只有 `ui/` 那一层被换成 Vue**：

| 目录 | 处理方式 | 说明 |
| --- | --- | --- |
| `src/domain/` | **原样复用** | schema：列、小组件、联动规则的唯一事实来源 |
| `src/data/` | 复用 + 联动入参改签名 | `DataSource` 接口 + mock / HTTP 两个实现；`parentId` → `parentIds`（见 §2.0） |
| `src/state/` | 复用 + 联动改语义 | `AppStore`（查询、联动、唯一写路径、脏数据、撤销栈）+ `SelectionModel` |
| `src/table/` | 复用 + 去掉聚焦态 | VTable 封装：列定义、canvas 小组件、编辑器、`LinkedTable` |
| `src/ui/` | **删除，改写为 Vue** | 见下表 |

命令式 `ui/` 与 Vue 组件的对应关系：

| 原文件 | 现在 |
| --- | --- |
| `ui/app.ts`（bootstrap + 工具栏 + 面包屑 + 状态栏） | `App.vue`、`components/AppBar.vue`、`components/CrumbTrail.vue`、`components/StatusBar.vue`、`components/HelpPanel.vue` |
| `ui/panel.ts`（`TablePanel` 类） | `components/TablePane.vue` |
| `ui/dom.ts`（`h` / `clear` / `openPopover` / `openModal` / 格式化） | `components/AppPopover.vue`、`components/AppModal.vue`、`utils/format.ts`（`h`/`clear` 不再需要） |
| `ui/filters.ts` | `components/FilterPanel.vue` + `utils/filter-ops.ts`（纯逻辑） |
| `ui/column-filter.ts` | `components/ColumnFilterPopover.vue` |
| `ui/bulk.ts` | `components/BulkDialog.vue` + `utils/bulk-ops.ts`（纯逻辑） |
| `styles.css` | **原样复用**（类名一个没改，所以视觉零漂移） |

`src/composables/`：

- `store-context.ts` —— `provideStore` / `useStore`，以及把 store 事件翻译成响应式信号的 `useStoreTick` / `useEntityTick`
- `use-linked-table.ts` —— VTable 的挂载 / 卸载
- `panel-registry.ts` —— 三个面板句柄（`{ entity, el, linked }`）的注册表，供状态栏与调试探针使用

---

## 2. 联动改成「勾选驱动」

原版是**点击驱动**：点哪一行，下一张表就收敛为那一行的关联项（`AppStore.focusRow` 把行 id 写进 `rt.focusedId`）。这一版按需求改成**勾选驱动**：

| | 原版（点击） | 这一版（勾选） |
| --- | --- | --- |
| 触发动作 | 单击任意单元格 | 勾选行首复选框 |
| 锚点状态 | `rt.focusedId: RowId \| null` | 上级 `SelectionModel` 里的勾选集合 |
| 一次能下钻几行 | 1 行 | N 行（勾选天生是多选，下级取并集） |
| 查询入参 | `parentId?: string \| null` | `parentIds?: RowId[] \| null` |
| 下级自己的勾选 | 上级变则清空 | 同样清空（结果集换了一批行，旧勾选会指向不存在的结果） |
| 取消下钻 | 「显示全部」/ 面包屑 ✕ / `clearFocus()` | 「显示全部」/ 面包屑 ✕ / `clearSelection()` |
| 点击一行 | 下钻 | **什么都不做**（只做本行的事：点开关翻转、点其它格进编辑） |
| 首屏默认 | 聚焦第一个项目 → 第一个任务（表 2 只有 50 行） | **前两张表全勾选** → 三张表都是全量 |

### 首屏为什么是全勾选

「全勾选 = 作用域覆盖全部行 = 不收窄」，所以这两个要求（前两张表全勾，三张表全量）是同一件事，不需要任何特殊分支：`App.vue` 里就两行 `selectAll()`。

```ts
store.entities.project.selection.selectAll();
await store.selectionChanged('project');   // 会清掉下级勾选，所以任务表要在这之后再全选
store.entities.task.selection.selectAll();
await store.selectionChanged('task');
```

于是首屏既看得出「联动是活的」（面包屑两级都有勾选计数、面板头部显示 `已勾选 2,000 / 100,000`），又没有被收窄 —— 想只看某几个项目的任务，把其余项目的勾去掉即可。

代价：全勾选走的是 `exclude` 模式，**不代表真有 10 万个 id 被逐个记下来**（`selectAll()` 仍是 0ms 的模式位翻转）；但一旦要把「勾了哪些」交给数据源，`ids()` 就得展开成 10 万长度数组，查询侧的扫描分支也变成了常态，所以那边补了两处缓存（见下）。

另外整行会铺选中底色，所以首屏第 1、2 张表是整片淡蓝（canvas 墨迹 15% → 84%）。这是「勾选 = 高亮」的直接结果，也符合常见表格的全选外观；嫌重的话把 `widgets.ts` 里 `background()` 的 `checked` 分支去掉、只留复选框和左侧色条即可。

为什么必须是**唯一入口**：勾选可以来自行内复选框、表头全选、面板上的全选 / 反选 / 清空、批量删除后的清空。全部收敛到 `store.selectionChanged(entity)`：

```ts
async selectionChanged(entity) {
  this.bumpVersion(); this.emit('selection', entity);  // 表格高亮 + 面板计数
  await this.rescopeFrom(entity);                      // 清下级勾选 + 按新作用域刷新下级
}
```

`refresh()` 里也不再缓存「上级勾了谁」，而是直接读上级的 `selection.ids()` —— 于是不存在第二份需要同步的状态：**勾选一变，下级必然跟着变**。为此 `SelectionModel.ids()` 加了按变更失效的缓存（`exclude` 模式下算一次就是一次 10 万行扫描，不能每次刷新都重算）。

### 10 万行下这笔账怎么算的

多选把一个 O(1) 的索引查询变成了「N 个父级取并集」。`MockDataSource.childrenOf()` 按代价分三条路：

| 勾选的父级行数 | 做法 | 代价 |
| --- | --- | --- |
| 1 | 子级索引命中 | O(1) |
| ≤ 32 | 按父级拼接子数组 | = 命中的子行数 |
| > 32 | 一次全表扫描 + Set 判定 | = 子表行数（在任务表全选 10 万行时，10 万次 map 查询比扫 4 万行慢得多） |

首屏默认全勾选之后，**第三条路成了常态**（任务表 10 万个父级），所以两处各加了一层缓存，都按「勾选没变就复用」失效：

- `SelectionModel.ids()` —— 缓存展开结果（`exclude` 模式展开一次就是一次 10 万行扫描）；
- `MockDataSource.scanMemo` —— 按 ids 数组的**引用**缓存那个 Set（`ids()` 勾选一变就换新数组，所以引用判定足够）。

实测首屏两条联动查询：任务表（2,000 个父级 × 10 万行）2ms，明细表（10 万个父级 × 4 万行）11ms。

另外「全选」是**跟随结果集**的语义（`exclude` 模式）：筛选条件一变，被勾选的行就换了一批，所以 `refresh()` 末尾会在全选态下顺带重算下级（`followAllSelected`），否则明细表会一直停在上一批任务的并集上。

## 3. 三个关键设计点

### 3.1 store 不进 Vue 的响应式系统

`AppStore` 是命令式的，只有 `on(topic, handler)`。**没有**把 store 包成 `reactive()`：那会让 10 万行的写路径每一步都背上 Proxy 开销，正是这个 demo 要避免的事。

取而代之的是一个「心跳计数器」：

```ts
const tick = useEntityTick('task');           // 订阅 data/selection/query/mode/status
const countText = computed(() => { void tick.value; /* 读 store，算派生值 */ });
```

事件 → `tick.value++` → computed 失效 → Vue 补丁 DOM。表格本身（canvas）不经过 Vue 的渲染管线：`LinkedTable` 自己订阅 store，走的还是 `setRecords` / `renderWithRecreateCells` 那条最短路径。

`useEntityTick` 刻意**不订阅 `cells`**：单元格级改动只该触发表格重绘，面板头部没必要重算（「联动生效」那个 chip 要抽样扫 3000 行规则）。联动改语义之后也**不再有 `focus` 这个 topic** —— 作用域统一由 `selection` 表达，少一个需要同步的概念。

### 3.2 浮层是组件，不是 `appendChild`

`openPopover()` / `openModal()` 变成 `<AppPopover>` / `<AppModal>`：`<Teleport to="body">` + `v-if` 表达生命周期，内容走插槽，定位 / 点外关闭 / Esc 的逻辑一字未改。表头列筛选的锚点仍然是一个**矩形**（表头画在 canvas 上没有 DOM 节点），`AppPopover` 的 `rect` prop 就是为它准备的。

### 3.3 VTable 的挂载只有一个 onMounted

```ts
const linked = useLinkedTable(bodyEl, { store, entity, onHeaderClick });
```

`onMounted` 里 `new LinkedTable({ container })`，`onBeforeUnmount` 里 `destroy()`。命令式版本是在元素还没进 DOM 时就构造表格、再 `appendChild`；Vue 版反而更稳：容器一定已经在文档里。

---

## 4. 行为等价性怎么验证的

`tools/probe.mjs` 是从原工程**整份搬过来**的回归探针：启动 headless Chrome，用 CDP 打开页面，读真实状态做断言 —— 三个面板都画出了 canvas、墨迹比例、列标题、三级联动的行数收敛、选择/筛选/排序、编辑态开关、11 种编辑器往返、表头列筛选的取值统计与回填、批量弹窗、布局不回退。

选择器、阈值、布局断言都没动，改动只有三类，都写在探针注释里：

1. 默认端口 `5273` → `5275`；
2. 阶段 H3 里「点一下按钮 → 立刻查 DOM」的同步断言插了一拍等待 —— Vue 在微任务里提交 DOM 补丁，这一步异步是实现细节，不是行为差异；
3. **联动相关的阶段按新语义重写**（§2）：`focusRow/clearFocus/notifySelection/focusedId` → `clearSelection/selectionChanged` 与「勾选数」；阶段 J 从「点行 → 下钻」改成「点行**不**下钻 + 勾选才下钻」；新增阶段 C2 验证多选并集；阶段 A 从「首屏收敛」改成「首屏全勾选 = 全量」。

除此之外它断言的是同一套 `.pane-*` / `.crumbs` / `.status-*` / `.filter-panel` / `.col-filter` / `.modal` 契约。

**结果：94 / 94 全绿**。其中与本次改动直接相关的：

```
PASS  首屏：第 1 张表默认全勾选                              — 勾选 2000 / 2000
PASS  首屏：第 2 张表也全勾选，作用域来自第 1 张表的全选      — 勾选 100000 / 作用域 2000
PASS  首屏：全勾选 = 不收窄，三张表都是全量                  — 任务 100000 / 明细 40000
PASS  松开第 1 张表的作用域后，任务表仍是全量 10 万行
PASS  清除勾选后上级作用域确实被松开（不是靠数据本来就这么全） — 作用域 0/0，勾选 0
PASS  勾选多个项目 → 任务表是被勾选项目子行的并集            — 勾选 3 项 / 任务 150，各项目 50+50+50=150
PASS  勾选多行任务 → 明细表是这些任务执行明细的并集          — 勾选 2 个任务 → 明细 234，各任务 167+67
PASS  上级勾选一变，下级自己的勾选被清空                      — 残留 0
PASS  面包屑按勾选显示：多选时是「已勾选 N 项」
PASS  点画布上的行不再触发联动（点击只做本行的事）            — 点击后勾选 0 / 任务仍为 100000
PASS  勾选项目行的复选框 → 任务表收敛为该项目的关联项        — 勾选 1 → 任务 50
PASS  勾选任务 → 明细表按该任务收窄                          — 明细 12 / 预期 12
PASS  再次点击取消勾选 → 明细表松开回到全量                  — 勾选 0 / 明细 40000
PASS  点末级表的一行既不勾选也不联动
PASS  收尾：清除勾选后三张表都回到全量，勾选与作用域都归零
```

性能红线一条没破：10 万行 `setRecords` 242ms、**全选仍是 0ms 的 O(1) 模式翻转**、关键字筛选 100000→838 @132ms、表头列筛选 100000→52267 并正确回填、控制台零 error / 零未捕获异常。

> 探针跑的时候别改源文件：Vite HMR 会整页重载，跑到一半的面板句柄就没了（`panels[1]` 为 null）。踩过一次。

另外做了两版页面的**外壳 DOM 逐行对照**（`tools/dom-snapshot.expr.js`）：

```bash
# 原版跑在 5273，Vue 版跑在 5275
VT_EXPR_FILE=tools/dom-snapshot.expr.js node tools/probe.mjs http://127.0.0.1:5273/ > snap-vanilla.json
VT_EXPR_FILE=tools/dom-snapshot.expr.js node tools/probe.mjs http://127.0.0.1:5275/ > snap-vue.json
```

两份快照（工具栏全部文案与按钮禁用态、面包屑、三个面板头部的标题/作用域/计数/工具按钮/联动 chip、空态覆盖层、每个面板与其 canvas 的尺寸、状态栏）各 132 行，**逐行差异 9 处，全部落在联动相关的字段上，全部是这次改动的预期结果**：

| 差异行 | 原版 | Vue 版 | 原因 |
| --- | --- | --- | --- |
| `bar` | 启动 613ms | 启动 618ms | 每次运行的数据生成耗时抖动 |
| `crumbs`（整行） | 「已下钻到最细粒度；清除任一级…」 | 「取消勾选不需要的行…清空某一级的勾选即可松开这一级」 | 提示文案跟着改语义 |
| `crumbChips` #1 | `项目华南数据中台平台化✕` | `项目已勾选 2,000 项✕` | 面包屑改列「勾了什么」 |
| `crumbChips` #2 | `任务梳理对账任务（信创迁移）✕` | `任务已勾选 100,000 项✕` | 同上 |
| `hd` #1 | 无勾选计数 | `已勾选 2,000` | 首屏默认全勾选 |
| `hd` #2 | `← 项目：华南数据中台平台化` · `50 条` | `← 项目：已勾选 2,000 项` · `100,000 条` · `已勾选 100,000` | 全勾选不收窄，且作用域文案按勾选数显示 |
| `hd` #3 | `← 任务：梳理对账任务（信创迁移）` · `167 条` | `← 任务：已勾选 100,000 项` · `40,000 条` | 同上 |
| `tools` #1 / #2 | `批量操作[disabled]` | `批量操作` | 有勾选行 → 批量操作可用（原版首屏只是「聚焦」，没有勾选） |
| `hd` #2 / #3 的查询耗时 | `<1ms` | `2ms` / `12ms` | 作用域从「1 个父级」变成「2,000 / 100,000 个父级」 |

**关键点：面板布局、列标题、列数、工具按钮集合、联动 chip、空态覆盖层、每个面板与 canvas 的尺寸、状态栏全部逐字符相同** —— 换 Vue、换联动语义、换首屏默认都没有带来任何布局或渲染漂移。差异全部是「联动状态本身」的表达。

截图对照（需要自己看）：

```bash
node tools/shot.mjs http://127.0.0.1:5275/ tools/shots/vue.png
node tools/shot.mjs http://127.0.0.1:5273/ tools/shots/vanilla.png
```

调试钩子也保持了原形状，控制台 / 探针用法不变：

```js
window.__vtDemo.store          // AppStore
window.__vtDemo.panels         // [{ entity, el, linked }]，linked.table 是 ListTable
window.__vtDemo.evaluateRowState
window.__vtDemo.sourceMode     // 'mock' | 'http'
```

## 5. URL 参数

| 参数 | 作用 |
| --- | --- |
| `?p=&t=&e=` | 数据规模（项目 / 任务 / 明细行数），工具栏下拉会重载页面 |
| `?ds=http&api=/api` | 切到预留的 HTTP 分页数据源；连不上后端会自动降级到本地 mock，并在工具栏与状态栏标出来 |
