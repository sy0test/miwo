import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireTenantCtx } from "@/db/tenant-context";
import { buildIsolationKey } from "@/socket/tenant";
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    episodesId: z.number().optional(),
    agentType: z.enum(["scriptAgent", "productionAgent"]),
    type: z.enum(["message", "summary", "all"]).optional(),
  }),
  async (req, res) => {
    const { projectId, episodesId,agentType, type = "all" } = req.body;
    // ⚠ Phase 1b / Task 5：与 socket 侧**同一把键**（唯一真相 = `@/socket/tenant` 的 `buildIsolationKey`）。
    //    不同步这里 ⇒ 清记忆会**静默清不掉**（不报错，比抛错更坏）。
    const isolationKey = buildIsolationKey(requireTenantCtx(), projectId, agentType, episodesId);

    if (type === "all") {
      await u.db("memories").where({ isolationKey }).del();
    } else if (type === "message") {
      // 删 message 时同步删关联的 summary，避免悬挂引用
      await u.db("memories").where({ isolationKey, type: "message" }).del();
      await u.db("memories").where({ isolationKey, type: "summary" }).del();
    } else {
      // 删 summary 时将关联的 message 重置为未总结，使其重新进入 shortTerm
      await u
        .db("memories")
        .where({ isolationKey, type: "message", summarized: 1 })
        .update({ summarized: 0 });
      await u.db("memories").where({ isolationKey, type: "summary" }).del();
    }

    res.status(200).send(success(null));
  },
);
