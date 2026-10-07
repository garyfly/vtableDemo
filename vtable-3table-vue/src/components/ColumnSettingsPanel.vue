<script setup lang="ts">
/**
 * 「列设置」浮层：勾选要显示的列。
 *
 * 受控组件：隐藏集合由父组件持有（真正生效的是 LinkedTable.hiddenFields），
 * 这里只负责把勾选变化翻译成一次 change 事件。
 */

import { computed } from 'vue';
import { SCHEMAS } from '../domain/schema';
import type { EntityKey } from '../domain/types';

const props = defineProps<{ entity: EntityKey; hidden: string[] }>();
const emit = defineEmits<{ (e: 'change', fields: string[]): void }>();

const fields = computed(() => SCHEMAS[props.entity].fields);
const hiddenSet = computed(() => new Set(props.hidden));

function toggle(field: string, e: Event): void {
  const next = new Set(props.hidden);
  if ((e.target as HTMLInputElement).checked) next.delete(field);
  else next.add(field);
  emit('change', [...next]);
}
</script>

<template>
  <div class="pop-panel">
    <div class="sec-title">列显示</div>
    <div class="col-list">
      <label v-for="f in fields" :key="f.field" class="opt-item" :class="{ on: !hiddenSet.has(f.field) }">
        <input type="checkbox" :checked="!hiddenSet.has(f.field)" @change="toggle(f.field, $event)" />
        <span>{{ f.title }}</span>
        <span class="muted">{{ f.widget }}</span>
      </label>
    </div>
    <div class="pop-actions"><button class="btn" @click="emit('change', [])">全部显示</button></div>
  </div>
</template>
