import express from "express";
import { success } from "@/lib/responseFormat";
import u from "@/utils";

const router = express.Router();

/**
 * 前端"AI 开发工具"开关的读端。
 *
 * ⚠ **Phase 1c Task 5**：删掉了 `import initDB from "@/lib/initDB"`（死 import —— 原代码
 *   **只 import、从不调用**，纯粹是 Phase 0 的遗留）。表由迁移负责（spec §5.2），
 *   本接口只读 `o_setting`：**没有这一行就回默认值 `"0"`，不写库**（读接口不该有写副作用）。
 */
export default router.get("/", async (req, res) => {
  const switchAiDevTool = await u.db("o_setting").where("key", "switchAiDevTool").first();
  res.status(200).send(success(switchAiDevTool?.value || "0"));
});
