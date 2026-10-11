/**
 * 显式生成 src/types/database.d.ts（原为启动期 dev 分支的副作用）。
 * 用法：node --env-file-if-exists=.env --import=tsx scripts/gen-db-types.ts
 *
 * ⚠ 两处与"直接 import ../src/utils/db"不同的必需细节（Task 9 实测）：
 *  1) 必须先 import `../src/utils`：`utils.ts` 的 `export default { db, ... }` 是在**求值时**捕获
 *     `@/utils/db` 的默认导出的，而 `db.ts` → `fixDB.ts` → `utils.ts` 是循环导入。若让 db.ts 当入口，
 *     它的求值会在 fixDB 的 import 处被打断，于是 utils 捕获到 `db: undefined`，
 *     `fixDB` 一调用就抛 `TypeError: import_utils.default.db is not a function`（实测原文）。
 *     先 import utils（= app.ts 的装配顺序 utils → db → fixDB）就没有这个问题。
 *  2) 末尾必须显式退出进程：utils 的依赖图上有常驻句柄（定时器/连接池），不退出会挂住。
 *     现在改成"业务成功后再退出"：先断言生成真的完成了，再 `exit(0)`。
 *
 * ⚠ Task 10 Step 0d 加固的两点（此前是"假成功"）：
 *  1) 门条件在 db.ts 里是 `config.env === "dev" && MIWO_GEN_DB_TYPES === "1"`。若 `MIWO_ENV=prod`，
 *     `initKnexType` **根本不会执行**，而脚本照样打印"已触发"并 `exit 0`。现在开头直接拒绝。
 *  2) 原来靠固定 `setTimeout(2000)` 猜写盘完成，冷启动超 2s 就会在写盘前退出并报成功。
 *     现在等 `db.ts` 导出的 `genDbTypesReady`（写盘完成的**真实**信号），并留超时上限兜底。
 */
process.env.MIWO_GEN_DB_TYPES = "1";

import fs from "node:fs";
import path from "node:path";

/** `db.ts` 里 initKnexType 的写盘目标是**裸相对路径**（按 cwd 解析）→ 本脚本必须从 apps/api 启动。 */
const API_ROOT = path.resolve(__dirname, "..");
const TYPES_FILE = path.join(API_ROOT, "src", "types", "database.d.ts");
const TIMEOUT_MS = 120_000;
/** 轮询 `genDbTypesReady` 的间隔。见下面 READY_POLL 的注释：它是在 `await initDB/fixDB` **之后**才被赋值的。 */
const READY_POLL_MS = 100;

function readHash(): string | null {
  try {
    const m = fs.readFileSync(TYPES_FILE, "utf8").match(/^\/\/\s*@db-hash\s*([a-zA-Z0-9]+)\n/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function main() {
  if (process.env.MIWO_ENV !== "dev") {
    console.error(`db:types 仅支持 MIWO_ENV=dev（当前 "${process.env.MIWO_ENV ?? "未设置"}"）：prod 下 db.ts 不会执行 initKnexType，跑下去只会假成功。`);
    process.exit(1);
  }

  // 写盘前的快照：用于区分"内容真的换了"与"本来就已是最新"
  const startHash = readHash();

  // ⚠ 顺序不能改（Task 10 实测踩过）：**先** import `../src/utils`（副作用）**再**取 db.ts 的导出。
  //   直接把 `await import("../src/utils/db")` 当入口，会让 db.ts 的求值在 fixDB 的 import 处被打断，
  //   utils 捕获到 `db: undefined` → `TypeError: import_utils.default.db is not a function`（实测原文）。
  //   这里用两行：第一行复刻 app.ts / 原实现的装配顺序（utils → db → fixDB），第二行只是为了拿活绑定。
  await import("../src/utils");
  const dbMod = await import("../src/utils/db");

  /**
   * ⚠ 这里必须**轮询**，不能 import 完就读一次（Task 10 实测踩过）：
   * `db.ts` 里 `genDbTypesReady` 是在 `await initDB(db); await fixDB(db);` **之后**才赋值的，
   * 而模块求值到第一个 await 就让出控制权 → `await import()` 返回时它**还是 null**（实测原文：
   * "db.ts 未启动类型生成"）。ESM 导出是活绑定，所以稍后再读就能拿到；超时才是真的没启动。
   */
  const deadline = Date.now() + TIMEOUT_MS;
  let ready = dbMod.genDbTypesReady;
  while (!ready) {
    if (Date.now() > deadline) {
      // ⚠ 口径澄清（修复轮 1，F12）：`.env` **不是** config.ts 加载的 —— 本脚本所在的 npm script
      //   （apps/api/package.json 的 db:types = `node --env-file-if-exists=.env --import=tsx ...`）
      //   把它交给 Node 的 `--env-file-if-exists` 加载；config.ts 只读 process.env。
      //   所以直接从命令行裸跑 `tsx scripts/gen-db-types.ts` 是没有 .env 的（缺变量时 config.ts 抛 ConfigError）。
      console.error(`等待 db.ts 启动类型生成超时（${TIMEOUT_MS} ms）：请确认 MIWO_ENV=dev，且 .env 是通过 package.json 的 db:types 脚本（node --env-file-if-exists=.env）加载的。`);
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
    ready = dbMod.genDbTypesReady;
  }

  // 等真实完成信号；超时上限只用于"永不 resolve"的极端情况兜底
  const outcome = await Promise.race([
    ready.then(() => "done" as const, (e: unknown) => ({ err: e })),
    new Promise<"timeout">((r) => setTimeout(() => r("timeout"), TIMEOUT_MS).unref()),
  ]);

  if (outcome === "timeout") {
    console.error(`等待 initKnexType 写盘超时（${TIMEOUT_MS} ms）：${TYPES_FILE} 仍是生成前的内容。`);
    process.exit(1);
  }
  if (typeof outcome === "object") {
    console.error("initKnexType 失败：", outcome.err);
    process.exit(1);
  }

  /**
   * 交叉核对（"假成功"检测）。
   *
   * ⚠ 这里**刻意只看内容、不看 mtime**。Task 10 实测本机 `mtime` 不可作同步依据：
   * 刚写过的文件 `mtimeMs` 会比同一进程的 `Date.now()` 早 12~40 秒且非单调
   * （实测 1791750833595 / 1791750861242 两次读数就是反序的），
   * 用"mtime 是否晚于启动时刻"判"本次有没有写"会**误报失败** —— 这正是"不要用时间猜同步"的又一个例证。
   *
   * 判据只有两条（都由**内容**给出，且**不重算**数据库 hash）：
   *   A) hash 变了（startHash → endHash） → 本次运行确实写盘了；
   *   B) hash 没变，且文件头**格式合法**（`^[a-zA-Z0-9]{32}$`） → 产物本来已是最新，`initKnexType`
   *      按 `needWrite=false` 正确跳过写盘（此时"没写"是正确的，不是假成功）。
   *
   * ⚠ 口径澄清（修复轮 1，F12）：本脚本**只校验 hash 头的格式**，不会去重算"当前库算出的 hash"再比对 ——
   *   重算需要复刻 db.ts 的建表/自省逻辑，代价与风险都远大于收益。因此"格式合法"**不等于**"内容已最新"：
   *   "这次到底写没写"只由 A（hash 变了）给出；想确认内容最新请再跑一次 db:types（幂等，会打印 needWrite=false）。
   *
   * 由于写盘完成已由 `genDbTypesReady` 保证，B 与"根本没跑"不可能混淆；真正的假成功
   * （加固前固定 `setTimeout(2000)` 后 `exit(0)`）会表现为**拿不到 `genDbTypesReady` 而超时**，
   * 或在文件缺失时落到下面的 "非法 hash 头" 分支。
   */
  const endHash = readHash();
  if (endHash === null || !/^[a-zA-Z0-9]{32}$/.test(endHash)) {
    console.error(`写盘后 ${TYPES_FILE} 缺少合法的 @db-hash 头（实际 ${endHash}）。`);
    process.exit(1);
  }
  const hashChanged = endHash !== startHash;
  console.log(
    `database.d.ts 生成完成（hash ${startHash ?? "无"} → ${endHash}，` +
      `${hashChanged ? "内容已更新" : "产物已是最新、按 needWrite=false 跳过写盘"}）`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
