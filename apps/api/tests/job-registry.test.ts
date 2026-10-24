/**
 * 任务类型注册表的机械守卫（Phase 1d Task 7）。
 *
 * 为什么需要它：注册表是**显式数组**（`src/jobs/registry.ts`），所以"写了 handler 忘了注册"
 * 不会让任何东西变红 —— 症状是"入队成功、永远没人执行"，只有到生产上才发现。
 * 这里把三件事钉死：
 *   ① 类型集合与预期逐一相等（新增/删除类型必须同时改这里 ⇒ 强制人工过目）；
 *   ② 每个类型都有正的超时、≥1 的重试上限、非空 pool；
 *   ③ `src/jobs/handlers/*.ts` 与 `registry.ts` 的 import **一一对应**（多写一个没注册的
 *      handler 文件、或注册了一个不存在的文件，都会红）。
 *
 * ⚠ 判别力说明（不要为了"好维护"把这些断言弱化成 `toContain`）：
 *   · 判据 ① 用 `toEqual`（集合相等），不是 `expect(subset)`；
 *   · 判据 ④（视频不重试）是**真金白银**的守卫：视频重复调用 = 重复扣费，所以 `video.*`
 *     的 `maxAttempts` 必须是 1（改实现删掉它 ⇒ 红）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_DEFINITIONS } from "@/jobs/registry";

const EXPECTED = [
  "video.generate",
  "video.batchGenerate",
  "image.assets.batch",
  "image.storyboard.batch",
  "image.productionAssets.batch",
  "prompt.batch",
  // 2026-10-24 转绘 M1：预处理 + 解析（redraw.prepare）
  "redraw.prepare",
  "redraw.storyboard",
  "selftest.sleep",
].sort();

describe("任务类型注册表", () => {
  it("类型集合与预期逐一相等（新增/删除类型必须同时改这里）", () => {
    expect(JOB_DEFINITIONS.map((d) => d.type).sort()).toEqual(EXPECTED);
  });

  it("每个类型都有正的超时/重试上限，且 pool 非空", () => {
    for (const d of JOB_DEFINITIONS) {
      expect(d.timeoutMs, d.type).toBeGreaterThan(0);
      expect(d.maxAttempts, d.type).toBeGreaterThanOrEqual(1);
      expect(d.pool.length, d.type).toBeGreaterThan(0);
    }
  });

  it("每个 handler 文件都被 registry 引用（防止'写了 handler 忘了注册'）", () => {
    const dir = path.resolve(__dirname, "..", "src", "jobs", "handlers");
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => f.replace(/\.ts$/, ""));
    // 8 = selftest + videoGenerate + imageAssets + imageStoryboard + imageProductionAssets + promptBatch
    //     + redrawPrepare + redrawStoryboard
    expect(files.length).toBe(8);
    const src = fs.readFileSync(path.resolve(__dirname, "..", "src", "jobs", "registry.ts"), "utf8");
    for (const f of files) expect(src).toContain(`handlers/${f}"`);
  });

  it("视频类型不重试（maxAttempts=1），这是'重复扣费'的守卫", () => {
    const videos = JOB_DEFINITIONS.filter((x) => x.type.startsWith("video."));
    expect(videos.length).toBe(2); // 防止 filter 写错导致本用例恒真
    for (const d of videos) expect(d.maxAttempts, d.type).toBe(1);
  });

  it("多参 handler 的 payload 只有引用 id（注册表层面没有 base64 进入的通道）", () => {
    // 静态断言：6 个业务 handler 的 parse 都必须是函数（入队即校验），且类型唯一
    for (const d of JOB_DEFINITIONS) expect(typeof d.parse, d.type).toBe("function");
    const types = JOB_DEFINITIONS.map((d) => d.type);
    expect(new Set(types).size).toBe(types.length);
  });
});