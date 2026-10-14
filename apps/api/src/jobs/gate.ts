/**
 * vendor 分池并发闸门（spec §9.3「全局并发：按 vendor 分池的信号量」+ R4「厂商配额是真实瓶颈」）。
 *
 * ── 为什么必须是**数据库**槽位而不是进程内信号量 ──
 * Phase 1 的拓扑是 api + worker 两个进程（Task 11 还会加容器 worker），进程内计数器管不住跨进程总量。
 * `o_gate` 用与 `o_job` 同一套"租约 + 条件写"的思想：持有者崩溃 → 槽位过期 → 自动回收。
 *
 * ── 准入算法（**插入后校验**，两种方言都安全，且不需要 raw SQL）──
 *   1. 先回收本池的过期槽位；
 *   2. 插入自己的一行；
 *   3. 按 `(acquiredAt, id)` 排序取本池前 `limit` 行：
 *      · 自己在前 `limit` 里 → 拿到槽位（返回槽位 id）；
 *      · 自己不在里面 → **删掉自己这行**、等 `pollMs` 重试（直到 `waitMs` 超时返回 null）。
 *   这样即使"先读计数再插入"的竞态导致多插了几行，**只有前 limit 个持有者会真正继续**。
 *   代价：极端并发下会有短暂的"插了又删"（可观测为 `o_gate` 行数波动），换来的是无锁正确性。
 *
 * ── 为什么本模块是 `runAsAuth` 的**新登记调用方**（不是新增绕过口）──
 *   `o_gate` 是 **platform** 表（`src/db/policies.ts`），platform 表的**写**要求 `ctx.role === "admin"`
 *   （见 `tenant-guard.ts:isPlatformWriteCtx`）。而调用方是两条真实路径：
 *     · worker 侧的 handler：ctx 由 `withJobTenant()` 建，`role: "user"`（最小权限，**故意**不给 admin）
 *       ⇒ handler 自己写 `o_gate` 会 403；
 *     · api 侧的"请求内同步等模型"入口：ctx 来自普通用户的 HTTP 请求，同样是 `role: "user"`。
 *   所以取/还槽位必须**代行系统身份** —— 与 `store.ts` 对 `o_job` 的做法**逐字同理**
 *   （不新增 `systemDb` 绕过口，只用已登记的特权原语；登记在 `tools/auth-writer-registry.json`）。
 *   ⚠ 代行的范围只有 `o_gate` 的这几条语句，**厂商调用本身仍在调用方的真实 ctx 里跑**
 *     （`withVendorSlot` 只把 acquire/release 包进去）。
 */
import type { Knex } from "knex";
import { v4 as uuidv4 } from "uuid";
import { runAsAuth } from "@/db/noContext";
import { JOB_POLICY } from "@/jobs/policy";
import { isDuplicateKeyError } from "@/jobs/store";

export interface GateLimits {
  [pool: string]: number;
}

/**
 * 池上限。⚠ 与 `JOB_POLICY` 一样是 **O10 口径的落点**（spec §15）：
 * 口径从"注册用户"改成"同时在线/同时生成"时，这里与 `policy.ts` 一起改。
 * 未列出的 pool 名取 `default`。
 */
export const GATE_LIMITS: GateLimits = {
  "vendor:text": 8,
  "vendor:image": 4,
  "vendor:video": 2,
  default: 4,
};

export interface Gate {
  acquire(pool: string, holderId: string, waitMs?: number): Promise<number | null>;
  release(slotId: number): Promise<boolean>;
  releaseAll(holderId: string): Promise<number>;
  reclaimExpired(): Promise<number>;
  counts(): Promise<Record<string, number>>;
}

export interface GateDeps {
  db: Knex;
  now?: () => number;
  limits?: GateLimits;
  pollMs?: number;
  leaseMs?: number;
  waitMs?: number;
  /** 注入用（测试/单例管理）。缺省 = `runAsAuth`（生产：platform 表的写必须代行系统身份）。 */
  asSystem?: <T>(fn: () => Promise<T>) => Promise<T>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createGate(deps: GateDeps): Gate {
  const db = deps.db;
  const now = deps.now ?? ((): number => Date.now());
  const limits = deps.limits ?? GATE_LIMITS;
  const pollMs = deps.pollMs ?? JOB_POLICY.gatePollMs;
  const leaseMs = deps.leaseMs ?? JOB_POLICY.gateLeaseMs;
  const defaultWait = deps.waitMs ?? JOB_POLICY.gateWaitMs;
  const asSystem = deps.asSystem ?? (<T,>(fn: () => Promise<T>): Promise<T> => runAsAuth(fn));

  const limitOf = (pool: string): number => Math.max(1, limits[pool] ?? limits.default ?? 1);

  function reclaimExpired(): Promise<number> {
    const ts = now();
    return asSystem(async () => (await db("o_gate").where("leaseUntil", "<", ts).del()) as number);
  }

  function counts(): Promise<Record<string, number>> {
    const ts = now();
    return asSystem(async () => {
      const rows = (await db("o_gate")
        .select("name")
        .count({ n: "*" })
        .where("leaseUntil", ">=", ts)
        .groupBy("name")) as Array<{ name: string; n: number | string }>;
      const out: Record<string, number> = {};
      for (const r of rows) out[r.name] = Number(r.n);
      return out;
    });
  }

  async function acquire(pool: string, holderId: string, waitMs = defaultWait): Promise<number | null> {
    const limit = limitOf(pool);
    const deadline = now() + waitMs;
    for (;;) {
      await reclaimExpired();
      const ts = now();
      const inserted = await asSystem(
        async () =>
          (await db("o_gate").insert({ name: pool, holderId, acquiredAt: ts, leaseUntil: ts + leaseMs, updatedAt: ts })) as unknown,
      );
      let slotId: number;
      try {
        slotId = Number(Array.isArray(inserted) ? inserted[0] : inserted);
      } catch (e) {
        // 理论上没有唯一键；留着以防将来给 o_gate 加约束（那时"插不进"= 让别人先跑）
        if (isDuplicateKeyError(e)) {
          await sleep(pollMs);
          continue;
        }
        throw e;
      }
      const mine = await asSystem(
        async () =>
          (await db("o_gate")
            .select("id")
            .where("name", pool)
            .andWhere("leaseUntil", ">=", now())
            .orderBy([{ column: "acquiredAt" }, { column: "id" }])
            .limit(limit)) as Array<{ id: number }>,
      );
      if (mine.some((r) => Number(r.id) === slotId)) return slotId;
      // 没轮到我 → **立刻让位**（这一步是"插入后校验"能成立的关键：不占着行等）
      await asSystem(async () => (await db("o_gate").where("id", slotId).del()) as number);
      if (now() >= deadline) return null;
      await sleep(pollMs);
    }
  }

  function release(slotId: number): Promise<boolean> {
    return asSystem(async () => ((await db("o_gate").where("id", slotId).del()) as number) > 0);
  }

  function releaseAll(holderId: string): Promise<number> {
    return asSystem(async () => (await db("o_gate").where("holderId", holderId).del()) as number);
  }

  return { acquire, release, releaseAll, reclaimExpired, counts };
}

/** 进程内单例（延迟建，避免模块加载即连库 —— 纯单测用 `createGate`，不走这里）。 */
let singleton: Gate | null = null;
/** 单例的建库入口：由**启动链上的模块**注入（`jobs/index.ts` 传 `u.db`）。
 *  ⚠ 这里刻意**不** `import u from "@/utils"` / 不写 `require("@/utils/db")`：
 *    · 顶层 import 会把 `gate.ts` 拖进启动链（路由 → gate → utils/db），加载顺序变脆；
 *    · `require("@/utils/db")` 的 `@/` 别名在**编译产物**里不会被改写（本仓库唯一的别名 require），
 *      生产上会 `MODULE_NOT_FOUND` —— 实测口径见 groupC-report.md「偏离登记」。
 *  所以用注入：`jobs/index.ts` 与 `store.ts` 一样只在启动路径上 import `u.db`。 */
let gateFactory: (() => Gate) | null = null;

/** 由启动链注入"怎么建生产闸门"（只应调用一次）。 */
export function __setGateFactory(factory: () => Gate): void {
  gateFactory = factory;
  singleton = null;
}

export function getGate(): Gate {
  if (!singleton) {
    if (!gateFactory) {
      throw new Error("[gate] 闸门未初始化：启动路径应调用 __setGateFactory()（见 src/jobs/index.ts），测试请直接传 deps.gate");
    }
    singleton = gateFactory();
  }
  return singleton;
}

/** 仅供测试/运维重置单例（生产不用）。 */
export function __setGateForTest(g: Gate | null): void {
  singleton = g;
}

/**
 * **请求内入口的 holder 命名**（约定，spec §9.3）：`api:${pid}:${uuid8}`。
 *
 * 为什么要按请求独立：请求内同步等模型的入口（`extractStylePrompt` / `getAiRegex` / `polishAssetsPrompt` …）
 * 没有 workerId，而且同一进程里多个并发请求必须**各占各的槽位**（否则一个请求的 release 会把别人的槽位删掉）。
 * 进程退出可用 `releaseAll('api:<pid>')` 兜底；Phase 1 先靠 `leaseMs` 过期回收。
 */
export function apiHolderId(): string {
  return `api:${process.pid}:${uuidv4().slice(0, 8)}`;
}

/** `withVendorSlot` 用的闸门：默认单例；测试可用 `__setGateForTest()` 换成注入版。 */
function activeGate(): Gate {
  return getGate();
}

export interface WithVendorSlotDeps {
  waitMs?: number;
  /** 显式注入（测试用；不给就走单例）。 */
  gate?: Gate;
  /** 兜底释放：`finally` 里 `release` 之外再按 holderId 清一次（避免 release 失败留下僵尸槽位）。 */
  holderId?: string;
}

/**
 * 包住**一次厂商调用**。
 *
 * ⚠ 只在**真正的厂商调用**外面用它，别包整条任务：一条视频任务可能跑 15 分钟，其中真正调厂商的
 *   是若干段短调用；若包在整条任务外面，`globalMaxRunning=8` 会退化成 1（谁都进不来）。
 * ⚠ `waitMs` 超时 → **抛错**（任务失败 / 请求 503），而不是无限等：排队等不到就失败，
 *   比无限占着 worker 槽位更符合"100 并发"的目标。默认 120s（`JOB_POLICY.gateWaitMs`）。
 * ⚠ `holderId` 约定：worker 用 `ctx.workerId`；请求内入口用 `api:${process.pid}:${uuid().slice(0,8)}`
 *   （每次请求独立 holder；进程退出可用 `releaseAll(prefix)` 兜底，Phase 1 先靠 `leaseMs` 过期回收）。
 */
export async function withVendorSlot<T>(
  pool: string,
  holderId: string,
  fn: () => Promise<T>,
  waitMsOrDeps?: number | WithVendorSlotDeps,
): Promise<T> {
  const opts: WithVendorSlotDeps = typeof waitMsOrDeps === "number" ? { waitMs: waitMsOrDeps } : (waitMsOrDeps ?? {});
  const gate = opts.gate ?? activeGate();
  const slotId = await gate.acquire(pool, holderId, opts.waitMs);
  if (slotId === null) throw new Error(`[gate] ${pool} 池等待超时（厂商并发已满，请稍后重试）`);
  try {
    return await fn();
  } finally {
    const released = await gate.release(slotId).catch(() => false);
    // 兜底：release 失败（连接抖动/进程将退）时按 holderId 再清一次；清不掉也有 leaseMs 兜底。
    if (!released && opts.holderId) await gate.releaseAll(opts.holderId).catch(() => 0);
  }
}
