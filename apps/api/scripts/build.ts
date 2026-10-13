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

/**
 * 【裁定 60】平台种子必须**跟产物一起**进容器 —— `seed/` → `data/serve/migrations/seed/`。
 *
 * ── 为什么必须由构建拷贝，而不是靠 `import` ──
 * `002_platform_seed` 读种子走 `fs.readFileSync`（运行时），所以 esbuild 打出的单文件
 * `data/serve/app.js` **不会内联**那 4 个 `.ndjson`。该迁移的候选路径只有三条：
 *   1) `path.join(__dirname, "seed")`                             → 产物旁 `data/serve/seed`
 *   2) `path.join(process.cwd(), "src", "db", "migrations", "seed")` → 源码树（cwd=apps/api）
 *   3) `path.join(process.cwd(), "data", "serve", "migrations", "seed")` → 产物旁（cwd=仓库根）
 * dev（cwd=`apps/api`）命中第 2 条，**所以本机永远看不出问题**；容器里源码树不存在，
 * 一条都不命中时 `seedDir()` 会抛错 —— 这是**有意**的（绝不能静默地"seed 0 行"）。
 *
 * 于是这里**两条都给**（1 与 3）：`__dirname/seed` 那条**不依赖 cwd**，容器里 `WORKDIR`
 * 怎么设都能命中；只给 3 的话 `cwd` 一改就炸。源目录缺失/为空 → **直接 `exit 1`**，
 * 不许"构建成功但产物里没种子"（那会在**生产才炸**，正是要避开的失败模式）。
 *
 * ⚠ 写入内容一律是 `seed/*.ndjson`（Task 5 的显式断言保证里面**没有** `o_setting.tokenKey`）；
 *   本文件不打印任何密钥，也不打印行内容。
 *
 * ⚠ 源目录检查在 `esbuild.build()` **之前**跑：缺种子时**连 app.js 都不该产出** ——
 *   否则留下的是"有产物、没种子"的半成品，部署它会在**生产**才炸（正是本裁定要防的失败模式）。
 */
const SEED_SRC = path.resolve("src", "db", "migrations", "seed");
/** 候选路径 3（cwd=仓库根时命中）与候选路径 1（`__dirname/seed`，不依赖 cwd）。 */
const SEED_DESTS = [
  path.resolve("data", "serve", "migrations", "seed"),
  path.resolve("data", "serve", "seed"),
];

/** 构建前的**预检**：源目录缺失/为空 → `exit 1`（在任何产物写盘之前）。 */
function requireSeedFiles(): string[] {
  const files = fs.existsSync(SEED_SRC)
    ? fs.readdirSync(SEED_SRC).filter((f) => f.endsWith(".ndjson")).sort()
    : [];
  if (!files.length) {
    console.error(`❌ 平台种子目录缺失或为空：${SEED_SRC}`);
    console.error("   `002_platform_seed` 用 fs.readFileSync 读它（不是 import），esbuild 不会把它打进 app.js。");
    console.error("   缺了它，容器里三条候选路径全不命中 → 迁移抛错、服务起不来；");
    console.error("   这个缺口只会在**生产**暴露 —— 所以这里直接失败，连 app.js 都不产出（不留半成品）。");
    process.exit(1);
  }
  return files;
}

/** 打包成功后把预检过的那几个 `.ndjson` 拷到两条候选路径，并**逐处复核拷贝数量**。 */
function copySeedDir(files: string[]): number {
  for (const dest of SEED_DESTS) {
    fs.mkdirSync(dest, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(SEED_SRC, f), path.join(dest, f));
    const copied = fs.readdirSync(dest).filter((f) => f.endsWith(".ndjson")).length;
    if (copied !== files.length) {
      console.error(`❌ 种子拷贝不完整：${dest} 有 ${copied} 个 .ndjson，源目录有 ${files.length} 个`);
      process.exit(1);
    }
  }
  return files.length;
}

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

    // 【裁定 60】先预检种子（缺了就连 app.js 都不产出），再打包，最后把种子放到产物旁。
    const seedFiles = requireSeedFiles();

    await esbuild.build(appBuildConfig);

    console.log("✅ 后端服务构建完成: data/serve/app.js");

    const seedCount = copySeedDir(seedFiles);
    for (const dest of SEED_DESTS) {
      const rel = path.relative(process.cwd(), dest).split(path.sep).join("/");
      console.log(`✅ 已拷贝 seed/ → ${rel}/（${seedCount} 个文件）`);
    }
    console.log("   ⚠ 容器/服务器：`seed/` 必须随产物一起进镜像（两条候选路径都给了，见 build.ts 顶部注释）。");

    console.log("\n🎉 所有构建任务完成!\n");
  } catch (err) {
    console.error("❌ 构建失败:", err);
    process.exit(1);
  }
})();
