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
 * ⚠ **非破坏性**（Lead 审查 P2-1 后的口径，别再写成"只读"）：
 *   ① **先过目标护栏**（`guard.requireRepoDevDbAllowed`）：解析成仓库内 `apps/api/data/db2.sqlite`
 *      且没有显式放行 ⇒ **拒绝执行**，而且这一步在**任何**会碰库的代码之前（旧版会先建库/跑迁移）；
 *   ② sqlite 目标**不存在就直接拒**（`DB_NOT_FOUND`）—— 不新建空库；
 *   ③ tokenKey 用 `createKnex()` **裸读**，**不再** `u.db`/`await dbReady`（那会触发启动迁移）；
 *   ④ ⚠ **残留**：为了复用**真实**连接逻辑，第 ③ 步之后会 import `@/socket/routes/productionAgent`
 *      → 连带加载 `@/utils/db`，其模块级启动 IIFE 会 `connect()` + `migrate.latest()`（**幂等**）。
 *      也就是说：**对已存在的、迁移过的目标库，它仍会走一遍应用启动路径**。所以别把它当"零副作用"
 *      工具用在生产库上（在 `MIWO_DB_DRIVER=mysql` 上误用会真的跑迁移）。
 *      要"零副作用"就只能放弃真 route 保真度（用守卫层复刻判定）——那会削弱 P1 的取证强度，故保留。
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
  // ① 目标护栏：**在**任何会碰库的代码之前（旧版会先建库/跑迁移）
  guard.requireRepoDevDbAllowed({ argv: args, what: "probe-agent-connect" });
  // ② sqlite 目标不存在就直接拒（不新建空库）
  if (config.db.driver === "sqlite" && !fs.existsSync(config.db.file)) {
    console.error(`[probe-agent-connect] 目标库不存在：${describeTarget()}（拒绝新建；先用 db:migrate 或指定正确的 MIWO_DATA_DIR）`);
    emitResult({ ok: false, reason: "DB_NOT_FOUND", disconnected: true }, 2);
    return;
  }
  // ③ tokenKey 用**裸 knex 直读**（不走 `u.db` ⇒ 不触发启动迁移）
  const db = createKnex();
  let tokenKey: unknown;
  try {
    const setting: any = await db("o_setting").where("key", "tokenKey").select("value").first();
    tokenKey = setting?.value;
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
  const token = "Bearer " + (jwt.sign as any)({ id: userId, name: "probe" }, String(tokenKey), { expiresIn: "1h" });

  // ④ 真 route（**动态 import**：护栏/存在性/裸读都在它之前；这是唯一会拉起应用数据层的一步）
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
