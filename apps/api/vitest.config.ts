import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // ⚠ 必须把 tsconfig 的 "@/*" 路径别名同步给 vitest，否则 src 里的 `@/config` 这类导入在测试里解析失败
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
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
      MIWO_DATA_DIR: "D:\\tmp\\miwo-test-data",
      MIWO_JWT_SECRET: "test-secret-at-least-32-bytes-long-000",
    },
  },
});
