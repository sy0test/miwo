/**
 * 转绘认账会话的工具集（M2-T7 / spec §7.2）。
 *
 * 工具名是**固定契约**（技能/前端都引用），不要改：`redraw_getScript` / `redraw_updateScript` /
 * `redraw_listAssetDrafts` / `redraw_listProjectAssets` / `redraw_bindDraft` / `redraw_createAsset` /
 * `redraw_updateAsset` / `redraw_confirmAssets` / `redraw_confirmSegmentCap`。
 *
 * ── 三条纪律 ──
 *  1. **不直写 SQL**：全部走 `redraw/assets.ts` / `redraw/state.ts` / `redraw/cap.ts`（那里才是口径）。
 *  2. **归属校验**：db 传入的是受租户守卫的 `u.db`，跨租户的资产查不到；跨**项目**的 assetId
 *     由 assets.ts 的 `projectId` 条件拒绝（单测覆盖）。
 *  3. **写后通知**：每次写都调 `notify(kind)`，socket 侧据此推 `redraw:updated` 让前端刷新。
 *
 * 返回给模型的结果尽量**短且确定**（JSON 摘要），不做长篇自然语言 —— 模型要的是事实，措辞由它组织。
 */
import { jsonSchema, tool } from "ai";
import { z } from "zod";
import type { Knex } from "knex";
import {
  bindDraft,
  confirmAssets,
  createAsset,
  getDrafts,
  getProjectAssets,
  updateAsset,
} from "@/redraw/assets";
import { SegmentCapError, confirmSegmentCap } from "@/redraw/cap";
import { readRedrawScript, writeRedrawScript } from "@/redraw/script";

export type RedrawUpdateKind = "script" | "assets" | "cap";

export type RedrawToolContext = {
  /** 生产传 `u.db`（受租户守卫）；单测传裸 knex */
  db: Knex;
  projectId: number;
  scriptId: number;
  /** 写库后回调（socket 侧推 `redraw:updated`） */
  notify?: (kind: RedrawUpdateKind) => void;
};

/** 组装固定工具集。返回的对象直接交给 `Ai.Text(...).stream({ tools })`。 */
export function createRedrawTools(ctx: RedrawToolContext): Record<string, any> {
  const { db, projectId, scriptId } = ctx;
  const notify = (kind: RedrawUpdateKind): void => ctx.notify?.(kind);
  const brief = async () => {
    const data = await getDrafts(db, { projectId, scriptId });
    return {
      total: data.drafts.length,
      pending: data.drafts.filter((d) => d.state === "pending").length,
      segments: data.segments.length,
      segmentCap: data.segmentCap,
    };
  };

  return {
    redraw_getScript: tool({
      description: "读取本集剧本正文（会话第①步）。返回 { content, name }",
      inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
      execute: async () => await readRedrawScript(db, { projectId, scriptId }),
    }),

    redraw_updateScript: tool({
      description: "保存本集剧本正文（用户要改台词/剧情时用）。返回 { changed }",
      inputSchema: jsonSchema<{ content: string }>(
        z.object({ content: z.string().describe("完整剧本正文（不是 diff）") }).toJSONSchema(),
      ),
      execute: async ({ content }) => {
        const r = await writeRedrawScript(db, { projectId, scriptId, content: String(content ?? "") });
        notify("script");
        return r;
      },
    }),

    redraw_listAssetDrafts: tool({
      description:
        "列出本集待确认的资产草稿 + 项目已有资产 + 当前绑定。草稿 state：pending（没处理）/ bound（绑了已有资产）/ created（本集新建）/ confirmed（已确认）",
      inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
      execute: async () => await getDrafts(db, { projectId, scriptId }),
    }),

    redraw_listProjectAssets: tool({
      description: "列出项目里已有的资产（供用户挑现成的复用）。返回 { assets: [{id,name,type}] }",
      inputSchema: jsonSchema<{ type?: "role" | "scene" | "tool" }>(
        z.object({ type: z.enum(["role", "scene", "tool"]).optional().describe("按类型过滤，可不给") }).toJSONSchema(),
      ),
      execute: async ({ type }) => {
        const all = await getProjectAssets(db, projectId);
        return { assets: type ? all.filter((a) => a.type === type) : all };
      },
    }),

    redraw_bindDraft: tool({
      description: "把一条草稿绑到项目里已有的资产（复用）。draftName 传草稿名，assetId 来自 redraw_listProjectAssets",
      inputSchema: jsonSchema<{ draftName: string; assetId: number }>(
        z.object({ draftName: z.string(), assetId: z.number() }).toJSONSchema(),
      ),
      execute: async ({ draftName, assetId }) => {
        const r = await bindDraft(db, { projectId, scriptId, draftName: String(draftName ?? ""), assetId: Number(assetId) });
        notify("assets");
        return r;
      },
    }),

    redraw_createAsset: tool({
      description:
        "按草稿新建资产（目标国语言写 name/describe/prompt）。返回 { id }；之后可用 redraw_updateAsset 微调",
      inputSchema: jsonSchema<{
        draftName: string;
        name: string;
        type: "role" | "scene" | "tool";
        describe?: string;
        prompt?: string;
        gender?: string;
      }>(
        z
          .object({
            draftName: z.string(),
            name: z.string().describe("目标国语言名称"),
            type: z.enum(["role", "scene", "tool"]),
            describe: z.string().optional(),
            prompt: z.string().optional(),
            gender: z.string().optional(),
          })
          .toJSONSchema(),
      ),
      execute: async (args) => {
        const r = await createAsset(db, {
          projectId,
          scriptId,
          draftName: String(args.draftName ?? ""),
          name: String(args.name ?? ""),
          type: args.type,
          describe: args.describe,
          prompt: args.prompt,
          gender: args.gender,
        });
        notify("assets");
        return r;
      },
    }),

    redraw_updateAsset: tool({
      description: "修改本集认账清单里的资产（改名/说明/出图提示词/性别）。已有的项目资产只补空、不覆盖",
      inputSchema: jsonSchema<{
        assetId: number;
        name?: string;
        describe?: string;
        prompt?: string;
        gender?: string;
      }>(
        z
          .object({
            assetId: z.number(),
            name: z.string().optional(),
            describe: z.string().optional(),
            prompt: z.string().optional(),
            gender: z.string().optional(),
          })
          .toJSONSchema(),
      ),
      execute: async ({ assetId, ...patch }) => {
        const r = await updateAsset(db, { projectId, scriptId, assetId: Number(assetId), patch });
        notify("assets");
        return { ...r, summary: await brief() };
      },
    }),

    redraw_confirmAssets: tool({
      description: "「全部确认」：把认账计划落成正式资产并挂到本集（之后 redrawState=2）。返回 { created, reused, linked }",
      inputSchema: jsonSchema<Record<string, never>>(z.object({}).toJSONSchema()),
      execute: async () => {
        const r = await confirmAssets(db, { projectId, scriptId });
        notify("assets");
        return r;
      },
    }),

    redraw_confirmSegmentCap: tool({
      description:
        "确认单段上限（第③步）。秒数不变时只写确认记录；要改值时**必须**先向用户说明需要重跑解析、拿到明确同意后再传 force:true",
      inputSchema: jsonSchema<{ seconds: number; force?: boolean }>(
        z.object({ seconds: z.number(), force: z.boolean().optional() }).toJSONSchema(),
      ),
      execute: async ({ seconds, force }) => {
        try {
          const r = await confirmSegmentCap(db, { projectId, scriptId, seconds, force });
          if (r.changed) notify("cap");
          return { ok: true, changed: r.changed, cap: r.cap };
        } catch (e: any) {
          if (e instanceof SegmentCapError) {
            // 不抛：模型需要看到"需要重跑"并把选择权交回用户（抛了会被 SDK 吞成 tool-error）
            return { ok: false, code: e.code, needRerun: e.code === "need_rerun", message: e.message };
          }
          throw e;
        }
      },
    }),
  };
}
