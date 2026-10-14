import express from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
const router = express.Router();

export default router.post("/", async (req, res) => {
  // ⚠ MySQL 必坏点修复：原 `select("id","name").groupBy("name")` 在 MySQL 8 的 `ONLY_FULL_GROUP_BY` 下是 `ER_1055`
  //   （`id` 既不在 GROUP BY 里也不是聚合）⇒ 该接口在 MySQL 上 500。改成"**每个 name 一行**"的合法写法，
  //   与原语义一致（sqlite 原来也是每个 name 回一行、id 任取；这里取 `min(id)` 让它**确定**）。
  const list = await u.db("o_project").select("name").min("id as id").groupBy("name");
  const data = list.filter((item) => item.name);
  res.status(200).send(success(data));
});
