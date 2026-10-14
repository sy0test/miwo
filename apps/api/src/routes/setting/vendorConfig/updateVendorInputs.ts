import express from "express";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import u from "@/utils";
import { z } from "zod";
import { requireAdmin } from "@/middleware/tenant";
import { audit, AUDIT_ACTIONS, actorFromCtx } from "@/utils/audit";

// Phase 1c Task 8：删掉了 `import { transform } from "sucrase"` —— 本文件从没执行过提交的代码
//   （它只是写 DB 一行 `inputValues`），但**沙箱入口就挂在这一族路由上**，Task 8/9 一并收口。
// Phase 1c Task 9：写供应商凭据是**平台资产的变更** ⇒ 落 `o_auditLog`。
//   ⚠ `detail` 里**只记键名**（`keys: ["apiKey","baseUrl"]`），绝不记值 —— 见 `utils/audit.ts` 文件头。
const router = express.Router();

export default router.post(
  "/",
  validateFields({
    id: z.string(),
    inputValues: z.record(z.string(), z.string()),
  }),
  requireAdmin,
  async (req, res) => {
    const { id, inputValues } = req.body;

    await u
      .db("o_vendorConfig")
      .where("id", id)
      .update({
        inputValues: JSON.stringify(inputValues),
      });
    // 响应**不回显**任何输入值（改前回的是 `success("更新成功")` 这种固定文案；
    // 这条断言由 tests/vendor-secrets.test.ts 的"响应体不含 sk-"守住）。
    await audit(actorFromCtx(req.ip), AUDIT_ACTIONS.VENDOR_INPUTS_UPDATE, String(id), {
      keys: Object.keys(inputValues ?? {}),
    });
    res.status(200).send(success("更新成功"));
  },
);
