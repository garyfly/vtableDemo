<script setup lang="ts">
/**
 * 当前联动路径（面包屑）。
 *
 * 它不持有任何状态：一次求值 = 读 store.breadcrumb()，
 * 而 breadcrumb 列的是「每一级勾了什么」—— 因为勾选就是联动本身。
 * 「全部项目」这个 chip 是清除第一级勾选的入口，点了所有下级都会松开。
 */

import { computed } from 'vue';
import { SCHEMAS } from '../domain/schema';
import type { EntityKey } from '../domain/types';
import { useStore, useStoreTick } from '../composables/store-context';

const store = useStore();
const tick = useStoreTick(['selection', 'data', 'query', 'mode', 'status']);

const trail = computed(() => {
  void tick.value;
  return store.breadcrumb();
});

const projectPicked = computed(() => trail.value.some(step => step.entity === 'project'));

const hint = computed(() => {
  if (trail.value.length === 0) return '勾选第 1 张表的任意一行，第 2 张表会自动只留下这些项目的关联任务';
  if (trail.value.length === 1) return '继续勾选第 2 张表的行，第 3 张表会只留下这些任务的执行明细（可以多选）';
  return '取消勾选不需要的行，下级会立刻只剩它们的关联项；清空某一级的勾选即可松开这一级';
});

const clearSelection = (entity: EntityKey): void => void store.clearSelection(entity);
</script>

<template>
  <div class="crumbs">
    <span class="crumb-label">当前联动路径</span>
    <button class="crumb chip-btn" :class="{ on: !projectPicked }" @click="clearSelection('project')">全部{{ SCHEMAS.project.label }}</button>
    <template v-for="step in trail" :key="step.entity">
      <span class="crumb-arrow">›</span>
      <span class="crumb">
        <b>{{ SCHEMAS[step.entity].short }}</b>
        <span>{{ step.title }}</span>
        <button class="chip-x" :title="`清除${SCHEMAS[step.entity].short}这一级的勾选（共 ${step.count} 项）`" @click="clearSelection(step.entity)">✕</button>
      </span>
    </template>
    <span class="crumb-hint">{{ hint }}</span>
  </div>
</template>
