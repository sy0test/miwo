/**
 * socket 生命周期（spec §9.5 的真机 bug 回归）。
 *
 * 历史 bug：`productionAgent.ts` 把 `disconnect` 挂在 **namespace** 上 —— 它是 **socket 级**
 * 事件，于是监听器永远不触发，用户关掉页面后 agent 继续烧 token。抽成小函数后，"必须挂在
 * socket 上 + 必须 abort" 就成了可单测的不变式（原代码里该逻辑依赖 token 校验，跑起来很脆）。
 *
 * ⚠ 本文件除了行为单测，还有**源码级静态断言**（判据 3 的后半）：因为"把 `socket.on` 改回
 *   `nsp.on`"在行为单测里做不到（单测根本不经过 `nsp`）⇒ 用"源码里不得再出现 `nsp.on("disconnect"`
 *   + 两个路由都必须接线"两处共同守住。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bindSocketLifecycle, joinUserRoom, type SocketLike } from "@/socket/lifecycle";

function fakeSocket(id = "s1") {
  const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
  const joined: string[] = [];
  const socket: SocketLike = {
    id,
    on: (event: string, fn: (...a: unknown[]) => void) => { (handlers[event] ||= []).push(fn); },
    join: (room: string) => { joined.push(room); },
  };
  return { socket, handlers, joined };
}

describe("socket 生命周期（spec §9.5）", () => {
  it("★ disconnect 必须挂在 **socket** 上，并且要 abort 正在跑的任务", () => {
    const { socket, handlers } = fakeSocket();
    let aborted = 0;
    bindSocketLifecycle(socket, () => ({ abort: () => { aborted += 1; } }));
    expect(handlers["disconnect"]?.length).toBe(1);
    handlers["disconnect"][0]();
    expect(aborted).toBe(1);
  });

  it("没有在跑的任务时 disconnect 不抛错", () => {
    const { socket, handlers } = fakeSocket();
    bindSocketLifecycle(socket, () => null);
    expect(() => handlers["disconnect"][0]()).not.toThrow();
  });

  it("room 名固定为 user:{id}；userId 为空时不加入", () => {
    const a = fakeSocket();
    joinUserRoom(a.socket, 7);
    expect(a.joined).toEqual(["user:7"]);
    const b = fakeSocket();
    joinUserRoom(b.socket, null);
    expect(b.joined).toEqual([]);
  });

  it("★ disconnect 只注册一次，且重复触发时不抛（socket.io 可能重入）", () => {
    const { socket, handlers } = fakeSocket();
    let aborted = 0;
    bindSocketLifecycle(socket, () => ({ abort: () => { aborted += 1; } }));
    expect(handlers["disconnect"].length).toBe(1);
    expect(() => handlers["disconnect"][0]()).not.toThrow();
    expect(aborted).toBe(1);
  });

  it("★ 每个 socket 实例各绑各的（不许出现跨连接的共享状态）", () => {
    const a = fakeSocket("a");
    const b = fakeSocket("b");
    let abortedA = 0;
    let abortedB = 0;
    bindSocketLifecycle(a.socket, () => ({ abort: () => { abortedA += 1; } }));
    bindSocketLifecycle(b.socket, () => ({ abort: () => { abortedB += 1; } }));
    a.handlers["disconnect"][0]();
    expect(abortedA).toBe(1);
    expect(abortedB, "A 断开不得 abort B 的任务").toBe(0);
  });

  it("★ 缺 join 的 socket 也不抛（jest 假对象/老版本 socket.io 兼容）", () => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const s: SocketLike = { id: "nojoin", on: (e, fn) => { (handlers[e] ||= []).push(fn); } };
    expect(() => joinUserRoom(s, 9)).not.toThrow();
  });
});

/**
 * 源码级静态守卫（判据 3 的后半）。**不许**把它当成"行为已测"的替代 —— 它守的是"接线有没有被改回去"：
 *  · 反向：`src/socket/**` 里不得再出现 `nsp.on("disconnect"`（排除注释行）；
 *  · 正向：两个 socket 路由（productionAgent / scriptAgent）都必须 `joinUserRoom` + `bindSocketLifecycle`；
 *  · 方向：`disconnect` 必须注册在 `socket.on` 上（lifecycle 的**唯一**注册点）。
 */
describe("socket 生命周期 —— 源码级静态守卫（spec §9.5 接线不回退）", () => {
  const SOCKET_SRC = path.resolve(__dirname, "..", "src", "socket");
  const read = (rel: string): string => fs.readFileSync(path.join(SOCKET_SRC, rel), "utf8");
  /** 去掉整行注释，避免"注释里解释这个 bug"被当成命中。 */
  const stripLineComments = (src: string): string =>
    src
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*\/\*.*$/, ""))
      .join("\n");

  it('★ 反向：src/socket/** 里不得再有 `nsp.on("disconnect"`（那是永不触发的命名空间挂法）', () => {
    const files = [path.join("routes", "productionAgent.ts"), path.join("routes", "scriptAgent.ts"), "lifecycle.ts"];
    for (const f of files) {
      expect(stripLineComments(read(f)), `${f} 不得再挂 namespace 级 disconnect`).not.toContain('nsp.on("disconnect"');
    }
  });

  it("★ 正向：两个 socket 路由都接了 joinUserRoom + bindSocketLifecycle", () => {
    for (const f of [path.join("routes", "productionAgent.ts"), path.join("routes", "scriptAgent.ts")]) {
      const src = read(f);
      expect(src, `${f} 必须 joinUserRoom`).toContain("joinUserRoom(socket");
      expect(src, `${f} 必须 bindSocketLifecycle`).toContain("bindSocketLifecycle(socket");
      // userId 必须来自服务端验签结果 tenant.userId，**不许**读客户端可伪造的 handshake
      expect(src, `${f} 的 room 归属必须用 tenant.userId`).toContain("tenant.userId");
      expect(src, `${f} 不许从 handshake.auth 里读 userId（客户端可伪造）`).not.toMatch(/handshake\.auth\??\.userId/);
    }
  });

  it("★ 方向：disconnect 的注册点是 socket.on（lifecycle 是唯一实现）", () => {
    const src = read("lifecycle.ts");
    expect(stripLineComments(src)).toContain('socket.on("disconnect"');
    expect(stripLineComments(src)).not.toMatch(/\bnsp\b/);
  });
});
