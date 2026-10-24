<template>
  <div class="redrawSession fc">
    <div class="header f ac jb">
      <div class="f ac" style="gap: 12px">
        <t-button variant="text" @click="back">← 返回</t-button>
        <h2 class="title">{{ title }}</h2>
        <t-tag :theme="store.statusView.theme" variant="light">{{ store.statusView.label }}</t-tag>
        <span v-if="stageText" class="stage">{{ stageText }}</span>
      </div>
      <t-button variant="outline" size="small" @click="showChat = !showChat">{{ showChat ? "收起助手" : "转绘助手" }}</t-button>
    </div>
    <StatusStepper v-model="step" :access="store.stepAccess" />
    <div class="body f">
      <div class="main">
        <t-alert v-if="store.error" theme="error" :message="store.error" class="err" />
        <ScriptStep v-if="step === 1" v-model="store.scriptContent" :saving="store.saving" @save="saveScript" />
        <AssetStep v-else-if="step === 2" :drafts="store.drafts" :existing="store.existing" :bindings="store.bindings" :confirming="store.busy" @bind="onBind" @create="onCreate" @update="onUpdate" @confirm="onConfirmAssets" />
        <DurationStep v-else :segments="store.segments" :cap="store.segmentCap" :saving="store.busy" @confirm-cap="onConfirmCap" />
      </div>
      <ChatPanel v-if="showChat" class="chat" :project-id="projectId" :script-id="scriptId" />
    </div>
    <div class="footer f ac jb">
      <div class="f ac" style="gap: 10px">
        <t-button variant="outline" :disabled="step === 1" @click="step--">上一步</t-button>
        <span class="hint">{{ stepHint }}</span>
      </div>
      <div class="f ac" style="gap: 8px">
        <t-button v-if="step !== 3" theme="primary" :loading="store.busy" @click="next">{{ step === 1 ? "保存并继续" : "下一步" }}</t-button>
        <t-button v-else theme="primary" :disabled="!store.stepAccess.canGenerate" :loading="store.busy" @click="generate">生成转绘分镜</t-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import StatusStepper from "@/views/redraw/components/StatusStepper.vue";
import ScriptStep from "./components/ScriptStep.vue";
import AssetStep from "./components/AssetStep.vue";
import DurationStep from "./components/DurationStep.vue";
import ChatPanel from "./components/ChatPanel.vue";
import { stageText as stageTextOf } from "@/views/redraw/logic";
import projectStore from "@/stores/project";
import useRedrawStore from "@/stores/redraw";

const route = useRoute();
const router = useRouter();
const store = useRedrawStore();
const { project } = storeToRefs(projectStore());

const projectId = computed(() => Number(project.value?.id ?? 0));
const scriptId = computed(() => Number(route.params.scriptId ?? 0));
const step = ref(1);
const showChat = ref(false);

const title = computed(() => "转绘会话 · " + (store.scriptName || "第 " + scriptId.value + " 集"));
const stageText = computed(() => (store.episode?.extractState === 0 ? stageTextOf(store.episode?.stage) : ""));
const stepHint = computed(() => {
  if (step.value === 1) return "剧本可以不改，直接继续";
  if (step.value === 2) return store.stepAccess.step3 ? "资产已全部确认" : store.stepAccess.blockedReason ?? "";
  return store.stepAccess.canGenerate ? "可以生成转绘分镜" : store.stepAccess.blockedReason ?? "";
});

onMounted(async () => {
  await store.loadEpisode(scriptId.value);
  await Promise.all([store.loadScript(), store.loadAssets()]);
  const rd = Number(store.episode?.redrawState ?? 0);
  if (rd >= 3) {
    await store.loadStoryboard();
    step.value = 3;
  } else if (rd === 2) {
    step.value = 2;
  }
});

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(() => {
    if (store.episode?.extractState === 0) store.refresh();
  }, 4000);
});
onUnmounted(() => timer && clearInterval(timer));

function back() {
  router.push("/inputVideo");
}

async function saveScript() {
  try {
    await store.saveScript(store.scriptContent);
    window.$message.success("剧本已保存");
  } catch (e: any) {
    window.$message.error(e?.message ?? "保存失败");
  }
}

async function next() {
  if (step.value === 1) {
    await saveScript();
    step.value = 2;
    return;
  }
  if (step.value === 2) {
    await store.refresh();
    await store.loadAssets();
    if (!store.stepAccess.step3) {
      window.$message.warning(store.stepAccess.blockedReason ?? "请先确认全部资产");
      return;
    }
    step.value = 3;
  }
}

function onBind(draftName: string, assetId: number) {
  store.bindDraft(draftName, assetId).catch((e: any) => window.$message.error(e?.message ?? "绑定失败"));
}
function onCreate(draft: any) {
  store
    .createAsset(draft)
    .then(() => window.$message.success("已新建资产：" + (draft.targetName || draft.name)))
    .catch((e: any) => window.$message.error(e?.message ?? "新建失败"));
}
function onUpdate(assetId: number, patch: any) {
  store
    .updateAsset(assetId, patch)
    .then(() => window.$message.success("已保存修改"))
    .catch((e: any) => window.$message.error(e?.message ?? "保存失败"));
}
async function onConfirmAssets() {
  try {
    const r = await store.confirmAssets();
    window.$message.success("资产已确认：新建 " + (r?.created ?? 0) + " / 复用 " + (r?.reused ?? 0));
    step.value = 3;
    await store.loadAssets();
  } catch (e: any) {
    window.$message.error(e?.message ?? "确认失败");
  }
}

function onConfirmCap(seconds: number) {
  if (seconds === store.segmentCap) {
    store.confirmSegmentCap(seconds).then(() => window.$message.success("时长已确认"));
    return;
  }
  const dialog = DialogPlugin.confirm({
    header: "修改单段上限",
    body: "把单段上限从 " + store.segmentCap + "s 改成 " + seconds + "s 需要重跑解析（当前分段是按旧上限切的）。确定继续吗？",
    theme: "warning",
    onConfirm: async () => {
      dialog.destroy();
      const r = await store.confirmSegmentCap(seconds, true);
      if (r.ok) window.$message.success("上限已更新，请重新分析");
      else window.$message.warning("上限未更新");
    },
    onClose: () => dialog.destroy(),
  });
}

async function generate() {
  try {
    await store.generateStoryboard();
    await store.refresh();
    window.$message.success("转绘分镜已开始生成");
    router.push("/redraw/review/" + scriptId.value);
  } catch (e: any) {
    window.$message.error(e?.message ?? "生成失败");
  }
}
</script>

<style lang="scss" scoped>
.redrawSession {
  height: 100%;
  padding: 16px;
  gap: 12px;
  .header {
    .title {
      font-size: 18px;
      margin: 0;
    }
    .stage {
      font-size: 12px;
      color: var(--td-brand-color);
    }
  }
  .body {
    flex: 1;
    min-height: 0;
    gap: 16px;
    .main {
      flex: 1;
      min-width: 0;
      background: var(--td-bg-color-container);
      border-radius: 12px;
      padding: 16px;
      overflow: auto;
    }
    .chat {
      width: 360px;
      height: 100%;
      background: var(--td-bg-color-container);
      border-radius: 12px;
    }
    .err {
      margin-bottom: 12px;
    }
  }
  .footer {
    padding: 12px 16px;
    background: var(--td-bg-color-container);
    border-radius: 12px;
    .hint {
      font-size: 12px;
      color: var(--td-text-color-placeholder);
    }
  }
}
</style>