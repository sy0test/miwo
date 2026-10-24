/**
 * 任务契约 / 策略常量 / 注册表 / 租户适配的用例（Task 2 的完成判据）。
 *
 * 三层判据：
 *  1. **状态集合**：终态 ∪ 活跃态 == 6 个状态且互斥（漏一个状态会让"是否终态"的判定静默错）；
 *  2. **策略常量**：`heartbeatMs * 4 <= leaseMs`（心跳必须显著小于租约）、退避递增且封顶；
 *  3. **注册表行为**：重复注册抛错、未知类型返回 null（判别力：脏 job 不许让 worker 崩）。
 * 另加一组 **租户适配**用例：`withJobTenant` 必须真的建出 ctx（且 role 是 `user`，不提权），
 * `userId = null` 时必须**不建 ctx**（平台任务；误碰租户表就该 fail-closed 抛错）。
 */
import { describe, expect, it } from "vitest";
import { JOB_POLICY, backoffMs } from "@/jobs/policy";
import { JOB_DEFINITIONS, createJobRegistry, jobRegistry } from "@/jobs/registry";
import { withJobTenant } from "@/jobs/tenant";
import { currentTenant, requireTenantCtx } from "@/db/tenant-context";
import { ACTIVE_STATES, TERMINAL_STATES, isTerminal, type JobDefinition } from "@/jobs/types";

describe("任务类型契约（spec §9.2 / §9.3）", () => {
  it("终态与活跃态互斥且覆盖全部 6 个状态", () => {
    const all = ["queued", "running", "succeeded", "failed", "dead", "canceled"] as const;
    expect([...TERMINAL_STATES, ...ACTIVE_STATES].sort()).toEqual([...all].sort());
    expect(new Set([...TERMINAL_STATES, ...ACTIVE_STATES]).size).toBe(6); // 互斥（并集 6 且无重复）
    for (const s of TERMINAL_STATES) expect(isTerminal(s)).toBe(true);
    for (const s of ACTIVE_STATES) expect(isTerminal(s)).toBe(false);
    // 逐项钉住成员（只遍历集合成员的话，把 `dead` 从终态里删掉本用例仍会绿）
    expect([...TERMINAL_STATES].sort()).toEqual(["canceled", "dead", "failed", "succeeded"]);
    expect([...ACTIVE_STATES].sort()).toEqual(["queued", "running"]);
  });

  it("策略常量是合法值（心跳显著小于租约、退避递增且封顶、payload 上限明确）", () => {
    expect(JOB_POLICY.heartbeatMs * 4).toBeLessThanOrEqual(JOB_POLICY.leaseMs);
    expect(JOB_POLICY.leaseMs).toBeGreaterThan(0);
    expect(JOB_POLICY.globalMaxRunning).toBeGreaterThanOrEqual(1);
    expect(JOB_POLICY.perUserMaxRunning).toBeGreaterThanOrEqual(1);
    expect(JOB_POLICY.maxPayloadBytes).toBe(64 * 1024);
    expect(JOB_POLICY.claimBatch).toBeGreaterThanOrEqual(JOB_POLICY.globalMaxRunning);
    expect(JOB_POLICY.gateLeaseMs).toBeGreaterThan(JOB_POLICY.gatePollMs);
    expect(backoffMs(1)).toBe(JOB_POLICY.retryBaseMs);
    expect(backoffMs(2)).toBe(JOB_POLICY.retryBaseMs * 2);
    expect(backoffMs(99)).toBe(JOB_POLICY.retryMaxMs);
    // 非法输入不得产生负/NaN 退避（0 / 负数 / 小数都按 1 处理）
    expect(backoffMs(0)).toBe(JOB_POLICY.retryBaseMs);
    expect(backoffMs(-5)).toBe(JOB_POLICY.retryBaseMs);
    expect(backoffMs(1.9)).toBe(JOB_POLICY.retryBaseMs);
  });

  it("注册表：重复类型必须抛错，未知类型返回 null", () => {
    const def: JobDefinition<{ n: number }> = {
      type: "t", timeoutMs: 1000, maxAttempts: 1, pool: "p",
      parse: (raw) => raw as { n: number },
      dedupeKey: () => "k",
      handle: async () => null,
    };
    expect(() => createJobRegistry([def, def])).toThrow(/重复注册/);
    const r = createJobRegistry([def]);
    expect(r.get("t")).toBe(def);
    expect(r.get("nope")).toBeNull(); // **不抛**：worker 要能把脏 job 判失败而不是崩
    expect(r.all()).toEqual([def]);
  });

  it("★ 全局注册表的登记集合是显式的（写 handler 忘注册 ⇒ 这条红）", () => {
    // Task 7 追加 6 个业务类型 + `selftest.sleep` 时，**这一行必须一起改**（本行已随 Task 7 更新）。
    // 故意的：注册表与实现一一对应，不允许"偷偷多/少一个类型"。
    // ⚠ 类型集合的**权威**断言在 `tests/job-registry.test.ts`（还带"handler 文件 ↔ registry import"机械守卫）；
    //   本条只做"这里也必须显式写出来"的冗余守卫，两个文件必须同时改。
    const TYPES = [
      "video.generate",
      "video.batchGenerate",
      "image.assets.batch",
      "image.storyboard.batch",
      "image.productionAssets.batch",
      "prompt.batch",
      // 2026-10-24 转绘 M1（见 tests/job-registry.test.ts 的同批更新）
      "redraw.prepare",
      "redraw.storyboard",
      "selftest.sleep",
    ].sort();
    expect([...JOB_DEFINITIONS].map((d) => d.type).sort()).toEqual(TYPES);
    expect(jobRegistry.all().map((d) => d.type).sort()).toEqual(TYPES);
    expect(jobRegistry.get("selftest.sleep")).not.toBeNull();
    // 未登记的类型仍然**不抛**、返回 null（worker 要把脏 job 判失败而不是崩）
    expect(jobRegistry.get("no.such.type")).toBeNull();
  });
});

describe("job → 租户 ctx 适配（spec §6.4）", () => {
  it("userId 非空：真的建出 ctx（role=user、source=system），并在回调结束后消失", async () => {
    expect(currentTenant()).toBeUndefined();
    await withJobTenant(7, async () => {
      const ctx = requireTenantCtx();
      expect(ctx.userId).toBe(7);
      // ⚠ 最小权限：任务**不是** admin（否则任何一条业务任务都能写 platform 表）
      expect(ctx.role).toBe("user");
      expect(ctx.source).toBe("system");
      expect(ctx.requestId.startsWith("job:")).toBe(true);
      // await 之后 ctx 仍在（ALS 语义）
      await new Promise((r) => setTimeout(r, 1));
      expect(currentTenant()?.userId).toBe(7);
    });
    expect(currentTenant()).toBeUndefined();
  });

  it("userId 为 null：不建 ctx（平台任务；误碰租户表就该 fail-closed 抛错）", async () => {
    let sawCtx: unknown = "NOT_CALLED";
    await withJobTenant(null, async () => {
      sawCtx = currentTenant() ?? null;
      expect(() => requireTenantCtx()).toThrow(/fail-closed/);
    });
    expect(sawCtx).toBeNull();
    // 返回值与异常都要原样透传（适配层不许吞错）
    await expect(withJobTenant(1, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(withJobTenant(null, async () => 42)).resolves.toBe(42);
  });

  it("两次任务尝试的 requestId 不同（便于把一次尝试的多条 SQL 串起来）", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      await withJobTenant(1, async () => {
        ids.push(requireTenantCtx().requestId);
      });
    }
    expect(ids[0]).not.toBe(ids[1]);
  });
});