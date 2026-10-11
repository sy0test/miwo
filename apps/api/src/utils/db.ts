import { readFile, writeFile } from "fs/promises";
import getPath from "@/utils/getPath";
import fs from "fs";
import path from "path";
import knex from "knex";
import initDB from "@/lib/initDB";
// import fixDB from "@/lib/fixDB";
import type { DB } from "@/types/database";
import crypto from "crypto";
import fixDB from "@/lib/fixDB";

type TableName = keyof DB & string;
type RowType<TName extends TableName> = DB[TName];

const dbPath = getPath("db2.sqlite");
console.log("数据库目录:", dbPath);
const dbDir = path.dirname(dbPath);

// 确保数据库目录存在
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// 创建空数据库文件
if (!fs.existsSync(dbPath)) {
  fs.writeFileSync(dbPath, "");
}

const db = knex({
  client: "better-sqlite3",
  connection: {
    filename: dbPath,
  },
  useNullAsDefault: true,
});

(async () => {
  await initDB(db);
  await fixDB(db);
  if (process.env.NODE_ENV == "dev") initKnexType(db);
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
