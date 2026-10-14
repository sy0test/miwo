/**
 * 诊断脚本：用**真实的** `productionAgent` 连接逻辑试连一次（**不起 transport**）。
 *
 *   cd apps/api
 *   MIWO_DATA_DIR=D:\tmp\miwo-t6 node --import=tsx scripts/probe-agent-connect.ts --project=98001 --script=98101 --user=7
 *
 * 为什么需要它（不是玩具）：真实库上 `productionAgent` 连不上的**唯一**原因是
 *   `o_script.userId` 未回填（NULL）⇒ 连接期的 `resolveOwnedScript` 归属校验拒连。
 *   排查"用户说 agent 连不上"时，需要一条**不依赖 socket.io 客户端**的判定：
 *   它复用 `src/socket/routes/productionAgent.ts` 的**同一段连接逻辑**（验签 → 归属校验 →
 *   服务端推导 isolationKey → bindSocketTenant），只把 transport 换成假 socket。
 *
 * 输出：最后一行 `PROBE_RESULT=<ASCII JSON>`；之前是人读的日志（token 不打印）。
 *   · `disconnected`        连接是否被拒（true = 拒）
 *   · `scriptCheckRejected` 是否**因为集号归属校验**被拒（区分"没回填/别人的集"与其它原因）
 *   · `handlers`            成功连上后注册的事件名（被 bindSocketTenant 包过的入口）
 *
 * ⚠ **非破坏性**（Lead 审查 P2-1 + 裁定 ① 后的口径，别再写成"只读"）：
 *   ⓪ **只支持 sqlite**：`MIWO_DB_DRIVER !== "sqlite"` ⇒ **直接拒绝**（`DRIVER_NOT_SQLITE`）。
 *      为什么：第 ④ 步的残留副作用在 MySQL 目标上是**真跑迁移**——那就别给它机会（文档警告 + 代码拒绝双保险）；
 *   ① **先过目标护栏**（`guard.requireRepoDevDbAllowed`）：解析成仓库内 `apps/api/data/db2.sqlite`
 *      且没有显式放行 ⇒ **拒绝执行**，而且这一步在**任何**会碰库的代码之前（旧版会先建库/跑迁移）；
 *   ② sqlite 目标**不存在就直接拒**（`DB_NOT_FOUND`）—— 不新建空库；
 *   ③ tokenKey 用 `createKnex()` **裸读**，**不再** `u.db`/`await dbReady`（那会触发启动迁移）；
 *   ④ ⚠ **残留**：为了复用**真实**连接逻辑，第 ③ 步之后会 import `@/socket/routes/productionAgent`
 *      → 连带加载 `@/utils/db`，其模块级启动 IIFE 会 `connect()` + `migrate.latest()`（**幂等**）。
 *      也就是说：**对已存在的、已迁移的 sqlite 目标库，它仍会走一遍应用启动路径**。
 *      要"零副作用"就只能放弃真 route 保真度（用守卫层复刻判定）——那会削弱 P1 的取证强度，
 *      Lead 已裁定**接受这个取舍**（代价写在这里 + README §3 + ⓪ 的代码拒绝）。
 */
import fs from "node:fs";
import jwt from "jsonwebtoken";
import { config } from "@/config";
import { createKnex, describeTarget } from "@/db/connect";
import guard from "./db-target-guard.cjs";

/** 收集 console.log（同时原样转发，人工仍能看到）；返回收集到的行。 */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: any[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
    original(...args);
  };
  return { lines, restore: () => { console.log = original; } };
}

function fakeSocket(auth: Record<string, any>) {
  const handlers = new Map<string, (...args: any[]) => any>();
  const socket: any = {
    id: "probe-socket",
    handshake: { auth },
    disconnected: false,
    on(event: string, handler: (...args: any[]) => any) { handlers.set(event, handler); return socket; },
    emit() { return true; },
    disconnect() { socket.disconnected = true; },
  };
  return { socket, handlers };
}

/**
 * 输出 `PROBE_RESULT=<ASCII JSON>` 并**显式退出**。
 *
 * ⚠ 必须显式退出：本脚本 import 了 `@/socket/routes/productionAgent`（连带 `@/utils`、AI SDK 等），
 *   那些模块会留下 keep-alive 句柄 ⇒ **main() 结束后进程不退出**，外层 `spawnSync` 会一直等
 *   （实测：真机上跑完工作后仍挂死 120s+，把端到端用例拖到超时）。
 *   用 `stdout.write(..., cb)` 的**回调**里退出，保证这行在被杀之前已经写出去（Windows 管道是异步写）。
 */
function emitResult(obj: Record<string, unknown>, code = 0): void {
  process.stdout.write("PROBE_RESULT=" + JSON.stringify(obj) + "\n", () => process.exit(code));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const valueOf = (prefix: string): string | undefined => args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  const projectId = Number(valueOf("--project="));
  const scriptId = Number(valueOf("--script="));
  const userId = Number(valueOf("--user=") ?? "1");
  if (!Number.isInteger(projectId) || !Number.isInteger(scriptId)) {
    console.error("用法：--project=<id> --script=<id> [--user=<id>]");
    process.exit(2);
  }
  // ① **只支持 sqlite**：非 sqlite 目标**直接拒绝**（Lead 裁定 ①：本脚本为了复用真 route 会加载应用
  //    数据层 ⇒ 在 MySQL 生产库上误用会**真跑迁移**；那就别让它有机会跑）。放在所有步骤之前。
  if (config.db.driver !== "sqlite") {
    console.error(
      `[probe-agent-connect] 拒绝执行 —— 本脚本只用于 sqlite 诊断；当前 MIWO_DB_DRIVER=${config.db.driver}。` +
        `MySQL 目标请用别的方式（本脚本会加载应用数据层，可能对你的库跑迁移）。`,
    );
    emitResult({ ok: false, reason: "DRIVER_NOT_SQLITE", disconnected: true }, 2);
    return;
  }
  // ② 目标护栏：**在**任何会碰库的代码之前（旧版会先建库/跑迁移）
  guard.requireRepoDevDbAllowed({ argv: args, what: "probe-agent-connect" });
  // ③ sqlite 目标不存在就直接拒（不新建空库）
  if (!fs.existsSync(config.db.file)) {
    console.error(`[probe-agent-connect] 目标库不存在：${describeTarget()}（拒绝新建；先用 db:migrate 或指定正确的 MIWO_DATA_DIR）`);
    emitResult({ ok: false, reason: "DB_NOT_FOUND", disconnected: true }, 2);
    return;
  }
  // ④ tokenKey 用**裸 knex 直读**（不走 `u.db` ⇒ 不触发启动迁移）
  const db = createKnex();
  let tokenKey: unknown;
  let userRow: any;
  try {
    const setting: any = await db("o_setting").where("key", "tokenKey").select("value").first();
    tokenKey = setting?.value;
    // ⚠【Phase 1c Task 11】令牌换成**新形状**（`{uid,role,tv,typ}`）之后，`decodeSocketToken` 每连接
    //   都要 `loadUserCtx()` 读这一行（复核 `status`/`tokenVersion`/`role`）⇒ 探针必须知道夹具账号
    //   在不在、是什么角色。读不到就照旧只报 NO_TOKEN_KEY，让调用方看见"夹具没种上"。
    userRow = await db("o_user").where("id", userId).select("role", "status", "tokenVersion").first();
  } catch (e: any) {
    console.error(`[probe-agent-connect] 读 o_setting 失败：${String(e?.message ?? e)}`);
    emitResult({ ok: false, reason: "DB_NOT_MIGRATED", disconnected: true }, 2);
    return;
  } finally {
    await db.destroy();
  }
  if (!tokenKey) {
    emitResult({ ok: false, reason: "NO_TOKEN_KEY", disconnected: true });
    return;
  }
  if (!userRow) {
    emitResult({ ok: false, reason: "NO_USER_ROW", disconnected: true });
    return;
  }
  const role = userRow.role === "admin" ? "admin" : "user";
  const token =
    "Bearer " +
    (jwt.sign as any)(
      { uid: userId, role, tv: Number(userRow.tokenVersion ?? 0), typ: "access", jti: "probe-agent-connect" },
      String(tokenKey),
      { expiresIn: "1h" },
    );

  // ⑤ 真 route（**动态 import**：driver/护栏/存在性/裸读全在它之前；这是唯一会拉起应用数据层的一步）
  const { default: productionAgentRoute } = await import("@/socket/routes/productionAgent");
  let connection: any = null;
  const nsp: any = { on(event: string, handler: any) { if (event === "connection") connection = handler; return nsp; } };
  productionAgentRoute(nsp as any);
  if (!connection) {
    emitResult({ ok: false, reason: "NO_CONNECTION_HANDLER", disconnected: true });
    return;
  }

  const captured = captureLogs();
  const { socket, handlers } = fakeSocket({ token, projectId, scriptId });
  let err: any = null;
  try {
    await connection(socket);
  } catch (e) {
    err = e;
  } finally {
    captured.restore();
  }
  // "因为集号归属校验被拒"的判别：连接被拒 **且** 日志里出现那句点名的文案
  // （文案在 src/socket/routes/productionAgent.ts；这里只做子串匹配，避免把"其它原因被拒"混读）
  const scriptCheckRejected =
    socket.disconnected === true && captured.lines.some((l) => l.includes("scriptId 不属于当前用户") || l.includes("o_script.userId 未回填"));
  emitResult({
    ok: true,
    disconnected: socket.disconnected === true,
    scriptCheckRejected,
    projectId,
    scriptId,
    userId,
    handlers: [...handlers.keys()],
    error: err ? String(err?.message ?? err) : null,
  });
}

main().catch((err) => {
  emitResult({ ok: false, reason: "THREW", message: String(err?.message ?? err), disconnected: true }, 1);
});
