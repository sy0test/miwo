/**
 * 单段上限（`o_project.redrawMaxSegmentSec`）的读写 + 第③步「时长确认」。
 *
 * 规则（spec §9.5 / T11）：
 *  · 合法范围 **4..30 秒**；
 *  · 用户**改值**时，解析出来的分镜是按旧上限切的 ⇒ 必须**重跑解析**。所以默认返回 409
 *    （`needRerun: true`），只有显式 `force: true`（用户在弹窗里确认"要重跑"）才写库并留审计；
 *  · 不改值 = 只写"已确认"记录（第③步的闸门），不触发重跑。
 *
 * 审计：写进工作区 `redrawCapConfirm`（`{seconds, at, forced?, from?}`）—— 谁在什么时候把上限从多少改到多少。
 */
import { writeCapConfirm } from "@/redraw/state";

export const SEGMENT_CAP_MIN = 4;
export const SEGMENT_CAP_MAX = 30;
export const SEGMENT_CAP_DEFAULT = 15;

export class SegmentCapError extends Error {
  code: "out_of_range" | "need_rerun";
  constructor(code: "out_of_range" | "need_rerun", message: string) {
    super(message);
    this.name = "SegmentCapError";
    this.code = code;
  }
}

/** 校验并归一（整数、4..30）。非法值抛 `out_of_range`。 */
export function normalizeSegmentCap(seconds: unknown): number {
  const n = Number(seconds);
  if (!Number.isInteger(n) || n < SEGMENT_CAP_MIN || n > SEGMENT_CAP_MAX) {
    throw new SegmentCapError("out_of_range", "单段上限必须是 " + SEGMENT_CAP_MIN + ".." + SEGMENT_CAP_MAX + " 的整数秒，实际：" + String(seconds));
  }
  return n;
}

/** 读项目的当前上限（缺省 15）。 */
export async function readSegmentCap(db: any, projectId: number): Promise<number> {
  const row = await db("o_project").where("id", projectId).select("redrawMaxSegmentSec").first();
  const n = Number(row?.redrawMaxSegmentSec);
  return Number.isInteger(n) && n >= SEGMENT_CAP_MIN && n <= SEGMENT_CAP_MAX ? n : SEGMENT_CAP_DEFAULT;
}

export type ConfirmSegmentCapResult = { ok: true; changed: boolean; cap: number };

/**
 * 确认单段上限。
 *
 * · 与当前值相同 ⇒ 只写确认记录（幂等），`changed: false`；
 * · 不同且 `force !== true` ⇒ 抛 `SegmentCapError("need_rerun")`（路由翻 409 + `data.needRerun=true`）；
 * · 不同且 `force === true` ⇒ 写项目 + 确认记录（带审计 from/forced），`changed: true`。
 */
export async function confirmSegmentCap(
  db: any,
  opts: { projectId: number; scriptId: number; seconds: unknown; force?: boolean },
): Promise<ConfirmSegmentCapResult> {
  const seconds = normalizeSegmentCap(opts.seconds);
  const current = await readSegmentCap(db, opts.projectId);
  if (seconds === current) {
    await writeCapConfirm(db, { projectId: opts.projectId, scriptId: opts.scriptId, seconds });
    return { ok: true, changed: false, cap: current };
  }
  if (opts.force !== true) {
    throw new SegmentCapError(
      "need_rerun",
      "把单段上限从 " + current + "s 改成 " + seconds + "s 后，已有分镜的段时长不再符合新上限，需要重跑解析。",
    );
  }
  await db("o_project").where("id", opts.projectId).update({ redrawMaxSegmentSec: seconds });
  await writeCapConfirm(db, { projectId: opts.projectId, scriptId: opts.scriptId, seconds, forced: true, from: current });
  return { ok: true, changed: true, cap: seconds };
}