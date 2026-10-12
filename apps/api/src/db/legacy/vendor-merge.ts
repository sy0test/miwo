/**
 * 供应商数据 id 的**合并**迁移（把 Phase 0 deferred 的"UPDATE 撞主键"缺陷修掉）。
 *
 * 语义（三态，都是幂等的）：
 *   A. 只有旧行            → 直接改 id（保留 inputValues/models/enable）
 *   B. 旧行与目标行都缺     → 什么都不做
 *   C. 旧行与目标行都在     → 删旧行（把旧行的 enable 合并进目标行的 enable，只取"更启用"的那个）
 *
 * C 是 Phase 0 会抛错的场景：真实库里 fixDB 的 tempOnsert 回插过 `toonflow` 行，
 * 而新装/已迁移的库里已有 `miwo` 行。
 *
 * ⚠ 为什么不能简单 `DELETE` 旧行：旧行可能开着 enable=1（用户配过 key），
 *    直接删会让"供应商被莫名禁用"。所以取 max(enable)。
 *
 * ⚠ 与 `apps/api/scripts/migrate-vendor-id.cjs` 的关系：那个脚本用的是
 *    `UPDATE o_vendorConfig SET id='miwo' WHERE id='toonflow'`，**目标行已存在时会撞主键抛错**；
 *    它现在只保留给 sqlite dev 库的历史一次性迁移，并在 apply 前显式检测冲突后拒绝执行。
 */
import type { Knex } from "knex";

export interface VendorMergeResult {
  action: "renamed" | "merged" | "noop";
  /** 目标行最终是否启用（1/0），便于 CLI 打印 */
  targetEnable?: number;
}

export async function mergeVendorId(
  knex: Knex,
  opts: { oldId?: string; newId?: string; apply?: boolean } = {},
): Promise<VendorMergeResult> {
  const oldId = opts.oldId ?? "toonflow";
  const newId = opts.newId ?? "miwo";
  const apply = opts.apply ?? true;

  // ⚠ `knex.schema.hasTable(...)` 返回的是**可 await 的 QueryBuilder**（永远是真值），
  //    写成 `hasTable(x) ? ... : ...` 的三元会**永远走前者** → 空库上直接抛
  //    `no such table`。必须 await 成布尔值。（brief Step 4 的原始一行就是这个坑，
  //    Step 6 的「表不存在时不炸」用例正是它的判别力来源。）
  if (!(await knex.schema.hasTable("o_vendorConfig"))) return { action: "noop" };

  const oldRow = await knex("o_vendorConfig").where("id", oldId).first();
  if (!oldRow) return { action: "noop" };

  const newRow = await knex("o_vendorConfig").where("id", newId).first();
  if (!newRow) {
    if (apply) await knex("o_vendorConfig").where("id", oldId).update({ id: newId });
    return { action: "renamed" };
  }

  const targetEnable = Math.max(Number(oldRow.enable) || 0, Number(newRow.enable) || 0);
  if (apply) {
    await knex.transaction(async (trx) => {
      await trx("o_vendorConfig").where("id", oldId).del();
      await trx("o_vendorConfig").where("id", newId).update({ enable: targetEnable });
    });
  }
  return { action: "merged", targetEnable };
}

/** 顺带把 o_agentDeploy.vendorId 上的旧 id 一起改（Phase 0 的脚本也做了这件事）。 */
export async function mergeAgentDeployVendorId(
  knex: Knex,
  opts: { oldId?: string; newId?: string; apply?: boolean } = {},
): Promise<number> {
  const oldId = opts.oldId ?? "toonflow";
  const newId = opts.newId ?? "miwo";
  const apply = opts.apply ?? true;
  if (!(await knex.schema.hasTable("o_agentDeploy"))) return 0;
  const rows = await knex("o_agentDeploy").where("vendorId", oldId).select("id");
  if (!rows.length) return 0;
  if (apply) await knex("o_agentDeploy").where("vendorId", oldId).update({ vendorId: newId });
  return rows.length;
}

void (async () => {
  // 允许当 CLI 用：node --import=tsx src/db/legacy/vendor-merge.ts [--apply]
  if (require.main !== module) return;
  const { config } = await import("@/config");
  const { createKnex, describeTarget } = await import("@/db/connect");
  const apply = process.argv.includes("--apply");
  const db = createKnex(config);
  try {
    console.log(`[vendor-merge] 目标：${describeTarget(config)}（${apply ? "APPLY" : "DRY-RUN"}）`);
    const r = await mergeVendorId(db, { apply });
    const n = await mergeAgentDeployVendorId(db, { apply });
    console.log(`[vendor-merge] o_vendorConfig: ${r.action}${r.targetEnable !== undefined ? ` (enable=${r.targetEnable})` : ""}`);
    console.log(`[vendor-merge] o_agentDeploy: ${n} 行`);
  } finally {
    await db.destroy();
  }
})();
