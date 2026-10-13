import express from "express";
import initDB from "@/lib/initDB";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）
import { success } from "@/lib/responseFormat";
const router = express.Router();

// 清空数据表
// ⚠ Phase 1b Task 7：本接口**必须**挂 `requireAdmin`。收权前它是"任意登录用户的 token 一条 POST 就能整库清空"
//   （Ruling 207，本阶段最该收口的一条）；它走 `systemDb`（唯一绕过口、实例级运维，不做租户过滤）。
//   已知遗留（登记，未在本任务修）：`initDB(db, true)` 会在第一张表上抛 `database is locked` ⇒ 本接口当前 500 且不生效。
export default router.post(
    "/",
    requireAdmin,
    async (req, res) => {
        await initDB(db, true);
        res.status(200).send(success({ message: "清空数据表成功" }));
    },
);
