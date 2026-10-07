<script setup lang="ts">
/**
 * 居中模态框（对应命令式版本的 openModal）。
 * 结构 / 类名与原来一致，只是主体和底部改成了插槽。
 */
import { onBeforeUnmount, onMounted } from 'vue';

defineProps<{ title: string }>();
const emit = defineEmits<{ (e: 'close'): void }>();

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

onMounted(() => document.addEventListener('keydown', onKey, true));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey, true));
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @mousedown.self="emit('close')">
      <div class="modal">
        <div class="modal-hd">
          <b>{{ title }}</b>
          <button class="icon-btn" title="关闭" @click="emit('close')">✕</button>
        </div>
        <div class="modal-bd">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-ft">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>
