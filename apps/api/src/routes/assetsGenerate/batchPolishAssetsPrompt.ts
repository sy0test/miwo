import express from "express";
import { currentAiBillingContext } from "@/billing/context";
import u from "@/utils";
import pLimit from "p-limit";
import * as zod from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import type { AssetKind } from "@/utils/feicai";
import { apiHolderId, withVendorSlot } from "@/jobs/gate";
const router = express.Router();
interface OutlineItem {
  description: string;
  name: string;
}

interface OutlineData {
  chapterRange: number[];
  characters?: OutlineItem[];
  props?: OutlineItem[];
  scenes?: OutlineItem[];
}

interface NovelChapter {
  id: number;
  reel: string;
  chapter: string;
  chapterData: string;
  projectId: number;
}

type ItemType = "characters" | "props" | "scenes";

//润色提示词
export default router.post(
  "/",
  validateFields({
    items: zod.array(
      zod.object({
        assetsId: zod.number(),
        type: zod.string(),
        name: zod.string(),
        describe: zod.string(),
      }),
    ),
    projectId: zod.number(),
    concurrentCount: zod.number().int().min(1).max(8).optional(), //并发数（spec §9.3：上限 8，超限在 validateFields 阶段 400 —— Phase 1d F8 收口）
    otherTextPrompt: zod.string(),
  }),
  async (req, res) => {
    const { projectId, items, concurrentCount, otherTextPrompt } = req.body;
    //获取风格
    const project = await u.db("o_project").where("id", projectId).select("artStyle", "videoRatio", "type", "intro").first();
    //如果没有找到对应的项目，返回错误
    if (!project) return res.status(500).send(success({ message: "项目为空" }));

    // 预加载公共数据
    const assetsIds = items.map((item: { assetsId: number }) => item.assetsId);
    //查询所有资产，用于判断每个资产是否是衍生资产
    const assetsDataList = await u.db("o_assets").whereIn("id", assetsIds).select("id", "assetsId");
    if (!assetsDataList || assetsDataList.length === 0) return res.status(500).send(error("资产不存在"));
    const assetsDataMap = new Map(assetsDataList.map((a: any) => [a.id, a]));
    //预加载父级资产的提示词，供衍生资产保持造型延续性
    const parentIds = [...new Set(assetsDataList.map((a: any) => a.assetsId).filter((id: any) => id !== null && id !== undefined))];
    const parentPromptMap = new Map<number, string>();
    if (parentIds.length) {
      const parents = await u.db("o_assets").whereIn("id", parentIds as number[]).select("id", "prompt", "describe");
      parents.forEach((p: any) => parentPromptMap.set(p.id, p.prompt || p.describe || ""));
    }
    // 所有前置检测通过后，再批量更新状态为生成中
    await u.db("o_assets").whereIn("id", assetsIds).update({ promptState: "生成中" });

    const typeConfig: Record<string, { promptKey: string; itemType: ItemType; label: string; nameLabel: string }> = {
      role: {
        promptKey: "role-polish",
        itemType: "characters",
        label: "角色标准四视图",
        nameLabel: "角色",
      },
      scene: {
        promptKey: "scene-polish",
        itemType: "scenes",
        label: "场景图",
        nameLabel: "场景",
      },
      tool: {
        promptKey: "tool-polish",
        itemType: "props",
        label: "道具图",
        nameLabel: "道具",
      },
    };

    const limit = pLimit(concurrentCount ?? 1);
    const tasks = items.map((item: { assetsId: number; type: string; name: string; describe: string }) =>
      limit(async () => {
        const fail = async (reason: string) => {
          await u.db("o_assets").where("id", item.assetsId).update({ promptState: "生成失败", promptErrorReason: reason });
        };
        const assetData = assetsDataMap.get(item.assetsId);
        if (!assetData) return;
        const config = typeConfig[item.type];
        if (!config) {
          await fail(`不支持的素材类型: ${item.type}`);
          return;
        }

        try {
          const systemPrompt = u.feicai.buildAssetPromptSystem({
            project,
            kind: item.type as AssetKind,
            parentDescribe: assetData.assetsId ? parentPromptMap.get(assetData.assetsId) : null,
          });
          if (!systemPrompt) {
            await fail("服化道技能未就绪");
            return;
          }

          const { _output } = (await withVendorSlot("vendor:text", apiHolderId(), () =>
            u.Ai.Text("universalAi", currentAiBillingContext()).invoke({
              system: systemPrompt + "\n" + otherTextPrompt,
              messages: [
                {
                  role: "user",
                  content: `
                    **基础参数：**
      **${config.nameLabel}设定：**
      - ${config.nameLabel}名称:${item.name},
      - ${config.nameLabel}描述:${item.describe},`,
                },
              ],
            }),
          )) as any;

          if (!_output) {
            await fail("模型未返回提示词");
            return;
          }

          // 角色/道具白底资产：提示词落库前补上不透明纯白画布声明（scene 原样）
          const assetPrompt = u.feicai.withOpaqueWhiteCanvas(_output, item.type);
          await u.db("o_assets").where("id", item.assetsId).update({ prompt: assetPrompt, promptState: "已完成", promptErrorReason: null });
        } catch (e: any) {
          await fail(u.error(e).message);
        }
      }),
    );

    try {
      await Promise.all(tasks);
    } catch (err: any) {
      return res.status(500).send(error(err));
    }

    return res.status(200).send(success({ total: items.length }));
  },
);
