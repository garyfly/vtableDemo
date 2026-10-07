# VTable 三表联动 · 10 万级数据

用 **VTable(VisActor) + 纯 TypeScript + Vite**（无 UI 框架）实现的一个数据管理页面：

- **3 张表逐级联动**：点第 1 张表的一行 → 第 2 张表收敛为该行的关联项；再点第 2 张表 → 第 3 张表展示关联明细。
- **横着分三屏**：三张表左右并排、等宽，各自独立纵向滚动与横向滚动。
- **点表头筛这一列**：点任意数据列的表头，弹出「只管这一列」的筛选面板，确定后表格只剩符合的行。
- **每张表都能全选、筛选、排序**，并有工具栏做批量操作。
- **每列一个独立小组件**：11 种小组件分别负责该属性的展示与编辑。
- **编辑态 / 查看态**：查看态不下发编辑器，属性联动仍然工作（只是全部只读）。
- **属性间联动**：开关类属性会控制后续属性的显隐、只读、必填，并自动清空/派生值。
- **10 万级**：默认生成 项目 2,000 / 任务 100,000 / 明细 40,000，合计约 14.2 万行。

---

## 快速开始

```bash
npm install
npm run dev        # http://127.0.0.1:5273
npm run build      # tsc --noEmit && vite build
npm run probe      # 无人值守渲染回归检查（需要 dev server 已启动）
```

数据规模可以用 URL 参数压测（不传则用默认值）：

```
?p=2000&t=100000&e=40000     # 项目 / 任务 / 明细
```

界面上「数据规模」下拉框会直接改这几个参数并重载页面。

---

## 目录结构

```
src/
  domain/
    types.ts        实体链、行/补丁/查询状态等基础类型
    schema.ts       ★ 三张表的字段定义 + 属性联动规则（唯一的事实来源）
  data/
    datasource.ts   DataSource 接口（换后端只需要实现它）
    mock-source.ts  纯前端 10 万级数据生成 + 内存查询引擎
    http-source.ts  预留的 HTTP 实现，连不上时自动降级到 mock
  state/
    selection.ts    倒排选择模型（10 万行全选 O(1)）
    store.ts        ★ 唯一写路径：联动求值 + 脏标记 + 撤销栈
  table/
    canvas.ts       canvas 图元工具箱（绝对定位绘制）
    widgets.ts      ★ 11 种属性小组件（展示）
    editors.ts      ★ 8 种编辑器（编辑）+ 浮层定位/提交逻辑
    columns.ts      schema → VTable 列定义的编译器
    linked-table.ts ★ VTable 实例封装（数据/选择/编辑态事件接线）
  ui/
    app.ts          外壳：加载页、全局工具栏、三级面包屑、状态栏
    panel.ts        单张表的面板：搜索、筛选、选择、批量、列设置、联动说明
    filters.ts      「筛选」面板：多条件构建器（字段 + 操作符 + 值）
    column-filter.ts ★ 表头列筛选弹窗（点表头 → 只筛这一列）
    bulk.ts         批量操作弹窗
    dom.ts          极简 DOM helper（h / 浮层 / 模态框）
tools/
  probe.mjs         用 Chrome DevTools Protocol 跑的渲染回归探针
```

---

## 架构：为什么这么设计

### 1. 唯一写路径

所有数据修改——内联编辑、开关单击、批量操作、联动派生、撤销/重做、回滚——**都必须经过
`AppStore.applyPatches()`**。它做四件事：

1. `writeCell()` 写入值，然后跑一遍 schema 规则，把**派生值**一起写进去；
2. 用「当前值 vs 已保存值」重算脏标记（方向永远正确，撤销也能正确变干净）；
3. 把 `{before, after}` 压入撤销栈（上限 200）；
4. 只广播 `cells` 事件。

VTable 自己的内联编辑会把值直接写进 `records` 里的行对象（它按引用持有我们传进去的数组）。
所以 `linked-table.ts` 监听 `change_cell_value`，**先把 VTable 写进去的值还原成 `rawValue`，
再走 `store.editCell()`**。这样联动派生、脏标记、撤销栈一个都不会漏。

### 2. 10 万级的四个关键取舍

| 取舍 | 做法 | 原因 |
|---|---|---|
| 行高/列宽 | `heightMode: 'standard'`，`defaultRowHeight: 36`，每列显式 `width` | 一旦开成 `autoHeight`/`adaptive`，VTable 要逐行测量；10 万行直接卡死 |
| 单元格绘制 | 不做 canvas 文本测量，用 CJK 感知的字符宽度估算（`canvas.ts`） | 逐格 `measureText` 是几十毫秒级的开销 |
| 全选 | 倒排 `SelectionModel`（`include`/`exclude` 双模式），全选 = `set.clear()` + 翻转模式位 | 10 万个 checkbox 状态无法逐行维护；实测 **<1ms** |
| 筛选 | 每行预拼一个小写 `_search` 串；父级子数组在生成时建好索引 | 关键字筛选退化为一次 `indexOf`，联动取子集是 O(1) |

实测（默认规模，1662px 宽的可视区）：

- 数据生成 + 首屏三表就绪：**约 34ms**
- 从「只显示 1 个项目的 50 条任务」切到「全量 10 万条」：**约 250ms**
- 10 万行全选：**<1ms**
- 10 万行关键字筛选：**约 15ms**

> 这些数字来自 `tools/probe.mjs` 在 headless Chrome 里的实测，可以用 `npm run probe` 复现。

### 3. 选择列是自己画的，不是 VTable 内置 checkbox 列

内置 checkbox 列的状态存在 VTable 内部，10 万行的全选/反选/清空都要逐行走一遍。
这里改用 `customLayout` 自己画复选框，状态放在 `SelectionModel` 里：

- `selectAll()` / `clear()` 都是 **O(1)**；
- 筛选条件变化时 `setUniverse()` 让选择自动跟随当前结果集语义；
- 重绘走 `renderWithRecreateCells()`，只重建可视区。

### 4. 属性联动是「行级」的，不是「列级」的

`domain/schema.ts` 里的规则形如：

```ts
{
  id: 'exec.billable-derived',
  driver: 'billable',
  when: row => row.billable === true,
  tag: '计费',
  label: '开启计费后，按工时 × 单价自动算出金额',
  effects: [
    { field: 'rate',   value: row => row.rate ?? 300 },
    { field: 'amount', value: row => round(Number(row.hours ?? 0) * Number(row.rate ?? 300), 2) },
  ],
}
```

求值结果是 `Map<field, FieldState>`，含义是：

- `visible: false` → 该单元格画成灰色占位「—」（**列不会逐行消失**，避免列结构抖动）；
- `editable: false` → 画成只读样式，双击会弹提示说明原因，而不是静默失败；
- `required: true` → 空值标红；
- `value` → 幂等改写数据（`applyRuleValues()`），和用户编辑走同一条写路径。

`editable` 只能被规则**收紧**，不能被后续规则重新打开。

面板上的「联动规则」按钮可以把当前表的全部规则列出来——联动不是黑盒。

### 5. 数据源可替换

页面只依赖 `DataSource` 接口：

```ts
interface DataSource {
  init(onProgress?): Promise<void>;
  query(entity, { parentId, query, page }): Promise<QueryResult>;
  patch(entity, patches): Promise<void>;
  remove(entity, ids): Promise<void>;
  getById(entity, id): DataRow | undefined;
  stats(entity): EntityStats;
}
```

- `?ds=mock`（默认）：纯前端生成 + 内存查询；
- `?ds=http`：走 `HttpDataSource`，接 `?api=` 指定的后端；**任何一次请求失败都会自动降级到本地 mock**，
  并在底部状态栏亮出橙色告警条说明原因，不会白屏、也不会假装数据是真实的：

  ```
  ⚠ 后端不可用，当前展示的是本地兜底数据（GET /health -> 非 JSON 响应）
  ```

换成真后端时，`parentId` / 关键字 / 条件 / 排序 / 分页都已经在 `QueryRequest` 里，
`HttpDataSource` 会把它们序列化成 query string，无需改页面代码。

---

## 11 种属性小组件

| 小组件 | 展示 | 编辑方式 |
|---|---|---|
| `link` | 编号 + 下钻箭头 | 单击直接下钻下一级 |
| `text` | 单行省略文本 | 双击 → 单元格内输入框 |
| `user` | 彩色头像 + 姓名 | 单击 → 人员下拉 |
| `select` | 状态色胶囊 | 单击 → 选项浮层 |
| `multiSelect` | 标签胶囊组 | 单击 → 多选浮层（含全选/清空） |
| `number` | 右对齐数字 + 单位 | 单击 → 数字浮层（含范围校验） |
| `money` | 千分位金额 | 单击 → 数字浮层 |
| `progress` | 进度条 + 百分比 | 单击 → 滑块浮层（含 0/25/50/75/100 快捷键） |
| `rating` | 星级 | 单击 → 点星即提交 |
| `date` | 日期 | 双击 → 日期输入 |
| `switch` | 开关 | **单击直接切换**，并立刻触发联动 |

展示用 `customLayout`（每个组件是一个 `Widget` 对象），编辑用 `register.editor()` 注册的
`IEditor` 实例。两者都由同一个字段的 `widget` 字段决定，schema 是唯一的接线点。

---

## 交互速查

| 操作 | 行为 |
|---|---|
| 单击任意行 | 设为聚焦行 → **触发下一级联动** |
| **单击数据列表头** | **弹出该列的筛选弹窗（只筛这一列）** |
| 单击开关单元格 | 直接切换（编辑态），并触发属性联动 |
| 单击编号单元格 | 下钻到下一级 |
| 双击单元格 | 进入编辑（编辑态） |
| Esc | 取消编辑 |
| 单击表头复选框 | 全选 / 取消全选当前结果集 |
| 面板「显示全部」 | 清除本表聚焦，下级回到全部 |
| 面包屑的 ✕ | 清除对应层级的聚焦 |

快捷键：`Ctrl+A` 选择单元格区域，`Tab` 移动焦点单元格。

### 表头列筛选

点任意数据列的表头，弹出**只管这一列**的筛选面板，形态跟着列的组件类型走：

| 列类型 | 弹窗形态 |
|---|---|
| 下拉 / 人员 / 标签 / 开关 / 星级 / 进度 | 勾选式取值列表 + 每项计数 + 值搜索 + 全选/清空 |
| 文本 / 编号 | 包含、不包含、等于、不等于、为空、不为空 + 输入框 |
| 数字 / 金额 | 等于、大于、小于、介于… |
| 日期 | 等于、不早于、不晚于、介于… |

弹窗里同时提供 **升序 / 降序 / 取消排序**（自定义表头不画排序图标，排序入口收在这里）。
生效后的列，表头会变成主色并带一个漏斗角标。

两个实现上的要点：

- **条件复用同一套查询状态**。列筛选和「筛选」面板的条件都写进 `query.conditions`，
  靠 id 前缀区分：列筛选固定是 `col:<field>`。所以两者可以叠加，又能各自独立替换 / 清除。
- **取值计数要排除该列自身的条件**。否则用户筛完之后再打开弹窗，取值列表里就只剩已选中的
  那一个值，没法把范围放宽回来 —— 这正是 `store.valueCounts()` 要重新查一次数据源的原因。

---

## 无人值守回归检查

`tools/probe.mjs` 用 Chrome DevTools Protocol 打开页面，读取真实状态并断言
（它不是单元测试，而是"页面真的画出来了"的端到端检查）：

```bash
npm run dev            # 另开一个终端
npm run probe          # 或 node tools/probe.mjs http://127.0.0.1:5273/
```

覆盖 **86 条断言**：三张表的 canvas 墨迹比例、列标题可读性、三级联动的收敛方向、
10 万行全量装载耗时、全选 O(1)、关键字/条件筛选、排序下推、联动派生 + 脏标记 + 撤销回滚、
编辑态/查看态切换、手写 DOM 工具栏与批量弹窗、编辑器真实往返（点星提交 / Esc 取消）、
合成 pointer 事件的真实画布点击（行聚焦 / 复选框 / 开关单击 / 逐级下钻）、
开关类属性对后续属性的显隐与只读控制、**三屏横排的几何关系与表头列筛选全流程**
（点表头 → 取值统计 → 确定 → 行数收敛且全部命中 → 重开回填 → 清除恢复）、控制台无 error。

调试时可以求值任意表达式（表达式长了就用文件，免得被 shell 引号咬到）：

```bash
VT_EXPR='window.__vtDemo.store.entities.task.rows.length' node tools/probe.mjs
VT_EXPR_FILE=tools/_expr.txt node tools/probe.mjs
```

`window.__vtDemo` 暴露了 `{ store, panels, sourceMode, schemas, evaluateRowState }`，
控制台里可以直接上手玩，也能直接断言字段级联动状态：

```js
__vtDemo.evaluateRowState(__vtDemo.schemas.task, __vtDemo.store.entities.task.rows[0])
```

---

## VTable 集成踩过的坑

这三个都是「代码看着对、但功能静默失效」的类型，全部由 `npm run probe` 抓出来：
### 1. VTable 的内联编辑会绕过你的状态层

VTable 按引用持有你传进 `records` 的数组，编辑完成时**直接改行对象**，
不经过任何 store。所以必须监听 `change_cell_value`，把它"倒回去"再走自己的写路径：

```ts
this.table.on('change_cell_value', args => {
  const rowData = rt.rows[args.recordIndex];
  // ⚠️ 此刻 rowData[field] 已经是新值了，判断"有没有变化"必须用 args.rawValue
  if (sameValue(args.rawValue, args.changedValue)) return;
  rowData[field] = args.rawValue;                       // 回滚 VTable 的旁路写入
  store.editCell(entity, rowData.id, field, args.changedValue, label);
});
```

`args.rawValue` 是 VTable 在写入**之前**抓的快照，`currentValue` / `changedValue` 都是写完之后读的
（在 `changeCellValueByRecord` 那条路径上三者甚至相等）。用 `rowData[field]` 当"旧值"会让判断恒为真，
结果是**编辑看起来生效了，但联动派生、脏标记、撤销栈全部丢失**。

### 2. 编辑器提交的顺序：先拆 DOM 还是先回调

`IEditor` 的实现里很自然会写成：

```ts
commit() { this.teardown(); this.endEditCb?.(); }   // ❌ teardown 把 endEditCb 置空了
commit() { const end = this.endEditCb; this.teardown(); end?.(); }   // ✅
```

写反了的表现是"浮层正常关闭、但值永远提交不上去"——因为 `endEditCb?.()` 变成了空操作，
而浮层关闭是 `teardown()` 干的，看起来一切正常。

### 3. 别用 VTable 内置的 checkbox 列做 10 万行全选

内置 checkbox 状态存在表格内部，全选/反选/清空都要逐行走一遍。
用 `customLayout` 自己画 + 外部 `SelectionModel` 才能做到 O(1)。

### 4. 用合成事件测点击时，`click_cell` 比想象中难触发

探针里模拟真实点击有三条硬规矩，违反任何一条都会得到"点了没反应"的假象：

```js
// ✅ 正确
canvas.dispatchEvent(new PointerEvent('pointerdown', { ...B, pointerId: id, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1 }));
canvas.dispatchEvent(new PointerEvent('pointerup',   { ...B, pointerId: id, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 0 }));
```

- **不要再补一个 `new MouseEvent('click')`**。vrender 的 `normalizeToPointerData`
  只认 `PointerEvent`（纯 `MouseEvent` 会被丢掉），多补这一下反而让本次点击失效。
- **必须点在单元格中心**。贴着列边界会命中 VTable 的列宽拖拽区 →
  `stateManager.isResizeCol()` 变真 → `shouldSkipClickCell` → `click_cell` 压根不发
  （`mouseup_cell` 照样发，所以只看"有没有反应"很容易误判）。
- **确认目标行真的在可视区**。画布只有 ~168px 高，`getCellRect()` 对滚出视口的行
  也会返回坐标，照着点会落到画布下面的 DIV 上。探针里加了 `out-of-canvas` 守卫。

还有个连带坑：`EventTarget.fireListeners` 是 `list.map(...)`，**没有 try/catch**。
任何一个 `click_cell` 监听器抛异常，它后面的监听器就都不会执行，
异常还会冒成"未捕获错误"。排查点击问题时先确认没有监听器在抛错。

### 5. `getCellRect()` 是内容坐标，点之前要先减掉滚动偏移

表头筛选的锚点、探针里的合成点击都踩过这个坑。VTable 有两个长得很像的 API：

| API | 坐标系 |
|---|---|
| `getCellRect(col, row)` | **内容坐标** —— 不含横向/纵向滚动偏移 |
| `getCellRelativeRect(col, row)` | **视口坐标** —— 已经算进滚动偏移，可以直接加 canvas 的左偏移 |

三张表并排之前每屏有 1662px，所有列都塞得下，`scrollLeft` 恒为 0，两者恰好相等，
所以一直没暴露。改成横着三屏后每屏只剩 554px，横向滚动变成常态：

```js
t.setScrollLeft(400);
t.getCellRect(5, 0).left          // 588  ← 一动不动
t.getCellRelativeRect(5, 0).left  // 188  ← 正确
```

另外 `setScrollLeft()` 会立刻改 `getScrollLeft()` 的返回值，但**不会**改 `getCellRect()`，
很容易误判成"滚动没生效"。要判断某列是否真的在可视区，只能用 `getCellRelativeRect()`
（负数 = 滚到左边外面去了）。

### 6. TypeScript 上的两个小坑

- `CustomRenderFunctionArg` **没有 `field`**（有 `originRow`/`originCol`）；要拿字段名得自己映射。
- `IRowSeriesNumber`、`ITableThemeDefine` 这类类型**不在包的主入口**上，
  需要 `import type { IRowSeriesNumber } from '@visactor/vtable/es/ts-types'`
  （该包没有 `exports` 字段，深路径可用）。

---

## 已知边界

- 数据是前端生成的 mock，刷新即重置；没有持久化。
- `evaluateRowState()` 对每行每次渲染都会跑一遍规则（规则数量是常数级，实测无感）。
  如果规则数量涨到几十条，应该换成"按 driver 字段建反向索引 + 按行缓存"。
- 明细表的父级分布是**重尾**的（少数任务吃掉大部分明细），这是刻意的：
  既贴近真实，也保证「点第一个项目 → 点第一个任务」一定能看到成片的数据。
- `HttpDataSource` 的接口契约是按 REST 约定的，接真后端时需要对齐字段名。
- 规模预设下拉里最大的是「超大 · 30 万行」（项目 3 000 / 任务 20 万 / 明细 10 万），实测：
  生成 30 万行约 **1.17s**、JS 堆 ~**190 MB**；20 万行下全选 **5ms**、关键字筛选 **50ms**、
  重置查询（`setRecords` 20 万行）**318ms**。再往上加需要先把 mock 生成改成 Worker，
  否则会阻塞主线程。
- 单元格内边距附近（约 ±8px）是 VTable 的列宽拖拽热区，在那里单击不会触发 `click_cell`。
  这是 VTable 的既有行为，不是本页面的 bug；真要改需要拦 `pointerdown` 自己判热区。
- 横着三屏后每屏只有 ~554px 宽，11 个属性列放不下，靠右的列需要横向滚动才能看到。
  这是「三屏并排」这个布局本身的代价；想一眼看全某几列，用工具栏的「列设置」把
  暂时不关心的列藏掉即可（隐藏后剩下的列会自动铺满）。
- 自定义表头（`headerCustomLayout` + `renderDefault: false`）下 VTable 不会画排序图标，
  所以表头单击只做筛选，排序入口在列筛选弹窗里的「升序 / 降序 / 取消排序」。
