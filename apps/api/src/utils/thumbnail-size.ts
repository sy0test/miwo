/**
 * `/oss/**?size=` 的可单测解析（带**显式上界**）—— Phase 1e Task 01 Step 3b。
 *
 * ── 为什么必须从 `app.ts` 抽出来并加上界 ──
 * 1e 之前这段逻辑内联在 `app.ts` 的缩略图分支里，且**没有上界**：
 *   · `?size=99999x1` / `?size=999999999` 会被 `\d+` 直接接受 ⇒ 服务端按请求方给的尺寸生成缩略图
 *     （内存/CPU/磁盘放大器）；而签名是**路径域**的（query 不参与），所以**任何拿到过一条合法
 *     媒体 URL 的人都能自由改 `size`** —— 放大面必须在这里收口。
 *   · 非法取值原来"静默降级返回原图"，等于把"参数没校验"伪装成"宽容"。
 * 现在：非法 / 越界一律 `{ok:false}`，由调用方回 **400**（不再静默降级）。
 *
 * 行为与旧内联逻辑**等价**的部分：`200x300` → 等比压到该宽高边界；`30` / `30%` → 按百分比。
 * 新增的只有上界（`MAX_THUMB_PX` / `MAX_THUMB_PERCENT`）与"非法即拒绝"。
 */
import type { ThumbnailSize } from "@/utils/image";

/** 宽高上界：超过它就不再生成缩略图（不参与签名带来的放大拒绝服务面必须收口）。 */
export const MAX_THUMB_PX = 4096;
/** 百分比上界：超过 200% 没有业务意义，且会成为带宽放大器。 */
export const MAX_THUMB_PERCENT = 200;

export type ThumbnailSizeParse =
  | { ok: true; subDir: string; opts: ThumbnailSize }
  | { ok: false; reason: string };

/**
 * 解析 `?size=` 的取值。
 *  - `200x300` → 等比压缩到该宽高边界
 *  - `30` / `30%` → 等比压缩到原图的 30%
 *  - 非法或越界 → `{ok:false}`（调用方回 400）
 */
export function parseThumbnailSize(raw: unknown): ThumbnailSizeParse {
  if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "size 为空" };
  const value = raw.trim();

  const dimens = value.match(/^(\d{1,5})x(\d{1,5})$/i);
  if (dimens) {
    const w = parseInt(dimens[1], 10);
    const h = parseInt(dimens[2], 10);
    if (w < 1 || h < 1) return { ok: false, reason: `宽高必须 >=1：${value}` };
    if (w > MAX_THUMB_PX || h > MAX_THUMB_PX) return { ok: false, reason: `宽高必须 <=${MAX_THUMB_PX}：${value}` };
    return { ok: true, subDir: `${w}x${h}`, opts: { type: "dimensions", width: w, height: h } };
  }

  const percent = value.match(/^(\d{1,4}(?:\.\d{1,2})?)\s*%?$/);
  if (percent) {
    const pct = parseFloat(percent[1]);
    if (!(pct > 0)) return { ok: false, reason: `百分比必须 >0：${value}` };
    if (pct > MAX_THUMB_PERCENT) return { ok: false, reason: `百分比必须 <=${MAX_THUMB_PERCENT}：${value}` };
    return { ok: true, subDir: `${percent[1]}p`, opts: { type: "percentage", value: pct } };
  }

  return { ok: false, reason: `无法识别的 size：${value}` };
}
