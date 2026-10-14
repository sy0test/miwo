/**
 * ★ review-C F3（High）的**真客户端集成用例**。
 *
 * 缺陷原样：room 是在 `/api/socket/productionAgent` **namespace 内** join 的，而 `app.ts` 把**根 `io`**
 * 交给 relay ⇒ `io.to(room)` 打的是根命名空间的房间 ⇒ **真客户端一条都收不到**
 * （reviewer 实测：`RELAY_TICK_SENT=2` 而 `CLIENT_A_EVENTS=[]`）。
 *
 * 本用例用**真 socket.io Server + 真 socket.io-client**（走 HTTP polling 传输，无额外依赖：
 * `socket.io-client` 是 `socket.io` 的传递依赖）复现两层：
 *  ① **A 片（缺陷接线）**：relay 打根 io ⇒ 三个客户端**全空**（功能不可达）；
 *  ② **B 片（修好的接线）**：relay 用 `makeRelayTargetResolver(io)` ⇒ 每个用户**只收自己的**事件，
 *     且**共用的第三个用户**（`user:3003`）**一条都收不到**（证明不是全广播）。
 *
 * ⚠ 这里刻意不 import `productionAgent` 路由（它要求真 token + 真项目，属另一层）；
 *   "room 在 namespace 内 join" 这个前提用**最小 route** 复现，接线错误本身就是被测对象。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { afterAll, describe, expect, it } from "vitest";
import type { Knex } from "knex";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";
import { runMigrations } from "@/db/migrations";
import { startProgressRelay } from "@/jobs/progressRelay";
import { PRODUCTION_AGENT_NAMESPACE, makeRelayTargetResolver } from "@/socket/index";

/**
 * ⚠ `socket.io-client` 不是 `@miwo/api` 的直接依赖（pnpm 的严格隔离 ⇒ 直接 `import` 解析不到），
 * 但它是 `socket.io` 的**传递依赖**。这里从 `socket.io` 的解析基点 require 它 —— **不新增依赖**。
 * 只用到 `io()` / `socket.on` / `close()`，因此用最小结构类型标注（不 import 它的类型）。
 */
const requireFromSocketIo = createRequire(require.resolve("socket.io/package.json"));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ioClient = requireFromSocketIo("socket.io-client").io as (
  url: string,
  opts: Record<string, unknown>,
) => {
  on(event: string, fn: (...a: unknown[]) => void): void;
  close(): void;
};

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-relay-nsp-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

function cfg(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: TMP, mediaDir: path.join(TMP, "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: "x".repeat(48), db: { driver: "sqlite", file },
  } as MiwoConfig;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 记录每个客户端收到的 `job:update` 事件。 */
function collect(sock: { on(event: string, fn: (...a: unknown[]) => void): void }): Array<Record<string, unknown>> {
  const seen: Array<Record<string, unknown>> = [];
  sock.on("job:update", (p: Record<string, unknown>) => seen.push(p));
  return seen;
}

async function insertJob(db: Knex, userId: number, n: number): Promise<void> {
  const ts = Date.now() + n;
  await db("o_job").insert({
    userId, type: "video.generate", payload: '{"items":[]}', state: "queued", attempts: 0, maxAttempts: 1,
    priority: 100, progress: 0, createdAt: ts, updatedAt: ts,
  });
}

/**
 * 起一个真 socket.io：注册 `PRODUCTION_AGENT_NAMESPACE`，连接后按**服务端给出的 userId**（这里用
 * `auth.userId` 模拟"验签结果"）join `user:{id}`，**同时**把两个用户都 join 到 `user:3003`（共享房间），
 * 用来验证"relay 只打各自房间，不做全广播"。
 */
async function setup() {
  const server = http.createServer();
  const io = new Server(server);
  io.of(PRODUCTION_AGENT_NAMESPACE).on("connection", (socket) => {
    const uid = Number((socket.handshake.auth as { userId?: number })?.userId ?? 0);
    void socket.join(`user:${uid}`);
    void socket.join("user:3003"); // 共享房间：任何"全广播"都会打进来
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}${PRODUCTION_AGENT_NAMESPACE}`;
  const mk = (userId: number) => ioClient(url, { auth: { userId }, transports: ["polling"], reconnection: false, forceNew: true });
  return { server, io, port, mk };
}

describe("relay → 真 socket 客户端（review-C F3）", () => {
  it("★ A/B 两片对照：根 io ⇒ 0 事件；namespace 解析器 ⇒ 各自只收自己的、共享房间不泄漏", async () => {
    const db = createKnex(cfg(path.join(TMP, "relay.sqlite")));
    await runMigrations(db);
    await insertJob(db, 4001, 1);
    await insertJob(db, 4002, 2);

    const { server, io, mk } = await setup();
    const a1 = mk(4001);
    const b1 = mk(4002);
    const shared = mk(4003); // 只 join 共享房间 user:3003
    try {
      await Promise.all([
        new Promise<void>((r) => a1.on("connect", () => r())),
        new Promise<void>((r) => b1.on("connect", () => r())),
        new Promise<void>((r) => shared.on("connect", () => r())),
      ]);
      await sleep(150); // 等 join 生效

      const seenA = collect(a1);
      const seenB = collect(b1);
      const seenShared = collect(shared);

      // ---- A 片：缺陷接线（根 io）——必须全空，证明"现状是死的" ----
      const broken = startProgressRelay({ db, io, pollMs: 10_000 });
      const sentBroken = await broken.tick();
      broken.stop();
      await sleep(250);
      // eslint-disable-next-line no-console
      console.log(`[F3] A片(根io) sent=${sentBroken} A=${seenA.length} B=${seenB.length} SHARED=${seenShared.length}`);
      expect(sentBroken, "relay 自己认为发了 2 条").toBe(2);
      expect([seenA.length, seenB.length], "根 io 打不到 namespace 内的 room ⇒ 真客户端必须是 0").toEqual([0, 0]);

      // ---- B 片：修好的接线（namespace 解析器）----
      const rows = await db("o_job").select("id").where("state", "queued").orderBy("id");
      await db("o_job").whereIn("id", rows.map((r: { id: number }) => Number(r.id))).update({ updatedAt: Date.now() + 1000 });
      const fixed = startProgressRelay({ db, io, targetOf: makeRelayTargetResolver(io), pollMs: 10_000 });
      const sentFixed = await fixed.tick();
      fixed.stop();
      await sleep(300);
      // eslint-disable-next-line no-console
      console.log(`[F3] B片(namespace) sent=${sentFixed} A=${seenA.length} B=${seenB.length} SHARED=${seenShared.length}`);
      expect(sentFixed).toBe(2);
      expect(seenA.length, "A 必须收到自己的 1 条").toBe(1);
      expect(seenB.length, "B 必须收到自己的 1 条").toBe(1);
      expect(seenShared.length, "共享房间收不到任何用户房间的事件 ⇒ 没有全广播").toBe(0);
      // 每条事件只含它自己那个 job 的 id（隔离）
      expect(seenA[0].id).not.toBe(seenB[0].id);
      // 载荷仍是白名单（不含 payload 原文）
      expect(Object.keys(seenA[0]).sort()).toEqual(["id", "progress", "stage", "state", "type"]);
    } finally {
      a1.close();
      b1.close();
      shared.close();
      io.close();
      await new Promise<void>((r) => server.close(() => r()));
      await db.destroy();
    }
  }, 60_000);
});
