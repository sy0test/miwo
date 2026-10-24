/**
 * 资产图批量生成 handler（从 `routes/assetsGenerate/batchGenerateImageAssets.ts` 的后台段搬来）。
 *
 * 与旧代码的差别：
 *  1. 不再用 `pLimit(concurrentCount)`（**它可以被请求方传 1000**，spec §3.4/§9.3 点名的无上限）；
 *     并发由**队列的全局/按用户上限**与 Task 9 的 vendor 池统一控制。
 *  2. 参考图 base64 不再从请求体里带（payload 不存 base64）——改为按 `assetsId` 现取。
 *  3. 每条都检查 abort 与幂等（`o_image.state` 已是终态就跳过）。
 *
 * ⚠ `abort` 是协作式的（B 组 review-B F6）：每轮开头 `if (ctx.signal.aborted) throw`。
 */
import crypto from "node:crypto";
import { currentAiBillingContext } from "@/billing/context";
import u from "@/utils";
import type { JobContext, JobDefinition } from "@/jobs/types";
import { withVendorSlot } from "@/jobs/gate";

export interface AssetsImageItem {
  assetsId: number;
  imageId: number;
  type: string;
  name: string;
  prompt: string;
}
export interface AssetsImagePayload {
  projectId: number;
  model: string;
  resolution: string;
  items: AssetsImageItem[];
}

const cfgOf: Record<string, { label: string; taskClass: string; dir: string; promptTitle: string; promptEnd: string }> = {
  role: { label: "角色", taskClass: "角色图生成", dir: "role", promptTitle: "角色设定图", promptEnd: "角色设定图（左侧面部特写 + 中间竖椭圆形人相框特写 + 右侧全身正/侧/背三视图，纯白背景，不得添加其它图块）" },
  scene: { label: "场景", taskClass: "场景图生成", dir: "scene", promptTitle: "标准场景图", promptEnd: "标准场景图" },
  tool: { label: "道具", taskClass: "道具图生成", dir: "props", promptTitle: "标准道具图", promptEnd: "标准道具图" },
};

function buildPrompt(cfg: { promptTitle: string; promptEnd: string; label: string }, artStyle: string, name: string, prompt: string): string {
  return `
    请根据以下参数生成${cfg.promptTitle}：

    **基础参数：**
    - 画风风格: ${artStyle || "未指定"}

    **${cfg.label}设定：**
    - 名称:${name},
    - 提示词:${prompt},

    请严格按照系统规范生成${cfg.promptEnd}。
  `;
}

export const imageAssetsBatch: JobDefinition<AssetsImagePayload> = {
  type: "image.assets.batch",
  timeoutMs: 300_000,
  maxAttempts: 2, // 单张图片生成是幂等安全的（产物按 imageId 覆盖），允许重试 1 次
  pool: "vendor:image",
  parse(raw) {
    const o = raw as Partial<AssetsImagePayload>;
    if (!o || typeof o.projectId !== "number" || typeof o.model !== "string" || typeof o.resolution !== "string") {
      throw new Error("[job] image.assets.batch payload 缺少 projectId/model/resolution");
    }
    if (!Array.isArray(o.items) || o.items.length === 0) throw new Error("[job] image.assets.batch 的 items 不能为空");
    for (const it of o.items) {
      if (typeof it.imageId !== "number" || typeof it.assetsId !== "number") throw new Error("[job] image.assets.batch 的 items 元素缺少 assetsId/imageId");
      if (typeof it.type !== "string" || !cfgOf[it.type]) throw new Error(`[job] image.assets.batch 不支持的素材类型: ${String(it.type)}`);
    }
    return { projectId: o.projectId, model: o.model, resolution: o.resolution, items: o.items };
  },
  // ⚠ **dedupeKey 粒度（brief Step 2 要求二选一并在报告里写明）**：
  //    选**表里给的 `sha1(assetsIds)` 版本**（不是"项目级一把锁"的备选）—— 理由：同项目不同批次的
  //    资产图互相独立，锁到项目级会把"补生成 2 个资产"卡在"整项目一批"后面，吞吐无谓下降；
  //    而同批重复提交（前端双击）仍被 sha1 锁住。两版都不违约束，这是**更细**的那个。
  dedupeKey: (p, userId) => {
    const ids = p.items.map((i) => i.assetsId).join(",");
    return `${userId ?? "anon"}:image.assets.batch:${p.projectId}:${sha1(ids)}`;
  },
  async handle(ctx: JobContext, p: AssetsImagePayload) {
    const project = await u.db("o_project").where("id", p.projectId).select("artStyle").first();
    const failed: string[] = [];
    for (let i = 0; i < p.items.length; i += 1) {
      const item = p.items[i];
      if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");
      const current = await u.db("o_image").where("id", item.imageId).select("state").first();
      if (!current) continue;
      if (current.state === "生成失败") continue; // 旧行为：已失败的不再重跑
      if (current.state === "已完成") continue; // 幂等：已完成的不重跑
      const cfg = cfgOf[item.type];
      if (!cfg) continue;

      await ctx.progress(Math.round((i / p.items.length) * 100), `生成${cfg.label}图 ${i + 1}/${p.items.length}`);
      const imagePath = `/${p.projectId}/${cfg.dir}/${u.uuid()}.jpg`;
      const assetPrompt = u.feicai.withOpaqueWhiteCanvas(item.prompt, item.type);
      const userPrompt = buildPrompt(cfg, project?.artStyle ?? "", item.name, assetPrompt);
      try {
        // Phase 1d Task 9：厂商调用前过 `vendor:image` 闸门（spec §9.3）。只包这一次调用。
        const aiImage = await withVendorSlot("vendor:image", ctx.workerId, async () => {
          const cls = u.Ai.Image(p.model as `${string}:${string}`, currentAiBillingContext());
          await cls.run(
            { prompt: userPrompt, referenceList: [], size: p.resolution as "1K" | "2K" | "4K", aspectRatio: "16:9" },
            {
              taskClass: cfg.taskClass,
              describe: `生成${cfg.label}图，名称：${item.name}，提示词：${item.prompt}`,
              projectId: p.projectId,
              relatedObjects: JSON.stringify({ id: item.assetsId, projectId: p.projectId, type: cfg.label }),
            },
          );
          return cls;
        });
        await aiImage.save(imagePath);
        if (ctx.signal.aborted) throw new Error("被中止（租约丢失或停机）");
        await u.db("o_image").where("id", item.imageId).update({ state: "已完成", filePath: imagePath, type: item.type, model: p.model.split(/:(.+)/)[1], resolution: p.resolution });
        await u.db("o_assets").where("id", item.assetsId).update({ imageId: item.imageId });
      } catch (e) {
        const msg = u.error(e).message;
        if (ctx.signal.aborted) throw new Error(`被中止（租约丢失或停机）：${msg}`);
        await u.db("o_image").where("id", item.imageId).update({ state: "生成失败", errorReason: msg });
        failed.push(`${item.imageId}=${msg}`);
      }
    }
    await ctx.progress(100, "完成");
    if (failed.length) throw new Error(`${failed.length}/${p.items.length} 张图失败：${failed.join("; ")}`);
    return { total: p.items.length };
  },
  async onAbandon(payload, reason) {
    const ids = payload.items.map((i) => i.imageId);
    if (!ids.length) return;
    await u.db("o_image").whereIn("id", ids).andWhere("state", "生成中").update({ state: "生成失败", errorReason: `任务放弃（${reason}）`.slice(0, 1000) });
  },
};

/** `sha1` 小工具（dedupeKey 用；与 videoGenerate 同一手法，不引新依赖）。 */
function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}
