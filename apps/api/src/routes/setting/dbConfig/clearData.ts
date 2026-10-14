import express from "express";
import { success, error } from "@/lib/responseFormat";
import { systemDb as db } from "@/utils/db"; // 实例级运维（整库/动态表名）：租户条件无法限定 ⇒ 显式走唯一绕过口
import { requireAdmin } from "@/middleware/tenant"; // Phase 1b Task 7：运维接口收权（无 ctx 401 / 非 admin 403）
import { dropAllTables, listTables, setForeignKeys } from "@/lib/dbOps";
import { runMigrations } from "@/db/migrations";
import { opsDisabledMessage, opsEnabled } from "@/utils/opsSwitch";
import { AUDIT_ACTIONS, actorFromCtx, audit } from "@/utils/audit";

const router = express.Router();

/**
 * 清空整库并**重建表结构**。
 *
 * ⚠ Phase 1c Task 4：在 1b 的 `requireAdmin` 之上再加 **默认关闭**（`allowDbAdminOps`）+ **审计**。
 *   spec §7.3 对破坏性运维接口的要求就是这三件套；`clearData` 是其中破坏面最大的一个
 *   （drop 全库 + 重建 ⇒ 所有租户数据一次性消失）。
 *
 * ⚠ **Phase 1c Task 5+6 的两处重写**（裁定 §2.5 —— Task 4 登记为"已知未修"，本任务收口）：
 *   1. **跨方言**：表清单与关/开外键改走 `@/lib/dbOps`
 *      （`information_schema` / `SET FOREIGN_KEY_CHECKS`）。旧写法 `sqlite_master` + `PRAGMA`
 *      在 MySQL 上**整片不可用**（表不存在 / 语法错）；
 *   2. **重建表结构改走迁移**（原来的 `initDB(db)` 已在 Task 5 随死代码删除）。
 *      `runMigrations` 是**唯一**的建表真相（spec §5.2），且它幂等：迁移记账表 `knex_migrations`
 *      不在被删清单里（见 `dbOps.listTablesSql` 的 `knex_%` 排除），所以已执行过的迁移会被跳过、
 *      只补跑"表被删掉之后缺的那些"。
 *
 * ⚠ 表结构**只重建，不重新种子**：`002_platform_seed` 等**已执行过**的迁移名字仍在
 *   `knex_migrations` 里 ⇒ 种子不会重跑。这是**有意**的：重跑种子会把用户在
 *   `o_setting` / `o_agentDeploy` 上的运维配置悄悄改回去。要全新库请用停机脚本重来。
 */
export default router.get("/", requireAdmin, async (req, res) => {
  const ctx = actorFromCtx(req.ip);
  try {
    // 闸二：默认关闭
    if (!(await opsEnabled("allowDbAdminOps"))) {
      await audit(ctx, AUDIT_ACTIONS.DB_CLEAR, "rejected:ops-disabled", { ok: false });
      return res.status(403).send(error(opsDisabledMessage()));
    }

    // 获取所有表名（**跨方言**：sqlite_master / information_schema，见 lib/dbOps.ts）
    const tables = await listTables(db);

    // 禁用外键约束 → 逐一删表（**跨方言**：PRAGMA / SET FOREIGN_KEY_CHECKS）→ 恢复
    await setForeignKeys(db, false);
    try {
      await dropAllTables(db, tables);
    } finally {
      await setForeignKeys(db, true);
    }

    // 重建表结构（唯一真相 = 迁移；不再调用已删除的 initDB）
    const [, applied] = await runMigrations(db);

    await audit(ctx, AUDIT_ACTIONS.DB_CLEAR, "all-tables", { droppedTables: tables.length, remigrated: applied });
    res.status(200).send(success("数据库已清空并重新初始化"));
  } catch (err: any) {
    await audit(ctx, AUDIT_ACTIONS.DB_CLEAR, "failed", { message: String(err?.message ?? err) });
    res.status(500).send(error(err?.message || "清除失败"));
  }
});
