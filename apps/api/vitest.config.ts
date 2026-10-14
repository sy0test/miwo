import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * 测试用数据目录（`MIWO_DATA_DIR`）。
 *
 * ⚠ **允许外部覆盖，但只接受"仓库外"的路径**（review-D.md F-4）：
 *   · 默认 = 仓库外的固定目录 `D:\tmp\miwo-test-data`（保持原口径）；
 *   · 外部给了 `MIWO_DATA_DIR` 且它**不在本仓库内** ⇒ 用它。两个真实动机：
 *     ① `verify:phase1d` 的 E3 跑整套测试，需要**一次性目录**（否则与另一次并发运行共享同一个库，
 *        会互相污染 —— 复核轮实测"并发跑两次各 1 failed，独占即 584|14"）；
 *     ② CI 的 api job 本来就设了 `MIWO_DATA_DIR=${{runner.temp}}/miwo-ci-data`（见 ci.yml 注释），
 *        但此前被这里的硬编码**覆盖**，那句注释实际是假的。
 *   · 外部给的是**仓库内**路径（例如 `apps/api/data`，里面是真实 dev 库）⇒ **忽略覆盖、退回默认**：
 *     测试整库建删，绝不允许指向仓库里的数据目录（与 `src/db/connect.ts` 的目标护栏同一取向）。
 */
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const ENV_DATA_DIR = process.env.MIWO_DATA_DIR ? path.resolve(process.env.MIWO_DATA_DIR) : "";
const ENV_OUTSIDE_REPO = ENV_DATA_DIR !== "" && !ENV_DATA_DIR.toLowerCase().startsWith(REPO_ROOT.toLowerCase());
const TEST_DATA_DIR = ENV_OUTSIDE_REPO ? ENV_DATA_DIR : "D:\\tmp\\miwo-test-data";

export default defineConfig({
  // ⚠ 必须把 tsconfig 的 "@/*" 路径别名同步给 vitest，否则 src 里的 `@/config` 这类导入在测试里解析失败
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // ⚠ 迁移/导入类测试会整库建删；并行跑会让它们互相踩（Task 8/9 的 MySQL 集成测试尤其：
    //    那个测试会整库 drop/create，与其他用例并行必然互毁）。串行化的代价可接受（当前全部用例在 10s 量级）。
    fileParallelism: false,
    // ⚠ 必须有 test.env：`src/config.ts` 末行是 `export const config = loadConfig()`（模块级 fail-fast），
    //    vitest 在**收集阶段**就会 import 它；此时 process.env 里没有 MIWO_*，会直接抛
    //    `ConfigError: 缺少必需环境变量 MIWO_ENV`，**整个测试文件在收集阶段就崩**（实测复现过）。
    //    Task 8/9 的单测要 `import { config } from "@/config"`，没有这几行会同样整文件崩。
    env: {
      MIWO_ENV: "dev",
      MIWO_PORT: "10599",
      MIWO_HOST: "127.0.0.1",
      // ⚠ 必须用**仓库外绝对路径**：相对路径会让数据根随运行目录漂移，且将来若有测试 mkdir mediaDir
      //    就会在仓库里生成目录（`check-copy` 的 mustNotBeTracked 清单不含这类临时目录，有误提交风险）。
      //    ⚠ 覆盖规则见文件头注释（只接受仓库外路径；E3/CI 用一次性目录）。
      MIWO_DATA_DIR: TEST_DATA_DIR,
      MIWO_JWT_SECRET: "test-secret-at-least-32-bytes-long-000",
      // Task 8/9：真实 MySQL 集成测试的开关与连接参数（只在显式打开时注入，见下）。
      // 默认不设 → 那些用例 skipIf 掉（本机没有 MySQL 服务端时 spec 要求的"测试仍可跑"）。
      // ⚠ 绝不能无条件注入 `MIWO_DB_DRIVER: "mysql"`：config.ts 是模块级 fail-fast，
      //    没有 MySQL/参数时会在**收集阶段**抛 ConfigError，把整个测试文件打成红（Phase 0 ledger Ruling C4）。
      ...(process.env.MIWO_TEST_MYSQL === "1"
        ? {
            MIWO_DB_DRIVER: "mysql",
            MIWO_DB_HOST: process.env.MIWO_DB_HOST ?? "127.0.0.1",
            MIWO_DB_PORT: process.env.MIWO_DB_PORT ?? "3307",
            MIWO_DB_USER: process.env.MIWO_DB_USER ?? "miwo",
            MIWO_DB_PASSWORD: process.env.MIWO_DB_PASSWORD ?? "miwo",
            MIWO_DB_NAME: process.env.MIWO_DB_NAME ?? "miwo_test",
          }
        : {}),
    },
  },
});
