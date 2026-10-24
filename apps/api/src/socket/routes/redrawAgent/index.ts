import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/redrawAgent/index";
import ResTool from "@/socket/resTool";
import { runWithTenant } from "@/db/tenant-context";
import {
  bindSocketTenant,
  buildIsolationKey,
  decodeSocketToken,
  pickEpisodesId,
  resolveOwnedProject,
  resolveOwnedScript,
} from "@/socket/tenant";
import { bindSocketLifecycle, joinUserRoom, type SocketLike } from "@/socket/lifecycle";
import { readRedrawState } from "@/redraw/state";

/**
 * 转绘认账会话的 socket 命名空间：`/api/socket/redrawAgent`。
 *
 * 握手（前端契约）：`auth = { token, isolationKey?, projectId, scriptId }`
 *  · token 走与其它 agent 相同的验签；`isolationKey` 客户端传的**不采信**，服务端重建；
 *  · projectId / scriptId 必须属于当前用户，否则拒连（与 productionAgent 同一规则）。
 *
 * 事件：
 *  · 收 `chat { content }` → 跑一轮 agent（标准 message 协议：`message` / `content:*` / `message:update`）；
 *  · 发 `redraw:updated { scriptId, kind: "script"|"assets"|"cap" }`（工具写库后推，前端刷新页面数据）；
 *  · 发 `redraw:step { scriptId, step: 1|2|3 }`（按 redrawState 推导当前在会话第几步）。
 *  · `stop` 中止本轮；断开（页面关闭）由 `bindSocketLifecycle` 中止，避免继续烧 token。
 */
export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    const tenant = await decodeSocketToken(socket.handshake.auth?.token);
    if (!tenant) {
      console.log("[redrawAgent] 连接失败：token 无效");
      socket.disconnect();
      return;
    }
    const projectId = await runWithTenant(tenant, () => resolveOwnedProject(tenant, socket.handshake.auth?.projectId));
    if (!projectId) {
      console.log("[redrawAgent] 连接失败：projectId 缺失，或该行在库里不属于当前用户");
      socket.disconnect();
      return;
    }
    const wantedScript = pickEpisodesId(socket.handshake.auth?.scriptId, socket.handshake.auth?.episodesId);
    // 归属校验要**两层**：① 这一集属于当前用户（resolveOwnedScript）；② 这一集属于握手的 projectId
    // （同租户跨项目传错 id 也必须拒 —— 否则 isolationKey 会把 A 项目的集拼进 B 项目的键）。
    const scriptId = wantedScript ? await runWithTenant(tenant, async () => {
      const owned = await resolveOwnedScript(tenant, wantedScript);
      if (!owned) return null;
      const row = await u.db("o_script").where({ id: owned, projectId }).first();
      return row ? owned : null;
    }) : null;
    if (!scriptId) {
      console.log("[redrawAgent] 连接失败：scriptId 缺失/不属于当前用户（o_script.userId 未回填也会落到这里）");
      socket.disconnect();
      return;
    }
    // 服务端推导 isolationKey（含 projectId + scriptId）：同一集重连读同一份记忆，换集不串
    const isolationKey = buildIsolationKey(tenant, projectId, "redrawAgent", scriptId);
    bindSocketTenant(socket, tenant);
    joinUserRoom(socket as unknown as SocketLike, tenant.userId);
    bindSocketLifecycle(socket as unknown as SocketLike, () => abortController, (m) => console.log(m));

    console.log("[redrawAgent] 已连接:", socket.id, isolationKey);

    const resTool = new ResTool(socket, { projectId, scriptId });
    let abortController: AbortController | null = null;
    const thinkConfig: agent.AgentContext["thinkConfig"] = { think: false, thinlLevel: 0 };

    /** 按状态推导会话步骤：1 → 第②步（资产）；2 → 第③步（时长）；其余 → 第①步（剧本）。 */
    const emitStep = async (): Promise<void> => {
      try {
        const state = await readRedrawState(u.db as any, { projectId, scriptId });
        const step = state !== null && state >= 2 ? 3 : state !== null && state >= 1 ? 2 : 1;
        socket.emit("redraw:step", { scriptId, step });
      } catch {
        // 推步骤失败不影响主流程
      }
    };
    // ⚠ 必须在租户 ctx 里跑：连接回调本身**不在** ctx 内（ALS 只覆盖 run() 内创建的资源），
    //   直接调 u.db 会抛 TenantContextError，被 catch 吞掉就成了"静默不推 step"。
    void runWithTenant(tenant, emitStep);

    socket.on("chat", async (data: { content: string }) => {
      const content = String(data?.content ?? "").trim();
      if (!content) return;
      abortController?.abort();
      abortController = new AbortController();
      const current = abortController;

      const msg = resTool.newMessage("assistant", "转绘助手");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        projectId,
        scriptId,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: current.signal,
        resTool,
        msg,
        thinkConfig,
      };

      try {
        await agent.runReconcileAI(ctx);
        void emitStep();
      } catch (err: any) {
        if (err?.name !== "AbortError" && !current.signal.aborted) {
          console.error("[redrawAgent] chat error:", u.error(err).message);
          try {
            msg.error(u.error(err).message);
          } catch {
            resTool.sendError(msg.id, u.error(err).message);
          }
        }
      } finally {
        if (abortController === current) abortController = null;
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = Boolean(data?.think);
      thinkConfig.thinlLevel = data?.thinlLevel ?? 0;
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
};