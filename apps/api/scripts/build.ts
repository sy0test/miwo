import esbuild from "esbuild";
import fs from "fs";
import path from "path";

// 打包默认使用 prod 环境变量
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = "prod";
}

const pkg = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));

const external = [
  // ⚠ 不是死配置，别删：src/app.ts:32、src/env.ts:5、src/utils/getPath.ts:7 仍有
  //   `require("electron")`（都在 `process.versions.electron !== undefined` 的运行时分支里，
  //   纯 Node 下不会执行，但 esbuild 静态解析仍需外部化）。删掉此条 = `pnpm run build`
  //   立即以 3 个 "Could not resolve \"electron\"" 失败。真正的移除属于后续 Task
  //   （Task 8/9 迁移 getPath.ts / env.ts / app.ts 时）。
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
