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
    // ⚠ 必需：src/config.ts 末尾有 `export const config = loadConfig()` —— 模块级 fail-fast，
    //   任何 import 了 src/config 的模块（Task 8/9 的 getPath.ts 等）在测试里加载时都会执行它。
    //   这里给出最小合法环境，保证测试运行期 process.env 始终自洽；不改变生产行为。
    env: {
      MIWO_ENV: "dev",
      MIWO_PORT: "10599",
      MIWO_HOST: "127.0.0.1",
      MIWO_DATA_DIR: ".tmp-vitest-data",
      MIWO_JWT_SECRET: "vitest-only-secret-padding-0123456789abcdef",
    },
  },
});
