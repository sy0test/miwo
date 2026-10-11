<template>
  <div class="refDrop" @dragover.prevent @drop.prevent="handleDrop">
    <template v-if="previewUrl">
      <t-image-viewer :images="[previewUrl]" :closeOnEscKeydown="true" :closeOnOverlay="true">
        <template #trigger="{ open }">
          <div class="refThumb">
            <img :src="previewUrl" class="refThumbImg" alt="reference" />
            <t-button class="refThumbPreview" theme="primary" variant="outline" shape="square" @click.stop="open">
              <template #icon><i-expand-text-input /></template>
            </t-button>
            <button class="refThumbRemove" type="button" @click.stop="clear">
              <i-close theme="outline" size="12" />
            </button>
          </div>
        </template>
      </t-image-viewer>
    </template>
    <t-button size="small" theme="default" variant="outline" @click="inputRef?.click()">
      <template #icon><i-upload /></template>
      {{ $t("workbench.cornerScape.referenceUpload") }}
    </t-button>
    <span class="refDropHint">{{ $t("workbench.cornerScape.referenceDropHint") }}</span>
    <input ref="inputRef" type="file" accept="image/*" style="display: none" @change="handleChange" />
  </div>
</template>

<script setup lang="ts">
/**
 * 参考图上传：点选或拖入本地图片，缩略图中间预览、右上角删除。
 * 只持有 File 对象，不落库，页面刷新即失效。
 */
const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;

const props = defineProps<{
  modelValue: File | null;
}>();

const emit = defineEmits<{
  "update:modelValue": [val: File | null];
}>();

const inputRef = ref<HTMLInputElement | null>(null);
const previewUrl = ref("");

watch(
  () => props.modelValue,
  (next) => {
    if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = next ? URL.createObjectURL(next) : "";
  },
  { immediate: true },
);

function accept(candidate: File | null | undefined) {
  if (!candidate) return;
  if (!candidate.type.startsWith("image/")) {
    window.$message.warning($t("workbench.cornerScape.msg.referenceNotImage"));
    return;
  }
  if (candidate.size > MAX_REFERENCE_IMAGE_BYTES) {
    window.$message.warning($t("workbench.cornerScape.msg.referenceTooLarge"));
    return;
  }
  emit("update:modelValue", candidate);
}

function handleChange(e: Event) {
  const target = e.target as HTMLInputElement;
  accept(target.files?.[0]);
  target.value = ""; // 清空以便再次选中同一个文件
}

function handleDrop(e: DragEvent) {
  accept(e.dataTransfer?.files?.[0]);
}

function clear() {
  emit("update:modelValue", null);
}

onBeforeUnmount(() => {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
});
</script>

<style lang="scss" scoped>
.refDrop {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.refDropHint {
  font-size: 12px;
  color: var(--td-text-color-placeholder);
}

.refThumb {
  position: relative;
  width: 96px;
  height: 96px;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--td-component-border);
}

.refThumbImg {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.refThumbPreview {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
}

.refThumbRemove {
  position: absolute;
  top: 3px;
  right: 3px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  cursor: pointer;

  &:hover {
    background: rgba(0, 0, 0, 0.7);
  }
}
</style>
