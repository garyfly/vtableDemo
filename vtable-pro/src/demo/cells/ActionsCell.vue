<script setup lang="ts">
/**
 * 操作列：**可交互**的导入组件。
 *
 * 这一列是唯一打开 `interactive: true` 的列 —— 覆盖层默认 pointer-events: none
 * （不挡 canvas 的滚轮 / 拖选），要让按钮真的能点，必须显式打开。
 * 打开之后这个 DOM 节点就会吃掉自己矩形内的鼠标事件，所以别在一屏几十个的列上乱开。
 */
const props = defineProps<{
  row: Record<string, any>;
  onAction?: (payload: { action: 'view' | 'edit'; row: Record<string, any> }) => void;
}>();

function fire(action: 'view' | 'edit', e: MouseEvent): void {
  e.stopPropagation();
  props.onAction?.({ action, row: props.row });
}
</script>

<template>
  <div class="vtp-cell-actions">
    <button class="vtp-cell-actions__btn" data-action="view" @click="fire('view', $event)">查看</button>
    <button class="vtp-cell-actions__btn primary" data-action="edit" @click="fire('edit', $event)">编辑</button>
  </div>
</template>

<style>
.vtp-cell-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 10px;
  width: 100%;
  height: 100%;
}
.vtp-cell-actions__btn {
  height: 22px;
  padding: 0 8px;
  border: 1px solid #e5e6eb;
  border-radius: 4px;
  background: #fff;
  color: #4e5969;
  font-size: 12px;
  cursor: pointer;
}
.vtp-cell-actions__btn:hover {
  border-color: #165dff;
  color: #165dff;
}
.vtp-cell-actions__btn.primary {
  background: #165dff;
  border-color: #165dff;
  color: #fff;
}
</style>
