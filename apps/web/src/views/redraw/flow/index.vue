<template>
  <div class="redrawFlow fc">
    <div class="header f ac jb">
      <div class="f ac" style="gap: 12px">
        <h2 class="title">转绘制作</h2>
        <t-select :value="scriptId" :options="episodeOptions" size="small" style="width: 220px" placeholder="选择一集" @change="onSelect" />
        <t-tag :theme="store.statusView.theme" variant="light">{{ store.statusView.label }}</t-tag>
      </div>
      <div class="f ac" style="gap: 8px">
        <t-button variant="outline" size="small" @click="reload">刷新</t-button>
        <t-button variant="outline" size="small" @click="showChat = !showChat">{{ showChat ? "收起助手" : "转绘助手" }}</t-button>
      </div>
    </div>

    <div class="body f">
      <div class="flowArea">
        <div class="cards">
          <div v-for="(n, i) in nodes" :key="n.key" class="nodeWrap f ac">
            <div class="node" :class="[n.key, n.state]">
              <div class="nodeTop f ac jb">
                <span class="nodeTitle">{{ n.title }}</span>
                <t-tag size="small" :theme="n.tagTheme" variant="light">{{ n.tag }}</t-tag>
              </div>
              <div class="nodeBody">{{ n.desc }}</div>
              <t-button size="small" :theme="n.primary ? 'primary' : 'default'" :variant="n.primary ? 'base' : 'outline'" block @click="n.action()">
                {{ n.button }}
              </t-button>
            </div>
            <div v-if="i < nodes.length - 1" class="arrow">→</div>
          </div>
        </div>
        <div class="tip">
          流程：源片分析 → 转绘会话（剧本/资产/时长）→ 生成转绘分镜 → 并排确认 → 工作台生成视频。
          任何一步都可以点节点回到对应页面。
        </div>
      </div>
      <ChatPanel v-if="showChat" class="chat" :project-id="projectId" :script-id="scriptId" />
    </div>

    <!--
      ⚠ 必须等 scriptId 就绪、且在打开时才挂载：
      生成面板的 generate/index.vue 在 onMounted 里就用注入的 episodesId 拉 getGenerateData。
      如果组件在页面加载时就挂载（scriptId 还是 0），那一次请求拿到空轨道之后不会再拉 ——
      真机症状：前面步骤全绿，打开「生成面板」是空的、时长显示 NaN。
    -->
    <workbenchDialog v-if="workbenchVisible && scriptId" :key="scriptId" v-model:visible="workbenchVisible" />
  </div>
</template>

<script setup lang="ts">
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import useRedrawStore from "@/stores/redraw";
import ChatPanel from "@/views/redraw/session/components/ChatPanel.vue";
import workbenchDialog from "@/views/production/components/workbench/index.vue";

const router = useRouter();
const { project } = storeToRefs(projectStore());
const store = useRedrawStore();
const projectId = computed(() => Number(project.value?.id ?? 0));
const list = ref<any[]>([]);
const scriptId = ref(0);
const showChat = ref(false);
const workbenchVisible = ref(false);

provide("episodesId", scriptId);

const rd = computed(() => Number(store.episode?.redrawState ?? 0));
const analyzed = computed(() => Number(store.episode?.segmentCount ?? 0) > 0);

const nodes = computed(() => {
  const s = store.episode;
  return [
    {
      key: "source", title: "源片", tag: analyzed.value ? "已解析" : "待分析",
      tagTheme: analyzed.value ? "success" : "warning", state: analyzed.value ? "done" : "todo", primary: !analyzed.value,
      desc: "上传源片并开始分析（切点 / 转写 / 解析）",
      button: "去源片页", action: () => router.push("/inputVideo"),
    },
    {
      key: "parse", title: "解析结果", tag: analyzed.value ? "有分镜" : "未解析",
      tagTheme: analyzed.value ? "success" : "default", state: analyzed.value ? "done" : "todo", primary: false,
      desc: "剧本 " + (store.scriptContent ? store.scriptContent.length + " 字" : "（空）"),
      button: "查看/修改剧本", action: () => router.push("/redraw/session/" + scriptId.value),
    },
    {
      key: "assets", title: "资产", tag: rd.value >= 2 ? "已确认" : "待认账",
      tagTheme: rd.value >= 2 ? "success" : "warning", state: rd.value >= 2 ? "done" : "todo", primary: rd.value === 1,
      desc: "已确认 " + (s?.assetsConfirmed ?? 0) + " / " + (s?.assetTotal ?? store.drafts.length),
      button: "去认账", action: () => router.push("/redraw/session/" + scriptId.value),
    },
    {
      key: "storyboard", title: "转绘分镜", tag: rd.value >= 3 ? "已生成" : "未生成",
      tagTheme: rd.value >= 3 ? "success" : "default", state: rd.value >= 3 ? "done" : "todo", primary: rd.value === 2,
      desc: "段数 " + (s?.segmentCount ?? 0) + " · 单段上限 " + (s?.segmentCap ?? 15) + "s",
      button: rd.value >= 3 ? "并排确认" : "先完成认账",
      action: () => router.push(rd.value >= 3 ? "/redraw/review/" + scriptId.value : "/redraw/session/" + scriptId.value),
    },
    {
      key: "confirm", title: "确认", tag: rd.value >= 4 ? "已确认" : "待确认",
      tagTheme: rd.value >= 4 ? "success" : "default", state: rd.value >= 4 ? "done" : "todo", primary: false,
      desc: "确认后覆盖源片分镜，进入生成",
      button: "去确认", action: () => router.push("/redraw/review/" + scriptId.value),
    },
    {
      key: "generate", title: "工作台", tag: rd.value >= 4 ? "可生成" : "未解锁",
      tagTheme: rd.value >= 4 ? "success" : "default", state: rd.value >= 4 ? "done" : "todo", primary: rd.value >= 4,
      desc: "按段生成视频（带资产绑定）",
      button: "打开生成面板", action: () => { if (rd.value >= 4) workbenchVisible.value = true; },
    },
  ];
});

const episodeOptions = computed(() =>
  list.value.map((x) => ({ label: (x.sortIndex ? "第 " + x.sortIndex + " 集 · " : "") + x.name, value: x.id })),
);

async function fetchList() {
  if (!projectId.value) return;
  const res: any = await axios.post("/redraw/getSourceList", { projectId: projectId.value });
  list.value = Array.isArray(res?.data) ? res.data : [];
  if (!scriptId.value && list.value.length) scriptId.value = list.value[0].id;
}

async function reload() {
  await fetchList();
  if (scriptId.value) await store.loadEpisode(scriptId.value);
}

function onSelect(v: number) {
  scriptId.value = Number(v);
  store.loadEpisode(scriptId.value);
}

onMounted(reload);
</script>

<style lang="scss" scoped>
.redrawFlow {
  height: 100%;
  padding: 16px;
  gap: 12px;
  .header .title { font-size: 18px; margin: 0; }
  .body { flex: 1; min-height: 0; gap: 16px; }
  .flowArea {
    flex: 1; overflow: auto; padding: 8px;
    .cards { display: flex; align-items: center; gap: 6px; min-width: max-content; }
  }
  .nodeWrap { gap: 6px; }
  .node {
    width: 200px; min-height: 170px; padding: 12px; border-radius: 12px;
    background: var(--td-bg-color-container); border: 1px solid var(--td-component-border);
    display: flex; flex-direction: column; gap: 8px;
    .nodeTitle { font-weight: 600; font-size: 14px; }
    .nodeBody { font-size: 12px; color: var(--td-text-color-placeholder); line-height: 1.6; flex: 1; }
  }
  .node.done { border-color: var(--td-success-color); }
  .node.todo { border-style: dashed; }
  .arrow { color: var(--td-text-color-placeholder); font-size: 18px; }
  .tip { margin-top: 16px; font-size: 12px; color: var(--td-text-color-placeholder); line-height: 1.8; }
  .chat { width: 340px; background: var(--td-bg-color-container); border-radius: 12px; }
}
</style>