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
 *    但只是**死代码**：它们的存在只为 **`tools/check-copy.cjs:94`** 的构件断言（"必须存在"清单里
 *    有 `apps/api/src/lib/initDB.ts`），删除归 Phase 1c。
 *    ⚠ **【L1 更正】原写"只为 `apps/api/scripts/verify-phase0.cjs` 的构件清单断言"—— 过期了**：
 *      `verify-phase0.cjs:179` 已把那条换成 `apps/api/src/db/migrations/index.ts`（Task 11）。
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

/**
 * `u.db` 的形状：函数 + **显式白名单**成员（spec §5.1）。
 *
 * ⚠ 历史（这里原先是一个**黑名单 hack**，实测过两层都是坏的）：
 *
 *   第一层：`Object.assign(wrapper, db)` —— 拷不到任何 knex 方法。knex 把 `transaction` / `raw` /
 *   `schema` … 定义成 **db 函数自己的、`enumerable: false` 的属性**（`schema` / `client` 还是 getter），
 *   而 `Object.assign` 只拷**自有可枚举**属性 ⇒ `u.db("表")` 能用、`u.db.transaction(fn)` 是 `undefined`
 *   （真机表现：`db.transaction is not a function`，事务落库整条路径静默失败）。
 *
 *   第二层：`for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(db)))` + 一张
 *   `SKIP = {constructor, caller, arguments, prototype, length, name}` 黑名单。实测
 *   **`Object.getPrototypeOf(db) === Function.prototype`**（knex 的成员是自有属性，不在原型上）
 *   ⇒ 这个循环遍历到的恰好是 `Function.prototype` 的 `caller`/`arguments`/… —— 在**严格模式**
 *   （esbuild 打出来的包带 "use strict"）下读它们**直接抛**：
 *     TypeError: 'caller', 'callee', and 'arguments' properties may not be accessed on strict mode functions
 *   后果是整个 `utils/db` 模块初始化失败 → 所有 `db(...)` 调用点都拿到 undefined
 *   → 打包版启动报「服务启动失败 / db_default is not a function」，后端起不来。
 *   （dev 用 tsx 转成非严格模式，读 `.caller` 只是拿到 null，所以本地测不出来。）
 *
 *   净效果：那个"拷贝原型方法"的循环**一个方法都没拷到**（真正起作用的是紧随其后的小名单），
 *   却引入了唯一的崩溃源。黑名单永远会漏 —— 现在换成**白名单**：只有下面这些成员会被挂上去，
 *   其余（含 `caller`/`arguments`）**在结构上不可能**被读到，不是"读到了再跳过"。
 *
 * 白名单的选取依据 = 全仓实际使用到的（`transaction` / `raw` / `schema`）+ knex 公共 API 里形状必需的那几个。
 * **形状必须逐个写对**（`typeof` 实测，knex 3.x）：`transaction` / `raw` / `ref` / `destroy` 是**函数**
 * （要 `bind(db)`，否则 `this` 丢失）；`fn` / `schema` / `client` / `migrate` / `seed` 是**对象**
 * （`bind` 只会把它们弄坏）。
 *
 * 若要新增，**必须同时在这里与 `tests/db-driver.test.ts` 的断言里加**（否则测试会红）。
 */
const DB_MEMBERS = {
  transaction: "function",
  raw: "function",
  ref: "function",
  destroy: "function",
  fn: "object",
  schema: "object",
  client: "object",
  migrate: "object",
  seed: "object",
} as const;

for (const [key, shape] of Object.entries(DB_MEMBERS)) {
  let value: any;
  try {
    value = (db as any)[key];
  } catch {
    continue; // 万一某个属性是 getter 且会抛，跳过而不是让模块初始化挂掉
  }
  if (typeof value !== shape) continue; // 形状与白名单不符 → 不挂（宁缺勿错，也不抛）
  (dbClient as any)[key] = shape === "function" ? value.bind(db) : value;
}
export default dbClient;

/**
 * **裸 knex（唯一合法的显式绕过口）**。只给三类调用者：
 *   1. 实例级运维接口（`routes/setting/dbConfig/*`、`routes/other/deleteAllData.ts`）——
 *      它们要读 `sqlite_master`、`PRAGMA`、按动态表名整库遍历，**根本无法**被租户条件限定；
 *   2. 启动期 / CLI / 迁移（`db/connect.ts`、`db/migrations/*`）——显然不属于任何租户；
 *   3. 死代码里的"启动期改库"（`lib/fixDB.ts`，Phase 1c 删除）。
 *
 * ⚠ **请求路径禁止使用**：它不经 `makeTenantAware`，没有任何租户条件注入。
 *   使用者必须登记在 `src/db/tenant-exceptions.json` 的 `bypassFiles` 里，
 *   并由 `tests/tenant-db-bypass.test.ts` 的逐文件断言钉住（新增使用者即红）。
 *   ⚠ 计划 **Task 8** 会把这个清单升级成 `systemDbUsers` 字段 + `tools/check-tenant-exceptions.cjs`
 *   的显式扫描：**当前那道门禁还认不出 `import { systemDb }`**（它现在的判据是
 *   "命名导入 `{ db }`"），所以本阶段的判据由上面那条测试承担。
 */
export const systemDb = db;

/** 同 `systemDb`，但按表名取 builder（运维接口里 `for (const table of tables)` 的写法会用到）。 */
export const systemTable = <TName extends TableName>(table: TName) => db<RowType<TName>, RowType<TName>[]>(table);

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
