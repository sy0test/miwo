import express from "express";
import { currentAiBillingContext } from "@/billing/context";
import u from "@/utils";
import * as zod from "zod";
import { error, success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { withVendorSlot, apiHolderId } from "@/jobs/gate";
import type { AssetKind } from "@/utils/feicai";
const router = express.Router();


type ItemType = "characters" | "props" | "scenes";

//润色提示词
export default router.post(
  "/",
  validateFields({
    assetsId: zod.number(),
    projectId: zod.number(),
    type: zod.string(),
    name: zod.string(),
    describe: zod.string(),
  }),
  async (req, res) => {
    const { assetsId, projectId, type, name, describe } = req.body;
    //获取风格
    const project = await u.db("o_project").where("id", projectId).select("artStyle", "videoRatio", "type", "intro", "targetCountry").first();
    //如果没有找到对应的项目，返回错误
    if (!project) return res.status(500).send(success({ message: "项目为空" }));

    await u.db("o_assets").where("id", assetsId).update({ promptState: "生成中" });

    //查询资产是否是衍生资产
    const assetsData = await u.db("o_assets").where("id", assetsId).select("assetsId").first();
    if (!assetsData) return { code: 500, message: "资产不存在" };
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

    const config = typeConfig[type];
    if (!config) return res.status(500).send(error("不支持的类型"));

    //衍生资产取父级描述，用于保持造型延续性
    let parentDescribe: string | null = null;
    if (assetsData.assetsId) {
      const parent = await u.db("o_assets").where("id", assetsData.assetsId).select("describe", "prompt").first();
      parentDescribe = parent?.prompt || parent?.describe || null;
    }

    const systemPrompt = u.feicai.buildAssetPromptSystem({
      project,
      kind: type as AssetKind,
      parentDescribe,
    });
    if (!systemPrompt) return res.status(500).send(error("服化道技能未就绪"));
    try {
      // Phase 1d Task 9：厂商调用前过全局闸门（spec §9.3）。响应形态不变。
      const { _output } = (await withVendorSlot("vendor:text", apiHolderId(), () =>
        u.Ai.Text("universalAi", currentAiBillingContext()).invoke({
        system: systemPrompt,
        messages: [
          {
            role: "user",
            content: `**基础参数：**
      **${config.nameLabel}设定：**
      - ${config.nameLabel}名称:${name},
      - ${config.nameLabel}描述:${describe},`,
          },
        ],
      }),
      )) as any;

      if (!_output) return res.status(500).send("失败");
      // 角色/道具白底资产：提示词落库前补上不透明纯白画布声明（scene 原样）
      const assetPrompt = u.feicai.withOpaqueWhiteCanvas(_output, type);
      await u.db("o_assets").where("id", assetsId).update({ prompt: assetPrompt, promptState: "已完成" });

      res.status(200).send(success({ prompt: assetPrompt, assetsId }));
    } catch (e: any) {
      await u
        .db("o_assets")
        .where("id", assetsId)
        .update({ promptState: "失败", promptErrorReason: u.error(e).message });
      return res.status(500).send(error(e?.data?.error?.message ?? e?.message ?? "生成失败"));
    }
  },
);
