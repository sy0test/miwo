import type { Knex } from "knex";

/**
 * 015_redraw_v2：转绘写入口径从 legacy（`o_storyboard` / `o_videoTrack`）迁到 v2 结构化分镜
 * （`o_segment` / `o_shot` / `o_shotAssets`）时，v2 缺的三列。
 *
 * 为什么需要（2026-10-21 决策：转绘「彻底迁 v2」）：
 *   · v2 的 `o_segment` 是"片段 = 生成单位"，但转绘要按**片段**切原片作参考视频 ⇒ 需要 `clipPath`；
 *     切片的依据是该片段覆盖的源片区间 ⇒ 需要 `sourceRange`（多段用 ` + ` 连接，与解析产物同形）。
 *   · `o_shot` 没有源片区间列，而转绘的每一镜都要能核对"这一镜取自原片哪一段" ⇒ 需要 `sourceRange`。
 *
 * 刻意**不加**的列（用户口径）：
 *   · 镜级「画面描述」列：转绘的展示/生成单位是**片段**，整段描述写进 `o_segment.videoDesc`
 *     （12 槽位格式，见 `utils/redraw.ts` 的 composeSegmentVideoDesc），不拆到镜级。
 *   · 镜级「原台词」列：原台词只用于「台词对照表」（`dialogue-map.md` 产物），不参与生成。
 *
 * 三列都是非索引 text（MySQL → longtext），不触发「TEXT 不能进索引」那条限制。
 */
export default {
  name: "015_redraw_v2",

  async up(knex: Knex): Promise<void> {
    await knex.schema.alterTable("o_segment", (t) => {
      t.text("sourceRange"); // 该片段覆盖的源片区间（`起-止` 或 `起-止 + 起-止`）
      t.text("clipPath"); // 按 sourceRange 切出来的原片参考片段（OSS 相对路径）
    });
    await knex.schema.alterTable("o_shot", (t) => {
      t.text("sourceRange"); // 该镜的源片区间（展示/核对用；切原片按片段做）
    });
  },

  async down(knex: Knex): Promise<void> {
    await knex.schema.alterTable("o_shot", (t) => {
      t.dropColumn("sourceRange");
    });
    await knex.schema.alterTable("o_segment", (t) => {
      t.dropColumn("clipPath");
      t.dropColumn("sourceRange");
    });
  },
};
