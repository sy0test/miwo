import type { Knex } from "knex";

/**
 * 016_redraw_pipeline：转绘改造 M1/M2 的两列（**不新增表**）。
 *
 *  · `o_project.redrawMaxSegmentSec` —— 转绘项目「单段上限」（秒，缺省 15，4..30）。
 *    解析层与转绘分镜层都以它约束每段时长；放在项目上而不是集上，因为它是"视频模型的单次上限"。
 *  · `o_script.redrawState` —— 转绘的**专用状态机**（见 `src/redraw/state.ts` 的 REDRAW_STATE）。
 *    `extractState` 回归"解析跑没跑完"（0 跑 / 1 成 / 2 等待 / -1 败），不再被转绘层写 3。
 *
 * 回填：旧的「待对账」是 `extractState = 3`（转绘分层设计里"解析完成但没认账"）；新状态机里它对应
 * `redrawState = 1`（PARSED）。只回填 `redrawState = 0` 的行，幂等。
 *
 * **部署行（R1-G3）**：`seed/o_agentDeploy.ndjson` 只在 002 迁移时 insert-if-absent ——
 * **已经迁移过的库不会拿到新 key**，而 M2 的认账会话与 M3 的转绘分镜都靠部署表解析模型。
 * 所以本迁移必须自己补两行：`redrawAgent:reconcileAgent` / `redrawAgent:storyboardAgent`。
 * 判据是 **按 key 判存在**（不硬编码 id）：老库已有同 key 行（运营改过模型）时不动它。
 *
 * `down` 删两列：本轮**没有**任何历史数据必须保留（用户确认测试集重跑），与 015 的 down 同口径。
 */
export default {
  name: "016_redraw_pipeline",

  async up(knex: Knex): Promise<void> {
    // 加列前先判存在：本迁移允许被**手工重跑**（运维在部署窗口里单独 apply 一次是常见操作），
    // 重跑必须幂等 —— 否则第二次会以 "duplicate column name" 失败，而回填那一步根本没机会跑。
    if (!(await knex.schema.hasColumn("o_project", "redrawMaxSegmentSec"))) {
      await knex.schema.alterTable("o_project", (t) => {
        // 缺省 15s：sd2.0 的单次上限。30s 需真机探针通过后才允许选（MIWO_REDRAW_30S_VERIFIED）
        t.integer("redrawMaxSegmentSec").defaultTo(15);
      });
    }
    if (!(await knex.schema.hasColumn("o_script", "redrawState"))) {
      await knex.schema.alterTable("o_script", (t) => {
        t.smallint("redrawState").defaultTo(0);
      });
    }
    // 旧数据的「待对账」（extractState=3）迁进新状态机：
    //  · redrawState 0 → 1（PARSED）；
    //  · **extractState 3 → 1**：spec §4.2 明确 extractState 只保留 0 跑 / 1 成 / 2 等待 / -1 败，
    //    「转绘不再写 3」。不一起改的话，旧库升级后会留下一个"解析态 3"的脏值，
    //    读 extractState 的老代码（前端状态映射、生产链）会看到不该出现的枚举。
    //  只动 redrawState=0（未开始）的行 —— 重复执行不会把已经推进过的状态退回 1。
    await knex("o_script")
      .where("extractState", 3)
      .andWhere((w) => w.whereNull("redrawState").orWhere("redrawState", 0))
      .update({ redrawState: 1, extractState: 1 });

    // ---- 部署行（R1-G3）：按 key 判存在，老库也能拿到；不硬编码 id ----
    const deployRows = [
      {
        key: "redrawAgent:reconcileAgent",
        model: "gpt-6.1-sol",
        modelName: "newapi:gpt-6.1-sol",
        vendorId: "newapi",
        name: "转绘Agent:认账",
        desc: "转绘资产认账会话：按「剧本 → 资产 → 时长」推进，所有决定落库",
        temperature: 1,
        maxOutputTokens: 0,
        disabled: 0,
      },
      {
        key: "redrawAgent:storyboardAgent",
        model: "gpt-6.1-sol",
        modelName: "newapi:gpt-6.1-sol",
        vendorId: "newapi",
        name: "转绘Agent:分镜",
        desc: "转绘分镜层：把源片分镜改写成目标国版分镜（并出变更摘要）",
        temperature: 1,
        maxOutputTokens: 0,
        disabled: 0,
      },
    ];
    for (const row of deployRows) {
      const hit = await knex("o_agentDeploy").where("key", row.key).first();
      if (!hit) await knex("o_agentDeploy").insert(row);
    }
  },

  async down(knex: Knex): Promise<void> {
    // 先删本迁移补的部署行（这两个 key 是本迁移引入的，回滚时一起走）
    await knex("o_agentDeploy").whereIn("key", ["redrawAgent:reconcileAgent", "redrawAgent:storyboardAgent"]).del();
    await knex.schema.alterTable("o_script", (t) => {
      t.dropColumn("redrawState");
    });
    await knex.schema.alterTable("o_project", (t) => {
      t.dropColumn("redrawMaxSegmentSec");
    });
  },
};