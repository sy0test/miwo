import { readFile, writeFile } from "fs/promises";
import fs from "fs";
import path from "path";
import type { DB } from "@/types/database";
import crypto from "crypto";
import { config } from "@/config";
import { connect, createKnex } from "@/db/connect";
import { makeTenantAware, type TenantAwareDb } from "@/db/tenant-guard";
import { currentTenant } from "@/db/tenant-context";
import type { Knex } from "knex";

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

/**
 * 数据层的**唯一入口**，三层结构：
 *   1. `db`（裸 knex）—— 由 `src/db/connect.ts` 按 `config.db.driver` 装配（本文件私有）。
 *   2. `dbClient`（**默认导出**，= 全仓的 `u.db`）—— 租户守卫（`src/db/tenant-guard.ts`）。
 *      **fail-closed**：没有 ctx 就拒绝访问租户表；未声明策略的表直接抛错。
 *      ⚠ 调用点口径（**可复现**，别再引用不可复现的"462 处"；Ruling 205）：在仓库根跑
 *        `$f = Get-ChildItem apps/api/src -Recurse -Filter *.ts -File`，再跑
 *        `(Select-String -Path $f.FullName -Pattern 'u[.]db' -AllMatches).Count` → Task 4 实测 **463 行**；
 *        共 **468 处**匹配（452 处在代码 + 16 处在注释）；调用形 `u[.]db\(` 共 **376 处**
 *        （`(Select-String -Path $f.FullName -Pattern 'u[.]db\(' -AllMatches).Count`）。
 *        ⚠ 命令里的正则刻意写成 `u[.]db`（等价于 `u\.db`）—— 否则**这段注释自己**会被下一次统计算进去。
 *        这些引用从此**全部**经守卫（spec §6.2 的原话：把"漏改"从"越权"变成"当场报错"）。
 *   3. `systemDb`（显式命名导出）—— **唯一合法的绕过口**（见下方注释）。
 *      ⚠ 曾与它并列导出的 `systemTable` 已**删除**（Task 4 / Ruling 204）：它 0 个使用者，
 *        却是**第二个无守卫出口**（实测 `systemTable("o_tasks").select("id")` 既不抛错也不加租户条件），
 *        而且当时的门禁与 bypass 测试都看不见它（两个正则都要求导入名恰为 `systemDb`）。
 *        **消除出口比登记出口安全**：要按表名取 builder 的实例级运维，用 `systemDb("表名")` 即可。
 *        判据：`tests/db-driver.test.ts` 有一条反向断言（`mod.systemTable` 必须是 `undefined`），
 *        所以它不会被悄悄加回来。
 *
 * ⚠ 为什么不再导出命名 `{ db }`（spec 附录 B.1 的 7 个绕过文件）：
 *   那个导出让 7 个文件直接拿到裸 knex、完全跳过隔离。删掉它是本阶段"把绕过口从
 *   '默认可用'变成'必须显式' "的关键一步：`routes/novel/event/getEvent.ts` 改走守卫，
 *   其余 6 个（5 个 `dbConfig` + `deleteAllData`）改成 `systemDb`。
 *
 * ⚠ 成员面（`transaction` / `raw` / `fn` / `ref` / `schema` / `client` / `destroy` / `migrate` / `seed`）
 *   现在由**守卫**挂上（`tenant-guard.ts` 的 `MEMBER_SHAPES`），本文件**不再自己拷一份**：
 *   原先这里有一张白名单 + `Object.assign`/循环拷贝，留着只会多一处会漂移的真相。
 *   历史（**真机 bug**：`db.transaction is not a function`）与"为什么不能用黑名单"的完整论证
 *   见守卫的 `MEMBER_SHAPES` 注释；`tests/db-driver.test.ts` 仍**逐成员断言形状**。
 *   一句话：黑名单必须先知道要跳哪些名字，而 `Function.prototype` 上的 `caller`/`arguments`
 *   在**严格模式**下**读一下就抛**（打包版整个模块初始化失败）—— 白名单让它们**在结构上
 *   不可能**被读到，不是"读到了再跳过"。
 *
 * ⚠ `dbClient` 的**类型**是"守卫 + 按表名推断行类型的调用签名"的交叉类型（纯 `as unknown as`，
 *   运行时就是守卫本身）。为什么需要这层断言：守卫的调用签名是 `(table: string) => any`
 *   ——它刻意不依赖 `@/types/database`。直接把守卫当 `u.db`，全仓回调参数会退化成 `any`，
 *   在 `noImplicitAny` 下当场报一片 TS7006（实测 8 处）。所以这里只把**类型**收回来：
 *   不复制成员、不引入第二份真相（成员面仍由守卫的 `MEMBER_SHAPES` 全权负责）。
 *
 *   两个调用签名都是**必需**的，别删第二条：
 *     ① 已知表名（`keyof DB`）→ 按表名推断行类型（Phase 1a 的既有类型契约）；
 *     ② 兜底（任意 string）→ 与**旧实现**形状一致：旧的 `Object.assign(fn, db)` 里 knex 自己的
 *        `(tableName: string)` 签名就是这个兜底。少了它，`getConfig.ts` 那个**不在 schema 里**的
 *        `t_config` 会落到守卫的 `(table: string) => any` 上，回调参数当场退化成隐式 `any`（TS7006）。
 *        ⚠ 兜底只影响**类型**：运行时未知表由守卫的 `PolicyNotFoundError` 响亮拦住（fail-closed）。
 *   `Omit<TenantAwareDb, never>` 是为了**只取成员、丢掉它的 `(table: string) => any` 调用签名**，
 *   否则交集里会同时存在两个 `(table: string)` 签名、调用点可能解析到 `any` 那个。
 */
const dbClient = makeTenantAware(db, { getCtx: currentTenant }) as unknown as {
  <TName extends TableName>(table: TName): Knex.QueryBuilder<RowType<TName>, RowType<TName>[]>;
  (table: string): Knex.QueryBuilder<any, any[]>;
} & Omit<TenantAwareDb, never>;

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
 *   并由 `tests/tenant-db-bypass.test.ts` 的**逐文件**断言钉住（新增使用者即红）。
 *
 * ⚠ `tools/check-tenant-exceptions.cjs` 当前的判据是「命名导入 `{ db }`」，它**不认识
 *   `systemDb` 这个名字**；上面 7 个调用方统一写成 `import { systemDb as db }`，所以那道门禁
 *   **碰巧**还能枚举到它们（`as db` 落进了它的正则）—— **这是巧合，不是设计**。
 *   计划 **Task 8** 会把它升级成 `systemDbUsers` 字段 + 显式扫描；在那之前，
 *   "6 个豁免文件只有 `systemDb` 这一条路"的不变式由 `tests/tenant-db-bypass.test.ts` 承担。
 */
export const systemDb = db;

// ⚠ 这里曾有 `export const systemTable = <T>(table: T) => db(table)`：Task 4 已删除（0 使用者、
//    第二个无守卫出口）。要按表名取 builder 的实例级运维写 `systemDb("表名")`，理由见上方第 3 条。

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
