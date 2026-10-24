<template>
  <div class="redrawReview fc">
    <div class="header f ac jb">
      <div class="f ac" style="gap: 12px">
        <t-button variant="text" @click="back">← 返回会话</t-button>
        <h2 class="title">{{ title }}</h2>
        <t-tag :theme="store.statusView.theme" variant="light">{{ store.statusView.label }}</t-tag>
      </div>
      <div class="f ac" style="gap: 8px">
        <t-button variant="outline" size="small" :loading="loading" @click="reload">刷新</t-button>
      </div>
    </div>

    <t-alert v-if="store.error" theme="error" :message="store.error" />
    <t-alert v-if="failed" theme="error" message="转绘分镜生成失败：可以点「重跑转绘层」，或到任务中心看失败原因。" />
    <t-alert v-if="showConfirmHint" theme="info" :message="confirmHint" />

    <div v-if="extracting || generating" class="waiting fc c">
      <t-loading size="large" />
      <div class="waitText">{{ extracting ? "解析中…完成后自动刷新" : "转绘分镜生成中…完成后会自动刷新" }}</div>
    </div>

    <template v-else>
      <t-card v-if="store.storyboard.changes.length" class="summary" shadow>
        <div class="sumTitle">变更摘要</div>
        <ul>
          <li v-for="(c, i) in store.storyboard.changes" :key="i">{{ c }}</li>
        </ul>
      </t-card>

      <div class="tables f">
        <div class="col">
          <div class="colTitle">源片版</div>
          <div v-for="s in sourceRows" :key="'s' + s.index" class="segCard" :class="s.cls">
            <div class="segHead f ac jb">
              <span class="segNo">段 {{ s.index }}</span>
              <span class="segDur">{{ s.duration }}s</span>
            </div>
            <div class="segRange">{{ s.sourceRange || "-" }}</div>
            <div class="segDesc">{{ s.desc || "（无描述）" }}</div>
          </div>
          <div v-if="!sourceRows.length" class="empty">源片版快照为空</div>
        </div>
        <div class="col">
          <div class="colTitle">转绘版</div>
          <div v-for="s in redrawRows" :key="'r' + s.index" class="segCard" :class="s.cls">
            <div class="segHead f ac jb">
              <span class="segNo">段 {{ s.index }}</span>
              <span class="segDur">{{ s.duration }}s</span>
            </div>
            <div class="segRange">{{ s.sourceRange || "-" }}</div>
            <div class="segDesc">{{ s.desc || "（无描述）" }}</div>
          </div>
          <div v-if="!redrawRows.length" class="empty">还没有转绘版（生成完成后出现）</div>
        </div>
      </div>
    </template>

    <div class="footer f ac jb">
      <div class="f ac" style="gap: 8px">
        <t-button variant="outline" :disabled="store.busy" @click="rollback">回退到源片版</t-button>
        <t-button variant="outline" :disabled="store.busy" @click="regenerate">重跑转绘层</t-button>
      </div>
      <t-tooltip :content="canConfirm ? '' : confirmHint" :disabled="canConfirm" placement="top">
        <t-button theme="primary" :disabled="!canConfirm" :loading="store.busy" @click="confirm">确认覆盖并进入制作</t-button>
      </t-tooltip>
    </div>
  </div>
</template>

<script setup lang="ts">
import projectStore from "@/stores/project";
import useRedrawStore from "@/stores/redraw";

const route = useRoute();
const router = useRouter();
const store = useRedrawStore();
const { project } = storeToRefs(projectStore());
const scriptId = computed(() => Number(route.params.scriptId ?? 0));
const loading = ref(false);
const extracting = computed(() => Number(store.episode?.extractState ?? 1) === 0);
const failed = computed(() => Number(store.episode?.redrawState ?? 0) === -1);
/** 已认账、正在生成转绘分镜（redrawState=2 且还没有转绘版）—— 这是"没有提示"的根因 */
const generating = computed(
  () => !extracting.value && Number(store.episode?.redrawState ?? 0) === 2 && store.storyboard.redraw.length === 0,
);
const title = computed(() => "转绘确认 · " + (store.scriptName || "第 " + scriptId.value + " 集"));
const canConfirm = computed(() => Number(store.episode?.redrawState ?? 0) === 3 && store.storyboard.redraw.length > 0);
/** 按钮为什么点不了 —— 必须写在界面上，而不是只灰着 */
const confirmHint = computed(() => {
  const rd = Number(store.episode?.redrawState ?? 0);
  if (rd === -1) return "生成失败：先重跑转绘层";
  if (rd === 1) return "还没完成资产认账：先回会话页确认资产";
  if (rd === 2) return "转绘分镜还没生成：点「重跑转绘层」生成后再确认";
  if (rd === 4) return "已经确认过了，可以直接去制作";
  if (!store.storyboard.redraw.length) return "还没有转绘版可确认";
  return "";
});
const showConfirmHint = computed(() => !canConfirm.value && !extracting.value && !generating.value && !!confirmHint.value);

function descOf(s: any): string {
  return String(s?.videoDesc ?? s?.desc ?? "");
}
function rowsOf(list: any[]) {
  return (list || []).map((s: any, i: number) => ({
    index: Number(s.index ?? s.segmentIndex ?? i + 1),
    duration: s.duration ?? "-",
    sourceRange: s.sourceRange ?? "",
    desc: descOf(s),
    cls: "",
  }));
}
const sourceRows = computed(() => rowsOf(store.storyboard.source));
const redrawRows = computed(() => {
  const rows = rowsOf(store.storyboard.redraw);
  const src = new Map(sourceRows.value.map((r) => [r.index, r]));
  return rows.map((r) => {
    const s = src.get(r.index);
    const changed = !s || String(s.duration) !== String(r.duration) || s.desc !== r.desc;
    return { ...r, cls: changed ? "changed" : "" };
  });
});

onMounted(async () => {
  await store.loadEpisode(scriptId.value);
  await Promise.all([store.loadScript(), store.loadStoryboard()]);
});

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(async () => {
    const rd = Number(store.episode?.redrawState ?? 0);
    if (extracting.value || generating.value || rd === 3) {
      await store.refresh();
      if (Number(store.episode?.redrawState ?? 0) >= 3) {
        await store.loadStoryboard();
      }
    }
  }, 4000);
});
onUnmounted(() => timer && clearInterval(timer));

async function reload() {
  loading.value = true;
  try {
    await store.loadEpisode(scriptId.value);
    await store.loadStoryboard();
  } finally {
    loading.value = false;
  }
}
function back() {
  router.push("/redraw/session/" + scriptId.value);
}
async function rollback() {
  try {
    await store.rollbackStoryboard();
    window.$message.success("已回退到源片版");
  } catch (e: any) {
    window.$message.error(e?.message ?? "回退失败");
  }
}
async function regenerate() {
  try {
    await store.generateStoryboard();
    window.$message.success("已重新开始生成转绘分镜");
    await reload();
  } catch (e: any) {
    window.$message.error(e?.message ?? "重跑失败");
  }
}
async function confirm() {
  try {
    const res: any = await store.confirmStoryboard();
    const cut = res?.cut;
    const issues = Array.isArray(cut?.issues) ? cut.issues : [];
    const errs = issues.filter((i: any) => i?.level === "error");
    if (errs.length) {
      window.$message.warning("已确认，但有 " + errs.length + " 段切片失败：" + errs[0]?.message + "（可在源片页「重切」）");
    } else {
      window.$message.success("已确认覆盖，正在进入制作");
    }
    router.push("/production");
  } catch (e: any) {
    window.$message.error(e?.message ?? "确认失败");
  }
}
</script>

<style lang="scss" scoped>
.redrawReview {
  height: 100%;
  padding: 16px;
  gap: 12px;
  .header .title {
    font-size: 18px;
    margin: 0;
  }
  .waiting {
    flex: 1;
    gap: 12px;
    color: var(--td-text-color-placeholder);
    .waitText { font-size: 13px; }
  }
  .summary {
    .sumTitle { font-weight: 600; margin-bottom: 6px; }
    ul { margin: 0; padding-left: 18px; font-size: 13px; line-height: 1.8; }
  }
  .tables {
    flex: 1;
    min-height: 0;
    gap: 16px;
    .col {
      flex: 1;
      min-width: 0;
      overflow-y: auto;
      background: var(--td-bg-color-container);
      border-radius: 12px;
      padding: 12px;
    }
    .colTitle { font-weight: 600; margin-bottom: 8px; }
  }
  .segCard {
    border: 1px solid var(--td-component-border);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 8px;
    .segHead { margin-bottom: 4px; }
    .segNo { font-weight: 600; font-size: 13px; }
    .segDur { color: var(--td-text-color-placeholder); font-size: 12px; }
    .segRange { font-size: 12px; color: var(--td-text-color-placeholder); margin-bottom: 4px; }
    .segDesc { font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
  }
  .segCard.changed {
    border-color: var(--td-warning-color);
    background: var(--td-warning-color-light);
  }
  .empty { font-size: 12px; color: var(--td-text-color-placeholder); }
  .footer {
    padding: 12px 16px;
    background: var(--td-bg-color-container);
    border-radius: 12px;
  }
}
</style>