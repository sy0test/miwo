<template>
  <div class="durationStep">
    <div class="hint">
      每段时长受视频模型上限约束（当前上限 <b>{{ cap }}s</b>）。超过上限的段会标红，需要回到解析层重新分段。
    </div>
    <div class="capRow f ac">
      <span>单段上限：</span>
      <t-input-number v-model="capLocal" :min="4" :max="30" theme="normal" size="small" />
      <span class="unit">秒</span>
      <t-button size="small" :loading="saving" @click="confirmCap">确认上限</t-button>
      <span class="tip" v-if="capLocal !== cap">改上限需要重跑解析</span>
    </div>
    <t-table row-key="index" size="small" :data="rows" :columns="columns" :max-height="420" />
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ segments: any[]; cap: number; saving?: boolean }>();
const emit = defineEmits(["confirmCap"]);

const capLocal = ref(props.cap);
watch(
  () => props.cap,
  (v) => (capLocal.value = v),
);

const rows = computed(() => {
  const list = (props.segments || []).map((s: any, i: number) => ({
    index: s.index ?? s.segmentIndex ?? i + 1,
    duration: s.duration,
    sourceRange: s.sourceRange ?? "-",
    over: Number(s.duration) > props.cap,
  }));
  return list;
});

const columns = [
  { colKey: "index", title: "段", width: 80 },
  { colKey: "duration", title: "时长(s)", width: 100 },
  { colKey: "sourceRange", title: "源片区间", width: 200 },
  {
    colKey: "state",
    title: "状态",
    cell: (_h: any, { row }: any) => (row.over ? "超过上限" : "正常"),
  },
];

function confirmCap() {
  emit("confirmCap", capLocal.value);
}
</script>

<style lang="scss" scoped>
.durationStep {
  display: flex;
  flex-direction: column;
  gap: 12px;
  .hint {
    font-size: 12px;
    color: var(--td-text-color-placeholder);
  }
  .capRow {
    gap: 8px;
    font-size: 13px;
    .unit {
      color: var(--td-text-color-placeholder);
    }
    .tip {
      color: var(--td-warning-color);
      font-size: 12px;
    }
  }
}
</style>