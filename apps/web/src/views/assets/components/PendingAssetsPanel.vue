<template>
  <div v-if="visible && pending.length" class="pendingAssets">
    <div class="head f ac jb">
      <div class="f ac" style="gap: 8px">
        <span class="title">本集待确认资产</span>
        <t-tag theme="warning" size="small" variant="light">{{ pending.length }} 集待处理</t-tag>
      </div>
      <t-button variant="text" size="small" @click="fetchList">刷新</t-button>
    </div>
    <div class="list f ac">
      <div v-for="item in pending" :key="item.id" class="card f ac jb">
        <div class="left">
          <div class="name">{{ item.name }}</div>
          <div class="meta">段数 {{ item.storyboards ?? 0 }} · {{ statusText(item.redrawState) }}</div>
        </div>
        <t-button size="small" theme="primary" @click="go(item)">去认账</t-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";

const { project } = storeToRefs(projectStore());
const router = useRouter();
const list = ref<any[]>([]);
const visible = computed(() => project.value?.projectType === "redraw");
const pending = computed(() => list.value.filter((x) => Number(x.redrawState ?? 0) === 1 || Number(x.redrawState ?? 0) === 2));

function statusText(s: number) {
  if (Number(s) === 1) return "待认账";
  if (Number(s) === 2) return "资产已确认";
  return "待处理";
}
async function fetchList() {
  if (!visible.value || !project.value?.id) return;
  try {
    const res: any = await axios.post("/redraw/getSourceList", { projectId: Number(project.value.id) });
    list.value = Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : [];
  } catch {
    list.value = [];
  }
}
onMounted(fetchList);
watch(() => project.value?.id, fetchList);

function go(item: any) {
  router.push("/redraw/session/" + item.id);
}
</script>

<style lang="scss" scoped>
.pendingAssets {
  margin-bottom: 12px;
  padding: 12px 16px;
  border: 1px solid var(--td-warning-color);
  border-radius: 12px;
  background: var(--td-warning-color-light);
  .head { margin-bottom: 8px; }
  .title { font-weight: 600; }
  .list { gap: 10px; flex-wrap: wrap; }
  .card {
    gap: 16px;
    min-width: 280px;
    padding: 10px 12px;
    border-radius: 8px;
    background: var(--td-bg-color-container);
    .name { font-size: 14px; font-weight: 600; }
    .meta { font-size: 12px; color: var(--td-text-color-placeholder); margin-top: 2px; }
  }
}
</style>