<script setup lang="ts">
/**
 * 列筛选面板（对应命令式版本的 buildFilterPanel）。
 *
 * 条件是有结构的（字段 + 操作符 + 值），不是一句自由文本，所以这里的编辑状态
 * 不是一坨 DOM，而是几个纯数据：当前字段 / 当前操作符 / 两个值槽 + draft 列表。
 *
 * 组件是**纯受控**的：它不认识 AppStore，只吃 fields + conditions 两个 props，
 * 改动全部落在内部的 draft 副本上，点「应用筛选」才把副本交出去。
 * 浮层外壳（定位 / 点外关闭 / Esc）由父组件用 <AppPopover> 包住，这里只渲染
 * `.filter-panel` 这一层内容 —— 原实现里手工清空容器、逐个挂载节点的那部分，
 * 现在全部由响应式模板表达。
 */

import { computed, reactive, ref } from 'vue';
import type { FieldOption, FieldSchema } from '../domain/schema';
import type { FilterCondition, FilterOperator } from '../domain/types';
import {
  OPERATOR_LABEL,
  describeCondition,
  exampleOptions,
  needsSecondValue,
  needsValue,
  operatorsFor,
  valueEditorKind,
  valueInputType,
} from '../utils/filter-ops';

const props = defineProps<{ fields: FieldSchema[]; conditions: FilterCondition[] }>();

const emit = defineEmits<{
  (e: 'apply', conditions: FilterCondition[]): void;
  (e: 'close'): void;
}>();

// 面板只改副本；父组件用 v-if 重建面板，所以不需要额外 watch props.conditions
const draft = ref<FilterCondition[]>(props.conditions.map(c => ({ ...c })));

/* ------------------------------------------------------------------ *
 * 值编辑器
 * ------------------------------------------------------------------ */

/**
 * 一个值槽。
 *
 * `value` 是真正要进条件里的值，`raw` 是输入框里「正在敲的原文」。
 * 两者分开是刻意的：数字类型要把 raw 解析成 Number，如果再把 Number 反写回输入框，
 * `1.` 会被归一化成 `1`，光标也会被顶走 —— 原实现在 DOM 上也只在构建时写一次 value，
 * 之后只把用户输入收进 currentValue。
 */
interface ValueSlot {
  value: unknown;
  raw: string;
}

const slotA = reactive<ValueSlot>({ value: '', raw: '' });
const slotB = reactive<ValueSlot>({ value: '', raw: '' });

const fieldName = ref(props.fields[0]?.field ?? '');
const operator = ref<FilterOperator>('contains');

const currentField = computed<FieldSchema | undefined>(() => props.fields.find(f => f.field === fieldName.value));
const operatorList = computed<FilterOperator[]>(() => operatorsFor(currentField.value?.widget ?? 'text'));
const editorKind = computed(() => valueEditorKind(currentField.value, operator.value));
const inputType = computed(() => valueInputType(currentField.value));
const optionChoices = computed<FieldOption[]>(() => exampleOptions(currentField.value, currentField.value?.widget ?? 'text') ?? []);
const placeholder = computed(() => {
  const fs = currentField.value;
  const unit = fs?.unit ? `（单位 ${fs.unit}）` : '';
  return `${fs?.title ?? ''}${unit}`;
});

/** valueHost 里要放几个编辑器：between 是「值 + 至 + 第二个值」，其余只有一个 */
interface EditorEntry {
  key: string;
  /** 编辑器前面的提示文字；原实现只在 between 时插一行「至」 */
  label: string;
  slot: ValueSlot;
}

const editors = computed<EditorEntry[]>(() => {
  const list: EditorEntry[] = [{ key: 'a', label: '', slot: slotA }];
  if (needsSecondValue(operator.value)) list.push({ key: 'b', label: '至', slot: slotB });
  return list;
});

/** 重建值编辑器时把槽里的值同步到输入框原文上 */
function syncRaw(slot: ValueSlot): void {
  slot.raw = slot.value === undefined || slot.value === null ? '' : String(slot.value);
}

/**
 * 重建值编辑器（原 refreshValue + buildValueEditor 的构建副作用）。
 *
 * switch 那个分支在构建时会**立刻回填一次**值：初始值只可能是 false/'false' 才算关闭，
 * 其余（包括空）一律视为开启。
 */
function refreshValue(): void {
  const switchLike = editorKind.value === 'switch';
  for (const ed of editors.value) {
    if (switchLike) ed.slot.value = ed.slot.value === false || ed.slot.value === 'false' ? false : true;
    syncRaw(ed.slot);
  }
}

/** 切换字段：重建操作符列表 → 清空两个值 → 重建值编辑器（顺序与原 refreshOperators 一致） */
function refreshOperators(): void {
  operator.value = operatorList.value[0] ?? 'contains';
  slotA.value = '';
  slotB.value = '';
  refreshValue();
}

/** 当前槽里已经勾中的候选值（原 buildValueEditor 里的 selected 集合） */
function selectedSet(slot: ValueSlot): Set<string> {
  const v = slot.value;
  if (Array.isArray(v)) return new Set((v as unknown[]).map(String));
  if (v !== undefined && v !== null && v !== '') return new Set([String(v)]);
  return new Set<string>();
}

function isOptionOn(slot: ValueSlot, value: string): boolean {
  return selectedSet(slot).has(value);
}

function onFieldChange(e: Event): void {
  fieldName.value = (e.target as HTMLSelectElement).value;
  refreshOperators();
}

function onOperatorChange(e: Event): void {
  // 换操作符不动已填的值（原实现把 currentValue 当作新编辑器的初始值），只重建编辑器
  operator.value = (e.target as HTMLSelectElement).value as FilterOperator;
  refreshValue();
}

function onToggleOption(slot: ValueSlot, opt: FieldOption, e: Event): void {
  const next = selectedSet(slot);
  if ((e.target as HTMLInputElement).checked) next.add(opt.value);
  else next.delete(opt.value);
  const arr = Array.from(next);
  // 单选操作符取第一个值，in 取整个数组（与原实现 onChange(multiple ? arr : arr[0] ?? '') 一致）
  slot.value = operator.value === 'in' ? arr : arr[0] ?? '';
  syncRaw(slot);
}

function onSwitchChange(slot: ValueSlot, e: Event): void {
  slot.value = (e.target as HTMLSelectElement).value === 'true';
}

function onInputChange(slot: ValueSlot, e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  slot.raw = raw;
  slot.value = inputType.value === 'number' ? (raw === '' ? '' : Number(raw)) : raw;
}

/* ------------------------------------------------------------------ *
 * 已添加条件列表 + 底部动作
 * ------------------------------------------------------------------ */

function addCondition(): void {
  const op = operator.value;
  draft.value.push({
    id: `f${Date.now()}${Math.floor(Math.random() * 1000)}`,
    field: fieldName.value,
    operator: op,
    value: needsValue(op) ? slotA.value : undefined,
    value2: needsSecondValue(op) ? slotB.value : undefined,
  });
}

function removeCondition(cond: FilterCondition): void {
  const i = draft.value.indexOf(cond);
  if (i >= 0) draft.value.splice(i, 1);
}

function clearConditions(): void {
  draft.value.length = 0;
}

function applyConditions(): void {
  // 交出去的是副本：面板里后续的编辑不该改到外面那份
  emit('apply', draft.value.slice());
  emit('close');
}

function removeTitle(cond: FilterCondition): string {
  return props.fields.find(f => f.field === cond.field)?.hint ?? '移除该条件';
}

function fieldLabel(f: FieldSchema): string {
  return `${f.title}${f.unit ? `（${f.unit}）` : ''}`;
}

// 构建面板时就位一次：操作符列表落到第一个，值编辑器按当前字段/操作符建好
refreshOperators();
</script>

<template>
  <div class="filter-panel">
    <div class="filter-sec">
      <div class="sec-title">新增条件</div>
    </div>

    <div class="filter-grid">
      <select class="input" :value="fieldName" @change="onFieldChange">
        <option v-for="f in fields" :key="f.field" :value="f.field">{{ fieldLabel(f) }}</option>
      </select>

      <select class="input" :value="operator" @change="onOperatorChange">
        <option v-for="op in operatorList" :key="op" :value="op">{{ OPERATOR_LABEL[op] }}</option>
      </select>

      <div class="value-host">
        <template v-for="ed in editors" :key="ed.key">
          <div v-if="ed.label" class="field-hint">{{ ed.label }}</div>

          <div v-if="editorKind === 'none'" class="field-hint">该操作符不需要填值</div>

          <div v-else-if="editorKind === 'options'" class="opt-grid">
            <label
              v-for="opt in optionChoices"
              :key="opt.value"
              :class="['opt-item', { on: isOptionOn(ed.slot, opt.value) }]"
            >
              <input
                type="checkbox"
                :checked="isOptionOn(ed.slot, opt.value)"
                @change="onToggleOption(ed.slot, opt, $event)"
              />
              <span class="dot" :style="{ background: opt.color }" />
              <span>{{ opt.label }}</span>
            </label>
          </div>

          <select
            v-else-if="editorKind === 'switch'"
            class="input"
            :value="ed.slot.value === false || ed.slot.value === 'false' ? 'false' : 'true'"
            @change="onSwitchChange(ed.slot, $event)"
          >
            <option value="true">已开启</option>
            <option value="false">已关闭</option>
          </select>

          <input
            v-else
            class="input"
            :type="inputType"
            :step="currentField?.step ?? 'any'"
            :placeholder="placeholder"
            :value="ed.slot.raw"
            @input="onInputChange(ed.slot, $event)"
          />
        </template>
      </div>
    </div>

    <div class="filter-actions">
      <button class="btn pri" @click="addCondition">添加条件</button>
      <button class="btn" @click="clearConditions">清空条件</button>
    </div>

    <div class="filter-sec">
      <div class="sec-title">已添加 {{ draft.length }} 个条件</div>
    </div>

    <div class="cond-list">
      <div v-if="draft.length === 0" class="empty-hint">还没有筛选条件</div>
      <div v-for="c in draft" :key="c.id" class="cond-item">
        <span>{{ describeCondition(c, fields) }}</span>
        <button class="icon-btn" :title="removeTitle(c)" @click="removeCondition(c)">✕</button>
      </div>
    </div>

    <div class="modal-ft-inline">
      <button class="btn pri" @click="applyConditions">
        应用筛选{{ draft.length ? `（${draft.length}）` : '' }}
      </button>
    </div>
  </div>
</template>
