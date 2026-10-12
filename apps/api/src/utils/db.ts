import { readFile, writeFile } from "fs/promises";
import getPath from "@/utils/getPath";
import fs from "fs";
import path from "path";
import initDB from "@/lib/initDB";
import type { DB } from "@/types/database";
import crypto from "crypto";
import fixDB from "@/lib/fixDB";
import { config } from "@/config";
import { createKnex } from "@/db/connect";

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
 * 冷启动（首次建库 + fixDB）超过 2s 就会在写盘前 `exit(0)`，报告成功却什么都没生成。
 * 这里把同一个 Promise 暴露出去，调用方 await 即可，不必再猜。
 *
 * 只在 `MIWO_GEN_DB_TYPES=1` 时非 null；调用方（`gen-db-types.ts`）负责 await 并处理 reject，
 * 所以失败会以非 0 退出码暴露，而不是变成一个没人看的 unhandled rejection。
 */
export let genDbTypesReady: Promise<void> | null = null;

const GENERATE_DB_TYPES = config.env === "dev" && process.env.MIWO_GEN_DB_TYPES === "1";

(async () => {
  await initDB(db);
  await fixDB(db);
  // 类型生成不再是启动期的隐式副作用：dev 且显式要求（scripts/gen-db-types.ts 会置位）才生成，
  // 否则每次 `pnpm dev` 都会重写 src/types/database.d.ts。
  if (GENERATE_DB_TYPES) genDbTypesReady = initKnexType(db);
})();

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
  // 后果是整个 `utils/db` 模块初始化失败 → `fixDB` 里的 `db(...)` 变成 undefined
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
