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
  /**
   * 自检（审查输入 D/E + 审查 P2-2）：**每一张目标表**（19 + `o_project`）的 NULL 计数与
   * "键首段 == userId"违规计数。只覆盖 3 张时，"某张表整表被误判孤儿"在自检里看不见。
   */
  selfCheck: Array<{
    table: string;
    userIdNull: number;
    expectedNull: number;
    keyHeadMismatch: number;
    updated: number;
    orphans: number;
    /** "整表都是孤儿"的可疑信号（警告级，不抛错；理由见 `assertBackfillConsistent`）。 */
    suspiciousAllOrphan: boolean;
  }>;
  /** 可疑信号的可读文案（`formatBackfillReport` 逐条打印）。 */
  warnings: string[];
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
type DeriveFn = (row: Row, idx: ProjectIndex) => number | null | "ambiguous";
/**
 * `derive` 规格：**它自己要用的列**跟着函数一起走（`columns`）。
 *
 * ⚠ 为什么必须这样（审查 P2-2 / 本任务 D3 的根因）：brief 初稿把"要 select 哪些外键列"写成
 *   **另一个手写清单**（`fk`），两个清单一旦漂移 ⇒ `projectId` 没被选出来 ⇒ `row.projectId === undefined`
 *   ⇒ **整表被误判成孤儿、回填静默不做**（实测 `o_assets.updated=0`；审查者用真快照复现同一形态）。
 *   现在 select 列**从 derive 规格派生**，并在 select 之后 `assertDeriveColumns()` 断言"这些列真的在返回行里"。
 */
interface Derive extends DeriveFn {
  columns: readonly string[];
}

function deriveWith(columns: readonly string[], fn: DeriveFn): Derive {
  const d = ((row: Row, idx: ProjectIndex) => fn(row, idx)) as Derive;
  (d as any).columns = columns;
  return d;
}

const viaProject = (fk: string): Derive => deriveWith([fk], (row, idx) => userOfProject(idx, num(row[fk])));

const viaIndex = (fk: string, index: keyof ProjectIndex): Derive =>
  deriveWith([fk], (row, idx) => userOfProject(idx, (idx[index] as Map<number, number>).get(num(row[fk]) ?? -1)));

const viaEither = (
  primaryFk: string,
  primaryIndex: keyof ProjectIndex,
  fallbackFk: string,
  fallbackIndex: keyof ProjectIndex,
): Derive =>
  deriveWith([primaryFk, fallbackFk], (row, idx) =>
    userOfProject(idx, (idx[primaryIndex] as Map<number, number>).get(num(row[primaryFk]) ?? -1)) ??
    userOfProject(idx, (idx[fallbackIndex] as Map<number, number>).get(num(row[fallbackFk]) ?? -1)));

/** `o_event` 的归属靠 `o_eventChapter → o_novel`，事件行自己只需要主键（`id` 已在 `key` 里）。 */
const deriveEvent: Derive = deriveWith([], (row, idx) => {
  const projectIds = idx.event.get(Number(row.id)) ?? [];
  const users = [...new Set(projectIds.map((p) => idx.project.get(p)).filter((u): u is number => u !== undefined))];
  if (users.length === 0) return null;
  return users.length > 1 ? "ambiguous" : users[0];
});

/**
 * `memories` 的归属：**老键首段是 projectId、新键首段是 userId**，两者要分得开。
 * 判据：首段是"已知 userId"**且**第二段是"已知 projectId" ⇒ 新键（首段即归属）；
 * 否则按老键处理（首段是 projectId）。
 * ⚠ brief 初稿要求 `parts.length >= 3` —— 那会把 `100:scriptAgent`（2 段老键）误判成孤儿
 *   （fixture 里 `m1` 就是这种键，brief 自己的 apply 断言要求它变 7）。这里按 2 段也认。
 */
const deriveMemories: Derive = deriveWith(["isolationKey"], (row, idx) => {
  const parts = String(row.isolationKey ?? "").split(":");
  if (parts.length < 2 || !/^\d+$/.test(parts[0])) return null;
  const head = Number(parts[0]);
  const knownUserIds = new Set(idx.project.values());
  if (knownUserIds.has(head) && idx.project.has(Number(parts[1]))) return head;
  return userOfProject(idx, head);
});

export interface BackfillTarget {
  table: string;
  /** 定位行的列（复合主键表给全部列） */
  key: string[];
  /** 归属推导规格；它自带的 `columns` 就是"必须 select 出来的列"（不再有第二份手写清单）。 */
  derive: Derive;
}

/** 测试/诊断用：取某张目标表的规格（`key` + `derive`，含 `derive.columns`）。 */
export function targetSpecOf(table: string): BackfillTarget | undefined {
  return TARGETS.find((t) => t.table === table);
}

/** 20 张租户表里"需要回填"的 19 张（`o_project` 自己单独处理：它是链的源头）。 */
const TARGETS: BackfillTarget[] = [
  { table: "o_tasks", key: ["id"], derive: viaProject("projectId") },
  { table: "o_novel", key: ["id"], derive: viaProject("projectId") },
  { table: "o_script", key: ["id"], derive: viaProject("projectId") },
  { table: "o_assets", key: ["id"], derive: viaProject("projectId") },
  { table: "o_storyboard", key: ["id"], derive: viaProject("projectId") },
  { table: "o_agentWorkData", key: ["id"], derive: viaProject("projectId") },
  { table: "o_video", key: ["id"], derive: viaProject("projectId") },
  { table: "o_videoTrack", key: ["id"], derive: viaProject("projectId") },
  { table: "o_segment", key: ["id"], derive: viaProject("projectId") },
  { table: "o_shot", key: ["id"], derive: viaProject("projectId") },
  { table: "o_image", key: ["id"], derive: viaIndex("id", "image") },
  { table: "o_eventChapter", key: ["id"], derive: viaIndex("novelId", "novel") },
  { table: "o_event", key: ["id"], derive: deriveEvent },
  { table: "o_assets2Storyboard", key: ["storyboardId", "assetId"], derive: viaEither("storyboardId", "storyboard", "assetId", "assets") },
  { table: "o_scriptAssets", key: ["scriptId", "assetId"], derive: viaEither("scriptId", "script", "assetId", "assets") },
  { table: "o_shotAssets", key: ["shotId", "assetId"], derive: viaEither("shotId", "shot", "assetId", "assets") },
  { table: "o_assetsRole2Audio", key: ["assetsAudioId", "assetsRoleId"], derive: viaEither("assetsAudioId", "assets", "assetsRoleId", "assets") },
  { table: "o_imageFlow", key: ["id"], derive: viaIndex("id", "imageFlow") },
  { table: "memories", key: ["id"], derive: deriveMemories },
];

/**
 * 回填目标表名（**19 张**；`o_project` 是归属链的源头，单独处理，故不在此列）。
 *
 * ⚠ 存在的意义是**三方相等断言**（审查输入 ⑥）：
 *   `policies.TENANT_TABLES` ↔ 这里的回填目标 ↔ 运行期 `report.selfCheck` 覆盖的表。
 *   本阶段已两次证明"**手工清单必漂**"（Ruling 12/175/240⑤：漏选外键列、`--aply` 静默降级），
 *   所以表清单必须有**机械**判据，不能靠人记得同步。
 *
 * ⚠【Phase 1c Task 1】三方相等现在写成：
 *   `TENANT_TABLES == BACKFILL_TARGET_TABLES ∪ {o_project} ∪ BACKFILL_EXEMPT_TABLES`
 *   —— 因为 1c 新增了 2 张**迁移后新建的租户空表**（`o_account` / `o_modelGrant`），
 *   它们没有历史行可回填。豁免仍是**这里的单一来源**（不是门禁里的第二份清单）。
 */
export const BACKFILL_TARGET_TABLES: readonly string[] = Object.freeze(TARGETS.map((t) => t.table));

/** 自检覆盖的表 = 19 张回填目标 + 链源头 `o_project`（= `policies.TENANT_TABLES − BACKFILL_EXEMPT_TABLES`）。 */
export const SELF_CHECK_TABLES: readonly string[] = Object.freeze(["o_project", ...BACKFILL_TARGET_TABLES]);

/**
 * **回填豁免表**（单一来源）：`policies.TENANT_TABLES` 里"既不在回填目标、也不在自检"的那一批。
 *
 * 判据：迁移后新建且没有历史行的租户表，或由专用迁移用已知归属初始化、无需 004 推导的表。
 * 把它们塞进 `TARGETS` 会造出永远为 0 的目标行（看起来在检查，其实什么都没检查），
 * 并让 `assertBackfillConsistent` 多出空断言。
 *
 * ⚠ 为什么不写成"门禁里的一份豁免清单"：那会是**第三份手写清单**（1b 反复出事的形状）。
 *   现在三方一致的不变量是：
 *     `TENANT_TABLES == BACKFILL_TARGET_TABLES ∪ {o_project} ∪ BACKFILL_EXEMPT_TABLES`
 *   三项都是**导出常量**，`tools/check-tenant-policies.cjs` 与单测都只读这里 ——
 *   "多一张租户表但没归类"会当场红，且**只有这一处**能改。
 *
 * ⚠ 加表的人必须做的唯一动作：新表若是"迁移后新建的空表"就加进这里；
 *   若是"老库就有、需要回填归属"的表，就必须同时给出 `TARGETS` 的 `derive` 规格（不能只加名字）。
 */
export const BACKFILL_EXEMPT_TABLES: readonly string[] = Object.freeze([
  "o_account",    // 006_quota_grants：每用户一行余额，迁移后新建的空表
  "o_ledger",     // 009_billing：账本在迁移后创建，没有历史租户数据
  "o_modelGrant", // 006_quota_grants：模型授权，迁移后新建的空表
  "o_order",      // 009_billing：充值订单在迁移后创建，没有历史租户数据
  "o_usage",      // 009_billing：provider 调用计量在迁移后创建，没有历史租户数据
  "o_dailyQuotaAdmission", // 010_daily_quota_admission：每日准入计数迁移后创建，没有历史租户数据
  "o_usageAdmission", // 011_usage_admission：providerCallId 准入表迁移后创建，没有历史租户数据
  "o_userGroupMembership", // 014_access_groups：迁移回填时直接写入已知 userId，不参与 004 历史归属推导
]);

/**
 * **根因级拦截**（审查 P2-2 第 1 条）：`derive.columns` 里每一列都必须真的出现在返回行里。
 * `select` 漏列时 `row[col] === undefined` ⇒ 推导全部返回 null ⇒ **整表被静默判成孤儿**，
 * 而自检算术（`expectedNull = nullBefore - updated`）用的是**同一套错误分类** ⇒ 自洽、永不发火。
 * 所以必须在"开始分类之前"就响亮失败。导出以便单测直接钉这条（无需构造真实误配）。
 */
export function assertDeriveColumns(rows: Row[], derive: Derive, table: string): void {
  if (!rows.length) return;
  const missing = derive.columns.filter((column) => rows[0][column] === undefined);
  if (missing.length) {
    throw new Error(
      `[backfill-userid] ${table}: select 没把归属推导需要的外键列选出来（缺 ${missing.join(", ")}）` +
        ` —— 这会让**整表被误判成孤儿**、回填静默不做（D3 根因）。请修 select 列的来源，不要绕过。`,
    );
  }
}

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
    warnings: [],
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

    // ⚠ 只取 `userId` + 主键 + **`derive` 规格自带的外键列**（不再有第二份手写清单，避免两者漂移）：
    //   漏列会让 `row.projectId === undefined` ⇒ 整表被静默判成孤儿（D3），所以下面**紧接着**断言。
    const columns = ["userId", ...target.key, ...target.derive.columns].filter((c, i, arr) => arr.indexOf(c) === i);
    const rows: Row[] = await knex(target.table).whereNull("userId").select(columns);
    assertDeriveColumns(rows, target.derive, target.table);
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

  // ② 自检（审查输入 D/E + 审查 P2-2）：写库**之后**再数一遍。
  //    ⚠ 覆盖**全部目标表**（19 + `o_project`），不再只 3 张：只覆盖 3 张时，"某张表整表被误判孤儿"
  //      在自检里**看不见**（审查者实测：去掉外键列后自检 `o_script: 8/8/0` 完全自洽）。
  const expectedOf = (nullBefore: number, updated: number) => (options.apply ? nullBefore - updated : nullBefore);
  const countNull = async (table: string): Promise<number> =>
    Number(((await knex(table).whereNull("userId").count({ n: "*" }).first()) as any)?.n ?? 0);
  const memRowsAfter: Row[] = await knex("memories").select("id", "userId", "isolationKey");
  const memKeyMismatch = memRowsAfter.filter((r) => num(r.userId) !== null && !isIsolationKeyCompliant(r.isolationKey, Number(r.userId))).length;
  report.selfCheck = [
    {
      table: "o_project",
      userIdNull: await countNull("o_project"),
      expectedNull: expectedOf(withoutUser.length, projectDidAssign ? withoutUser.length : 0),
      keyHeadMismatch: 0,
      updated: projectDidAssign ? withoutUser.length : 0,
      orphans: withoutUser.length,
      suspiciousAllOrphan: false,
    },
  ];
  for (const t of report.tables) {
    report.selfCheck.push({
      table: t.table,
      userIdNull: await countNull(t.table),
      expectedNull: expectedOf(t.nullBefore, t.updated),
      keyHeadMismatch: t.table === "memories" ? memKeyMismatch : 0,
      updated: t.updated,
      orphans: t.orphans.length,
      // "可疑：整表都是孤儿"信号（审查 P2-2 第 2 条）：
      //   有外键列 ⇒ 本该能推导；本表有 NULL 行却一行都没填、且它们**全部**被判孤儿，而项目索引**非空**
      //   （说明不是"库整体没归属"）⇒ 极可能是"外键列没选出来/推导坏了"。
      //   ⚠ 刻意做成**警告**而不是抛错：真库上完全可能出现"某张表 100% 归属为孤儿项目"的合法情形，
      //     在 `004.up`（启动路径）抛错会让**应用起不来**。硬拦截交给 `assertDeriveColumns()`。
      suspiciousAllOrphan:
        (targetSpecOf(t.table)?.derive.columns.length ?? 0) > 0 && t.nullBefore > 0 && t.updated === 0 && t.orphans.length === t.nullBefore && index.project.size > 0,
    });
  }
  report.warnings = report.selfCheck
    .filter((s) => s.suspiciousAllOrphan)
    .map((s) => `${s.table}: 本表 ${s.orphans} 行**全部**被判孤儿（项目索引非空）—— 高度可疑：外键列没选出来 / 归属链坏了；请查 select 列与 derive 规格`);
  return report;
}

/**
 * 自检断言（fail-loud）：**每一张**目标表的 `userId IS NULL` 实际值与"应剩"不符（= 有行该填没填），
 * 或**已写库**时"键首段 == userId"仍有违规 → 抛。
 *
 * ⚠ dry-run（`applied=false`）**只报不抛**：那时违规计数是"待修复量"（真实库上就是 92 条老键），
 *   不是缺陷；否则真库上连 dry-run 都跑不了（会得出"工具坏了"的假结论）。
 * ⚠ "整表孤儿"只进 `report.warnings`（不在这里抛）：真库上可能存在合法的全孤儿表，
 *   而本函数也会在 `004.up`（启动路径）被调用 —— 那会让应用起不来。硬拦截在 `assertDeriveColumns()`。
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
    // 控制台只点前 5 条（完整名单走 `--report=` 的 JSON，见 CLI 注释：预裁定 1 要求"留 NULL + 报告"，
    // 名单被截断会让操作者只能自己写 SQL 才能枚举）。
    for (const o of t.orphans.slice(0, 5)) lines.push(`      孤儿 ${JSON.stringify(o)}（完整名单见 --report= 的 JSON）`);
    for (const a of t.ambiguous.slice(0, 5)) lines.push(`      多义 ${JSON.stringify(a)}（需人工裁定）`);
  }
  lines.push(`memories 键：共 ${report.memoriesKeys.total}，改写 ${report.memoriesKeys.rewritten}，已合规跳过 ${report.memoriesKeys.skipped}`);
  for (const w of report.warnings) lines.push(`⚠ 可疑：${w}`);
  // 自检表（审查输入 E + P2-2）：覆盖**全部**目标表
  lines.push("自检：table / userId IS NULL（实际 / 应剩）/ 键首段违规 / 本次处理 / 孤儿");
  for (const s of report.selfCheck) {
    lines.push(`  ${s.table}: ${s.userIdNull} / ${s.expectedNull} / ${s.keyHeadMismatch} / ${s.updated} / ${s.orphans}`);
  }
  return lines.join("\n");
}
