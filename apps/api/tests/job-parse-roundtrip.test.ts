/**
 * ★ review-C F1（Critical）的**机械往返守卫**。
 *
 * 不变式：对注册表里的**每一个**任务类型，`parse()` 必须对自己的输出幂等 ——
 *    `parse(JSON.parse(JSON.stringify(parse(raw))))` 必须成功，且形状与第一次 `parse(raw)` **逐字段相等**。
 *
 * 为什么必须有这一条：`store.enqueue()` 会先 `parse()` 归一化再入库，而 `worker.ts` 领到任务后
 * 会把**入库的那份 JSON** 再 `parse()` 一次。所以任何"非幂等 parse"都会让该类型
 * **入队成功、worker 领走即 dead** —— `video.generate` 就是这么坏的
 * （实测原文：`lastError=[job] video.generate payload 缺少 videoId`，`o_video.state` 永远停在"生成中"）。
 *
 * ⚠ 本用例按**注册表**遍历（不是硬编码 7 个字符串）：新增任务类型若 parse 不幂等，
 *   这条会立刻红 —— 它才是这一整类缺陷的机械守卫。
 */
import { describe, expect, it } from "vitest";
import { JOB_DEFINITIONS, jobRegistry } from "@/jobs/registry";

/**
 * 每个类型的**入队侧原始形状**（= 路由真实传的那一份）。
 * ⚠ 只写引用 id/路径，**不写 base64**（队列不许存大对象）。
 */
const RAW: Record<string, unknown> = {
  // ⚠ 最常用的单个视频入口传的是**扁平**形状（generateVideo.ts 的 payload），parse 必须把它包成 items[]
  "video.generate": {
    projectId: 1,
    scriptId: 2,
    model: "miwo:m",
    mode: "text",
    resolution: "720p",
    audio: false,
    aspectRatio: "16:9",
    trackId: 3,
    videoId: 4,
    videoPath: "/1/video/x.mp4",
    prompt: "p",
    duration: 5,
    refs: [{ path: "/1/a.png", sources: "role" }],
  },
  "video.batchGenerate": {
    projectId: 1,
    scriptId: 2,
    model: "miwo:m",
    mode: "text",
    resolution: "720p",
    aspectRatio: "16:9",
    items: [{ videoId: 4, videoPath: "/1/video/x.mp4", trackId: 3, prompt: "p", duration: 5, refs: [] }],
  },
  "image.assets.batch": {
    projectId: 1,
    model: "miwo:m",
    resolution: "1K",
    items: [{ assetsId: 11, imageId: 12, type: "role", name: "n", prompt: "p" }],
  },
  "image.storyboard.batch": { projectId: 1, scriptId: 2, storyboardIds: [21, 22], compulsory: false },
  "image.productionAssets.batch": { projectId: 1, scriptId: 2, assetIds: [31] },
  "prompt.batch": { projectId: 1, model: "miwo:m", mode: "text", trackData: [{ trackId: 41, info: [{ id: 42, sources: "storyboard" }] }] },
  // 转绘 M1/M3：只存引用 id（解析/模型调用的参数都在 handler 里从库/文件取）
  "redraw.prepare": { projectId: 1, scriptId: 2, replace: true, lang: "zh" },
  "redraw.storyboard": { projectId: 1, scriptId: 2 },
  "selftest.sleep": { ms: 10, tag: "roundtrip" },
};

describe("parse 往返幂等（review-C F1 的机械守卫）", () => {
  it("★ 每个注册类型的 parse 都对自己的输出幂等（`parse(parse(raw))` 形状稳定）", () => {
    for (const def of JOB_DEFINITIONS) {
      const raw = RAW[def.type];
      expect(raw, `RAW 表缺 ${def.type} 的入队侧样例（新增类型必须同时加样例）`).toBeDefined();

      const once = def.parse(raw);
      const stored = JSON.parse(JSON.stringify(once)); // ← 入库再取出的那一份
      let twice: unknown;
      expect(() => {
        twice = def.parse(stored);
      }, `${def.type} 的 parse 对入库形状**不幂等**（worker 重解析会抛 ⇒ 该类型永远 dead）`).not.toThrow();
      expect(twice, `${def.type} 的 parse 往返后形状变了（必须逐字段相等）`).toEqual(stored);
    }
  });

  it("★ 覆盖度：注册表里每个类型都有往返样例（防止新增类型漏加样例而恒绿）", () => {
    for (const def of JOB_DEFINITIONS) {
      expect(Object.keys(RAW), `RAW 表必须覆盖 ${def.type}`).toContain(def.type);
    }
    // 反向：RAW 里也不该有注册表之外的类型（否则是过期残留）
    const types = JOB_DEFINITIONS.map((d) => d.type).sort();
    expect(Object.keys(RAW).sort()).toEqual(types);
  });

  it("★ 回归到 review-C 的实测反例：video.generate 的入库形状（items[]）必须能被再解析", () => {
    const def = jobRegistry.get("video.generate");
    expect(def).not.toBeNull();
    // review-C 证据原文里的 STORED_PAYLOAD 形状
    const stored = {
      projectId: 1,
      scriptId: 2,
      model: "miwo:m",
      mode: "text",
      resolution: "720p",
      audio: false,
      aspectRatio: "16:9",
      items: [{ videoId: 4, videoPath: "/1/video/x.mp4", trackId: 3, prompt: "p", duration: 5, refs: [] }],
    };
    expect(() => def!.parse(stored)).not.toThrow();
    expect(def!.parse(stored)).toEqual(stored);
  });

  it("坏形状仍然抛（幂等化不得把校验放宽）", () => {
    const def = jobRegistry.get("video.generate")!;
    expect(() => def.parse({})).toThrow(/缺少 videoId/);
    // ⚠ `items: []`（空数组）走的是"扁平分支"⇒ 报的仍是"缺少 videoId"（不是 `parseBatch` 的"items 不能为空"）。
    //   诊断文案不同但**拒收行为一致**；这里钉的是"空 items 绝不能被接受"，不许因为文案不同而放宽。
    expect(() => def.parse({ projectId: 1, scriptId: 2, model: "m", resolution: "720p", items: [] })).toThrow(/缺少 videoId|items 不能为空/);
    expect(() => def.parse({ projectId: 1, scriptId: 2, model: "m", resolution: "720p", items: [{ videoId: 1 }] })).toThrow(/缺少 videoId\/videoPath\/prompt/);
  });
});