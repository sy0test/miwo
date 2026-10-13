import express from "express";
import { requireAdmin } from "@/middleware/tenant"; // 保留：停用后也不让它变成"未鉴权即可探测"的端点

const router = express.Router();

/**
 * 停用文案（导出常量便于用例精确断言"是**停用**而不是**报错**"）。
 * 对外的信息量：① 能力已停用；② 归属到本阶段（Phase 1b Task 7）；③ 给运维一条**正确**的出路。
 */
export const DELETE_ALL_DATA_DISABLED_MESSAGE =
  "整库清空能力已停用（Phase 1b Task 7）。如需清库，请用离线工具（与 scripts/backfill-userid.ts 同款的目标护栏 + dry-run 口径）在停机窗口里做，勿走 HTTP。";

/**
 * `POST /api/other/deleteAllData` —— **整库清空，Phase 1b Task 7 起无条件停用（501）**。
 *
 * ⚠ **不是"修不好"，是"不该让它活着"**：
 *   · 收权前它是"任意登录用户的 token 一条 POST 就能整库清空"（Ruling 207）；
 *   · 实测它当前**本来就不生效**：`initDB(db, true)` 在**第一张表** `o_user` 上抛
 *     ``drop table `o_user` - database is locked``（BEFORE/AFTER 表与行数完全不变）⇒ 500；
 *   · **修好它 = 把最危险的操作从"坏的"变成"活的"** —— 让一条 HTTP 真能清空 20 张租户表；
 *     而"清库"是**停机窗口 + 离线 + 先备份**的动作，它**不该**有一个 HTTP 入口。
 *
 * 所以这里**无条件 501**（连 admin 也拿 501）：
 *   · 保留文件与路由挂载（删掉会让 `check-copy` 的构件断言、`check-dead-ddl` 的依赖图、
 *     `tenant-exceptions.json` 的条目一起漂；**停用**在行为上等价于删掉，却零波及）；
 *   · 保留 `requireAdmin`：未登录/普通用户先吃到 401/403，**不**给"探测这个端点存不存在"的免费信息；
 *   · 本文件因此**不再 import `initDB` / `systemDb`**（零 DB 访问面）⇒ bypass 使用者 7 → 6。
 *
 * 登记（Phase 1c/2 决策项）：**"修好（带审计/双人确认/离线凭据体系）"还是"彻底删除"** —— 等运维凭据
 * 体系齐了再定；在那之前，"坏的、停用的"就是**正确的**状态。
 */
export default router.post("/", requireAdmin, async (_req, res) => {
  res.status(501).send({ code: 501, message: DELETE_ALL_DATA_DISABLED_MESSAGE });
});
