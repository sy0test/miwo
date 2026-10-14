/**
 * 真进程事实探针（Phase 1c Task 8/9）：**"执行用户代码的能力已不存在"的运行期证据**。
 *
 * ── 它做什么 ──
 * 在一个**真 Node 进程**里 import 应用入口（`src/app.ts`，走完整模块图，包括注册表与 13 个适配器），
 * 然后把 `require.cache` 的键全量打印成一行 JSON。
 *
 * ── 为什么必须这样证（Ruling 243 的口径）──
 * "源码里 grep 不到 vm2"只能证明**没有人写这个名字**；用别的名字 `require` 进来照样能溜过去。
 * 所以判据是**运行期**的：真进程加载完之后，进程里到底有没有 vm2 / sucrase。
 *
 * ⚠ **观测不到闭包不等于干净**：调用方必须同时断言
 *   ① 探针真的打印了（`VS_REQUIRE_CACHE=<n>`）、② n 是个"像真仓库"的数（>50）、
 *   ③ 应用自己的模块（`app.ts`/`router.ts`）**在**缓存里（正面对照：证明模块图真的被加载了）。
 *   三条缺一条 ⇒ 判据无效（`tests/vendor-secrets.test.ts` 的 D1 就是这么写的）。
 *
 * ⚠ 它会**真的启动服务**（`app.ts` 末行是 `startServe()`）⇒ 必须给它一次性 `MIWO_DATA_DIR`
 *   与随机端口（调用方负责），跑完即杀。`apps/api/data/db2.sqlite` 全程只读不碰。
 *
 * 用法（由用例 spawn，不手工跑）：`node --import=tsx tests/helpers/require-cache-probe.ts`
 */
import fs from "node:fs";
import Module from "node:module";

const OUT_PREFIX = "VS_REQUIRE_CACHE";

async function main(): Promise<void> {
  // `MIWO_DB_DRIVER` 钉死 sqlite：探针的环境若漂到 mysql 会去连不存在的服务端。
  process.env.MIWO_DB_DRIVER = process.env.MIWO_DB_DRIVER ?? "sqlite";
  await import("@/app");
  const keys = Object.keys((Module as any)._cache);
  console.log(`${OUT_PREFIX}=${keys.length}`);
  console.log(`${OUT_PREFIX}_KEYS=${JSON.stringify(keys)}`);
  // 打印"应用自己的文件在缓存里"的两条正面对照（调用方也会查，这里给一眼可见的证据）
  const appHit = keys.filter((k) => /[\\/](app|router)\.ts$/.test(k));
  console.log(`${OUT_PREFIX}_APP_MODULES=${JSON.stringify(appHit)}`);
  // 沙箱模块的命中（正常必须为空数组）
  const sandboxHit = keys.filter((k) => /[\\/](vm2|sucrase)[\\/]/i.test(k));
  console.log(`${OUT_PREFIX}_SANDBOX_MODULES=${JSON.stringify(sandboxHit)}`);
  // ⚠ 刻意**不**在这里 exit(0)：服务还在监听，由调用方 kill；若本进程自己退出，说明启动就失败过。
  void fs;
}

main().catch((err) => {
  console.error("VS_PROBE_FAIL", err);
  process.exit(9);
});
