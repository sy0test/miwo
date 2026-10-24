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

    <!-- 顶部常驻状态条：分镜板是后台任务，用户必须随时能看到"现在到哪一步/完成没" -->
    <div class="statusBar f ac" :class="'s-' + sbStatus.theme">
      <t-tag :theme="sbStatus.theme" variant="light">{{ sbStatus.label }}</t-tag>
      <span class="statusDetail">{{ sbStatus.detail }}</span>
      <t-progress v-if="jobRunning && jobPct != null" :percentage="jobPct" theme="line" style="width: 260px" />
      <span v-if="jobRunning" class="statusHint">后台任务、无流式输出；完成后自动刷新</span>
    </div>

    <t-alert v-if="store.error" theme="error" :message="store.error" />
    <t-alert v-if="failed" theme="error" message="转绘分镜生成失败：可以点「重跑转绘层」，或到任务中心看失败原因。" />
    <t-alert v-if="showConfirmHint" theme="info" :message="confirmHint" />

    <div v-if="waiting" class="waiting fc c">
      <t-loading size="large" />
      <div class="waitText">{{ waitingText }}</div>
      <t-progress v-if="jobPct != null" :percentage="jobPct" theme="line" style="width: 320px" />
      <div class="waitTip">没有流式输出，这是后台任务进度；完成后会自动刷新</div>
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
          <div class="colTitle">转绘版（videoDesc 按镜头表格展开）</div>
          <div v-if="!redrawRows.length" class="empty">还没有转绘版（生成完成后出现）</div>
          <table v-else class="segTable">
            <thead>
              <tr>
                <th style="width: 46px">段</th>
                <th style="width: 56px">时长</th>
                <th style="width: 130px">源片区间</th>
                <th v-for="h in vdHeaders" :key="h">{{ h }}</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(r, ri) in redrawFlat" :key="ri">
                <tr v-if="r.type === 'intro'" :class="r.cls">
                  <td colspan="11" class="introRow">{{ r.text }}</td>
                </tr>
                <tr v-else-if="r.type === 'single'" :class="r.cls">
                  <td class="c">{{ r.seg }}</td>
                  <td class="c">{{ r.duration }}s</td>
                  <td class="range">{{ r.range || "-" }}</td>
                  <td colspan="8">{{ r.text || "（无描述）" }}</td>
                </tr>
                <tr v-else :class="r.cls">
                  <template v-if="r.first">
                    <td class="c segCell" :rowspan="r.rowspan">{{ r.seg }}</td>
                    <td class="c" :rowspan="r.rowspan">{{ r.duration }}s</td>
                    <td class="range" :rowspan="r.rowspan">{{ r.range || "-" }}</td>
                  </template>
                  <td v-for="(c, ci) in r.cells" :key="ci">{{ c }}</td>
                </tr>
              </template>
            </tbody>
          </table>
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
import { jobRunning as jobIsRunning, jobText } from "@/views/redraw/logic";

const route = useRoute();
const router = useRouter();
const store = useRedrawStore();
const { project } = storeToRefs(projectStore());
const scriptId = computed(() => Number(route.params.scriptId ?? 0));
const loading = ref(false);
const extracting = computed(() => Number(store.episode?.extractState ?? 1) === 0);
const failed = computed(() => Number(store.episode?.redrawState ?? 0) === -1);
/** 后端返回的活跃任务：解析/生成分镜/切原片都算"正在跑"（不再靠状态猜） */
const jobRunning = computed(() => jobIsRunning(store.episode));
const jobPct = computed(() => {
  const p = store.episode?.job?.progress;
  return p == null ? null : Math.max(0, Math.min(100, Math.round(Number(p))));
});
const generating = computed(
  () => !extracting.value && Number(store.episode?.redrawState ?? 0) === 2 && store.storyboard.redraw.length === 0,
);
const waiting = computed(() => jobRunning.value || extracting.value || generating.value);
const waitingText = computed(() => {
  if (jobRunning.value) return (jobText(store.episode) || "转绘任务") + " 进行中…完成后自动刷新";
  if (extracting.value) return "源片解析中…完成后自动刷新";
  return "转绘分镜生成中…完成后自动刷新";
});
const title = computed(() => "转绘确认 · " + (store.scriptName || "第 " + scriptId.value + " 集"));
/** 顶部状态条：让用户随时知道分镜板生成到哪一步（后台任务，没有 streaming） */
const sbStatus = computed<any>(() => {
  const rd = Number(store.episode?.redrawState ?? 0);
  if (jobRunning.value) {
    return {
      theme: "primary",
      label: "生成中",
      detail: jobText(store.episode) || "后台任务执行中",
      ...(jobPct.value != null ? { detail: (jobText(store.episode) || "后台任务执行中") + " · " + jobPct.value + "%" } : {}),
    };
  }
  if (rd === -1) return { theme: "danger", label: "生成失败", detail: "点「重跑转绘层」重试，或到任务中心看失败原因" };
  if (rd === 3) return { theme: "success", label: "转绘分镜已生成", detail: (redrawRows.value.length || 0) + " 段 · 可并排确认" };
  if (rd === 4) return { theme: "success", label: "已确认覆盖", detail: "可直接去工作台生成视频" };
  if (rd === 2) return { theme: "warning", label: "转绘分镜未确认", detail: store.storyboard.redraw.length ? "当前显示的是上次生成版本（已回退）" : "尚未生成" };
  if (rd === 1) return { theme: "warning", label: "资产未认账", detail: "先回会话页完成资产认账" };
  return { theme: "default", label: "未开始", detail: "先完成源片解析与资产认账" };
});
const canConfirm = computed(() => Number(store.episode?.redrawState ?? 0) === 3 && store.storyboard.redraw.length > 0);
/** 按钮为什么点不了 —— 必须写在界面上，而不是只灰着 */
const confirmHint = computed(() => {
  const rd = Number(store.episode?.redrawState ?? 0);
  if (rd === -1) return "生成失败：先重跑转绘层";
  if (rd === 1) return "还没完成资产认账：先回会话页确认资产";
  if (rd === 2) {
    return store.storyboard.redraw.length
      ? "当前显示的是上次生成的转绘版（已回退/未确认）；点「重跑转绘层」重新生成后再确认"
      : "转绘分镜还没生成：点「重跑转绘层」生成后再确认";
  }
  if (rd === 4) return "已经确认过了，可以直接去制作";
  if (!store.storyboard.redraw.length) return "还没有转绘版可确认";
  return "";
});
const showConfirmHint = computed(() => !canConfirm.value && !waiting.value && !!confirmHint.value);

function descOf(s: any): string {
  return String(s?.videoDesc ?? s?.desc ?? "");
}

/** videoDesc 的列（与生成技能输出一致：序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效） */
const vdHeaders = ["镜", "画面描述", "时长", "景别", "运镜", "光影氛围", "台词", "音效"];

/** 把 videoDesc 拆成「说明行 + 表格行」：表格行以 | 开头，一行一镜 */
function parseVideoDesc(text: string): { intro: string[]; rows: string[][] } {
  const intro: string[] = [];
  const rows: string[][] = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("|")) {
      const cells = line
        .replace(/^\|/, "")
        .replace(/\|$/, "")
        .split("|")
        .map((c) => c.trim());
      rows.push(cells);
    } else {
      intro.push(line);
    }
  }
  return { intro, rows };
}
function rowsOf(list: any[]) {
  return (list || []).map((s: any, i: number) => {
    const desc = descOf(s);
    return {
      index: Number(s.index ?? s.segmentIndex ?? i + 1),
      duration: s.duration ?? "-",
      sourceRange: s.sourceRange ?? "",
      desc,
      parsed: parseVideoDesc(desc),
      cls: "",
    };
  });
}
const sourceRows = computed(() => rowsOf(store.storyboard.source));
const redrawRows = computed(() => {
  const rows = rowsOf(store.storyboard.redraw);
  const src = new Map(sourceRows.value.map((r) => [r.index, r]));
  return rows.map((r: any) => {
    const s = src.get(r.index);
    const changed = !s || String(s.duration) !== String(r.duration) || s.desc !== r.desc;
    return { ...r, cls: changed ? "changed" : "" };
  });
});

/** 右侧表格的扁平行：说明行 / 单镜行 / 多镜行（段/时长/源片区间用 rowspan 合并） */
const redrawFlat = computed<any[]>(() => {
  const out: any[] = [];
  for (const s of redrawRows.value as any[]) {
    const id = Number(s.index);
    const intro = (s.parsed?.intro ?? []).join(" ");
    if (intro) out.push({ type: "intro", seg: id, text: intro, cls: s.cls });
    const shots: string[][] = s.parsed?.rows ?? [];
    if (!shots.length) {
      out.push({ type: "single", seg: id, duration: s.duration, range: s.sourceRange, text: s.desc, cls: s.cls });
      continue;
    }
    shots.forEach((cells: string[], i: number) => {
      out.push({
        type: "shot",
        seg: id,
        duration: s.duration,
        range: s.sourceRange,
        cells,
        first: i === 0,
        rowspan: shots.length,
        cls: s.cls,
      });
    });
  }
  return out;
});

onMounted(async () => {
  await store.loadEpisode(scriptId.value);
  await Promise.all([store.loadScript(), store.loadStoryboard()]);
});

let timer: ReturnType<typeof setInterval> | null = null;
onMounted(() => {
  timer = setInterval(async () => {
    const rd = Number(store.episode?.redrawState ?? 0);
    // 有活跃任务时一定要轮询：任务结束会改 redrawState，页面不能停在旧状态上
    if (jobRunning.value || extracting.value || generating.value || rd === 3) {
      await store.refresh();
      if (Number(store.episode?.redrawState ?? 0) >= 3) {
        await store.loadStoryboard();
      }
      if (!jobRunning.value && Number(store.episode?.redrawState ?? 0) === -1) {
        await store.loadStoryboard();
      }
    }
  }, 3000);
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
  .statusBar {
    padding: 8px 12px;
    border-radius: 8px;
    gap: 10px;
    background: var(--td-bg-color-container);
    border: 1px solid var(--td-component-border);
    .statusDetail { font-size: 13px; color: var(--td-text-color-secondary); }
    .statusHint { font-size: 12px; color: var(--td-text-color-placeholder); margin-left: auto; }
    &.s-primary { border-color: var(--td-brand-color); }
    &.s-success { border-color: var(--td-success-color); }
    &.s-warning { border-color: var(--td-warning-color); }
    &.s-danger { border-color: var(--td-error-color); }
  }
  .waiting {
    flex: 1;
    gap: 12px;
    color: var(--td-text-color-placeholder);
    .waitText { font-size: 13px; }
    .waitTip { font-size: 12px; opacity: 0.8; }
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
      overflow-x: auto;
      background: var(--td-bg-color-container);
      border-radius: 12px;
      padding: 12px;
    }
    /* 转绘版字段多，给它更宽的展示区 */
    .col:last-child { flex: 1.7; }
    .colTitle { font-weight: 600; margin-bottom: 8px; }
  }
  .segTable {
    width: 100%;
    /* 11 列（段/时长/区间 + 8 个镜头字段）在窄容器里会挤成一条线：给个下限，超出横向滚动 */
    min-width: 980px;
    border-collapse: collapse;
    font-size: 12px;
    th,
    td {
      border-bottom: 1px solid var(--td-component-border);
      padding: 8px 10px;
      text-align: left;
      vertical-align: top;
    }
    th {
      position: sticky;
      top: 0;
      z-index: 1;
      background: var(--td-bg-color-container);
      font-weight: 600;
      white-space: nowrap;
    }
    .c { text-align: center; white-space: nowrap; }
    .range { color: var(--td-text-color-placeholder); white-space: pre-wrap; }
    .desc { line-height: 1.7; white-space: pre-wrap; word-break: break-word; }
    .segCell { font-weight: 600; background: var(--td-bg-color-secondarycontainer); }
    .introRow {
      background: var(--td-bg-color-secondarycontainer);
      color: var(--td-text-color-secondary);
      line-height: 1.7;
      white-space: pre-wrap;
      word-break: break-word;
    }
    td { line-height: 1.6; word-break: break-word; }
    tr.changed td {
      background: var(--td-warning-color-light);
    }
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