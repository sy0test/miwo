/**
 * 转绘集状态 store（M2）。
 *
 * 只负责「当前这一集」的状态与动作；页面组件不直接拼接口。
 * 接口口径见 docs/superpowers/specs/2026-10-24-redraw-redesign.md §10.9；
 * 后端未就绪时请求会 404，页面会显示错误而不是静默假成功。
 */
import axios from "@/utils/axios";
import projectStore from "@/stores/project";
import { primaryActionFor, secondaryActionsFor, statusViewFor, stepAccessFor, type EpisodeState, type PrimaryAction } from "@/views/redraw/logic";

export type DraftType = "role" | "scene" | "tool";

export interface AssetDraft {
  name: string;
  type: DraftType;
  targetName?: string;
  desc?: string;
  prompt?: string;
  gender?: string;
  state?: "pending" | "bound" | "created" | "confirmed";
  assetId?: number;
}

export interface RedrawSegment {
  index: number;
  segmentIndex?: number;
  sourceRange?: string;
  duration: number;
  sceneTitle?: string;
  videoDesc?: string;
}

export default defineStore("redraw", () => {
  const project = projectStore();

  const scriptId = ref<number | null>(null);
  const episode = ref<EpisodeState | null>(null);
  const scriptContent = ref("");
  const scriptName = ref("");
  const drafts = ref<AssetDraft[]>([]);
  const existing = ref<any[]>([]);
  const bindings = ref<Record<string, number>>({});
  const segments = ref<RedrawSegment[]>([]);
  const storyboard = ref<{ source: any[]; redraw: any[]; changes: string[] }>({ source: [], redraw: [], changes: [] });
  const loading = ref(false);
  const saving = ref(false);
  const busy = ref(false);
  const error = ref<string | null>(null);
  const capConfirmed = ref(false);
  const segmentCap = ref(15);

  function pid(): number {
    return Number(project.project?.id ?? 0);
  }

  async function post<T = any>(path: string, body: Record<string, any> = {}): Promise<T> {
    const res: any = await axios.post(path, { projectId: pid(), scriptId: Number(scriptId.value), ...body });
    return (res?.data ?? res) as T;
  }

  function applyEpisode(raw: any) {
    episode.value = {
      extractState: Number(raw?.extractState ?? 0),
      redrawState: Number(raw?.redrawState ?? 0),
      stage: raw?.stage ?? null,
      progress: raw?.progress ?? null,
      segmentCount: Number(raw?.segmentCount ?? raw?.segments ?? 0),
      assetTotal: Number(raw?.assetTotal ?? raw?.drafts ?? 0),
      assetsConfirmed: Number(raw?.assetsConfirmed ?? raw?.confirmed ?? 0),
      clipsReady: Boolean(raw?.clipsReady ?? raw?.clipsCut ?? false),
      segmentCap: Number(raw?.segmentCap ?? raw?.redrawMaxSegmentSec ?? 15),
      capConfirmed: Boolean(raw?.capConfirmed ?? false),
      job: raw?.job
        ? {
            id: Number(raw.job.id),
            type: String(raw.job.type ?? ""),
            state: String(raw.job.state ?? ""),
            stage: raw.job.stage ?? null,
            progress: raw.job.progress == null ? null : Number(raw.job.progress),
          }
        : null,
    };
    segmentCap.value = episode.value.segmentCap;
    if (typeof raw?.capConfirmed === "boolean") capConfirmed.value = raw.capConfirmed;
  }

  async function loadEpisode(id: number) {
    scriptId.value = id;
    error.value = null;
    try {
      const raw = await post("redraw/getEpisodeState");
      applyEpisode(raw);
      if (raw?.segmentCap != null) segmentCap.value = Number(raw.segmentCap);
    } catch (e: any) {
      error.value = errText(e);
    }
  }

  async function refresh() {
    if (!scriptId.value) return;
    try {
      const raw = await post("redraw/getEpisodeState");
      applyEpisode(raw);
    } catch (e: any) {
      error.value = errText(e);
    }
  }

  async function loadScript() {
    try {
      const raw = await post<{ content: string; name?: string }>("redraw/getScript");
      scriptContent.value = raw?.content ?? "";
      scriptName.value = raw?.name ?? "";
    } catch (e: any) {
      error.value = errText(e);
    }
  }

  async function saveScript(content: string) {
    saving.value = true;
    try {
      const raw = await post<{ changed: boolean }>("redraw/updateScript", { content });
      scriptContent.value = content;
      return Boolean(raw?.changed);
    } finally {
      saving.value = false;
    }
  }

  async function loadAssets() {
    loading.value = true;
    try {
      const raw = await post<any>("redraw/getAssetDrafts");
      drafts.value = Array.isArray(raw?.drafts) ? raw.drafts : [];
      existing.value = Array.isArray(raw?.existing) ? raw.existing : [];
      bindings.value = raw?.bindings ?? {};
      if (raw?.segmentCap != null) segmentCap.value = Number(raw.segmentCap);
      if (Array.isArray(raw?.segments)) segments.value = raw.segments;
    } catch (e: any) {
      error.value = errText(e);
    } finally {
      loading.value = false;
    }
  }

  async function bindDraft(draftName: string, assetId: number) {
    await post("redraw/bindAssetDraft", { draftName, assetId });
    await loadAssets();
    await refresh();
  }

  async function createAsset(draft: AssetDraft) {
    const raw = await post<{ id: number }>("redraw/createAsset", {
      draftName: draft.name,
      name: draft.targetName || draft.name,
      type: draft.type,
      describe: draft.desc ?? "",
      prompt: draft.prompt ?? "",
      gender: draft.gender ?? "",
    });
    await loadAssets();
    await refresh();
    return raw?.id;
  }

  async function updateAsset(assetId: number, patch: Record<string, any>) {
    await post("redraw/updateAsset", { assetId, patch });
    await loadAssets();
  }

  async function confirmAssets() {
    const raw = await post<{ created: number; reused: number; linked: number }>("redraw/confirmAssets");
    await loadAssets();
    await refresh();
    return raw;
  }

  async function confirmSegmentCap(seconds: number, force = false) {
    try {
      await post("redraw/confirmSegmentCap", { seconds, force });
      segmentCap.value = seconds;
      capConfirmed.value = true;
      return { ok: true as const };
    } catch (e: any) {
      // axios 拦截器已把错误归一化成 { code, data, message }（见 utils/apiError.ts）
      const payload = e?.data ?? e?.response?.data?.data ?? e?.response?.data;
      const status = Number(e?.code ?? e?.response?.status ?? 0);
      const needRerun = status === 409 || Boolean(payload?.needRerun);
      return { ok: false as const, needRerun };
    }
  }

  async function loadStoryboard() {
    try {
      const raw = await post<any>("redraw/getStoryboard");
      storyboard.value = {
        source: Array.isArray(raw?.source) ? raw.source : [],
        redraw: Array.isArray(raw?.redraw) ? raw.redraw : [],
        changes: Array.isArray(raw?.changes) ? raw.changes : [],
      };
      if (!segments.value.length && storyboard.value.redraw.length) segments.value = storyboard.value.redraw as RedrawSegment[];
    } catch (e: any) {
      error.value = errText(e);
    }
  }

  async function generateStoryboard() {
    busy.value = true;
    try {
      const raw = await post<{ jobId?: number }>("redraw/generateStoryboard");
      return raw;
    } finally {
      busy.value = false;
    }
  }

  async function confirmStoryboard() {
    busy.value = true;
    try {
      const raw = await post("redraw/confirmStoryboard");
      await refresh();
      return raw;
    } finally {
      busy.value = false;
    }
  }

  async function rollbackStoryboard() {
    await post("redraw/rollbackStoryboard");
    await loadStoryboard();
    await refresh();
  }

  async function analyze(replace = false) {
    busy.value = true;
    try {
      return await post("redraw/analyzeSource", { replace });
    } finally {
      busy.value = false;
    }
  }

  async function cut() {
    busy.value = true;
    try {
      return await post("redraw/cutSource", { onlyMissing: true, cleanStale: true });
    } finally {
      busy.value = false;
    }
  }

  const allConfirmed = computed(() => {
    if (!drafts.value.length) return false;
    return drafts.value.every((d) => d.state === "confirmed" || d.state === "created" || d.state === "bound");
  });

  const stepAccess = computed(() =>
    stepAccessFor({
      assetTotal: drafts.value.length,
      assetsConfirmed: drafts.value.filter((d) => d.state === "confirmed" || d.state === "created" || d.state === "bound").length,
      capConfirmed: capConfirmed.value,
    }),
  );

  const primaryAction = computed<PrimaryAction | null>(() => primaryActionFor(episode.value, { busy: busy.value }));
  const secondaryActions = computed<PrimaryAction[]>(() => secondaryActionsFor(episode.value));
  const statusView = computed(() => statusViewFor(episode.value));

  function errText(e: any): string {
    return e?.message ?? e?.response?.data?.message ?? String(e);
  }

  return {
    scriptId, episode, scriptContent, scriptName, drafts, existing, bindings, segments, storyboard,
    loading, saving, busy, error, segmentCap, capConfirmed,
    allConfirmed, stepAccess, primaryAction, secondaryActions, statusView,
    loadEpisode, refresh, loadScript, saveScript, loadAssets, bindDraft, createAsset, updateAsset,
    confirmAssets, confirmSegmentCap, loadStoryboard, generateStoryboard, confirmStoryboard, rollbackStoryboard,
    analyze, cut,
  };
});
