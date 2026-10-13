import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
const router = express.Router();

// 新增项目
export default router.post(
  "/",
  validateFields({
    projectType: z.string(),
    name: z.string(),
    intro: z.string(),
    type: z.string(),
    artStyle: z.string(),
    videoRatio: z.string(),
    imageModel: z.string(),
    videoModel: z.string(),
    imageQuality: z.string(),
    mode: z.string(),
    // 出海转绘专用；其它项目类型不传
    targetCountry: z.string().optional(),
  }),
  async (req, res) => {
    const { projectType, name, intro, type, artStyle, videoRatio, imageModel, videoModel, imageQuality, mode, targetCountry } = req.body;

    // ⚠ 改动点（Phase 1b / Task 4；修复轮 1 更正）：
    //   · **保留 `id: Date.now()`** —— `o_project.id` 由**代码给**（毫秒值），DDL **没有自增**：
    //     `db/migrations/001_schema.ts` 用 `T.bigInteger("id").unsigned().primary()`，sqlite 落到
    //     `id bigint, … primary key (id)`，它**不是** rowid 别名 ⇒ **允许 NULL**。曾经删掉这一行
    //     （`e3d5886`）实测：插入成功返回 200，但库里 `id = NULL`（`getProject` 原样返回 `"id":null`）；
    //     MySQL 侧同列无 auto_increment ⇒ 严格模式 INSERT 缺列 = ERROR 1364 ⇒ 500。
    //     真自增（`t.pk(T,"id")`）属 Phase 1a **deferred #6**，不在 1b 内做。
    //     判据：`tests/add-project-persist.test.ts`（真 HTTP + 真落库，断言 `id` 非 NULL 且是 number；
    //     把这一行删掉时该用例必红）。
    //   · 删掉 `userId: 1` —— 租户守卫会在 insert 时自动填 `ctx.userId`；显式写 1 会被守卫
    //     判成"写别人的行"而抛错（`tenant-guard.ts` 的注入规则 3）
    await u.db("o_project").insert({
      id: Date.now(),
      projectType,
      name,
      intro,
      type,
      artStyle,
      videoRatio,
      imageModel,
      videoModel,
      createTime: Date.now(),
      imageQuality,
      mode,
      targetCountry: targetCountry ?? null,
    });

    res.status(200).send(success({ message: "新增项目成功" }));
  },
);
