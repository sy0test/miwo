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
 * 目标 namespace 未注册时回退根 `io`（测试/精简装配下不至于抛错；此时也无订阅者，语义等同现状）。
 * ⚠ 刻意**不**用 `io.of(path)` 兜底：那会**凭空创建** namespace（含路由表与内存），是副作用。
 */
export function makeRelayTargetResolver(io: Server, nspPath: string = PRODUCTION_AGENT_NAMESPACE) {
  return (room: string): { emit(event: string, payload: unknown): void } => {
    const nsps = (io as unknown as { _nsps?: Map<string, unknown> })._nsps;
    const target = (nsps?.get(nspPath) ?? io) as { to(r: string): { emit(event: string, payload: unknown): void } };
    return target.to(room);
  };
}
