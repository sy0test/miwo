import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { requireTenantCtx } from "@/db/tenant-context";
import { buildIsolationKey } from "@/socket/tenant";
const router = express.Router();

function normalizeRole(role?: string | null): "user" | "assistant" {
  return role?.startsWith("assistant") ? "assistant" : "user";
}

export default router.post(
  "/",
  validateFields({
    projectId: z.number(),
    agentType: z.enum(["scriptAgent", "productionAgent"]),
    episodesId: z.number().optional(),
  }),
  async (req, res) => {
    const { projectId, agentType, episodesId } = req.body;
    // ⚠ Phase 1b / Task 5：键由**服务端**拼，且格式与 socket 侧**逐字符相同**
    //    （唯一真相 = `@/socket/tenant` 的 `buildIsolationKey`：`${userId}:${projectId}:${agentType}[:episodesId]`）。
    //    只改 socket 侧会让这里静默读不到（`tests/socket-tenant.test.ts` §C 用行为断言钉住这条合同）。
    const isolationKey = buildIsolationKey(requireTenantCtx(), projectId, agentType, episodesId);

    const rows = await u
      .db("memories")
      .where({ isolationKey, type: "message" })
      .orderBy("createTime", "asc")
      .select("id", "role", "name", "content", "createTime");

    const history = rows.map((row) => ({
      id: row.id,
      role: normalizeRole(row.role),
      name: row.name ?? undefined,
      status: "complete",
      datetime: new Date(row.createTime).toISOString(),
      content: [{ type: "markdown", status: "complete", data: row.content }],
      createTime: row.createTime,
    }));

    res.status(200).send(success(history));
  },
);
