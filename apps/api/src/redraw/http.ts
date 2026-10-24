/**
 * 转绘路由的**共享 HTTP 小工具**：可预期的业务错误（带状态码/数据）与"这一集是否属于这个项目"。
 *
 * ⚠ 文件名不带下划线前缀也没关系 —— 它在 `src/redraw/` 下，不在 `src/routes/` 里，
 *   不会被 `scripts/generate-router.ts` 当成一条路由。
 */

/** 可预期错误：路由把它翻成 `{code,data,message}`（前端按 code/data 分支）。 */
export class RedrawHttpError extends Error {
  status: number;
  data: unknown;
  constructor(status: number, message: string, data: unknown = null) {
    super(message);
    this.name = "RedrawHttpError";
    this.status = status;
    this.data = data;
  }
}

/** 校验"项目存在 + 这一集属于该项目"；任一不满足抛 400（守卫保证跨租户查不到）。 */
export async function requireOwnedScript(
  db: any,
  projectId: number,
  scriptId: number,
): Promise<Record<string, any>> {
  const project = await db("o_project").where("id", projectId).first();
  if (!project) throw new RedrawHttpError(400, "项目不存在：" + projectId);
  const script = await db("o_script").where({ id: scriptId, projectId }).first();
  if (!script) throw new RedrawHttpError(400, "项目 " + projectId + " 下没有这一集：scriptId=" + scriptId);
  return script;
}

/** 统一把异常翻成响应。`RedrawHttpError` 用自己的状态码与 data；其它一律 500（不回内部文案）。 */
export function sendRedrawRouteError(res: any, e: any, fallbackMessage: string): void {
  if (e instanceof RedrawHttpError) {
    res.status(e.status).send({ code: e.status, data: e.data ?? null, message: e.message });
    return;
  }
  const msg = typeof e?.message === "string" && e.message.trim() ? e.message.trim() : fallbackMessage;
  res.status(500).send({ code: 500, data: null, message: msg });
}