import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/scriptAgent/index";
import ResTool from "@/socket/resTool";
import { runWithTenant } from "@/db/tenant-context";
import { bindSocketTenant, buildIsolationKey, decodeSocketToken, pickEpisodesId, resolveOwnedProject } from "@/socket/tenant";

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    // ① 验签 → ctx（⚠ 连接回调**本身不在** ctx 里：ALS 只覆盖 `run()` 内创建的资源）
    const tenant = await decodeSocketToken(socket.handshake.auth?.token);
    if (!tenant) {
      console.log("[scriptAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    // ② 归属校验必须在 ctx 里做（守卫按 ctx.userId 过滤）：客户端传的 projectId 只是**待校验输入**
    const projectId = await runWithTenant(tenant, () => resolveOwnedProject(tenant, socket.handshake.auth?.projectId));
    if (!projectId) {
      console.log("[scriptAgent] 连接失败：projectId 缺失或不属于当前用户");
      socket.disconnect();
      return;
    }
    // ③ isolationKey 由服务端推导；客户端传的那个**不再采信**（spec §3.2：改造前它可被任意指定）
    const isolationKey = buildIsolationKey(tenant, projectId, "scriptAgent", pickEpisodesId(socket.handshake.auth?.episodesId));
    // ④ 之后所有 socket.on(…) 的 handler 都带 ctx（只包"事件回调入口"，内部 await/timer 自动继承）
    bindSocketTenant(socket, tenant);

    console.log("[scriptAgent] 已连接:", socket.id, isolationKey);

    const resTool = new ResTool(socket, { projectId });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "统筹");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey,
        text: content,
        userMessageTime: new Date(msg.datetime).getTime() - 1,
        abortSignal: currentController.signal,
        resTool,
        msg,
        thinkConfig,
      };

      try {
        await agent.runDecisionAI(ctx);
      } catch (err: any) {
        if (err.name !== "AbortError" && !currentController.signal.aborted) {
          console.error("[scriptAgent] chat error:", u.error(err).message);
          msg.error(u.error(err).message)
        }
      } finally {
        if (abortController === currentController) {
          abortController = null;
        }
      }
    });

    socket.on("updateThinkConfig", (data: { think: boolean; thinlLevel: 0 | 1 | 2 | 3 }) => {
      thinkConfig.think = data.think;
      thinkConfig.thinlLevel = data.thinlLevel;
      console.log("[scriptAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[scriptAgent] 已断开连接:", socket.id);
  });
};
