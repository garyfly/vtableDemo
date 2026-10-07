<script setup lang="ts">
/**
 * 表头列筛选弹窗。
 *
 * 点表头 → 弹出「只管这一列」的筛选面板，形态跟着列的组件类型走：
 *   - 枚举类（下拉 / 人员 / 标签 / 开关 / 星级 / 进度）
 *       → 勾选式取值列表 + 计数，像 Excel / 飞书那样
 *   - 文本类（文本 / 编号）
 *       → 包含 / 不包含 / 等于 / 不等于 + 输入框
 *   - 数值类（数字 / 金额）→ 等于 / 大于 / 小于 / 介于
 *   - 日期类 → 等于 / 不早于 / 不晚于 / 介于
 *
 * 弹窗里同时提供排序入口（升序 / 降序 / 取消），
 * 因为表头的排序图标很小，不好点。
 *
 * 条件本身仍然走 store.setColumnFilter → 数据源谓词，
 * 所以 10 万行下筛选同样是一次内存扫描，不在前端逐行过滤。
 *
 * 与命令式版本（ui/column-filter.ts）的差别只有一处：
 * 原来手工 clear()/appendChild() 的列表与值输入行，现在由响应式状态驱动模板。
 */
import { computed, ref } from 'vue';
import type { FieldOption, FieldSchema, WidgetKind } from '../domain/schema';
import { SCHEMAS } from '../domain/schema';
import type { EntityKey, FilterCondition, FilterOperator } from '../domain/types';
import type { AnchorRect } from '../utils/format';
import { num } from '../utils/format';
import { useStore } from '../composables/store-context';
import AppPopover from './AppPopover.vue';

const props = defineProps<{
  entity: EntityKey;
  field: string;
  /** 表头单元格在视口里的位置；表头画在 canvas 上，没有 DOM 锚点 */
  rect: AnchorRect;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  /** 条件或排序变过之后触发，父组件靠它重建列定义（刷新表头漏斗角标） */
  (e: 'changed'): void;
}>();

const store = useStore();

/* ------------------------------------------------------------------ *
 * 列类型 → 可用的操作符
 * ------------------------------------------------------------------ */

const ENUM_WIDGETS = new Set<WidgetKind>(['select', 'user', 'switch', 'rating', 'progress', 'multiSelect']);
const NUMERIC_WIDGETS = new Set<WidgetKind>(['number', 'money']);
const DATE_WIDGETS = new Set<WidgetKind>(['date']);

const OP_LABEL: Record<string, string> = {
  contains: '包含',
  notContains: '不包含',
  eq: '等于',
  neq: '不等于',
  gt: '大于',
  gte: '不小于',
  lt: '小于',
  lte: '不大于',
  between: '介于',
  empty: '为空',
  notEmpty: '不为空',
  in: '是其中之一',
};

function operatorsFor(widget: WidgetKind): FilterOperator[] {
  if (ENUM_WIDGETS.has(widget)) return ['eq', 'neq', 'empty', 'notEmpty'];
  if (NUMERIC_WIDGETS.has(widget)) return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'notEmpty'];
  if (DATE_WIDGETS.has(widget)) return ['eq', 'gte', 'lte', 'between', 'empty', 'notEmpty'];
  return ['contains', 'notContains', 'eq', 'neq', 'empty', 'notEmpty'];
}

const needsValue = (op: FilterOperator): boolean => op !== 'empty' && op !== 'notEmpty';
const needsValue2 = (op: FilterOperator): boolean => op === 'between';

/* ------------------------------------------------------------------ *
 * 取值 → 显示文案
 * ------------------------------------------------------------------ */

/** 取值列表里那一行显示什么：优先用 schema 里的选项文案和颜色 */
function displayOf(fs: FieldSchema, value: string): { label: string; color?: string } {
  if (value === '') return { label: '（空）' };
  if (fs.widget === 'switch') return { label: value === 'true' ? '已开启' : '已关闭' };
  const opt: FieldOption | undefined = fs.options?.find(o => o.value === value);
  if (opt) return { label: opt.label, color: opt.color };
  if (fs.unit) return { label: `${value}${fs.unit}` };
  return { label: value };
}

/* ------------------------------------------------------------------ *
 * 列 schema 与打开时的既有条件
 * ------------------------------------------------------------------ */

const schemaFields = SCHEMAS[props.entity].fields;
const found = schemaFields.find(f => f.field === props.field);
if (!found) throw new Error(`未知列：${props.entity}.${props.field}`);
// 已知非空，取个别名，后面 computed / 模板里就不用到处判空
const fs: FieldSchema = found;
const field = props.field;
const enumLike = ENUM_WIDGETS.has(fs.widget);

const existing = store.columnFilterOf(props.entity, props.field);

/** 条件或排序写完之后统一收口：先通知父组件重建列定义，再关闭（顺序不能反） */
function commit(pending: Promise<void>): void {
  void pending.then(() => {
    emit('changed');
    emit('close');
  });
}

function close(): void {
  emit('close');
}

/** 清除本列筛选 */
function clearFilter(): void {
  commit(store.setColumnFilter(props.entity, field, null));
}

/* ------------------------------------------------------------------ *
 * 枚举类：勾选取值列表
 * ------------------------------------------------------------------ */

const allValues = ref<string[]>([]);
const counts = ref<Map<string, number>>(new Map());
/** 统计是否已结束（成功或失败），决定列表里显示哪一段 */
const ready = ref(false);
const failed = ref(false);
/** 统计跑完就允许确定：即便失败，确定也等价于「清掉这一列的筛选」（与原实现一致） */
const canApply = ref(false);
const keyword = ref('');

/** 把已有条件回填进勾选状态：in 取数组、eq 取单值 */
function initialPicked(): string[] {
  if (existing && existing.operator === 'in' && Array.isArray(existing.value)) {
    return (existing.value as unknown[]).map(String);
  }
  if (existing && existing.operator === 'eq') return [String(existing.value)];
  return [];
}

const selected = ref<Set<string>>(new Set(initialPicked()));

if (enumLike) {
  // 取值分布是异步算的（要跑一遍数据源），先渲染个「统计中」
  void store
    .valueCounts(props.entity, field)
    .then(rows => {
      allValues.value = rows.map(r => r.value);
      counts.value = new Map(rows.map(r => [r.value, r.count]));
      ready.value = true;
      canApply.value = true;
    })
    .catch(() => {
      ready.value = true;
      failed.value = true;
      canApply.value = true;
    });
}

/** 搜索框过滤后的可见行；勾选态也在这里读，勾一下自动重算 */
const shownRows = computed(() => {
  if (!ready.value || failed.value) return [];
  const q = keyword.value.trim().toLowerCase();
  return allValues.value
    .filter(v => {
      if (!q) return true;
      const d = displayOf(fs, v);
      return v.toLowerCase().includes(q) || d.label.toLowerCase().includes(q);
    })
    .map(v => {
      const d = displayOf(fs, v);
      return { value: v, label: d.label, color: d.color, count: counts.value.get(v) ?? 0, on: selected.value.has(v) };
    });
});

const summaryText = computed(() => {
  if (!ready.value) return '统计中…';
  return selected.value.size === 0 ? '未选择 = 不筛选' : `已选 ${selected.value.size} / ${allValues.value.length}`;
});

function togglePick(value: string, e: Event): void {
  if ((e.target as HTMLInputElement).checked) selected.value.add(value);
  else selected.value.delete(value);
}

function selectAllShown(): void {
  // 只全选"当前搜出来"的那些，符合直觉
  const q = keyword.value.trim().toLowerCase();
  for (const v of allValues.value) {
    const d = displayOf(fs, v);
    if (!q || v.toLowerCase().includes(q) || d.label.toLowerCase().includes(q)) selected.value.add(v);
  }
}

function clearPicked(): void {
  selected.value.clear();
}

function applyEnum(): void {
  const picked = Array.from(selected.value);
  // 一个都没勾 / 全勾 = 等价于不筛选
  const cond: FilterCondition | null =
    picked.length === 0 || picked.length === allValues.value.length ? null : { id: '', field, operator: 'in', value: picked };
  commit(store.setColumnFilter(props.entity, field, cond));
}

/* ------------------------------------------------------------------ *
 * 文本 / 数值 / 日期：操作符 + 值
 * ------------------------------------------------------------------ */

const ops = operatorsFor(fs.widget);
const op = ref<FilterOperator>(existing?.operator && ops.includes(existing.operator) ? existing.operator : ops[0]);
const inputType = DATE_WIDGETS.has(fs.widget) ? 'date' : NUMERIC_WIDGETS.has(fs.widget) ? 'number' : 'text';
const stepValue: number | string = fs.step ?? 'any';
const placeholder1 = `筛选值${fs.unit ? `（${fs.unit}）` : ''}`;

/** 输入框的初值：null / undefined 一律给空串 */
const rawOf = (value: unknown): string => (value === undefined || value === null ? '' : String(value));
const v1 = ref<string>(rawOf(existing?.value));
const v2 = ref<string>(rawOf(existing?.value2));

const showValue = computed(() => needsValue(op.value));
const showValue2 = computed(() => needsValue2(op.value));

function applyForm(): void {
  const cur = op.value;
  const cond: FilterCondition | null = needsValue(cur)
    ? {
        id: '',
        field,
        operator: cur,
        value: valueOf(v1.value, cur, fs),
        value2: needsValue2(cur) ? valueOf(v2.value, cur, fs) : undefined,
      }
    : { id: '', field, operator: cur };
  commit(store.setColumnFilter(props.entity, field, cond));
}

/** 输入框的值按列类型转一下：数值列转 number，其余保持字符串 */
function valueOf(raw: string, _op: FilterOperator, fs: FieldSchema): unknown {
  if (raw === '') return '';
  if (NUMERIC_WIDGETS.has(fs.widget)) return Number(raw);
  return raw;
}

/* ------------------------------------------------------------------ *
 * 排序：表头图标的可点区域太小，这里再给一份
 * ------------------------------------------------------------------ */

const curSort = store.entities[props.entity].query.sort;
const isSorted = curSort?.field === field;
const ascPri = isSorted && curSort?.order === 'asc';
const descPri = isSorted && curSort?.order === 'desc';

function sortBy(order: 'asc' | 'desc'): void {
  commit(store.setSort(props.entity, { field, order }));
}

function cancelSort(): void {
  commit(store.setSort(props.entity, null));
}

/* ------------------------------------------------------------------ *
 * 确定按钮：枚举类要等统计出来
 * ------------------------------------------------------------------ */

// 统计是异步落地的，所以这里必须是 computed：跑完那一刻按钮要自己亮起来
const applyDisabled = computed(() => enumLike && !canApply.value);

function apply(): void {
  if (enumLike) applyEnum();
  else applyForm();
}
</script>

<template>
  <AppPopover :open="true" :rect="rect" :width="288" align="left" @close="close">
    <div class="col-filter">
      <!-- 头部 -->
      <div class="cf-hd">
        <b>{{ fs.title }}</b>
        <span class="cf-sub">{{ enumLike ? '勾选要保留的取值' : '设置筛选条件' }}</span>
        <button class="icon-btn" title="关闭" @click="close">✕</button>
      </div>

      <!-- 主体 -->
      <div class="cf-bd">
        <!-- 枚举类 -->
        <template v-if="enumLike">
          <div class="cf-tools">
            <input v-model="keyword" class="input compact" type="search" placeholder="在本列取值里搜索…" />
            <div class="cf-bulk">
              <button class="btn tiny" @click="selectAllShown">全选</button>
              <button class="btn tiny" @click="clearPicked">清空</button>
            </div>
          </div>
          <div class="cf-list">
            <div v-if="!ready" class="empty-hint">正在统计本列取值…</div>
            <div v-else-if="failed" class="empty-hint">取值统计失败，可直接用「筛选」面板</div>
            <template v-else>
              <div v-if="shownRows.length === 0" class="empty-hint">没有匹配的取值</div>
              <label v-for="row in shownRows" :key="row.value" class="cf-item" :class="{ on: row.on }">
                <input type="checkbox" :checked="row.on" @change="togglePick(row.value, $event)" />
                <span v-if="row.color" class="dot" :style="{ background: row.color }" />
                <span class="cf-item-label" :title="row.label">{{ row.label }}</span>
                <span class="cf-item-n">{{ num(row.count) }}</span>
              </label>
            </template>
          </div>
          <div class="cf-sum"><span class="cf-count">{{ summaryText }}</span></div>
        </template>

        <!-- 文本 / 数值 / 日期 -->
        <div v-else class="cf-form">
          <label class="cf-label">条件</label>
          <select v-model="op" class="input">
            <option v-for="o in ops" :key="o" :value="o">{{ OP_LABEL[o] ?? o }}</option>
          </select>
          <div class="cf-label">值</div>
          <div class="cf-vals">
            <div v-if="!showValue" class="field-hint">该操作符不需要填值</div>
            <template v-else>
              <input v-model="v1" class="input" :type="inputType" :step="stepValue" :placeholder="placeholder1" />
              <template v-if="showValue2">
                <span class="cf-tilde">~</span>
                <input v-model="v2" class="input" :type="inputType" :step="stepValue" placeholder="上限" />
              </template>
            </template>
          </div>
        </div>
      </div>

      <!-- 底部动作 -->
      <div class="cf-ft">
        <button class="btn" @click="clearFilter">清除本列筛选</button>
        <span class="spacer" />
        <button class="btn ghost" @click="close">取消</button>
        <button class="btn pri" :disabled="applyDisabled" @click="apply">确定</button>
      </div>

      <!-- 排序 -->
      <div class="cf-sort">
        <span class="cf-label">排序</span>
        <button class="btn tiny" :class="{ pri: ascPri }" @click="sortBy('asc')">↑ 升序</button>
        <button class="btn tiny" :class="{ pri: descPri }" @click="sortBy('desc')">↓ 降序</button>
        <button v-if="isSorted" class="btn tiny ghost" @click="cancelSort">取消排序</button>
      </div>
    </div>
  </AppPopover>
</template>
