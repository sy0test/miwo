/**
 * `?size=` 解析的用例（Phase 1e Task 01 Step 3b）。
 *
 * 判别力的核心是**上界**：`MAX_THUMB_PX` / `MAX_THUMB_PERCENT` 被放大到无效值（例如 `1e9`）时，
 * "越界 → 拒绝"这两条必须立刻红 —— 因为签名是路径域的（query 不参与），
 * 任何拿到过一条合法媒体 URL 的人都能自由改 `size`，上界是这块唯一的收口。
 */
import { describe, expect, it } from "vitest";
import { MAX_THUMB_PERCENT, MAX_THUMB_PX, parseThumbnailSize } from "@/utils/thumbnail-size";

describe("?size= 解析", () => {
  it("宽高格式", () => {
    expect(parseThumbnailSize("200x300")).toEqual({
      ok: true,
      subDir: "200x300",
      opts: { type: "dimensions", width: 200, height: 300 },
    });
  });

  it("百分比格式（带 % 与不带 % 等价）", () => {
    expect(parseThumbnailSize("30")).toEqual({ ok: true, subDir: "30p", opts: { type: "percentage", value: 30 } });
    expect(parseThumbnailSize("30%")).toEqual({ ok: true, subDir: "30p", opts: { type: "percentage", value: 30 } });
    expect(parseThumbnailSize("12.5%")).toEqual({ ok: true, subDir: "12.5p", opts: { type: "percentage", value: 12.5 } });
  });

  it("★ 边界内侧必须放行（上界不等于一律拒绝）", () => {
    const maxPx = parseThumbnailSize(`${MAX_THUMB_PX}x${MAX_THUMB_PX}`);
    expect(maxPx.ok).toBe(true);
    const maxPct = parseThumbnailSize(String(MAX_THUMB_PERCENT));
    expect(maxPct.ok).toBe(true);
  });

  it("★★ 宽高越界 → 拒绝", () => {
    expect(parseThumbnailSize(`${MAX_THUMB_PX + 1}x10`).ok).toBe(false);
    expect(parseThumbnailSize(`10x${MAX_THUMB_PX + 1}`).ok).toBe(false);
    expect(parseThumbnailSize("99999x1").ok).toBe(false);
  });

  it("★★ 百分比越界 → 拒绝", () => {
    expect(parseThumbnailSize(String(MAX_THUMB_PERCENT + 1)).ok).toBe(false);
    expect(parseThumbnailSize("9999").ok).toBe(false);
    expect(parseThumbnailSize("0").ok).toBe(false);
    expect(parseThumbnailSize("0%").ok).toBe(false);
  });

  it("非数字/空 → 拒绝（不得回退成原图）", () => {
    expect(parseThumbnailSize("abc").ok).toBe(false);
    expect(parseThumbnailSize("").ok).toBe(false);
    expect(parseThumbnailSize(undefined).ok).toBe(false);
    expect(parseThumbnailSize("10x").ok).toBe(false);
  });

  it("注入形态 → 拒绝（`..`、路径分隔符、超长数字）", () => {
    expect(parseThumbnailSize("../../etc").ok).toBe(false);
    expect(parseThumbnailSize("10\\\\20").ok).toBe(false);
    expect(parseThumbnailSize("99999999999x1").ok).toBe(false);
  });

  it("数组形态（`?size=a&size=b`）→ 拒绝，不猜第一个", () => {
    expect(parseThumbnailSize(["20", "30"]).ok).toBe(false);
  });
});
