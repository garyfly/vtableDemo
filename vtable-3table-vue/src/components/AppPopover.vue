<script setup lang="ts">
/**
 * 通用浮层。
 *
 * 对应命令式版本的 openPopover()/openPopoverAt()：区别是
 *   - 内容由默认插槽给（不再手工 appendChild 一个 DOM 树）
 *   - 生命周期由 v-if 表达（不再手工 host.remove()）
 * 定位规则保持一字不差：优先贴锚点下方，越界翻到上方，右边越界再左移。
 */
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { AnchorRect } from '../utils/format';

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** 锚点矩形（视口坐标）。用 rect 而不是元素：canvas 表头没有 DOM 节点 */
    rect: AnchorRect | null;
    /** 锚点元素：点在它上面不算「点击外部」 */
    anchorEl?: HTMLElement | null;
    width?: number;
    align?: 'left' | 'right';
  }>(),
  { width: 320, align: 'left', anchorEl: null }
);

const emit = defineEmits<{ (e: 'close'): void }>();

const host = ref<HTMLElement | null>(null);
const left = ref(0);
const top = ref(0);

function place(): void {
  const rect = props.rect;
  if (!rect) return;
  const width = props.width;
  left.value = props.align === 'right' ? Math.max(8, rect.right - width) : Math.min(rect.left, window.innerWidth - width - 8);
  top.value = rect.bottom + 6;
  // 先按「下方」摆好，等真实尺寸量出来再决定是否翻转
  requestAnimationFrame(() => {
    const el = host.value;
    if (!el || !props.open) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > window.innerHeight - 8) top.value = Math.max(8, rect.top - r.height - 6);
    if (r.right > window.innerWidth - 8) left.value = Math.max(8, window.innerWidth - r.width - 8);
  });
}

function onDown(e: MouseEvent): void {
  const target = e.target as Node | null;
  if (!target) return;
  if (host.value?.contains(target)) return;
  if (props.anchorEl?.contains(target)) return;
  emit('close');
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close');
}

function bind(): void {
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
}

function unbind(): void {
  document.removeEventListener('mousedown', onDown, true);
  document.removeEventListener('keydown', onKey, true);
}

watch(
  () => props.open,
  open => {
    if (!open) {
      unbind();
      return;
    }
    void nextTick(() => {
      place();
      bind();
    });
  },
  { immediate: true }
);

// 打开状态下锚点矩形被换掉（例如换了一列表头），重新定位
watch(() => props.rect, () => { if (props.open) place(); });

onBeforeUnmount(unbind);
</script>

<template>
  <Teleport to="body">
    <div v-if="open" ref="host" class="popover" :style="{ left: `${left}px`, top: `${top}px`, width: `${width}px` }">
      <slot />
    </div>
  </Teleport>
</template>
