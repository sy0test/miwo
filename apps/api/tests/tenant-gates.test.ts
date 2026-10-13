/**
 * Task 8 门禁的 **CI 双入口**（brief Step 5 的 vitest 侧）：把两条收口后的门禁也在 `pnpm test` 里跑一遍。
 *
 * 为什么只跑"门禁自身"，不在这里做篡改类红端：
 *   · 门禁是**只读**脚本（读源码 + 读清单），spawn 它零副作用 ⇒ 可以安全地每轮都跑；
 *   · 篡改类红端（旧门禁看不见无别名 `systemDb`、删一张表三方必红、探针观测不到必须 exit 3…）
 *     需要**临时改源码**，而 `apps/api/src/**` 同时被 `tenant-db-bypass.test.ts` 等"遍历 src"的用例读 ——
 *     vitest 并行跑文件时会出现**跨用例互相看见临时文件**的假红/假绿。所以那些红端放在
 *     `task-8-report.md` 里以"VCS 还原的实验原文"形式给出（Ruling 229），而不是塞进并行测试。
 *   · 这里额外断言：两条门禁的**退出码**必须是 0（不是 "0 或 3"）—— 3 是"检查没跑起来"，
 *     把它当通过就等于放弃门禁（Ruling 243）。
 */
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");

function runGate(name: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [path.join("tools", name)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    timeout: 180000,
    windowsHide: true,
  });
  return { status: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("Phase 1b 门禁双入口（Task 8）", () => {
  it("check-tenant-exceptions 退出码必须是 0（清单一致 + 全部已标注 + 每条有 phase1b）", () => {
    const r = runGate("check-tenant-exceptions.cjs");
    expect(r.status, `门禁没通过（exit ${r.status}）：\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/systemDbUsers \d+ 个/);
    expect(r.out).toMatch(/历史存档 \d+ 条/);
  }, 200000);

  it("check-tenant-policies 退出码必须是 0（策略表 ↔ 001_schema ↔ 回填/自检三方一致）", () => {
    const r = runGate("check-tenant-policies.cjs");
    expect(r.status, `门禁没通过（exit ${r.status}）：\n${r.out}`).toBe(0);
    expect(r.out).toMatch(/check-tenant-policies 通过/);
    // 判别力：3 = "检查没跑起来"（探针观测不到），绝不能当成通过。
    expect(r.status).not.toBe(3);
  }, 200000);
});
