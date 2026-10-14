/**
 * ★ review-C F2（Critical）的机械守卫：**worker 启动链必须初始化闸门单例**。
 *
 * 缺陷原样：`__setGateFactory()` 只写在 `@/jobs`（桶文件）里，而 `src/worker.ts` 的启动链从不 import 它
 * ⇒ worker 进程里六个 handler 的第一次 `withVendorSlot()` 直接抛 `[gate] 闸门未初始化`
 * （实测旁证：构建产物 `worker.js` 里连 `__setGateFactory(` 符号都没有，`app.js` 有 3 处）。
 *
 * 本文件守三层（缺一层就可能回退）：
 *  ① **源码**：两条启动链（`src/worker.ts` 与 `src/jobs/index.ts`）都必须 import `@/jobs/bootstrap`；
 *  ② **行为**：真子进程按"worker 的 import 顺序"启动 → `getGate()` 必须**不抛**（观测不到 ⇒ 用 exit 3，不是绿）；
 *  ③ **产物**：`tools/check-build.cjs` 另有断言（`worker.js` 与 `app.js` 都必须出现 `__setGateFactory(`）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";

const API_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-gate-init-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const read = (rel: string): string => fs.readFileSync(path.join(API_ROOT, rel), "utf8");

describe("worker 启动链的闸门初始化（review-C F2）", () => {
  it("★ 源码：worker 入口与 @/jobs 桶都 import 了 @/jobs/bootstrap", () => {
    const workerEntry = read("src/worker.ts");
    expect(workerEntry, "src/worker.ts 必须在启动链里初始化队列基础设施").toMatch(/@\/jobs\/bootstrap/);
    expect(workerEntry, "必须真的调用 bootstrapJobInfra()").toMatch(/bootstrapJobInfra\(\)/);
    // worker 入口的 import 点必须在 `await dbReady` **之后**（本模块会求值 @/utils：连接 → 迁移）
    const readyIdx = workerEntry.indexOf("await dbReady");
    const bootstrapIdx = workerEntry.indexOf("@/jobs/bootstrap");
    expect(readyIdx, "worker.ts 里应当有 await dbReady").toBeGreaterThan(-1);
    expect(bootstrapIdx, "bootstrap 的引用必须在 await dbReady 之后（避免在路径确定前触发迁移链）").toBeGreaterThan(readyIdx);

    const barrel = read("src/jobs/index.ts");
    expect(barrel, "@/jobs 桶也必须注册（API 侧只 import 它的既有路径不能退化）").toMatch(/@\/jobs\/bootstrap/);
  });

  it("★ 行为：按 worker 的 import 顺序真起一个子进程，`getGate()` 必须不抛", () => {
    const probe = path.join(TMP, "probe-gate-init.cjs");
    const dbFile = path.join(TMP, "probe.sqlite").replace(/\\/g, "/");
    fs.writeFileSync(
      probe,
      [
        `process.env.MIWO_ENV ||= "dev";`,
        `process.env.MIWO_PORT ||= "10599";`,
        `process.env.MIWO_HOST ||= "127.0.0.1";`,
        `process.env.MIWO_DATA_DIR ||= ${JSON.stringify(TMP.replace(/\\/g, "/"))};`,
        `process.env.MIWO_JWT_SECRET ||= "x".repeat(48);`,
        `const { createKnex } = require("@/db/connect");`,
        `const { runMigrations } = require("@/db/migrations");`,
        `const { __resetGateForTest, getGate } = require("@/jobs/gate");`,
        `const { bootstrapJobInfra } = require("@/jobs/bootstrap");`,
        `(async () => {`,
        `  const db = createKnex({ env: "dev", port: 10599, host: "127.0.0.1", dataDir: process.env.MIWO_DATA_DIR,`,
        `    mediaDir: process.env.MIWO_DATA_DIR + "/oss", storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599",`,
        `    trustProxy: 0, jwtSecret: "x".repeat(48), db: { driver: "sqlite", file: ${JSON.stringify(dbFile)} } });`,
        `  await runMigrations(db);`,
        `  __resetGateForTest();              // 清掉工厂与单例（模拟"worker 进程的初始状态"）`,
        `  try { getGate(); console.log("BEFORE_BOOTSTRAP=OK"); } catch (e) { console.log("BEFORE_BOOTSTRAP=THROW:" + e.message); }`,
        `  let afterOk = false;`,
        `  try { bootstrapJobInfra(); const g = getGate(); afterOk = typeof g.acquire === "function"; } catch (e) { console.log("AFTER_BOOTSTRAP=THROW:" + e.message); }`,
        `  console.log("AFTER_BOOTSTRAP=" + (afterOk ? "OK" : "FAIL"));`,
        `  await db.destroy();`,
        `  process.exit(afterOk ? 0 : 3);   // ⚠ 观测不到 ⇒ exit 3（不是绿）`,
        `})().catch((e) => { console.error(e); process.exit(3); });`,
      ].join("\n"),
      "utf8",
    );

    const r = spawnSync(process.execPath, ["--import=tsx", probe], {
      cwd: API_ROOT,
      encoding: "utf8",
      timeout: 180_000,
      env: { ...process.env },
    });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    // ① 注册前：必须先抛（证明"没注册就真的用不了"，不是测试假绿）
    expect(out, `期望注册前抛"未初始化"，实际输出：${out}`).toMatch(/BEFORE_BOOTSTRAP=THROW/);
    expect(out, "注册前抛的必须是明确的'未初始化'文案").toMatch(/闸门未初始化/);
    // ② 注册后：必须能用（否则 exit 3）
    expect(out, `bootstrapJobInfra() 之后 getGate() 必须可用；实际输出：${out}`).toMatch(/AFTER_BOOTSTRAP=OK/);
    expect(r.status, `子进程必须以 0 退出（观测不到 = exit 3）；输出：${out}`).toBe(0);
  }, 200_000);
});
