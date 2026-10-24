/**
 * 剧本读写（M2 会话页第①步）。
 *
 * 只碰 `o_script.content` / `o_script.name`；**不碰** 解析产物（分镜/资产草稿），
 * 也不改 `extractState` —— 改台词不改变"解析已完成的"事实。
 */
import { RedrawHttpError } from "@/redraw/http";
import { upsertWorkData } from "@/redraw/state";

export type ScriptView = { content: string; name: string };

export async function readRedrawScript(db: any, opts: { projectId: number; scriptId: number }): Promise<ScriptView> {
  const row = await db("o_script").where({ id: opts.scriptId, projectId: opts.projectId }).first();
  if (!row) throw new RedrawHttpError(400, "项目 " + opts.projectId + " 下没有这一集：scriptId=" + opts.scriptId);
  return { content: String(row.content ?? ""), name: String(row.name ?? "") };
}

/**
 * 存剧本正文。返回 `{changed}`（内容真的变了才 true）—— 前端用它决定要不要提示"已保存"。
 *
 * 顺带把变更摘记进工作区 `redrawScriptEdits`（保留最近 20 条：谁改的、改了多久前、长度变化）。
 * 这是给认账会话的上下文用的（它要在对话里说"剧本你刚改过"），不是审计。
 */
export async function writeRedrawScript(
  db: any,
  opts: { projectId: number; scriptId: number; content: string },
): Promise<{ changed: boolean }> {
  const current = await readRedrawScript(db, opts);
  const next = String(opts.content ?? "");
  if (next === current.content) return { changed: false };
  await db("o_script").where("id", opts.scriptId).update({ content: next });
  const prev = await db("o_agentWorkData")
    .where("projectId", String(opts.projectId))
    .andWhere("episodesId", String(opts.scriptId))
    .andWhere("key", "redrawScriptEdits")
    .first();
  let list: Array<{ at: number; fromLen: number; toLen: number }> = [];
  if (prev?.data) {
    try {
      const parsed = JSON.parse(prev.data);
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
  }
  list.push({ at: Date.now(), fromLen: current.content.length, toLen: next.length });
  await upsertWorkData(db, opts.projectId, opts.scriptId, "redrawScriptEdits", list.slice(-20));
  return { changed: true };
}