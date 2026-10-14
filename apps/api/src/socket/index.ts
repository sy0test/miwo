import { Server } from "socket.io";
import productionAgent from "./routes/productionAgent";
import scriptAgent from "./routes/scriptAgent";

/**
 * 进度事件真正被订阅的命名空间（**唯一常量**，review-C F3）。
 *
 * 为什么必须显式给出来：room（`user:{userId}`）是在 `productionAgent` 的 `connection` 回调里
 * **在 namespace 内** join 的；而 relay 原来拿到的是**根 `io`**，`io.to(room)` 打的是根命名空间的
 * 房间 ⇒ **真客户端一条都收不到**（reviewer 实测：`RELAY_TICK_SENT=2` 而 `CLIENT_A_EVENTS=[]`）。
 * 接线错在"名字对不上"，不是房间过滤逻辑 —— 改正命名空间后 A 只收 A、B 只收 B。
 */
export const PRODUCTION_AGENT_NAMESPACE = "/api/socket/productionAgent";

/**
 * 进度事件的**订阅方命名空间清单**（C 组复核轮 **N2**）。
 *
 * ⚠ 复核轮实测：只有 `productionAgent` 被 relay 覆盖，而 **`scriptAgent` 也 join 了同名 room** ——
 *   同一用户只连 `scriptAgent` 时 **0 事件**，是**死订阅**（看起来接了、实际收不到）。
 *   修法（最小且不留假接线）：resolver 对**每个已注册的订阅方 namespace** 各投一次。
 *   `scriptAgent` 在前端真正消费 `job:update` 之前**保留订阅**：它收到的是同一份事件，
 *   且事件只进 `user:{自己的 userId}` 房间 ⇒ 无泄漏风险。
 *   ⇒ 若 1e 决定只保留一个订阅方，删掉这里的条目即可（判断入口唯一，不会散落）。
 */
export const JOB_EVENT_NAMESPACES: readonly string[] = [PRODUCTION_AGENT_NAMESPACE, "/api/socket/scriptAgent"];

export default (io: Server) => {
  const routes: Record<string, (nsp: ReturnType<Server["of"]>) => void> = {
    productionAgent,
    scriptAgent,
  };

  for (const [name, handler] of Object.entries(routes)) {
    const nsp = io.of(`/api/socket/${name}`);
    handler(nsp);
    console.log(`[Socket] 注册命名空间: /api/socket/${name}`);
  }
};

/**
 * 给 progress relay 用的**发送目标解析器**：把"房间名"解析成"该房间真正被 join 的那个 namespace"。
 *
 * 取值方式：socket.io 4.x 的 `Server._nsps` 是 `Map<path, Namespace>`（实测 4.8.4 是 Map，根为 `/`）。
 *
 * ⚠ **N2：绝不静默回退根 io**。旧实现"resolver 未注册 ⇒ 打根 io"会让接线错误**看起来是接好的**
 *   （事件进了没人订阅的根房间，客户端 0 事件却毫无报错）。现在：
 *   · 逐个订阅方 namespace 各投一次（`JOB_EVENT_NAMESPACES`）；
 *   · **一个都没注册** ⇒ 仍然打根 `io`，但**同时打一条警告**（可观测，不是静默），
 *     且调用点唯一（`app.ts`），保证不会散落成"看不出来"的假接线。
 * ⚠ 刻意**不**用 `io.of(path)` 兜底：那会**凭空创建** namespace（含路由表与内存），是副作用。
 */
export function makeRelayTargetResolver(io: Server, nspPaths: readonly string[] = JOB_EVENT_NAMESPACES) {
  const nsps = (io as unknown as { _nsps?: Map<string, unknown> })._nsps;
  const registered = nspPaths.filter((p) => nsps?.has(p));
  if (registered.length === 0) {
    console.warn(
      `[relay] 没有任何进度订阅方 namespace 已注册（期望其一：${nspPaths.join(" / ")}）——` +
        ` 事件将打进**根命名空间**（无人订阅）。这是接线错误，不是正常运行状态。`,
    );
  }
  const targets = (registered.length ? registered : ["/"]).map(
    (p) => (nsps?.get(p) ?? io) as { to(r: string): { emit(event: string, payload: unknown): void } },
  );
  return (room: string): { emit(event: string, payload: unknown): void } => {
    // 多订阅方：每个 namespace 各投一次（同一条事件不会重复到达同一个客户端 —— 它们在不同 namespace）
    const emitters = targets.map((t) => t.to(room));
    return {
      emit: (event: string, payload: unknown) => {
        for (const e of emitters) e.emit(event, payload);
      },
    };
  };
}
