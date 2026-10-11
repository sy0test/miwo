import express from "express";
import u from "@/utils";
import { z } from "zod";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/middleware/middleware";
import { readShotsEngine } from "@/utils/shots/readShots";

/**
 * 切换结构化分镜的开关（**建议用它，而不是直连 sqlite 改库**）。
 *
 * 直连 sqlite 改 `o_setting` 会和正在运行的 App 抢锁（WAL 下也不是完全没风险）；
 * 走这个接口就是走 App 自己的连接，写完立刻生效（读取端每次都现查设置）。
 *
 * 请求：
 *   { shotsEngine?: "v2" | "legacy" }      // 切读取/写入路径（默认 legacy）
 *   { shotsAutoRepair?: "0" | "1" }        // 是否让阶段4 之后自动按行修复（默认关）
 * 语义：**upsert**，只改传了的键。
 *
 * 回滚：{ shotsEngine: "legacy" } 即可 —— 旧表数据从未被 v2 写过，所以立刻回到旧行为。
 */
export default express.Router().post(
  "/",
  validateFields({
    shotsEngine: z.enum(["v2", "legacy"]).optional(),
    shotsAutoRepair: z.enum(["0", "1"]).optional(),
  }),
  async (req, res) => {
    const { shotsEngine, shotsAutoRepair } = req.body as { shotsEngine?: string; shotsAutoRepair?: string };
    const upsert = async (key: string, value: string) => {
      const exist = await u.db("o_setting").where("key", key).first();
      if (exist) await u.db("o_setting").where("key", key).update({ value });
      else await u.db("o_setting").insert({ key, value });
    };
    if (shotsEngine) await upsert("shotsEngine", shotsEngine);
    if (shotsAutoRepair) await upsert("shotsAutoRepair", shotsAutoRepair);

    const current = await readShotsEngine(u.db);
    const repairRow = await u.db("o_setting").where("key", "shotsAutoRepair").first();
    console.log(`[shots/setEngine] 已切换：shotsEngine=${current} shotsAutoRepair=${repairRow?.value ?? "(未设置)"}`);
    return res.status(200).send(success({ shotsEngine: current, shotsAutoRepair: repairRow?.value ?? null }));
  },
);
