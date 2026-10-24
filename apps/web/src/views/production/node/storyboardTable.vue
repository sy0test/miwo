<template>
  <t-card class="storyboardTable">
    <div class="titleBar dragHandle pr">
      <div class="title c">{{ $t("workbench.production.node.storyboardTable.title") }}</div>
      <t-button size="small" variant="text" @click="openEdit">{{ $t("workbench.production.edit") }}</t-button>
      <Handle :id="props.handleIds.target" type="target" :position="Position.Left" style="left: calc(-1 * var(--td-comp-paddingLR-xl))" />
      <Handle :id="props.handleIds.source" type="source" :position="Position.Right" style="right: calc(-1 * var(--td-comp-paddingLR-xl))" />
    </div>
    <div class="storyboardList">
      <t-empty v-if="!storyboardTable" style="margin-top: 16px"></t-empty>
      <MdPreview v-else v-model="storyboardTable" :theme="themeSetting.mode === 'dark' ? 'dark' : 'light'" />
    </div>
    <!-- 结构化同步反馈（阶段2）：手改分镜表保存后，后端会再解析 + 事务落库并把结果回传。
         没有这一块的话，用户只能从日志猜"结构有没有跟上、有没有违规"。 -->
    <div v-if="shotsSync" class="syncBar" :class="{ warn: !!shotsSync.errors.length || !!shotsSync.warnings.length }">
      <div class="line">
        <span class="dot"></span>
        <span class="txt">{{ shotsSync.note }}</span>
      </div>
      <ul v-if="shotsSync.errors.length" class="list err">
        <li v-for="(e, i) in shotsSync.errors.slice(0, 6)" :key="'e' + i">✗ {{ e }}</li>
        <li v-if="shotsSync.errors.length > 6" class="more">… 另有 {{ shotsSync.errors.length - 6 }} 条</li>
      </ul>
      <ul v-if="shotsSync.warnings.length" class="list dim">
        <li v-for="(w, i) in shotsSync.warnings.slice(0, 4)" :key="'w' + i">! {{ w }}</li>
        <li v-if="shotsSync.warnings.length > 4" class="more">… 另有 {{ shotsSync.warnings.length - 4 }} 条</li>
      </ul>
    </div>
  </t-card>

  <t-dialog
    v-model:visible="dialogVisible"
    :header="$t('workbench.production.node.storyboardTable.editDialog')"
    :width="'90vw'"
    :confirm-btn="$t('workbench.production.save')"
    :cancel-btn="$t('workbench.production.cancel')"
    @confirm="onConfirm"
    @cancel="onCancel"
    @close="onCancel"
    :close-on-overlay-click="false"
    placement="center"
    attach="body">
    <MdEditor
      v-model="editContent"
      :theme="themeSetting.mode === 'dark' ? 'dark' : 'light'"
      :toolbars="toolbars"
      :footers="[]"
      style="height: 72vh"
      @onUploadImg="() => {}"
      @drop.prevent
      @paste="onPaste" />
  </t-dialog>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { Handle, Position } from "@vue-flow/core";
import { MdEditor, MdPreview } from "md-editor-v3";
import type { ToolbarNames } from "md-editor-v3";
import settingStore from "@/stores/setting";
import productionAgentStore from "@/stores/productionAgent";
const { themeSetting } = storeToRefs(settingStore());
// 结构化同步结果（阶段2）：由 store 在保存分镜表后写入
const { shotsSync } = storeToRefs(productionAgentStore());

const props = defineProps<{
  id: string;
  handleIds: {
    target: string;
    source: string;
  };
}>();

const storyboardTable = defineModel<string>({ required: true });
const editContent = ref("");
const dialogVisible = ref(false);

const toolbars: ToolbarNames[] = [
  "bold",
  "underline",
  "italic",
  "strikeThrough",
  "-",
  "title",
  "sub",
  "sup",
  "quote",
  "unorderedList",
  "orderedList",
  "task",
  "-",
  "codeRow",
  "code",
  "table",
  "-",
  "revoke",
  "next",
  "=",
  "preview",
];

function openEdit() {
  editContent.value = storyboardTable.value ?? "";
  dialogVisible.value = true;
}

function onConfirm() {
  storyboardTable.value = editContent.value;
  dialogVisible.value = false;
  productionAgentStore().setFlowData();

}

function onCancel() {
  dialogVisible.value = false;
}

function onPaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (item.type.startsWith("image/") || item.type.startsWith("video/")) {
      e.preventDefault();
      return;
    }
  }
}
</script>

<style lang="scss" scoped>
.storyboardTable {
  max-width: 100vw;
  width: fit-content;
  min-width: 100px;
  user-select: text;
  cursor: default;

  .titleBar {
    cursor: grab;
    user-select: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .title {
    background-color: #000;
    width: fit-content;
    padding: 5px 10px;
    color: #fff;
    border-radius: 8px 0;
    font-size: 16px;
  }

  // 结构化同步反馈（阶段2）
  .syncBar {
    margin-top: 10px;
    padding: 8px 10px;
    border-radius: 8px;
    background-color: var(--td-bg-color-container-hover);
    border-left: 3px solid var(--td-success-color);
    font-size: 12px;
    max-width: 760px;
    &.warn {
      border-left-color: var(--td-warning-color);
    }
    .line {
      display: flex;
      gap: 6px;
      align-items: flex-start;
    }
    .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--td-success-color);
      margin-top: 6px;
      flex: 0 0 6px;
    }
    &.warn .dot {
      background: var(--td-warning-color);
    }
    .txt {
      color: var(--td-text-color-secondary);
      word-break: break-all;
    }
    .list {
      margin: 4px 0 0;
      padding-left: 16px;
      &.err {
        color: var(--td-error-color);
      }
      &.dim {
        color: var(--td-text-color-placeholder);
      }
      li {
        margin: 2px 0;
      }
    }
    .more {
      opacity: 0.8;
    }
  }

  .storyboardList {
    display: flex;
    flex-direction: column;
    margin-top: 8px;
    :deep(.md-editor) {
      border: none;
      box-shadow: none;
    }

    :deep(.md-editor-preview-wrapper) {
      padding: 0;
    }
  }

  .storyboardItem {
    display: flex;
    align-items: flex-start;
    padding: 12px 0;
    border-bottom: 1px solid var(--td-border-level-1-color, #e7e7e7);

    &:last-child {
      border-bottom: none;
    }
  }

  .itemTag {
    flex-shrink: 0;
    width: 36px;
    height: 22px;
    border-radius: 4px;
    color: #fff;
    font-size: 12px;
    font-weight: 500;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-right: 12px;
    margin-top: 2px;
  }

  .itemContent {
    flex: 1;
    min-width: 0;
  }

  .itemHeader {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .itemTags {
    display: flex;
    gap: 5px;
    flex-shrink: 0;
    margin-left: 12px;
  }

  .itemTitle {
    font-size: 14px;
    color: var(--td-text-color-primary, #333);
    line-height: 1.5;
  }

  .itemDetail {
    font-size: 12px;
    color: var(--td-text-color-secondary, #999);
    line-height: 1.4;

    .sep {
      margin: 0 6px;
      color: var(--td-border-level-1-color, #ddd);
    }
  }
}
</style>
