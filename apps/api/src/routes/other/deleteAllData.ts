import express from "express";
import initDB from "@/lib/initDB";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { success } from "@/lib/responseFormat";
const router = express.Router();

// 清空数据表
export default router.post(
    "/",
    async (req, res) => {
        await initDB(db, true);
        res.status(200).send(success({ message: "清空数据表成功" }));
    },
);
