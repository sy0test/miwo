/**
 * 进度推送 relay（api 进程内）。worker 只写 `o_job`，这里把变化推到 socket room。
 *
 * ── 为什么 worker 不直接 emit ──
 * worker 是**独立进程**，没有 socket.io 服务端（它连 http 都不开）。跨进程推事件需要 IPC/redis
 * （Phase 3 才考虑）。所以走"**worker 只写库 + api 侧用游标轮询推事件**"：一条 SQL 就能拿到
 * "哪些任务变了"，且重启后自动继续（游标在内存里丢一次没关系，下一轮会把当前状态补推）。
 *
 * ── 四条关键设计 ──
 *  1. **复合游标 (updatedAt, id)**：`updatedAt` 只到毫秒，一批里很容易相同；只按 updatedAt 推进
 *     会**漏掉**"同一毫秒的另一条"（`batch=1` 时必然发生）。用 `(updatedAt > ts) OR (updatedAt = ts AND id > lastId)`
 *     两方言通吃（纯 knex 原语，不依赖窗口函数）。
 *  2. **状态去重**：`heartbeat` 每 15s 改一次 `updatedAt`，若按行推送会造成事件风暴；
 *     这里只在 `state`/`progress`/`stage` 变化时才 emit（`lastSent` 是一张小 Map）。
 *  3. **载荷白名单**：只推 `{id,type,state,progress,stage,error?}` —— **绝不推 payload**
 *     （payload 里有用户提示词/资产 id），`error` 也只截断到 200 字符（脱敏：不把内部栈整段送出去）。
 *  4. **只推给归属用户**：`io.to(\`user:${userId}\`)`；`userId` 为 NULL 的平台任务不进任何 room。
 *
 * ⚠ 本模块只**读** `o_job`（platform 表）：读它不需要租户 ctx，但也不能因此把别的用户的行推出去 ——
 *   room 名从**行自身的 `userId`** 来，这正是"平台表读取必须按归属过滤"的落点。
 */
import type { Knex } from "knex";
import { JOB_POLICY } from "@/jobs/policy";

export interface RelayEvent {
  id: number;
  type: string;
  state: string;
  progress: number;
  stage: string | null;
  error?: string;
}

export interface RelayDeps {
  db: Knex;
  io: { to(room: string): { emit(event: string, payload: unknown): void } };
  /**
   * ⚠ review-C F3（High）：room 是在 `/api/socket/productionAgent` **namespace 内** join 的，
   * 而原来这里直接打**根 io** ⇒ 真客户端一条都收不到（tick 却报 sent>0）。
   *
   * 契约：**传入房间名，拿回"一个已经限定到该房间"的发送器**（即可直接 `.emit()` 的对象）。
   * 这样调用点只有一句 `targetOf(room).emit(...)`，接线错（打根 io）与否一目了然。
   * 缺省 = 用 `io` 本身（单测的假 io / 旧装配）。
   */
  targetOf?: (room: string) => { emit(event: string, payload: unknown): void };
  pollMs?: number;
  batch?: number;
  now?: () => number;
  log?: (m: string) => void;
}

export function startProgressRelay(deps: RelayDeps): { stop(): void; tick(): Promise<number> } {
  const db = deps.db;
  const targetOf = deps.targetOf ?? ((room: string) => deps.io.to(room));  const pollMs = deps.pollMs ?? JOB_POLICY.relayPollMs;
  const batch = deps.batch ?? JOB_POLICY.relayBatch;
  const log = deps.log ?? (() => {});
  let cursorTs = 0;
  let cursorId = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  const lastSent = new Map<number, string>(); // jobId → `${state}:${progress}:${stage}`

  async function tick(): Promise<number> {
    const rows = (await db("o_job")
      .select("id", "userId", "type", "state", "progress", "stage", "updatedAt", "lastError")
      .where((w) => w.where("updatedAt", ">", cursorTs).orWhere((w2) => w2.where("updatedAt", cursorTs).andWhere("id", ">", cursorId)))
      .orderBy([{ column: "updatedAt" }, { column: "id" }])
      .limit(batch)) as Array<{
      id: number;
      userId: number | null;
      type: string;
      state: string;
      progress: number;
      stage: string | null;
      updatedAt: number;
      lastError: string | null;
    }>;

    let sent = 0;
    for (const r of rows) {
      // 游标推进**先做**（与是否 emit 无关）：跳过的 NULL 用户行也必须推进，
      // 否则两条 NULL 行 + batch=1 会让游标永久卡在同一位置（死循环）。
      cursorTs = Number(r.updatedAt);
      cursorId = Number(r.id);
      if (r.userId === null || r.userId === undefined) continue;
      const sig = `${r.state}:${r.progress}:${r.stage ?? ""}`;
      if (lastSent.get(r.id) === sig) continue;
      lastSent.set(r.id, sig);
      const payload: RelayEvent = {
        id: Number(r.id),
        type: r.type,
        state: r.state,
        progress: Number(r.progress),
        stage: r.stage,
        ...(r.lastError ? { error: String(r.lastError).slice(0, 200) } : {}),
      };
      // ⚠ F3：目标必须是**该 room 被 join 的那个 namespace**（不是根 io）
      targetOf(`user:${r.userId}`).emit("job:update", payload);
      sent += 1;
    }
    if (lastSent.size > 5_000) lastSent.clear(); // 兜底：不让这张表无限长
    return sent;
  }

  timer = setInterval(() => {
    void tick().catch((e) => log(`[relay] tick 失败：${e instanceof Error ? e.message : String(e)}`));
  }, pollMs);

  return {
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    tick,
  };
}
