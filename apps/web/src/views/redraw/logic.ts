/**
 * 转绘前端的纯逻辑：状态 → 文案 / 按钮 / 步骤闸门。
 *
 * 抽出来是为了能被 node --experimental-strip-types 直接单测（见 tests/redraw-logic.test.mjs），
 * 页面组件只负责渲染。字段口径与后端 `getEpisodeState` / `getSourceList` 一致。
 */

export interface EpisodeState {
  extractState: number;
  redrawState: number;
  stage: string | null;
  progress: number | null;
  segmentCount: number;
  assetTotal: number;
  assetsConfirmed: number;
  clipsReady: boolean;
  segmentCap: number;
  capConfirmed?: boolean;
}

export interface PrimaryAction {
  key: string;
  label: string;
  theme: "primary" | "default" | "success" | "warning";
  disabled?: boolean;
  reason?: string;
  /** 前端路由跳转 */
  route?: string;
  /** 或调用某个动作（analyze / cut / generateStoryboard ...） */
  action?: string;
}

const STAGE_TEXT: Record<string, string> = {
  cut: "预处理·切点",
  transcribe: "预处理·转写",
  analyze: "解析中",
  analysis: "解析中",
  storyboard: "生成转绘分镜",
  cut_source: "切原片中",
};

export function stageText(stage: string | null | undefined): string {
  if (!stage) return "分析中";
  return STAGE_TEXT[stage] ?? stage;
}

export function statusViewFor(ep: { extractState?: number | null; redrawState?: number | null; stage?: string | null } | null): {
  label: string;
  theme: "default" | "primary" | "success" | "warning" | "danger";
} {
  if (!ep) return { label: "未开始", theme: "default" };
  const ex = Number(ep.extractState ?? 0);
  const rd = Number(ep.redrawState ?? 0);
  if (ex === 0) return { label: stageText(ep.stage), theme: "primary" };
  if (rd === -1 || ex === -1) return { label: "失败", theme: "danger" };
  if (rd === 1) return { label: "待认账", theme: "warning" };
  if (rd === 2) return { label: "资产已确认", theme: "warning" };
  if (rd === 3) return { label: "转绘待确认", theme: "warning" };
  if (rd === 4) return { label: "可生成", theme: "success" };
  if (ex === 1) return { label: "已解析", theme: "success" };
  if (ex === 2) return { label: "等待提取", theme: "default" };
  return { label: "未开始", theme: "default" };
}

export function primaryActionFor(ep: EpisodeState | null, opts: { busy?: boolean } = {}): PrimaryAction | null {
  if (!ep) return null;
  if (opts.busy || ep.extractState === 0) {
    return { key: "busy", label: stageText(ep.stage), theme: "default", disabled: true, reason: "正在处理中" };
  }
  if (ep.redrawState === -1 || ep.extractState === -1) {
    return { key: "retry", label: "重试分析", theme: "primary", action: "analyze" };
  }
  if (ep.redrawState === 0) return { key: "analyze", label: "开始分析", theme: "primary", action: "analyze" };
  if (ep.redrawState === 1) return { key: "reconcile", label: "去认账", theme: "primary", route: "session" };
  if (ep.redrawState === 2) return { key: "storyboard", label: "生成转绘分镜", theme: "primary", action: "generateStoryboard" };
  if (ep.redrawState === 3) return { key: "review", label: "去确认", theme: "primary", route: "review" };
  if (ep.redrawState === 4) return { key: "produce", label: "去制作", theme: "success", route: "/production" };
  return { key: "analyze", label: "开始分析", theme: "primary", action: "analyze" };
}

export function secondaryActionsFor(ep: EpisodeState | null): PrimaryAction[] {
  if (!ep || ep.extractState === 0) return [];
  const out: PrimaryAction[] = [];
  if (ep.extractState === 1 || ep.redrawState > 0) {
    out.push({ key: "reanalyze", label: "重新分析", theme: "default", action: "analyze", reason: "会覆盖当前解析与转绘结果" });
  }
  if (ep.redrawState >= 3) {
    out.push({
      key: "cut",
      label: ep.clipsReady ? "已切原片 · 重切" : "切原片",
      theme: "default",
      action: "cut",
    });
  }
  return out;
}

export function stepAccessFor(o: {
  assetTotal: number;
  assetsConfirmed: number;
  capConfirmed: boolean;
}): { step2: boolean; step3: boolean; canGenerate: boolean; blockedReason: string | null } {
  // 零资产集（纯场景/无人物的集）没有可确认的资产：视为已确认，不能因此卡死第③步。
  const allConfirmed = o.assetTotal === 0 ? true : o.assetsConfirmed >= o.assetTotal;
  const step2 = true; // 剧本可跳过
  const step3 = allConfirmed;
  const canGenerate = allConfirmed && o.capConfirmed;
  const blockedReason = !allConfirmed
    ? "还有资产未确认"
    : !o.capConfirmed
      ? "请先确认每段时长"
      : null;
  return { step2, step3, canGenerate, blockedReason };
}
