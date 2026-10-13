import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/productionAgent/index";
import ResTool from "@/socket/resTool";
import { runWithTenant } from "@/db/tenant-context";
import { bindSocketTenant, buildIsolationKey, decodeSocketToken, pickEpisodesId, resolveOwnedProject, resolveOwnedScript } from "@/socket/tenant";

export default (nsp: Namespace) => {
  nsp.on("connection", async (socket: Socket) => {
    // ① 验签 → ctx（⚠ 连接回调**本身不在** ctx 里：ALS 只覆盖 `run()` 内创建的资源）
    const tenant = await decodeSocketToken(socket.handshake.auth?.token);
    if (!tenant) {
      console.log("[productionAgent] 连接失败，token无效");
      socket.disconnect();
      return;
    }
    // ② 归属校验：projectId 必须在 ctx 里查得到（别人的 ⇒ 查不到）
    const projectId = await runWithTenant(tenant, () => resolveOwnedProject(tenant, socket.handshake.auth?.projectId));
    if (!projectId) {
      console.log("[productionAgent] 连接失败：projectId 缺失或不属于当前用户");
      socket.disconnect();
      return;
    }
    // ③ 集号：前端发的是 `scriptId`（`auth.episodesId` 只是兼容别名），**按值判定**（-1/0/undefined 视为没有）。
    //    是正整数就必须属于当前用户，否则拒连 —— 不能拿它去拼键。
    const authScriptId = pickEpisodesId(socket.handshake.auth?.episodesId, socket.handshake.auth?.scriptId);
    let scriptId: number | null = null;
    if (authScriptId) {
      scriptId = await runWithTenant(tenant, () => resolveOwnedScript(tenant, authScriptId));
      if (!scriptId) {
        console.log("[productionAgent] 连接失败：scriptId 不属于当前用户");
        socket.disconnect();
        return;
      }
    }
    // ④ isolationKey 由服务端推导；客户端传的那个**不再采信**（spec §3.2）。
    //    ⚠ 用 `let currentIsolationKey`：`updateContext` 之后 `chat` 必须读到**最新**的键。
    let currentIsolationKey = buildIsolationKey(tenant, projectId, "productionAgent", scriptId);
    bindSocketTenant(socket, tenant);   // 之后所有 socket.on(…) 的 handler 都带 ctx

    console.log("[productionAgent] 已连接:", socket.id, currentIsolationKey);

    let resTool = new ResTool(socket, {
      projectId,
      scriptId: scriptId ?? undefined,
    });
    let abortController: AbortController | null = null;

    const thinkConfig: agent.AgentContext["thinkConfig"] = {
      think: false,
      thinlLevel: 0,
    };

    socket.on("updateContext", async (data: { episodesId?: number; isolationKey?: string; projectId: number; scriptId: number }, callback) => {
      // ⚠ 这里以前**直接采信**客户端传的 isolationKey/projectId/scriptId（spec §3.2 的漏洞）。
      //    现在：projectId 必须属于当前用户；集号（`episodesId ?? scriptId`，按值判定）若给了正整数
      //    也必须属于当前用户；isolationKey 一律由服务端重建。
      const ownedProject = await resolveOwnedProject(tenant, data?.projectId);
      if (!ownedProject) {
        console.log("[productionAgent] 上下文更新被拒：projectId 不属于当前用户");
        callback?.({ success: false });
        return;
      }
      const wantedScript = pickEpisodesId(data?.episodesId, data?.scriptId);
      let ownedScript: number | null = null;
      if (wantedScript) {
        ownedScript = await resolveOwnedScript(tenant, wantedScript);
        if (!ownedScript) {
          console.log("[productionAgent] 上下文更新被拒：scriptId 不属于当前用户");
          callback?.({ success: false });
          return;
        }
      }
      currentIsolationKey = buildIsolationKey(tenant, ownedProject, "productionAgent", ownedScript);
      resTool = new ResTool(socket, {
        projectId: ownedProject,
        scriptId: ownedScript ?? undefined,
      });
      console.log("[productionAgent] 上下文已更新:", currentIsolationKey);
      callback?.({ success: true });
    });

    socket.on("chat", async (data: { content: string }) => {
      const { content } = data;
      abortController?.abort();
      abortController = new AbortController();
      const currentController = abortController;

      const msg = resTool.newMessage("assistant", "视频策划");
      const ctx: agent.AgentContext = {
        socket,
        isolationKey: currentIsolationKey,   // ⚠ 读**最新**的键（updateContext 之后必须生效）
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
          console.error("[productionAgent] chat error:", u.error(err).message);
          // ⚠ 必须把状态推给前端。此前这里**只打日志**：那条消息已经在 :65 以 pending 状态
          // 发出去了，前端 status 会永远停在 pending → 输入框永久禁用，用户以为产品死了，
          // 唯一出路是点菜单里的「重新连接」。resTool.sendError 一直是死代码，没人调用。
          const msgText = `处理失败：${u.error(err).message}`;
          try {
            // 主路径：把错误写进这条消息的内容块，并把状态推到 error
            // （前端 message:update 收到 error/stop/complete 才会把输入框解禁）
            ctx.msg.text().append(msgText);
            ctx.msg.text().error();
            ctx.msg.error(msgText);
          } catch {
            // 兜底：至少把状态推出去。MessageBuilder 的 id 是私有字段，用公开的 `id` getter。
            resTool.sendError(msg.id, msgText);
          }
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
      console.log("[productionAgent] 更新思考配置:", thinkConfig);
    });

    socket.on("stop", () => {
      abortController?.abort();
      abortController = null;
    });
  });
  nsp.on("disconnect", (socket: Socket) => {
    console.log("[productionAgent] 已断开连接:", socket.id);
  });
};
