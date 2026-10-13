/**
 * `userId` 回填 + `memories` 旧键回填（spec §6.2 / §14 R5；Phase 1b Task 6）。
 *
 * 三条硬约束：
 *  1. **零 raw SQL**：全部用 knex query builder → sqlite（本机回归网）与 MySQL（生产）跑同一份代码，
 *     不需要写两套 UPDATE…JOIN。代价是"批量 UPDATE 的条数受行数影响"，对一次性迁移完全可接受
 *     （真实快照实测量级：memories 92 行，最大单表 926 行）。
 *  2. **幂等**：只处理 `userId IS NULL` 的行；`memories.isolationKey` 的改写判据是"首段已经是该行 userId"。
 *  3. **归属链全部收敛到 `projectId → o_project.userId`**：所以回填与表顺序无关
 *     （`o_script.projectId` / `o_shot.projectId` / `o_assets.projectId` …都是直接列），
 *     只有两处特殊：`o_event`（无归属列，经 `o_eventChapter → o_novel`）与
 *     `o_imageFlow`（主链 `o_assets.flowId` 可能断 → `flowData` 路径首段兜底）。
 *
 * ⚠ 孤儿（推不出归属）**默认留 NULL**：fail-closed 的语义是"谁都看不到"，这比"猜一个用户"安全。
 *   要归给某个用户必须由操作者显式 `--assign-to=<userId>`（本函数不会自作主张）。
 *
 * ⚠⚠ **最容易做错的一点（审查者实测）**：`memories` 必须**同时**回填 `userId` 与 `isolationKey`。
 *   只改键不改 `userId` ⇒ 守卫注入的 `userId = ctx.userId` 仍会把那些行滤掉，**而且不报错**
 *   ⇒ 得到"看起来回填成功了、实际还是读不到"的**假成功**。本文件对此留了三条防线：
 *     · `memories` 分支**一次写两个字段**；
 *     · `selfCheck` 打印三张表的 `userId IS NULL` 计数与"键首段 == userId"的违规计数；
 *     · `assertBackfillConsistent()` 的**算术**判据（`实际 NULL == 应剩 NULL`）+ 键首段违规必须 0。
 *
 * ⚠ 键格式**不是**这里定义的：唯一真相是 `@/db/isolation-key` 的 `buildIsolationKey`
 *   （`@/socket/tenant` 把它**再导出**；为什么不在 socket 模块里定义——那里顶层拉 `@/utils`，
 *    会让迁移链构成加载期循环，见该文件头）。本文件只负责"把老键拆成它的入参"，
 *   保证回填出来的键与 socket/HTTP 两侧**逐字符相同**（否则记忆面板照样读不到）。
 */
import type { Knex } from "knex";
import { buildIsolationKey } from "@/db/isolation-key";
import type { TenantCtx } from "@/db/tenant-context";

export interface BackfillReport {
  applied: boolean;
  assignedTo: number | null;
  projects: { total: number; withUser: number; withoutUser: Array<{ id: number; name: unknown }> };
  tables: Array<{
    table: string;
    total: number;
    nullBefore: number;
    updated: number;
    orphans: Array<Record<string, unknown>>;
    ambiguous: Array<Record<string, unknown>>;
  }>;
  memoriesKeys: { total: number; rewritten: number; skipped: number };
  /** 自检（审查输入 D/E）：三张关键表的 NULL 计数与"键首段 == userId"违规计数。 */
  selfCheck: Array<{ table: string; userIdNull: number; expectedNull: number; keyHeadMismatch: number }>;
}

type Row = Record<string, any>;

export interface ProjectIndex {
  /** projectId -> userId（只含 userId 非空的项） */
  project: Map<number, number>;
  /** 下面这些都是 `<主键> -> projectId` */
  assets: Map<number, number>;
  script: Map<number, number>;
  storyboard: Map<number, number>;
  shot: Map<number, number>;
  novel: Map<number, number>;
  /** imageId -> projectId（主链 o_image.assetsId → o_assets；兜底 o_assets.imageId → o_image） */
  image: Map<number, number>;
  /** eventId -> projectId[]（多值 = 多义） */
  event: Map<number, number[]>;
  /** imageFlowId -> projectId（主链 o_assets.flowId；兜底 flowData 路径首段） */
  imageFlow: Map<number, number>;
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 从 `flowData` 文本里取形如 `{projectId}/…` 的路径首段（dev 库实测：`1790518568661/role/…`）。 */
export function firstProjectIdInFlowData(flowData: unknown): number | null {
  const text = typeof flowData === "string" ? flowData : "";
  const match = /(?:^|[\\/"'\s])(\d{6,})[\\/]/.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * 老键 `projectId:agentType[:episodesId]` → `userId:projectId:agentType[:episodesId]`；
 * 已是新格式（首段就是 userId）→ `null`（幂等，表示"不用改"）。
 *
 * ⚠ 交付实现复用 `buildIsolationKey`（唯一真相），所以集号段会被**按值归一化**
 *   （`0011` → `11`；`0`/非数字 → 视为非法，返回 `null` 交给自检报告，不猜）。
 * ⚠ `projectId === userId` 的**巧合**分不出来（纯函数没有项目索引）⇒ 保守返回 `null`；
 *   此时自检会把该行的"键首段违规"报出来（fail-loud），不会静默放过。
 */
export function rewriteIsolationKey(userId: number, isolationKey: string): string | null {
  const parts = String(isolationKey ?? "").split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  if (!/^\d+$/.test(parts[0]) || !parts[1]) return null;
  const projectId = Number(parts[0]);
  if (projectId === Number(userId)) return null; // 首段已是 userId ⇒ 已是新格式
  let episodesId: number | undefined;
  if (parts.length === 3) {
    if (!/^\d+$/.test(parts[2]) || Number(parts[2]) <= 0) return null;
    episodesId = Number(parts[2]);
  }
  const ctx: TenantCtx = { userId: Number(userId), role: "user", requestId: "backfill", source: "system" };
  return buildIsolationKey(ctx, projectId, parts[1], episodesId);
}

/** 新格式合规判据：`userId:projectId:…`（首段 == userId、第二段是数字 projectId）。 */
export function isIsolationKeyCompliant(isolationKey: unknown, userId: number): boolean {
  const parts = String(isolationKey ?? "").split(":");
  return parts.length >= 3 && parts[0] === String(userId) && /^\d+$/.test(parts[1] ?? "");
}

function toMap(rows: Row[], keyColumn: string, valueColumn: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    const key = num(row[keyColumn]);
    const value = num(row[valueColumn]);
    if (key !== null && value !== null) map.set(key, value);
  }
  return map;
}

export async function collectProjectIndex(knex: Knex): Promise<ProjectIndex> {
  const project = toMap(await knex("o_project").select("id", "userId"), "id", "userId");
  const assets = toMap(await knex("o_assets").select("id", "projectId"), "id", "projectId");
  const script = toMap(await knex("o_script").select("id", "projectId"), "id", "projectId");
  const storyboard = toMap(await knex("o_storyboard").select("id", "projectId"), "id", "projectId");
  const shot = toMap(await knex("o_shot").select("id", "projectId"), "id", "projectId");
  const novel = toMap(await knex("o_novel").select("id", "projectId"), "id", "projectId");

  // o_image：主链 assetsId；兜底 o_assets.imageId（dev 实测：assetsId 覆盖 58/58，imageId 覆盖 54/58）
  const image = new Map<number, number>();
  for (const row of await knex("o_image").select("id", "assetsId")) {
    const projectId = assets.get(num(row.assetsId) ?? -1);
    if (projectId !== undefined) image.set(Number(row.id), projectId);
  }
  for (const row of await knex("o_assets").select("id", "imageId").whereNotNull("imageId")) {
    const projectId = assets.get(Number(row.id));
    const imageId = num(row.imageId);
    if (projectId !== undefined && imageId !== null && !image.has(imageId)) image.set(imageId, projectId);
  }

  // o_event：经 o_eventChapter.novelId → o_novel.projectId（一个 event 可能挂多个项目 → 多义）
  const event = new Map<number, number[]>();
  for (const row of await knex("o_eventChapter").select("eventId", "novelId")) {
    const projectId = novel.get(num(row.novelId) ?? -1);
    if (projectId === undefined) continue;
    const eventId = num(row.eventId);
    if (eventId === null) continue;
    const list = event.get(eventId) ?? [];
    if (!list.includes(projectId)) list.push(projectId);
    event.set(eventId, list);
  }

  // o_imageFlow：主链 o_assets.flowId；兜底 flowData 的路径首段
  const imageFlow = new Map<number, number>();
  for (const row of await knex("o_assets").select("id", "flowId").whereNotNull("flowId")) {
    const projectId = assets.get(Number(row.id));
    const flowId = num(row.flowId);
    if (projectId !== undefined && flowId !== null) imageFlow.set(flowId, projectId);
  }
  for (const row of await knex("o_imageFlow").select("id", "flowData")) {
    const flowId = Number(row.id);
    if (imageFlow.has(flowId)) continue;
    const projectId = firstProjectIdInFlowData(row.flowData);
    if (projectId !== null) imageFlow.set(flowId, projectId);
  }

  return { project, assets, script, storyboard, shot, novel, image, event, imageFlow };
}

const userOfProject = (idx: ProjectIndex, projectId: number | null | undefined): number | null =>
  projectId === null || projectId === undefined ? null : idx.project.get(projectId) ?? null;

/** 一行 + 索引 → userId；`"ambiguous"` 表示"推得出多个归属，必须人来定"。 */
type Derive = (row: Row, idx: ProjectIndex) => number | null | "ambiguous";

const viaProject =
  (fk: string): Derive =>
  (row, idx) =>
    userOfProject(idx, num(row[fk]));

const viaIndex =
  (fk: string, index: keyof ProjectIndex): Derive =>
  (row, idx) =>
    userOfProject(idx, (idx[index] as Map<number, number>).get(num(row[fk]) ?? -1));

const viaEither =
  (primaryFk: string, primaryIndex: keyof ProjectIndex, fallbackFk: string, fallbackIndex: keyof ProjectIndex): Derive =>
  (row, idx) =>
    userOfProject(idx, (idx[primaryIndex] as Map<number, number>).get(num(row[primaryFk]) ?? -1)) ??
    userOfProject(idx, (idx[fallbackIndex] as Map<number, number>).get(num(row[fallbackFk]) ?? -1));

const deriveEvent: Derive = (row, idx) => {
  const projectIds = idx.event.get(Number(row.id)) ?? [];
  const users = [...new Set(projectIds.map((p) => idx.project.get(p)).filter((u): u is number => u !== undefined))];
  if (users.length === 0) return null;
  return users.length > 1 ? "ambiguous" : users[0];
};

/**
 * `memories` 的归属：**老键首段是 projectId、新键首段是 userId**，两者要分得开。
 * 判据：首段是"已知 userId"**且**第二段是"已知 projectId" ⇒ 新键（首段即归属）；
 * 否则按老键处理（首段是 projectId）。
 * ⚠ brief 初稿要求 `parts.length >= 3` —— 那会把 `100:scriptAgent`（2 段老键）误判成孤儿
 *   （fixture 里 `m1` 就是这种键，brief 自己的 apply 断言要求它变 7）。这里按 2 段也认。
 */
const deriveMemories: Derive = (row, idx) => {
  const parts = String(row.isolationKey ?? "").split(":");
  if (parts.length < 2 || !/^\d+$/.test(parts[0])) return null;
  const head = Number(parts[0]);
  const knownUserIds = new Set(idx.project.values());
  if (knownUserIds.has(head) && idx.project.has(Number(parts[1]))) return head;
  return userOfProject(idx, head);
};

interface BackfillTarget {
  table: string;
  /** 定位行的列（复合主键表给全部列） */
  key: string[];
  derive: Derive;
  /**
   * `derive` 需要的**外键列**（不含 `key` 里已有的）。必须显式列出来：
   * brief 初稿只 select `userId` + key ⇒ `viaProject("projectId")` 拿不到 `projectId`
   * （`row.projectId === undefined`）⇒ **所有行都被判成孤儿、回填静默不做**（实测：`o_assets.updated=0`）。
   */
  fk?: string[];
}

/** 20 张租户表里"需要回填"的 19 张（`o_project` 自己单独处理：它是链的源头）。 */
const TARGETS: BackfillTarget[] = [
  { table: "o_tasks", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_novel", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_script", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_assets", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_storyboard", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_agentWorkData", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_video", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_videoTrack", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_segment", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_shot", key: ["id"], derive: viaProject("projectId"), fk: ["projectId"] },
  { table: "o_image", key: ["id"], derive: viaIndex("id", "image") },
  { table: "o_eventChapter", key: ["id"], derive: viaIndex("novelId", "novel"), fk: ["novelId"] },
  { table: "o_event", key: ["id"], derive: deriveEvent },
  { table: "o_assets2Storyboard", key: ["storyboardId", "assetId"], derive: viaEither("storyboardId", "storyboard", "assetId", "assets") },
  { table: "o_scriptAssets", key: ["scriptId", "assetId"], derive: viaEither("scriptId", "script", "assetId", "assets") },
  { table: "o_shotAssets", key: ["shotId", "assetId"], derive: viaEither("shotId", "shot", "assetId", "assets") },
  { table: "o_assetsRole2Audio", key: ["assetsAudioId", "assetsRoleId"], derive: viaEither("assetsAudioId", "assets", "assetsRoleId", "assets") },
  { table: "o_imageFlow", key: ["id"], derive: viaIndex("id", "imageFlow") },
  { table: "memories", key: ["id"], derive: deriveMemories },
];

function pickKey(row: Row, key: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const column of key) out[column] = row[column];
  return out;
}

function chunks<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const MAX_BATCH = 500;

export async function backfillUserIds(knex: Knex, options: { apply: boolean; assignTo?: number }): Promise<BackfillReport> {
  const index = await collectProjectIndex(knex);
  const projectRows: Row[] = await knex("o_project").select("id", "name", "userId");
  const withoutUser = projectRows.filter((r) => num(r.userId) === null);
  const report: BackfillReport = {
    applied: options.apply,
    assignedTo: options.assignTo ?? null,
    projects: { total: projectRows.length, withUser: projectRows.length - withoutUser.length, withoutUser: withoutUser.map((r) => ({ id: Number(r.id), name: r.name })) },
    tables: [],
    memoriesKeys: { total: 0, rewritten: 0, skipped: 0 },
    selfCheck: [],
  };

  // ① o_project 自己：没有任何链能推出归属，只能靠显式 --assign-to
  const projectDidAssign = options.assignTo !== undefined && withoutUser.length > 0;
  if (projectDidAssign) {
    const ids = withoutUser.map((r) => Number(r.id));
    if (options.apply) await knex("o_project").whereIn("id", ids).update({ userId: options.assignTo });
    for (const id of ids) index.project.set(id, options.assignTo as number); // 让后续目标表能顺着新归属回填
  }

  for (const target of TARGETS) {
    const total = await knex(target.table).count({ n: "*" }).first();
    const tableReport = { table: target.table, total: Number((total as any)?.n ?? 0), nullBefore: 0, updated: 0, orphans: [] as Row[], ambiguous: [] as Row[] };

    if (target.table === "memories") {
      // memories 一次处理两个字段：userId + isolationKey 前缀。
      // ⚠ **不只处理 `userId IS NULL` 的行**：键不规范（老格式）但 userId 已有值的行也必须改写，
      //    否则"键首段 == userId"这条不变式永远修不好（自检会红）。
      const memRows: Row[] = await knex("memories").select("id", "userId", "isolationKey");
      tableReport.nullBefore = memRows.filter((r) => num(r.userId) === null).length;
      for (const row of memRows) {
        const hadUser = num(row.userId) !== null;
        let userId: number | null = hadUser ? Number(row.userId) : null;
        if (userId === null) {
          const derived = target.derive(row, index);
          userId = derived === "ambiguous" ? null : derived ?? options.assignTo ?? null;
          if (userId === null) {
            tableReport.orphans.push(pickKey(row, target.key));
            continue;
          }
        }
        const nextKey = rewriteIsolationKey(userId, String(row.isolationKey ?? ""));
        report.memoriesKeys.total += 1;
        if (nextKey === null) report.memoriesKeys.skipped += 1;
        else report.memoriesKeys.rewritten += 1;
        if (!hadUser) tableReport.updated += 1; // `updated` 只算"补了 userId"的行（自检算术用它）
        if (options.apply) {
          const patch: Row = {};
          if (!hadUser) patch.userId = userId;
          if (nextKey !== null) patch.isolationKey = nextKey;
          if (Object.keys(patch).length) await knex("memories").where("id", row.id).update(patch);
        }
      }
      report.tables.push(tableReport);
      continue;
    }

    // ⚠ 只取 `userId` + 主键 + `derive` 需要的外键列：`isolationKey` 只有 `memories` 有（那条链单独处理），
    //   而 `projectId` 这类外键**必须**选出来（brief 初稿两者都没做对，实测 `no such column` + 全行误判孤儿）。
    const columns = ["userId", ...target.key, ...(target.fk ?? [])].filter((c, i, arr) => arr.indexOf(c) === i);
    const rows: Row[] = await knex(target.table).whereNull("userId").select(columns);
    tableReport.nullBefore = rows.length;
    const groups = new Map<number, Row[]>();
    for (const row of rows) {
      const derived = target.derive(row, index);
      if (derived === "ambiguous") {
        tableReport.ambiguous.push(pickKey(row, target.key));
        continue;
      }
      const userId = derived ?? options.assignTo ?? null;
      if (userId === null) {
        tableReport.orphans.push(pickKey(row, target.key));
        continue;
      }
      const list = groups.get(userId) ?? [];
      list.push(row);
      groups.set(userId, list);
    }

    if (options.apply) {
      for (const [userId, grouped] of groups) {
        if (target.key.length === 1) {
          const column = target.key[0];
          for (const batch of chunks(grouped, MAX_BATCH)) {
            await knex(target.table).whereIn(column, batch.map((r) => r[column])).update({ userId });
          }
        } else {
          // 复合主键：whereIn 会变成笛卡尔积，所以逐行更新（表都很小；dev 最大 520 行）
          for (const row of grouped) await knex(target.table).where(pickKey(row, target.key)).update({ userId });
        }
      }
    }
    tableReport.updated = [...groups.values()].reduce((sum, g) => sum + g.length, 0);
    report.tables.push(tableReport);
  }

  // ② 自检（审查输入 D/E）：写库**之后**再数一遍
  const tableOf = (name: string) => report.tables.find((t) => t.table === name);
  const scriptT = tableOf("o_script");
  const memT = tableOf("memories");
  const expectedOf = (nullBefore: number, updated: number) => (options.apply ? nullBefore - updated : nullBefore);
  const countNull = async (table: string): Promise<number> =>
    Number(((await knex(table).whereNull("userId").count({ n: "*" }).first()) as any)?.n ?? 0);
  const memRowsAfter: Row[] = await knex("memories").select("id", "userId", "isolationKey");
  report.selfCheck = [
    { table: "o_script", userIdNull: await countNull("o_script"), expectedNull: expectedOf(scriptT?.nullBefore ?? 0, scriptT?.updated ?? 0), keyHeadMismatch: 0 },
    {
      table: "o_project",
      userIdNull: await countNull("o_project"),
      expectedNull: expectedOf(withoutUser.length, projectDidAssign ? withoutUser.length : 0),
      keyHeadMismatch: 0,
    },
    {
      table: "memories",
      userIdNull: await countNull("memories"),
      expectedNull: expectedOf(memT?.nullBefore ?? 0, memT?.updated ?? 0),
      keyHeadMismatch: memRowsAfter.filter((r) => num(r.userId) !== null && !isIsolationKeyCompliant(r.isolationKey, Number(r.userId))).length,
    },
  ];
  return report;
}

/**
 * 自检断言（fail-loud）：`userId IS NULL` 的实际值与"应剩"不符（= 有行该填没填），
 * 或**已写库**时"键首段 == userId"仍有违规 → 抛。
 *
 * ⚠ dry-run（`applied=false`）**只报不抛**：那时违规计数是"待修复量"（真实库上就是 92 条老键），
 *   不是缺陷；否则真库上连 dry-run 都跑不了（会得出"工具坏了"的假结论）。
 */
export function assertBackfillConsistent(report: BackfillReport): void {
  const problems: string[] = [];
  for (const s of report.selfCheck) {
    if (s.userIdNull !== s.expectedNull) {
      problems.push(`${s.table}: userId IS NULL 实际 ${s.userIdNull}，应剩 ${s.expectedNull}（有行该填没填）`);
    }
    if (report.applied && s.keyHeadMismatch !== 0) {
      problems.push(`${s.table}: 键首段违规 ${s.keyHeadMismatch} 条（isolationKey 没改写对，那些行读不到）`);
    }
  }
  if (problems.length) throw new Error(`[backfill-userid] 自检失败：\n  - ${problems.join("\n  - ")}`);
}

export function formatBackfillReport(report: BackfillReport): string {
  const lines: string[] = [];
  lines.push(`模式：${report.applied ? "APPLY（已写库）" : "DRY-RUN（未写库）"}${report.assignedTo ? `；孤儿归给 userId=${report.assignedTo}` : "；孤儿保持 NULL（对任何租户都不可见）"}`);
  lines.push(`项目：共 ${report.projects.total}，有归属 ${report.projects.withUser}，无归属 ${report.projects.withoutUser.length}`);
  for (const p of report.projects.withoutUser) lines.push(`  ⚠ 孤儿项目 id=${p.id} name=${String(p.name)}（其子行无法推导归属）`);
  lines.push("表：table / 总行 / 回填前 NULL / 本次处理 / 孤儿 / 多义");
  for (const t of report.tables) {
    lines.push(`  ${t.table}: ${t.total} / ${t.nullBefore} / ${t.updated} / ${t.orphans.length} / ${t.ambiguous.length}`);
    for (const o of t.orphans.slice(0, 5)) lines.push(`      孤儿 ${JSON.stringify(o)}`);
    for (const a of t.ambiguous.slice(0, 5)) lines.push(`      多义 ${JSON.stringify(a)}（需人工裁定）`);
  }
  lines.push(`memories 键：共 ${report.memoriesKeys.total}，改写 ${report.memoriesKeys.rewritten}，已合规跳过 ${report.memoriesKeys.skipped}`);
  // 自检表（审查输入 E）：运维一眼能看出"还有多少行谁都看不见"
  lines.push("自检：table / userId IS NULL（实际 / 应剩）/ 键首段违规");
  for (const s of report.selfCheck) lines.push(`  ${s.table}: ${s.userIdNull} / ${s.expectedNull} / ${s.keyHeadMismatch}`);
  return lines.join("\n");
}
