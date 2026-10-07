<script setup lang="ts">
/**
 * 「联动规则」浮层：把当前表的全部属性联动规则摊开给人看。
 *
 * 规则本身就是「行级」的，这里只是把 schema 里的声明念出来 ——
 * 面板不参与求值，求值在 domain/schema.ts 的 evaluateRowState 里。
 */

import { computed } from 'vue';
import { SCHEMAS } from '../domain/schema';
import type { EntityKey } from '../domain/types';

const props = defineProps<{ entity: EntityKey }>();
const schema = computed(() => SCHEMAS[props.entity]);
</script>

<template>
  <div class="pop-panel wide">
    <div class="sec-title">{{ schema.label }} · 属性联动规则</div>
    <div class="rule-list">
      <div v-for="r in schema.rules" :key="r.id" class="rule-item">
        <span class="rule-tag">{{ r.tag }}</span>
        <div>
          <div class="rule-label">{{ r.label }}</div>
          <div class="rule-meta">驱动字段：{{ r.driver }} · 影响 {{ r.effects.length }} 个属性</div>
        </div>
      </div>
    </div>
    <div class="pop-note">
      规则是「行级」的：同一列在不同行上可以同时是可见、隐藏或只读。被隐藏的属性会渲染成灰色占位符，双击会给出原因而不是静默失败。
    </div>
  </div>
</template>
