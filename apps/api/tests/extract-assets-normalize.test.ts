import { describe, expect, it } from "vitest";
import { normalizeAssetItems } from "@/routes/script/extractAssets";

/**
 * AI 工具入参**没有运行时校验**（`jsonSchema` 只约束模型输出），
 * 所以 `asset.scriptIds` 可能是缺失、字符串、数字 —— 直接 `for...of` 会抛
 * `asset.scriptIds is not iterable`（线上实测：剧本页「资产提取失败」）。
 * 本用例锁死"把各种脏形状收干净"的行为。
 */
describe("normalizeAssetItems", () => {
  const batch = [7, 8];

  it("回填缺失的 scriptIds 为本批剧本 id（不再抛 not iterable）", () => {
    const { newAssets } = normalizeAssetItems(
      { newAssets: [{ name: "林晚", desc: "女主", type: "role" }] },
      batch,
    );
    expect(newAssets).toEqual([{ name: "林晚", desc: "女主", type: "role", scriptIds: [7, 8] }]);
  });

  it("把字符串/数字形式的 scriptIds 收成数字数组", () => {
    const { newAssets, existingRefs } = normalizeAssetItems(
      {
        newAssets: [
          { name: "雾港码头", desc: "码头", type: "scene", scriptIds: "7, 8" },
          { name: "老怀表", desc: "道具", type: "tool", scriptIds: 7 },
        ],
        existingAssetRefs: [{ name: "林晚", scriptIds: ["8"] }],
      },
      batch,
    );
    expect(newAssets.map((a) => a.scriptIds)).toEqual([[7, 8], [7]]);
    expect(existingRefs).toEqual([{ name: "林晚", scriptIds: [8] }]);
  });

  it("丢弃无名条目、非法类型回退 scene、非法 id 剔除并去重", () => {
    const { newAssets } = normalizeAssetItems(
      {
        newAssets: [
          { name: "", desc: "无名字", type: "role", scriptIds: [7] },
          { name: "旧船票", desc: "道具", type: "unknown-type", scriptIds: [7, "abc", 8, 8] },
        ],
      },
      batch,
    );
    expect(newAssets).toEqual([{ name: "旧船票", desc: "道具", type: "scene", scriptIds: [7, 8] }]);
  });

  it("容忍工具返回单个对象而不是数组", () => {
    const { newAssets } = normalizeAssetItems(
      { newAssets: { name: "林晚", desc: "女主", type: "role", scriptIds: [7] } },
      batch,
    );
    expect(newAssets).toHaveLength(1);
    expect(newAssets[0].name).toBe("林晚");
  });

  it("空/非对象输入返回空列表，不抛异常", () => {
    expect(normalizeAssetItems({}, batch)).toEqual({ newAssets: [], existingRefs: [] });
    expect(normalizeAssetItems({ newAssets: null, existingAssetRefs: "x" }, batch)).toEqual({
      newAssets: [],
      existingRefs: [],
    });
  });
});
