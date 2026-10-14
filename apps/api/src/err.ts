import { serializeError } from "serialize-error";

/**
 * 进程级兜底（spec §10.2 Tier 1 #16）。Phase 1c Task 6 重写。
 *
 * ── 旧行为（只 `console.error`、**不退出**）的真实代价 ──
 * Phase 0 / Task 6 在真机上踩过：`utils/db.ts` 的顶层求值链一旦抛错，进程继续活着、接口照回 200，
 * 但"连接 → 迁移"这条路已经断了 ⇒ **看起来正常、实际半残**的启动（半个库、没有表）。
 * 只断言 HTTP 200 的验收脚本对这类故障完全无感 —— `verify-phase0.cjs` 的 E 组因此专门断言
 * "输出里不得出现未处理拒绝标记"，作为那道闸门的兜底。
 *
 * ── 新行为 ──
 *   ① 打印**完整上下文**（名称/消息/堆栈/序列化详情）—— 诊断信息一个都不许少（**日志**里）；
 *   ② `process.exitCode = 1` + 一拍 `setTimeout(...,0).unref()` 之后 `process.exit(1)`：
 *      只设 `exitCode` 在还有句柄（监听中的 server、socket、DB 池）时**根本不会退出**，
 *      所以必须显式 `process.exit(1)`；而 `unref()` 让这个定时器自己**不阻止**进程退出。
 *   ③ **不吞掉启动期致命错误**：`startServe()` 里 `await dbReady` 失败时本来就是
 *      `dbReady.catch → process.exit(1)`（见 `utils/db.ts`），这条路径**不经**本文件；
 *      本文件只兜"没人 catch 的异常/拒绝"，两者都由 `app.ts` 在**监听端口之前**装配。
 *
 * ⚠ `unhandledRejection` 的默认策略在 Node 15+ 本来就是 `throw`（"不退出"才是**特意配的**）：
 *   所以这里是**回到 Node 的默认语义**，不是新引入的激进行为。
 * ⚠ 退出由 systemd（`Restart=always`）或容器重启策略接管（deploy/ 的编排已经这么配）。
 * ⚠ 幂等：`exiting` 旗标保证并发/连续触发只走一次打印与一次退出（不会打两份栈、不会双重 exit）。
 */
let exiting = false;

/** 统一的"打印后退出"。所有兜底路径都走它，避免两份行为。 */
function fatal(kind: string, detail: unknown): void {
  if (exiting) return;
  exiting = true;

  console.error(`[致命] ${kind} —— 进程将退出（exit 1），由 systemd/容器重启策略接管`);
  if (detail instanceof Error) {
    console.error("错误名称:", detail.name);
    console.error("错误消息:", detail.message);
    console.error("堆栈信息:", detail.stack);
    try {
      console.error("序列化详情:", JSON.stringify(serializeError(detail), null, 2));
    } catch {
      console.error("序列化详情: (无法序列化)");
    }
  } else {
    console.error("原因:", detail);
    console.error("类型:", typeof detail);
    try {
      console.error("JSON:", JSON.stringify(detail, null, 2));
    } catch {
      console.error("JSON: (无法序列化)");
    }
  }

  process.exitCode = 1;
  // 留一拍让上面几行日志刷到 stdout/stderr（管道/重定向下 console 是**异步**的），
  // 然后**显式**退出：只设 exitCode 在有句柄时不会退出（见文件头）。
  setTimeout(() => process.exit(1), 0).unref();
}

// 处理未捕获的 Promise 拒绝
process.on("unhandledRejection", (reason, promise) => {
  fatal("未处理的 Promise 拒绝", reason);
  console.error("Promise:", promise);
});

// 处理未捕获的异常
process.on("uncaughtException", (error) => {
  fatal("未捕获的异常", error);
});
