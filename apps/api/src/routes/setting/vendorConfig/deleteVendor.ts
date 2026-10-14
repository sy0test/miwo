import express from "express";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import { requireAdmin } from "@/middleware/tenant";
import { audit, AUDIT_ACTIONS, actorFromCtx } from "@/utils/audit";

// Phase 1c Task 8：`fs.rmSync(path.join(u.getPath("vendor"), `${id}.ts`))` **整段删除** ——
//   适配器已编译期内置（`src/vendors/*.ts` 是真源码，不是用户目录里的可写资产），
//   运行时**不存在**可删的适配器文件 ⇒ 路径穿越面**由构造消除**（spec Tier 0 #4 的原文），
//   不是"加了一道路径校验"。
// Phase 1c Task 9：`id` 仍收成白名单正则（**纵深防御**）—— 即使将来又有人写出按 id 拼路径的
//   代码，`../` / 绝对路径 / UNC / 大小写变体都进不来。正常供应商 id（`miwo` / `volcengineSd2`）
//   全部匹配这个模式。
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/i, "供应商 id 只允许字母、数字、下划线与连字符（1–64 位）"),
  }),
  requireAdmin,
  async (req, res) => {
    const { id } = req.body;
    await u.db("o_vendorConfig").where("id", id).del();
    await u.db("o_agentDeploy").where("vendorId", id).update({
      model: null,
      vendorId: null,
    });
    await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.VENDOR_DELETE, String(id), null);
    res.status(200).send(success("删除成功"));
  },
);
