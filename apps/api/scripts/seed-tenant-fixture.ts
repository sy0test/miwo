/**
 * `verify-phase1b.cjs` 用的**确定性种子**（Task 9）。
 *
 *   cd apps/api
 *   MIWO_DATA_DIR=D:\tmp\miwo-p1b node --import=tsx scripts/seed-tenant-fixture.ts --token-key=<key>
 *
 * 设计要点：
 *   · 用**裸 knex**（`systemDb`）：造数据不属于任何租户（它就是"运维/迁移"这一类动作）；
 *   · **幂等**：全部 `onConflict(...).merge()` ⇒ 重复跑不报错、结果一致（验收可重跑）；
 *   · **自证**：结尾回读关键行数，缺一条就 `exit 1`（验收脚本的"空转护栏"的第二道；
 *     第一道在 `verify-phase1b.cjs` 里直接读库）；
 *   · `--data-dir` 由 `verify-phase1b.cjs` 通过 **env** 注入：`config.ts` 是模块级 fail-fast，
 *     必须在 import 之前准备好环境（脚本自己不解析它，只在日志里回显 `config.dataDir`）。
 */
import { config } from "@/config";
import { dbReady, systemDb } from "@/utils/db";

const ARG_TOKEN_KEY = "--token-key=";
const TOKEN_KEY =
  process.argv.find((a) => a.startsWith(ARG_TOKEN_KEY))?.slice(ARG_TOKEN_KEY.length) ?? "miwo-phase1b-e2e-token-key-0123456789";

/** A=7 → project 7001；B=8 → project 8001（与 `tests/tenant-isolation-http.test.ts` 同一套 id 语义）。 */
async function main(): Promise<void> {
  // ⚠ **必须先等启动链完成**（`@/utils/db` 的模块级 IIFE 会 `connect()` + `migrate.latest()`，但它是**异步**的）：
  //   不等它就会出现"表还没建好就开始 insert"的竞态（实测：`no such table: o_setting`，brief 里"模块加载即跑迁移"的说法不成立）。
  await dbReady;
  await systemDb("o_setting").insert({ key: "tokenKey", value: TOKEN_KEY }).onConflict("key").merge();
  await systemDb("o_user")
    .insert([
      { id: 1, name: "admin", password: "x" },
      { id: 7, name: "a", password: "x" },
      { id: 8, name: "b", password: "x" },
    ])
    .onConflict("id")
    .merge();
  await systemDb("o_project")
    .insert([
      { id: 7001, userId: 7, name: "p1b-A", createTime: 1 },
      { id: 8001, userId: 8, name: "p1b-B", createTime: 1 },
    ])
    .onConflict("id")
    .merge();
  await systemDb("o_tasks")
    .insert([
      { id: 7002, userId: 7, projectId: 7001, state: "进行中" },
      { id: 8002, userId: 8, projectId: 8001, state: "进行中" },
    ])
    .onConflict("id")
    .merge();
  await systemDb("o_assets")
    .insert([
      { id: 7003, userId: 7, projectId: 7001, type: "role" },
      { id: 8003, userId: 8, projectId: 8001, type: "role" },
    ])
    .onConflict("id")
    .merge();
  await systemDb("o_image")
    .insert([
      { id: 7004, userId: 7, assetsId: 7003, state: "已完成", filePath: "p1b/a.png" },
      { id: 8004, userId: 8, assetsId: 8003, state: "已完成", filePath: "p1b/b.png" },
    ])
    .onConflict("id")
    .merge();
  await systemDb("o_assets").where("id", 7003).update({ imageId: 7004 });
  await systemDb("o_assets").where("id", 8003).update({ imageId: 8004 });
  await systemDb("o_novel")
    .insert([
      { id: 7005, userId: 7, projectId: 7001, chapterIndex: 1 },
      { id: 8005, userId: 8, projectId: 8001, chapterIndex: 1 },
    ])
    .onConflict("id")
    .merge();
  await systemDb("o_event")
    .insert([
      { id: 7006, userId: 7, name: "A 的事件" },
      { id: 8006, userId: 8, name: "B 的事件" },
    ])
    .onConflict("id")
    .merge();
  await systemDb("o_eventChapter")
    .insert([
      { id: 7007, userId: 7, eventId: 7006, novelId: 7005 },
      { id: 8007, userId: 8, eventId: 8006, novelId: 8005 },
    ])
    .onConflict("id")
    .merge();
  // `memories` 的键按**公共契约**写：`键首段 == 该行 userId`（README-db.md §2.3）
  await systemDb("memories")
    .insert([
      { id: "p1b-ha", userId: 7, isolationKey: "7:7001:scriptAgent", type: "message", content: "A 的记忆", createTime: 1 },
      { id: "p1b-hb", userId: 8, isolationKey: "8:8001:scriptAgent", type: "message", content: "B 的记忆", createTime: 1 },
    ])
    .onConflict("id")
    .merge();

  // 自证：缺一条就 exit 1（"什么都没种上"时绝不能让验收空转通过）
  const expect: Array<[string, Record<string, unknown>, number]> = [
    ["o_project", { id: 7001 }, 1],
    ["o_project", { id: 8001 }, 1],
    ["o_tasks", { id: 7002 }, 1],
    ["o_tasks", { id: 8002 }, 1],
    ["o_assets", { id: 7003 }, 1],
    ["o_image", { id: 7004 }, 1],
    ["o_novel", { id: 7005 }, 1],
    ["o_event", { id: 7006 }, 1],
    ["o_eventChapter", { id: 7007 }, 1],
    ["memories", { id: "p1b-ha" }, 1],
    ["memories", { id: "p1b-hb" }, 1],
  ];
  const missing: string[] = [];
  for (const [table, where, want] of expect) {
    const n = Number(((await systemDb(table).where(where).count({ n: "*" }).first()) as any)?.n ?? 0);
    if (n !== want) missing.push(`${table} ${JSON.stringify(where)}=${n}`);
  }
  if (missing.length) {
    console.error("[seed-tenant-fixture] 自证失败（种子没落库）：" + missing.join(", "));
    process.exit(1);
  }
  console.log(
    `[seed-tenant-fixture] 完成：dataDir=${config.dataDir}；tokenKey=${TOKEN_KEY}；关键行 11/11 已就位（A=7 / B=8）`,
  );
  // 显式退出：`systemDb` 的连接池会留下句柄，别让父进程等（Phase 1a 的老坑）。
  process.exit(0);
}

main().catch((err) => {
  console.error("[seed-tenant-fixture] 失败：", err);
  process.exit(1);
});
