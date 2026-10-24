import express from "express";
import u from "@/utils";
import { z } from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { enqueueJobInTransaction } from "@/jobs";
import { currentUserId } from "@/jobs/context";
import { submitBilledJob } from "@/billing/submit";
import { resolveSubmissionEstimate } from "@/billing/estimate";

const router = express.Router();

type AssetType = "role" | "scene" | "tool";

interface AssetTypeConfig {
  label: string;
  taskClass: string;
  dir: string;
  promptTitle: string;
  promptEnd: string;
}

const assetTypeConfig: Record<AssetType, AssetTypeConfig> = {
  role: {
    label: "角色",
    taskClass: "角色图生成",
    dir: "role",
    promptTitle: "角色设定图",
    promptEnd: "角色设定图（左侧面部特写 + 中间竖椭圆形人相框特写 + 右侧全身正/侧/背三视图，纯白背景，不得添加其它图块）",
  },
  scene: {
    label: "场景",
    taskClass: "场景图生成",
    dir: "scene",
    promptTitle: "标准场景图",
    promptEnd: "标准场景图",
  },
  tool: {
    label: "道具",
    taskClass: "道具图生成",
    dir: "props",
    promptTitle: "标准道具图",
    promptEnd: "标准道具图",
  },
};

function buildPrompt(cfg: AssetTypeConfig, artStyle: string, name: string, prompt: string): string {
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

const requestSchema = {
  projectId: z.number(),
  model: z.string(),
  resolution: z.string(),
  concurrentCount: z.number().int().min(1).max(8).optional(),
  items: z.array(
    z.object({
      id: z.number(),
      type: z.enum(["role", "scene", "tool", "storyboard"]),
      name: z.string(),
      prompt: z.string(),
      base64: z.string().optional().nullable(),
    }),
  ),
};

export default router.post("/", validateFields(requestSchema), async (req, res) => {
  const { projectId, model, resolution, concurrentCount, items } = req.body;

  // 1. 查询项目
  const project = await u.db("o_project").where("id", projectId).select("artStyle", "type", "intro").first();
  if (!project) return res.status(500).send(error("项目为空"));

  // 2. Create placeholder rows, enqueue, and freeze in one transaction.
  const userId = currentUserId(req);
  if (userId === null) return res.status(401).send(error("未登录或会话已失效"));
  const estimateMicro = await resolveSubmissionEstimate(u.db as any, model, "image", items.length);
  const submitted = await submitBilledJob({
    db: u.db as any,
    userId,
    estimateMicro,
    idempotencyKey: `job:${userId}:image.assets.batch:${projectId}:${items.map((item: { id: number }) => item.id).join(",")}`,
    createBusinessRows: async (trx) => {
      const imageIds: number[] = [];
      for (const item of items) {
        const [imageId] = await trx("o_image").insert({ type: item.type, state: "生成中", assetsId: item.id });
        await trx("o_assets").where("id", item.id).update({ imageId });
        imageIds.push(Number(imageId));
      }
      return { imageIds };
    },
    resolveExistingBusiness: async (trx, existingJobId) => {
      const existing = await trx("o_job").where({ id: existingJobId }).first();
      const payload = JSON.parse(existing.payload) as { items: Array<{ imageId: number }> };
      return { imageIds: payload.items.map((item) => item.imageId) };
    },
    enqueue: async (trx, business) => enqueueJobInTransaction(trx, {
      type: "image.assets.batch", userId,
      payload: {
        projectId, model, resolution,
        items: items.map((item: { id: number; type: string; name: string; prompt: string }, index: number) => ({
          assetsId: item.id, imageId: business.imageIds[index], type: item.type, name: item.name, prompt: item.prompt,
        })),
      },
    }),
  });

  return res.status(200).send({ ...success({ total: items.length }), jobIds: [submitted.jobId] });
});
