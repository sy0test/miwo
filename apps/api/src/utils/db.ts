import { readFile, writeFile } from "fs/promises";
import fs from "fs";
import path from "path";
import type { DB } from "@/types/database";
import crypto from "crypto";
import { config } from "@/config";
import { connect, createKnex } from "@/db/connect";

type TableName = keyof DB & string;
type RowType<TName extends TableName> = DB[TName];

// SQLite 需要文件先存在；MySQL 不需要任何本地文件准备。
if (config.db.driver === "sqlite") {
  const dbPath = config.db.file;
  console.log("数据库文件:", dbPath);
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
  if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, "");
}

// 连接装配统一走 src/db/connect.ts（spec §5.1）：client 由 config.db.driver 决定。
// `useNullAsDefault` 只在 sqlite 分支加，见 connect.ts。
const db = createKnex();

/**
 * 类型生成的完成信号（Task 10 Step 0d）。
 *
 * ⚠ 为什么必须有这个显式信号：`initKnexType` 的写盘是**异步且无人 await** 的。
 * 唯一需要等它的是 `scripts/gen-db-types.ts`，而它此前只能靠固定 `setTimeout(2000)` 猜时间 ——
 * 冷启动（首次建库 + 迁移）超过 2s 就会在写盘前 `exit(0)`，报告成功却什么都没生成。
 * 这里把同一个 Promise 暴露出去，调用方 await 即可，不必再猜。
 *
 * 只在 `MIWO_GEN_DB_TYPES=1` 时非 null；调用方（`gen-db-types.ts`）负责 await 并处理 reject，
 * 所以失败会以非 0 退出码暴露，而不是变成一个没人看的 unhandled rejection。
 */
export let genDbTypesReady: Promise<void> | null = null;

const GENERATE_DB_TYPES = config.env === "dev" && process.env.MIWO_GEN_DB_TYPES === "1";

/**
 * db 就绪信号（Phase 1a / Task 4）：**连接 → 跑迁移**，完成前不许有人接请求。
 *
 * ⚠ 为什么不是"顶层 await"：本仓库 tsconfig 是 `module: CommonJS`（不是 ESM，见 tsconfig.json:4），
 *    顶层 await 不可用。所以改成**导出一个 Promise**，由**唯一需要它的人**
 *   （`app.ts` 起监听之前）`await` 它。
 *
 * ⚠ 这修的是 spec §3.3 点名的**启动竞态**：原实现是"**未被 await** 的 IIFE 里跑 initDB + fixDB"
 *    —— 建表没完成就开始接请求（表现为冷启动第一批请求偶发 `no such table`）。
 *
 * ⚠ 这里**不再**调用 `@/lib/initDB` / `@/lib/fixDB`（Task 4 Step 3 摘除）。两个文件仍留在仓库里，
 *    但只是**死代码**：它们的存在只为 `apps/api/scripts/verify-phase0.cjs` 的构件清单断言，删除归 Phase 1c。
 *    守这条不变式的门禁是 `tools/check-dead-ddl.cjs`（从 `src/app.ts` 出发的 import 图上不得再出现它们）。
 *    被摘掉的两条"启动期无条件副作用"的语义变化登记在 `src/db/migrations/001_schema.ts` 的 `up` 开头与根 README。
 */
export const dbReady: Promise<void> = (async () => {
  const { applied } = await connect();
  if (applied.length) console.log(`[db] 已应用迁移：${applied.join(", ")}`);
  // 类型生成不再在启动路径上（Phase 0 Task 9 已改为 db:types 脚本）；保留显式开关：
  if (GENERATE_DB_TYPES) genDbTypesReady = initKnexType(db);
})();
// 失败必须响亮：不要让进程"看起来起来了、实际半残"（Phase 0 的 err.ts 只 console.error 不退出）。
// ⚠ `process.exit(1)` 不能只写在 app.ts 的 `await dbReady` 那里：那条 await 在 `startServe()` 里，
//    而 Electron 分支（随机端口）与别的入口也 import 本模块 —— 初始化失败一律让进程死。
dbReady.catch((err) => {
  console.error("[db] 初始化失败，进程即将退出：", err);
  process.exit(1);
});

const dbClient = Object.assign(<TName extends TableName>(table: TName) => db<RowType<TName>, RowType<TName>[]>(table), db);
dbClient.schema = db.schema;
/**
 * ⚠ `Object.assign` 只拷**自有属性**，而 knex 的实例方法（`transaction` / `raw` / `fn` / `ref` …）
 * 都在**原型**上 —— 于是 `u.db("表")` 能用，`u.db.transaction(fn)` 却是 undefined
 *（真机表现：`db.transaction is not a function`，事务落库整条路径静默失败）。
 * 这里把原型上的方法一并绑到包装函数上：既有调用方式不变，同时让 `u.db` 真正像 knex 一样可用。
 */
{
  const proto = Object.getPrototypeOf(db);
  // ⚠ `getOwnPropertyNames(Function.prototype)` 里有 **`caller` / `arguments` / `prototype`**：
  // 在**严格模式**（esbuild 打出来的包带 "use strict"）下**读取它们会直接抛**
  //   TypeError: 'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions
  // 后果是整个 `utils/db` 模块初始化失败 → 所有 `db(...)` 调用点都拿到 undefined
  //   → 打包版启动报「服务启动失败 / db_default is not a function」，后端起不来。
  //（dev 用 tsx 转成非严格模式，读 `.caller` 只是拿到 null，所以本地测不出来 —— 必须跳过。）
  const SKIP = new Set(["constructor", "caller", "arguments", "prototype", "length", "name"]);
  for (const key of Object.getOwnPropertyNames(proto)) {
    if (SKIP.has(key)) continue;
    let value: any;
    try {
      value = (db as any)[key];
    } catch {
      continue; // 万一还有别的"毒药属性"，跳过就好，不能让模块初始化挂掉
    }
    if (typeof value === "function" && typeof (dbClient as any)[key] !== "function") {
      (dbClient as any)[key] = value.bind(db);
    }
  }
  // 链式构造器（db.select/from/...）与顶部调用同为函数属性，一并兜住
  for (const key of ["transaction", "raw", "destroy", "fn", "ref", "schema", "client"] as const) {
    let value: any;
    try {
      value = (db as any)[key];
    } catch {
      continue;
    }
    if (typeof value === "function" && typeof (dbClient as any)[key] !== "function") {
      (dbClient as any)[key] = value.bind(db);
    }
  }
}
export default dbClient;

export { db };

async function initKnexType(knexDb: any) {
  const { Client } = await import("@rmp135/sql-ts");
  const outFile = "src/types/database.d.ts";
  const dbClient = Client.fromConfig({
    interfaceNameFormat: "${table}",
    typeMap: {
      number: ["bigint"],
      string: ["text", "varchar", "char"],
    },
  }).fetchDatabase(knexDb);
  const declarations = await dbClient.toTypescript();
  const dbObject = await dbClient.toObject();
  const customHeader = `//该文件由脚本自动生成，请勿手动修改`;
  // 清除上次的注释头
  let declBody = declarations.replace(/^\/\*[\s\S]*?\*\/\s*/, "");
  declBody = declBody.replace(/(\n\s*)\/\*([^*][\s\S]*?)\*\//g, "$1/**$2*/");
  const tableInterfaces = dbObject.schemas.flatMap((schema) => schema.tables.map((table) => table.interfaceName));
  const aggregateTypes = `
export interface DB {
${tableInterfaces.map((name) => `  ${JSON.stringify(name)}: ${name};`).join("\n")}
}
`;
  // 哈希仅基于结构化信息，header和空格不算
  const hashSource = JSON.stringify({
    tableInterfaces,
    declBody,
  });
  const hash = crypto.createHash("md5").update(hashSource).digest("hex");
  // 文件内容
  const content = `// @db-hash ${hash}\n${customHeader}\n\n` + declBody + aggregateTypes;
  let needWrite = true;
  try {
    const current = await readFile(outFile, "utf8");
    // 文件头已存在相同 hash，不需要写
    const match = current.match(/^\/\/\s*@db-hash\s*([a-zA-Z0-9]+)\n/);
    const currentHash = match ? match[1] : null;
    if (currentHash === hash) {
      needWrite = false;
    }
  } catch (err) {
    needWrite = true;
  }
  if (needWrite) await writeFile(outFile, content, "utf8");
}
