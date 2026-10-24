/**
 * 原生切点检测（spec §5.2）：ffmpeg 场景分数候选 → 轻度聚类 → 最短镜/首尾约束。
 *
 * ── 为什么不用 hypit / 外部脚本 ──
 * 原实现依赖外部仓库的 CLI（见 routes/redraw/analyzeSource.ts 的历史注释）。交付要能打包，
 * 所以这里只用 ffmpeg 自带的 select='gt(scene,TH)' + metadata=print ——
 * 它给的是**帧级**时间戳（pts_time）与场景分数（scene_score），足够支撑「切点表」这个下游输入。
 *
 * ── 验收口径（spec §5.2 明确写了「不要求与 hypit 完全相同」）──
 *  · 主要切点不漏；
 *  · 边界误差 ≤ 0.1s。
 * 所以本模块的核心是两个**纯函数**（clusterCuts / parseSceneScores）—— 它们的行为可以单测，
 * 不需要样本视频；真实样本比对留在部署窗口做（见实施计划 T1 的验收说明）。
 *
 * ── 两个关键参数 ──
 *  · gapSec = 0.25：相邻候选间隔 ≤ 0.25s 视为**同一次过渡**（场景检测在过渡期间会连出多帧），
 *    取簇内分数最高者。间隔 > 0.25s 就是两次不同过渡。
 *  · minShotSec = 0.4：最短镜长。切点太密会让下游分镜碎成 0.1s 的镜头（模型没法写描述）。
 *    首镜从 0 起算，所以第一个保留的切点也必须 ≥ 0.4s。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { config } from "@/config";

const run = promisify(execFile);

export type CutCandidate = { at: number; score: number };

export type ClusterOptions = {
  /** 同一次过渡的最大候选间隔（秒）。默认 0.25 */
  gapSec?: number;
  /** 最短镜长（秒）。默认 0.4 */
  minShotSec?: number;
  /** 视频总时长（秒）。给了才做「末尾 0.2s 内丢弃」与「末镜不短于 minShotSec」 */
  duration?: number;
  /** 距片头/片尾的丢弃余量（秒）。默认 0.2 */
  edgeSec?: number;
};

/** 排序 + 稳定性：候选可能乱序、可能重复，统一在这里归一。 */
function normalize(cands: CutCandidate[]): CutCandidate[] {
  return cands
    .filter((c) => Number.isFinite(c?.at) && Number.isFinite(c?.score) && c.at >= 0 && c.score >= 0)
    .map((c) => ({ at: c.at, score: c.score }))
    .sort((a, b) => a.at - b.at || b.score - a.score);
}

/**
 * 候选 → 切点时间数组（升序，单位秒，保留 3 位小数）。
 *
 * 步骤：排序 → 按 gapSec 分簇（间隔 ≤ gap 同簇）→ 每簇取最高分（同分取更早的）
 * → 丢弃首尾 edgeSec 内的 → 贪心保证相邻切点（含片头 0）间隔 ≥ minShotSec。
 *
 * ⚠ 贪心是**按时间顺序**的：在同一次过渡已经被聚类之后，0.4s 内的两个切点本就不该同时存在
 * （那意味着一个镜头短于 0.4s）。先到先得而不是「留给分数高的」，因为切点是**时间顺序**语义，
 * 抬高一簇的分数去覆盖前一簇会让镜序错位。
 */
export function clusterCuts(cands: CutCandidate[], o: ClusterOptions = {}): number[] {
  const gapSec = o.gapSec ?? 0.25;
  const minShotSec = o.minShotSec ?? 0.4;
  const edgeSec = o.edgeSec ?? 0.2;
  const sorted = normalize(cands);
  if (!sorted.length) return [];

  // 1) 分簇：簇内取最高分
  const clusters: CutCandidate[][] = [];
  for (const c of sorted) {
    const last = clusters[clusters.length - 1];
    const lastAt = last?.[last.length - 1]?.at;
    if (last && lastAt !== undefined && c.at - lastAt <= gapSec) last.push(c);
    else clusters.push([c]);
  }
  const picked: CutCandidate[] = clusters.map((cl) => {
    // 同分取更早：normalize 已按 at 升序，这里用严格大于即可保序
    let best = cl[0];
    for (const c of cl) if (c.score > best.score) best = c;
    return best;
  });

  // 2) 首尾约束：片头/片尾 edgeSec 内的候选丢弃（它们不是「镜头之间」的过渡）
  const duration = o.duration;
  const edgeFiltered = picked.filter((c) => {
    if (c.at < edgeSec) return false;
    if (duration !== undefined && Number.isFinite(duration) && c.at > duration - edgeSec) return false;
    return true;
  });

  // 3) 最短镜长：从片头 0 起贪心，末镜也要 ≥ minShotSec
  const out: number[] = [];
  let prev = 0;
  for (const c of edgeFiltered) {
    if (c.at - prev < minShotSec) continue;
    if (duration !== undefined && Number.isFinite(duration) && duration - c.at < minShotSec) continue;
    out.push(Math.round(c.at * 1000) / 1000);
    prev = c.at;
  }
  return out;
}

/**
 * 解析 ffmpeg metadata=print 的输出（stdout+stderr 都可）。
 *
 * 实际输出形如（两行一组，顺序固定）：
 *   [Parsed_metadata_2 @ 0000] frame:12   pts:512   pts_time:0.512
 *   [Parsed_metadata_2 @ 0000] lavfi.scene_score=0.184219
 * 解析失败的行**跳过**而不是抛错：ffmpeg 的日志会混进版本/输入信息，因一行杂音整集失败不值得。
 */
export function parseSceneScores(text: string): CutCandidate[] {
  const out: CutCandidate[] = [];
  let pendingAt: number | null = null;
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const t = /pts_time:\s*(-?\d+(?:\.\d+)?)/.exec(raw);
    if (t) {
      pendingAt = Number(t[1]);
      continue;
    }
    const s = /(?:lavfi\.)?scene_score=([0-9]+(?:\.[0-9]+)?)/.exec(raw);
    if (s && pendingAt !== null) {
      out.push({ at: pendingAt, score: Number(s[1]) });
      pendingAt = null;
    }
  }
  return normalize(out);
}

export type DetectCutsOptions = {
  /** 场景分数阈值，默认 0.3（spec §5.2） */
  threshold?: number;
  ffmpegPath?: string;
  timeoutMs?: number;
  /** 测试注入：替代真实 ffmpeg 的执行函数。 */
  exec?: (bin: string, args: string[], opts: { timeout: number; maxBuffer: number }) => Promise<{ stdout?: string; stderr?: string }>;
};

/** 跑一次 ffmpeg 收集场景候选（未聚类）。调用方一般直接用 detectCuts 再 clusterCuts。 */
export async function detectCutCandidates(videoAbs: string, o: DetectCutsOptions = {}): Promise<CutCandidate[]> {
  const threshold = o.threshold ?? 0.3;
  const bin = o.ffmpegPath ?? config.ffmpeg.path;
  const timeout = o.timeoutMs ?? config.ffmpeg.timeoutMs;
  // ⚠ select 的表达式里 `,` 是滤镜分隔符，必须整段作为**一个** argv 参数给 ffmpeg；
  //   -an 是因为切点只关心画面；-f null - 不落盘任何产物。
  const filter = "select='gt(scene," + threshold + ")',metadata=print";
  const args = ["-hide_banner", "-nostdin", "-i", videoAbs, "-vf", filter, "-an", "-f", "null", "-"];
  const runner = o.exec ?? (async (b, a, opts) => run(b, a, { timeout: opts.timeout, maxBuffer: opts.maxBuffer }));
  try {
    const { stdout, stderr } = await runner(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 });
    return parseSceneScores(String(stdout ?? "") + "\n" + String(stderr ?? ""));
  } catch (e: any) {
    if (e?.code === "ENOENT") throw new Error("找不到 " + bin + "，请确认已安装 ffmpeg（或用 MIWO_FFMPEG_PATH 指定）");
    // ffmpeg 把内容都写在 stderr；execFile 的 error.stderr 里是真正的诊断信息
    const tail = String(e?.stderr ?? "").trim().split(/\r?\n/).slice(-3).join(" | ");
    throw new Error("切点检测失败（" + bin + "）：" + (tail || e?.message || e));
  }
}

/**
 * 切点检测（候选 + 解析）。**不读视频总时长** —— 时长由调用方 probeVideo 给出后传给 clusterCuts
 * （这样本函数不需要自己再 probe 一次，也便于单测注入）。
 */
export async function detectCuts(videoAbs: string, o: DetectCutsOptions = {}): Promise<CutCandidate[]> {
  return detectCutCandidates(videoAbs, o);
}
