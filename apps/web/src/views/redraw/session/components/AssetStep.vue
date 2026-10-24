<template>
  <div class="assetStep">
    <div class="hint">
      解析出的角色 / 场景 / 道具。可以复用项目里已有的资产，也可以改名、改性别、改设定；确认后才会写进资产库。
    </div>
    <div class="grid">
      <t-card v-for="d in drafts" :key="d.name" class="assetCard" shadow>
        <div class="head f ac jb">
          <div class="left f ac">
            <t-tag size="small" variant="light-outline">{{ typeLabel(d.type) }}</t-tag>
            <span class="name">{{ d.name }}</span>
          </div>
          <t-tag v-if="stateOf(d) === 'done'" theme="success" size="small">已确认</t-tag>
          <t-tag v-else theme="warning" size="small">待处理</t-tag>
        </div>
        <div class="field">
          <label>目标国名字</label>
          <input v-model="d.targetName" class="input" :placeholder="d.name" />
        </div>
        <div class="field">
          <label>说明</label>
          <textarea v-model="d.desc" class="area" rows="2" placeholder="角色/场景/道具的中文说明"></textarea>
        </div>
        <div class="field">
          <label>出图提示词</label>
          <textarea v-model="d.prompt" class="area" rows="2" placeholder="中文提示词，用于资产生图"></textarea>
        </div>
        <div class="actions f ac">
          <select class="select" @change="onPick(d, $event)">
            <option value="">复用已有资产…</option>
            <option v-for="a in existingByType(d.type)" :key="a.id" :value="a.id">{{ a.name }}</option>
          </select>
          <t-button size="small" variant="outline" @click="emit('create', d)">新建资产</t-button>
          <t-button v-if="d.assetId" size="small" variant="text" @click="emit('update', d.assetId, { name: d.targetName, describe: d.desc, prompt: d.prompt })">
            保存修改
          </t-button>
        </div>
        <div class="bound" v-if="bindings[d.name]">已绑定资产 #{{ bindings[d.name] }}</div>
      </t-card>
    </div>
    <div class="foot f ac jb">
      <span class="count">已确认 {{ doneCount }} / {{ drafts.length }}</span>
      <t-button theme="primary" :disabled="!allDone" :loading="confirming" @click="emit('confirm')">全部确认</t-button>
    </div>
  </div>
</template>

<script setup lang="ts">
const props = defineProps<{
  drafts: any[];
  existing: any[];
  bindings: Record<string, number>;
  confirming?: boolean;
}>();
const emit = defineEmits(["bind", "create", "update", "confirm"]);

const TYPE: Record<string, string> = { role: "角色", scene: "场景", tool: "道具" };
function typeLabel(t: string) {
  return TYPE[t] ?? t;
}
function existingByType(t: string) {
  return (props.existing || []).filter((a: any) => (a.type ?? a.assetType) === t);
}
function stateOf(d: any) {
  if (d.state === "confirmed") return "done";
  if (props.bindings?.[d.name]) return "done";
  if (d.assetId) return "done";
  return "pending";
}
const doneCount = computed(() => (props.drafts || []).filter((d: any) => stateOf(d) === "done").length);
const allDone = computed(() => props.drafts.length > 0 && doneCount.value === props.drafts.length);

function onPick(d: any, ev: Event) {
  const v = Number((ev.target as HTMLSelectElement).value);
  if (!v) return;
  emit("bind", d.name, v);
  (ev.target as HTMLSelectElement).value = "";
}
</script>

<style lang="scss" scoped>
.assetStep {
  display: flex;
  flex-direction: column;
  gap: 12px;
  .hint {
    font-size: 12px;
    color: var(--td-text-color-placeholder);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 12px;
    max-height: 460px;
    overflow-y: auto;
  }
  .assetCard {
    .head {
      margin-bottom: 8px;
      .name {
        font-weight: 600;
      }
    }
    .field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 8px;
      label {
        font-size: 12px;
        color: var(--td-text-color-placeholder);
      }
    }
    .input,
    .area,
    .select {
      border: 1px solid var(--td-component-border);
      border-radius: 6px;
      padding: 6px 8px;
      background: var(--td-bg-color-container);
      color: var(--td-text-color-primary);
      font-size: 13px;
      width: 100%;
    }
    .actions {
      gap: 8px;
      .select {
        flex: 1;
        min-width: 120px;
      }
    }
    .bound {
      margin-top: 6px;
      font-size: 12px;
      color: var(--td-success-color);
    }
  }
  .foot {
    .count {
      font-size: 12px;
      color: var(--td-text-color-placeholder);
    }
  }
}
</style>