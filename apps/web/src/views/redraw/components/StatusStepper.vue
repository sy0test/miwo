<template>
  <div class="redrawStepper f ac">
    <div v-for="s in steps" :key="s.n" class="stepItem f ac" :class="{ active: modelValue === s.n, done: modelValue > s.n, locked: !reachable(s.n) }" @click="go(s.n)">
      <span class="dot fc c">{{ modelValue > s.n ? "✓" : s.n }}</span>
      <span class="label">{{ s.label }}</span>
      <span v-if="s.n < steps.length" class="line"></span>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  modelValue: number;
  access: { step2: boolean; step3: boolean };
}>();
const emit = defineEmits(["update:modelValue"]);

const steps = [
  { n: 1, label: "剧本" },
  { n: 2, label: "资产" },
  { n: 3, label: "时长" },
];

function reachable(n: number) {
  if (n <= 1) return true;
  if (n === 2) return props.access.step2;
  return props.access.step3;
}
function go(n: number) {
  if (reachable(n)) emit("update:modelValue", n);
}
</script>

<style lang="scss" scoped>
.redrawStepper {
  gap: 8px;
  padding: 12px 16px;
  background: var(--td-bg-color-container);
  border-radius: 12px;

  .stepItem {
    gap: 8px;
    cursor: pointer;
    color: var(--td-text-color-placeholder);
    font-size: 14px;

    .dot {
      width: 24px;
      height: 24px;
      border-radius: 50%;
      border: 1px solid var(--td-component-border);
      font-size: 12px;
    }
    .line {
      width: 48px;
      height: 1px;
      background: var(--td-component-border);
      margin: 0 4px;
    }
  }
  .stepItem.active {
    color: var(--td-brand-color);
    .dot {
      border-color: var(--td-brand-color);
      color: var(--td-brand-color);
    }
  }
  .stepItem.done {
    color: var(--td-success-color);
    .dot {
      border-color: var(--td-success-color);
      color: var(--td-success-color);
    }
  }
  .stepItem.locked {
    cursor: not-allowed;
    opacity: 0.5;
  }
}
</style>