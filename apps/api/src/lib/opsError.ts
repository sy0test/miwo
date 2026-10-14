/**
 * 运维接口的**响应脱敏**（Phase 1c Task 6；裁定 §2.7）。
 *
 * ── 为什么需要它（不是"顺手统一文案"）──
 * 全局错误处理器（`src/app.ts` 的 `errorHandler`）只兜**未捕获**到 next(err) 的路径。
 * 而 5 个运维接口都是**自己 try/catch** 的：它们此前直接 `error(err?.message || "…")`，
 * 于是同一条泄漏面**从后门回来了** —— 实测形状：
 *   · sqlite：`insert into \`o_user\` … - UNIQUE constraint failed: o_user.username`
 *     （表名 + 列名 + 约束名）；
 *   · mysql ：`ER_DUP_ENTRY: Duplicate entry 'x' for key 'o_user.username'`
 *     （同样含表名/键名）；
 *   · 任何方言：knex 的连接错误会带上**主机/库名**，SQLITE 错误可能带**库文件绝对路径**。
 * 管理员令牌被盗时，"库长什么样"不该是免费信息。
 *
 * ── 与外部错误体的统一口径（`{code, data, message}`，与 responseFormat 的 error() 同形）──
 *   · `status < 500`（4xx：白名单拒绝、参数不合法）⇒ 保留 `message`：调用方**需要**知道怎么改；
 *   · `status >= 500` ⇒ 只回 `messageFor` 给的固定文案；**完整错误只进服务端日志**
 *     （含 method/path，便于用访问日志对时）。
 */

/** 与 `@/lib/responseFormat` 的 `error()` 同形（本文件不 import 它，避免把响应层拖进 dbOps 那一类纯工具）。 */
export interface ErrorBody {
  code: number;
  data: null;
  message: string;
}

/**
 * 运维接口的 500 响应体。
 *
 * @param endpoint 接口名（只进日志，不回响应）
 * @param err      原始错误（**完整进日志**）
 * @param fallback 对外固定文案（例如 "清除失败"）
 */
export function opsErrorBody(endpoint: string, err: unknown, fallback: string): ErrorBody {
  console.error(`[ops:${endpoint}] 内部错误（对外只回固定文案）:`, err);
  return { code: 500, data: null, message: fallback };
}
