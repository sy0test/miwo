import u from "@/utils";
import { Namespace, Socket } from "socket.io";
import * as agent from "@/agents/scriptAgent/index";
import ResTool from "@/socket/resTool";
import { runWithTenant } from "@/db/tenant-context";
import { bindSocketTenant, buildIsolationKey, decodeSocketToken, resolveOwnedProject } from "@/socket/tenant";
import { bindSocketLifecycle, joinUserRoom, type SocketLike } from "@/socket/lifecycle";

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
      // ⚠ 两种原因在服务端**无法区分**（要区分就得做一次无租户条件的 `o_project` 读，而 Ruling 220 #4
      //    禁止为此新增 `systemDb` 使用者）：① 别人的行；② `userId` 还没回填（NULL，真实库现状）。
      //    **别把日志读成越权**；精确区分登记为 Task 6 的文案事项（见 task-5-report §6）。
      console.log("[scriptAgent] 连接失败：projectId 缺失，或该行在库里不属于当前用户（o_project.userId 未回填也会落到这里）");
      socket.disconnect();
      return;
    }
    // ③ isolationKey 由服务端推导；客户端传的那个**不再采信**（spec §3.2：改造前它可被任意指定）。
    //    ⚠ scriptAgent **刻意不采纳集号**（连"正整数集号"也不采纳 —— 与 productionAgent 的规则**不同**）：
    //       这条链路本来就是**按项目**的，没有集维度：前端握手只发 `{isolationKey, projectId}`
    //       （`apps/web/src/stores/scriptAgent.ts:22-25`），HTTP 侧的读/清也不带集号
    //       （`apps/web/src/views/scriptAgent/index.vue:337-340` 的 getMemory、`:313` 的 clearMemory）。
    //       若把客户端给的 `episodesId` 拼进键，那行记忆**没有任何 HTTP 路径能寻址**
    //       ⇒ 记忆面板永远读不到、清记忆永远清不掉（静默孤儿）。
    //       所以正确做法是**让客户端 id 根本不进键**，而不是"校验后采纳"。
    const isolationKey = buildIsolationKey(tenant, projectId, "scriptAgent");
    // ④ 之后所有 socket.on(…) 的 handler 都带 ctx（只包"事件回调入口"，内部 await/timer 自动继承）
    bindSocketTenant(socket, tenant);

    /**
     * Phase 1d Task 8：**同一处 spec §9.5 bug 的姊妹实例**（原文件末尾的 `nsp.on("disconnect", …)`
     * 挂在 namespace 上 ⇒ 永不触发 ⇒ 关页面后 agent 继续烧 token）。brief 只点名了 productionAgent，
     * 但两处是**逐字相同**的缺陷 ⇒ 一并修（判据只收紧不放宽：静态守卫改成扫**整个 `src/socket`**）。
     * `userId` 取**服务端**推导的 `tenant.userId`，绝不读客户端可伪造的 handshake 字段。
     */
    joinUserRoom(socket as unknown as SocketLike, tenant.userId);
    bindSocketLifecycle(socket as unknown as SocketLike, () => abortController, (m) => console.log(m));

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
  // ⚠ Phase 1d Task 8：原 `nsp.on("disconnect", …)` 已删 —— namespace 上没有 socket 级 `disconnect`，
  //   那段代码从未触发（spec §9.5）。现由 `bindSocketLifecycle` 在 connection 回调里挂到 **socket** 上。
};
