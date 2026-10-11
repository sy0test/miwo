import esbuild from "esbuild";
import fs from "fs";
import path from "path";

// 打包默认使用 prod 环境变量
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "prod";
}

const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

const external = [
  // ⚠ 不是死配置，别删：`app.ts` 的 checkPermissions 里仍有 `require("electron")`（在运行时分支里，
  //   纯 Node 下不会执行，但 esbuild 只做静态解析，仍需外部化）。删掉此条 = `pnpm run build` 立即以
  //   `Could not resolve "electron"` 失败。历史上另有 src/utils/getPath.ts:7 与 src/env.ts:5 两处，
  //   已分别由 Task 8（改为只留 isEletron 判定）与 Task 9（env.ts 换成 config 垫片）移除。
  //   最后一处（src/app.ts 的 checkPermissions）属 Phase 1c，移除后方可删除本条目。
  "electron",
  "undici",
  "@huggingface/transformers",
  "onnxruntime-node",
  "vm2",
  "sqlite3",
  "better-sqlite3",
  "sharp",
  "mysql",
  "mysql2",
  "mariadb",
  "mariadb/callback",
  "pg",
  "pg-query-stream",
  "oracledb",
  "tedious",
  "mssql",
];

// 后端服务打包配置
const appBuildConfig: esbuild.BuildOptions = {
  entryPoints: ["src/app.ts"],
  bundle: true,
  minify: false,
  format: "cjs",
  allowOverwrite: true,
  outfile: `data/serve/app.js`,
  platform: "node",
  target: "esnext",
  tsconfig: "./tsconfig.json",
  alias: {
    "@": "./src",
  },
  sourcemap: false,
  external,
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
};

(async () => {
  try {
    console.log("🔨 开始构建...\n");

    await esbuild.build(appBuildConfig);

    console.log("✅ 后端服务构建完成: data/serve/app.js");
    console.log("\n🎉 所有构建任务完成!\n");
  } catch (err) {
    console.error("❌ 构建失败:", err);
    process.exit(1);
  }
})();
