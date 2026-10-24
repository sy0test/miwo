<template>
  <div class="scriptStep">
    <div class="hint">解析出的源片剧本。可以直接改台词和剧情，保存后转绘分镜会按这份内容生成。</div>
    <textarea v-model="local" class="editor" spellcheck="false" placeholder="（这一集还没有剧本内容）"></textarea>
    <div class="foot f ac jb">
      <span class="count">{{ local.length }} 字</span>
      <t-button size="small" theme="default" variant="outline" :loading="saving" @click="save">保存草稿</t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{ modelValue: string; saving?: boolean }>();
const emit = defineEmits(["update:modelValue", "save"]);

const local = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => (local.value = v),
);
watch(local, (v) => emit("update:modelValue", v));

function save() {
  emit("save", local.value);
}
</script>

<style lang="scss" scoped>
.scriptStep {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  .hint {
    font-size: 12px;
    color: var(--td-text-color-placeholder);
  }
  .editor {
    flex: 1;
    min-height: 320px;
    padding: 12px;
    border: 1px solid var(--td-component-border);
    border-radius: 8px;
    background: var(--td-bg-color-container);
    color: var(--td-text-color-primary);
    font-size: 14px;
    line-height: 1.7;
    resize: vertical;
  }
  .foot {
    .count {
      font-size: 12px;
      color: var(--td-text-color-placeholder);
    }
  }
}
</style>