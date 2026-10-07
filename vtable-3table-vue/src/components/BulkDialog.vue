<script setup lang="ts">
/**
 * 批量操作弹窗（对应命令式版本的 openBulkDialog）。
 *
 * 10 万级批量修改的关键不是弹窗本身，而是**改完之后不要整表重载**：
 * 这里只产出 patches，交给 store 统一写回，
 * 表格侧收到的是「cells 变了」而不是「行集变了」，因此只重画可视区。
 *
 * 原来手工 replaceChildren 出来的三块（操作符单选、操作数编辑器、汇总行）
 * 现在都交给模板按状态渲染：字段 / 操作符 / 操作数就是三个状态。
 */
import { computed, ref, watch } from 'vue';
import { SCHEMAS, type FieldSchema } from '../domain/schema';
import type { EntityKey } from '../domain/types';
import { useStore } from '../composables/store-context';
import { num } from '../utils/format';
import { buildBulkPatches, defaultOperand, labelOf, opsFor, type OpDef, type OpKind } from '../utils/bulk-ops';
import AppModal from './AppModal.vue';

const props = defineProps<{ entity: EntityKey }>();
const emit = defineEmits<{ (e: 'close'): void }>();

const store = useStore();
/** schema 由 entity 推导，不从父组件传进来 */
const schema = computed(() => SCHEMAS[props.entity]);
const fields = computed(() => schema.value.fields.filter(f => f.editable && f.bulkEditable !== false));

const rt = store.entities[props.entity];
// 选中行在打开时快照一次：原实现也是弹窗一打开就固化，
// 模态遮罩挡着表格，弹窗期间选中集不会再变。
const selectedRows = rt.selection.selectedRows();
const selectedCount = rt.selection.size;

const currentFieldName = ref(fields.value[0]?.field ?? '');
/** 兜底到 schema 的第一个字段，保证它永远是有效字段（模板那边另有 fields 为空的拦截） */
const currentField = computed<FieldSchema>(
  () => fields.value.find(f => f.field === currentFieldName.value) ?? fields.value[0] ?? schema.value.fields[0]
);
/** 操作符随字段变 */
const ops = computed<OpDef[]>(() => opsFor(currentField.value));
/** 候选值（select / multiSelect）；没有就退回空数组，模板里不用再判空 */
const fieldOptions = computed(() => currentField.value.options ?? []);
const currentOp = ref<OpKind>(ops.value[0].kind);
const operand = ref<unknown>(defaultOperand(currentField.value, currentOp.value));
/**
 * 输入框里那串原始文本。
 *
 * 它和 operand 分开存是有原因的：`<input type="number">` 在「1.」这类中间态下
 * 读回来的 value 是空串，如果直接把空串写回去会把用户刚敲的小数点顶掉；
 * 原实现只在创建编辑器时设一次 value，这里保持同样的写法。
 */
const operandText = ref(String(operand.value ?? ''));

const inputType = computed<'date' | 'number' | 'text'>(() => {
  const numeric = ['number', 'money', 'progress', 'rating'].includes(currentField.value.widget);
  return currentField.value.widget === 'date' ? 'date' : numeric ? 'number' : 'text';
});

const unitPlaceholder = computed(() => (currentField.value.unit ? `单位：${currentField.value.unit}` : ''));

/** 操作数回到当前「字段 × 操作符」的默认值（原来 refreshOperand 干的事） */
function resetOperand(): void {
  operand.value = defaultOperand(currentField.value, currentOp.value);
  operandText.value = String(operand.value ?? '');
}

// 换字段：操作符先回到该字段的第一个选项，操作数再跟着重算（原来 refreshOps 的第一步 + refreshOperand）
watch(currentFieldName, () => {
  currentOp.value = ops.value[0].kind;
  resetOperand();
});

// 单选换操作符：操作数跟着重算
watch(currentOp, resetOperand);

function onFieldChange(e: Event): void {
  currentFieldName.value = (e.target as HTMLSelectElement).value;
}

function onOpChange(kind: OpKind): void {
  currentOp.value = kind;
}

function onSwitchChange(e: Event): void {
  operand.value = (e.target as HTMLSelectElement).value === 'true';
}

function onOptionChange(e: Event): void {
  operand.value = (e.target as HTMLSelectElement).value;
}

function onInput(e: Event): void {
  const raw = (e.target as HTMLInputElement).value;
  operandText.value = raw;
  operand.value = inputType.value === 'number' ? (raw === '' ? 0 : Number(raw)) : raw;
}

function onExecute(): void {
  if (rt.selection.isEmpty) {
    store.setStatus('请先勾选要修改的行');
    return;
  }
  const patches = buildBulkPatches(currentField.value, currentOp.value, operand.value, selectedRows);
  store.applyPatches(props.entity, patches, `批量${labelOf(currentOp.value)}「${currentField.value.title}」`);
  store.setStatus(`已批量修改 ${patches.length} 行 · ${currentField.value.title}（可撤销）`);
  emit('close');
}
</script>

<template>
  <!-- fields 为空时原实现直接 return（压根不弹窗），这里等价于整块不渲染 -->
  <AppModal v-if="fields.length > 0" :title="`批量操作 · ${schema.label}`" @close="emit('close')">
    <div class="bulk-body">
      <div class="field-row">
        <label class="field-label">目标属性</label>
        <div class="field-control">
          <select class="input" :value="currentFieldName" @change="onFieldChange">
            <option v-for="f in fields" :key="f.field" :value="f.field">{{ f.title }}</option>
          </select>
        </div>
      </div>

      <div class="field-row">
        <label class="field-label">操作</label>
        <div class="field-control">
          <div class="op-row">
            <label v-for="o in ops" :key="o.kind" class="op-item" :class="{ on: o.kind === currentOp }">
              <input type="radio" name="bulk-op" :checked="o.kind === currentOp" @change="onOpChange(o.kind)" />
              <span>{{ o.label }}</span>
            </label>
          </div>
        </div>
      </div>

      <div class="field-row">
        <label class="field-label">值</label>
        <div class="field-control">
          <div class="operand-host">
            <div v-if="currentOp === 'toggle'" class="field-hint">把每一行的开关取反</div>
            <select
              v-else-if="currentField.widget === 'switch'"
              class="input"
              :value="operand === false ? 'false' : 'true'"
              @change="onSwitchChange"
            >
              <option value="true">已开启</option>
              <option value="false">已关闭</option>
            </select>
            <select
              v-else-if="fieldOptions.length > 0"
              class="input"
              :value="String(operand ?? '')"
              @change="onOptionChange"
            >
              <option v-for="o in fieldOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
            </select>
            <input
              v-else
              class="input"
              :type="inputType"
              :value="operandText"
              :step="currentField.step ?? 'any'"
              :placeholder="unitPlaceholder"
              @input="onInput"
            />
          </div>
        </div>
      </div>

      <div class="bulk-note">联动提示：被 schema 规则约束的属性（例如「已交付」任务的进度）在写回时会自动重新求值，批量改也不会绕过规则。</div>

      <div class="bulk-summary">
        <b>{{ num(selectedCount) }}</b> 行将被修改
        <span v-if="selectedCount === 0" class="warn">（当前没有勾选任何行，请先勾选）</span>
        <span v-if="selectedCount > 50000" class="warn">（数据量较大，将生成等量单元格补丁，可通过「撤销」整体回退）</span>
      </div>
    </div>

    <template #footer>
      <div class="modal-ft-row">
        <button class="btn" @click="emit('close')">取消</button>
        <button class="btn pri" @click="onExecute">执行</button>
      </div>
    </template>
  </AppModal>
</template>
