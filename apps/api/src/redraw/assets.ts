/**
 * 资产认账层（M2-T6 / spec §7）：解析草稿 → 用户绑定/新建/改名 → 确认落 `o_assets` + `o_scriptAssets`。
 *
 * ── 数据放哪（三个工作区 key）──
 *  · `redrawAssetDraft`（解析层写）：`{ assets: RedrawAsset[] }` —— 模型解析出的资产草稿，**不代表已落库**；
 *  · `redrawAssetBindings`（本层写）：`{ [draftName]: assetId }` —— spec §4.3 的契约，前端直接读；
 *  · `redrawAssetReconcile`（本层写，内部）：`{ [draftName]: { assetId, kind, name?, describe?, prompt?, gender? } }`
 *    —— 记录"这条草稿是复用还是新建、用户改过的目标国名/说明/出图提示词/性别"。
 *    单靠 bindings 分不出 created/bound（前端卡片状态机要它），也不想把 UI 元数据塞进 `o_assets`。
 *
 * ── 落库口径（沿用 writeRedraw）──
 *  · 复用已有资产：**只补空、不覆盖** `describe/prompt`（那可能是用户在资产中心手改过的）；
 *  · 新建资产：写 name/type/describe/prompt + `scriptId`（= 本集新建，updateAsset 可覆盖）；
 *  · 链接 `o_scriptAssets`（幂等：已存在不重复插）；
 *  · 全部成功后才把 `redrawState` 推到 2（ASSETS_OK）；草稿**永不直接进 `o_assets`**。
 *
 * ⚠ 本模块不碰 HTTP/租户守卫：db 由调用方注入（路由传 `u.db`、工具层传同一个、单测传裸 knex）。
 */
import type { RedrawAsset } from "@/utils/redraw";
import { RedrawHttpError } from "@/redraw/http";
import { REDRAW_STATE, readRedrawState, readWorkData, transitionRedrawState, upsertWorkData } from "@/redraw/state";

export const ASSET_DRAFT_KEY = "redrawAssetDraft";
export const ASSET_BINDINGS_KEY = "redrawAssetBindings";
export const ASSET_PLAN_KEY = "redrawAssetReconcile";

export type RedrawAssetType = "role" | "scene" | "tool";
export const ASSET_TYPES: readonly RedrawAssetType[] = ["role", "scene", "tool"];
export function isAssetType(v: unknown): v is RedrawAssetType {
  return typeof v === "string" && (ASSET_TYPES as readonly string[]).includes(v);
}

/** 一条草稿在前端的卡片状态（M2 会话页/资产页面板的共享状态机）。 */
export type DraftState = "pending" | "bound" | "created" | "confirmed";

export type AssetDraftView = {
  /** 解析名（源片原名优先，前端显示"沈公子 → Lucia"的左边） */
  name: string;
  type: RedrawAssetType;
  /** 目标国名（前端显示右边） */
  targetName: string;
  desc: string;
  prompt: string;
  gender: string;
  state: DraftState;
  assetId?: number;
};

export type ExistingAssetView = { id: number; name: string; type: string };

/** 内部认账计划（不进前端契约）。 */
export type ReconcilePlanEntry = {
  assetId: number;
  kind: "new" | "reuse";
  /** 用户改过的目标国名（缺省 = 草稿名） */
  name?: string;
  describe?: string;
  prompt?: string;
  gender?: string;
};
export type ReconcilePlan = Record<string, ReconcilePlanEntry>;

export type SegmentBrief = { index: number; duration: number; sourceRange: string | null };

export class AssetReconcileError extends RedrawHttpError {
  constructor(message: string, status = 400) {
    super(status, message);
    this.name = "AssetReconcileError";
  }
}

// ---------- 工作区读写 ----------

export async function readDraftAssets(db: any, projectId: number, scriptId: number): Promise<RedrawAsset[]> {
  const row = await readWorkData<{ assets?: RedrawAsset[] }>(db, projectId, scriptId, ASSET_DRAFT_KEY);
  return Array.isArray(row?.assets) ? row!.assets! : [];
}

export async function readBindings(db: any, projectId: number, scriptId: number): Promise<Record<string, number>> {
  const row = await readWorkData<Record<string, number>>(db, projectId, scriptId, ASSET_BINDINGS_KEY);
  if (!row || typeof row !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(row)) {
    const id = Number(v);
    if (Number.isInteger(id) && id > 0) out[k] = id;
  }
  return out;
}

export async function readPlan(db: any, projectId: number, scriptId: number): Promise<ReconcilePlan> {
  const row = await readWorkData<ReconcilePlan>(db, projectId, scriptId, ASSET_PLAN_KEY);
  return row && typeof row === "object" ? row : {};
}

async function writeBindings(db: any, projectId: number, scriptId: number, value: Record<string, number>): Promise<void> {
  await upsertWorkData(db, projectId, scriptId, ASSET_BINDINGS_KEY, value);
}

async function writePlan(db: any, projectId: number, scriptId: number, value: ReconcilePlan): Promise<void> {
  await upsertWorkData(db, projectId, scriptId, ASSET_PLAN_KEY, value);
}

/** 草稿名归一：前端可能传解析名（sourceName）或目标国名，两种都认，统一返回**目标国名**（= 内部 key）。 */
function findDraft(drafts: RedrawAsset[], draftName: string): RedrawAsset | null {
  const key = String(draftName ?? "").trim();
  if (!key) return null;
  return drafts.find((d) => d.name === key) ?? drafts.find((d) => (d.sourceName || "") === key) ?? null;
}

// ---------- 读：草稿 + 已有资产 + 绑定（前端会话页/资产面板） ----------

export async function getProjectAssets(db: any, projectId: number): Promise<ExistingAssetView[]> {
  const rows = await db("o_assets").where("projectId", projectId).select("id", "name", "type");
  return rows.map((r: any) => ({ id: Number(r.id), name: String(r.name ?? ""), type: String(r.type ?? "") }));
}

export async function readSegments(db: any, projectId: number, scriptId: number): Promise<SegmentBrief[]> {
  const rows = await db("o_segment")
    .where({ projectId, scriptId })
    .orderBy("segmentIndex", "asc")
    .select("segmentIndex", "duration", "sourceRange");
  return rows.map((r: any) => ({
    index: Number(r.segmentIndex),
    duration: Number(r.duration ?? 0),
    sourceRange: r.sourceRange ?? null,
  }));
}

export type DraftsResult = {
  drafts: AssetDraftView[];
  existing: ExistingAssetView[];
  bindings: Record<string, number>;
  segments: SegmentBrief[];
  segmentCap: number;
};

export async function getDrafts(
  db: any,
  opts: { projectId: number; scriptId: number },
): Promise<DraftsResult> {
  const { projectId, scriptId } = opts;
  const [draftAssets, plan, bindings, redrawState, existing, segments, project] = await Promise.all([
    readDraftAssets(db, projectId, scriptId),
    readPlan(db, projectId, scriptId),
    readBindings(db, projectId, scriptId),
    readRedrawState(db, { projectId, scriptId }),
    getProjectAssets(db, projectId),
    readSegments(db, projectId, scriptId),
    db("o_project").where("id", projectId).first(),
  ]);
  const assetsOk = (redrawState ?? 0) >= REDRAW_STATE.ASSETS_OK;
  const drafts: AssetDraftView[] = draftAssets.map((a) => {
    const entry = plan[a.name];
    const state: DraftState = entry ? (assetsOk ? "confirmed" : entry.kind === "new" ? "created" : "bound") : "pending";
    return {
      name: a.sourceName || a.name,
      type: a.type,
      targetName: entry?.name ?? a.name,
      desc: entry?.describe ?? a.describe ?? "",
      prompt: entry?.prompt ?? a.prompt ?? "",
      gender: entry?.gender ?? "",
      state,
      ...(entry?.assetId ? { assetId: entry.assetId } : {}),
    };
  });
  const capNum = Number(project?.redrawMaxSegmentSec);
  return {
    drafts,
    existing: existing.filter((e) => isAssetType(e.type)),
    bindings,
    segments,
    segmentCap: Number.isInteger(capNum) && capNum >= 4 && capNum <= 30 ? capNum : 15,
  };
}

// ---------- 写：绑定 / 新建 / 修改 ----------

/** 绑定草稿 → 项目里已有资产。 */
export async function bindDraft(
  db: any,
  opts: { projectId: number; scriptId: number; draftName: string; assetId: number },
): Promise<{ ok: true; draftName: string; assetId: number }> {
  const { projectId, scriptId } = opts;
  const drafts = await readDraftAssets(db, projectId, scriptId);
  const draft = findDraft(drafts, opts.draftName);
  if (!draft) throw new AssetReconcileError("本集没有这条资产草稿：" + String(opts.draftName));
  const assetId = Number(opts.assetId);
  if (!Number.isInteger(assetId) || assetId <= 0) throw new AssetReconcileError("assetId 非法：" + String(opts.assetId));
  // 归属：资产必须属于这个项目（跨租户在守卫层查不到；跨项目的在这里拦）
  const asset = await db("o_assets").where({ id: assetId, projectId }).first();
  if (!asset) throw new AssetReconcileError("资产不属于该项目：" + assetId);
  const bindings = await readBindings(db, projectId, scriptId);
  bindings[draft.name] = assetId;
  await writeBindings(db, projectId, scriptId, bindings);
  const plan = await readPlan(db, projectId, scriptId);
  const prev = plan[draft.name];
  plan[draft.name] = { ...(prev ?? {}), assetId, kind: prev?.kind === "new" ? "new" : "reuse" };
  await writePlan(db, projectId, scriptId, plan);
  return { ok: true, draftName: draft.name, assetId };
}

/** 按草稿新建资产（写 `o_assets`，类型列 + 名称 + 说明 + 提示词）。 */
export async function createAsset(
  db: any,
  opts: {
    projectId: number;
    scriptId: number;
    draftName: string;
    name: string;
    type: RedrawAssetType;
    describe?: string;
    prompt?: string;
    gender?: string;
  },
): Promise<{ id: number }> {
  const { projectId, scriptId } = opts;
  const drafts = await readDraftAssets(db, projectId, scriptId);
  const draft = findDraft(drafts, opts.draftName);
  if (!draft) throw new AssetReconcileError("本集没有这条资产草稿：" + String(opts.draftName));
  if (!isAssetType(opts.type)) throw new AssetReconcileError("资产类型只能是 role / scene / tool，实际：" + String(opts.type));
  const name = String(opts.name ?? "").trim();
  if (!name) throw new AssetReconcileError("资产名称不能为空");
  // 幂等：同一 draftName 已经建过（plan 里有记录）⇒ 拒绝重复建（前端双击/断线重试会重复调用）。
  // 想改就走 updateAsset —— 否则一次双击就多一条 o_assets。
  const existingPlan = await readPlan(db, projectId, scriptId);
  if (existingPlan[draft.name]?.assetId) {
    throw new AssetReconcileError("这条草稿已经处理过（assetId=" + existingPlan[draft.name].assetId + "）：要修改请用 updateAsset", 409);
  }
  const [id] = await db("o_assets").insert({
    name,
    type: opts.type,
    describe: String(opts.describe ?? "").trim(),
    prompt: String(opts.prompt ?? "").trim(),
    projectId,
    // scriptId：本集新建（updateAsset 的可改范围判据之一是它）
    scriptId,
    startTime: Date.now(),
  });
  const assetId = Number(id);
  const plan = await readPlan(db, projectId, scriptId);
  plan[draft.name] = {
    assetId,
    kind: "new",
    name,
    describe: String(opts.describe ?? "").trim(),
    prompt: String(opts.prompt ?? "").trim(),
    gender: String(opts.gender ?? "").trim(),
  };
  await writePlan(db, projectId, scriptId, plan);
  const bindings = await readBindings(db, projectId, scriptId);
  bindings[draft.name] = assetId;
  await writeBindings(db, projectId, scriptId, bindings);
  return { id: assetId };
}

export type AssetPatch = { name?: string; describe?: string; prompt?: string; gender?: string };

/**
 * 修改**本集认账清单里**的资产（改名/改说明/改出图提示词/改性别）。
 *
 * 口径（G8）：
 *  · 只能改本集新建（kind=new，`o_assets.scriptId` 指向本集）或已绑定（kind=reuse）的资产 —— 别的资产一概拒绝；
 *  · kind=new：允许覆盖 name/describe/prompt；
 *  · kind=reuse（项目里的已有资产）：**只补空、不覆盖** describe/prompt，name 不改（那是共享资产）；
 *  · gender 只存在认账计划里（`o_assets` 没有这一列，也不该为了它加列）。
 */
export async function updateAsset(
  db: any,
  opts: { projectId: number; scriptId: number; assetId: number; patch: AssetPatch },
): Promise<{ changed: boolean }> {
  const { projectId, scriptId } = opts;
  const assetId = Number(opts.assetId);
  if (!Number.isInteger(assetId) || assetId <= 0) throw new AssetReconcileError("assetId 非法：" + String(opts.assetId));
  const plan = await readPlan(db, projectId, scriptId);
  const entryKey = Object.keys(plan).find((k) => plan[k].assetId === assetId);
  if (!entryKey) throw new AssetReconcileError("只能修改本集认账清单里的资产：" + assetId, 403);
  const entry = plan[entryKey];
  const asset = await db("o_assets").where({ id: assetId, projectId }).first();
  if (!asset) throw new AssetReconcileError("资产不属于该项目：" + assetId);

  const patch = opts.patch ?? {};
  const clean = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() : undefined);
  const rowPatch: Record<string, string> = {};
  if (entry.kind === "new") {
    const name = clean(patch.name);
    const describe = clean(patch.describe);
    const prompt = clean(patch.prompt);
    if (name) rowPatch.name = name;
    if (describe !== undefined) rowPatch.describe = describe;
    if (prompt !== undefined) rowPatch.prompt = prompt;
  } else {
    // 复用资产：只补空
    const describe = clean(patch.describe);
    const prompt = clean(patch.prompt);
    if (describe && !String(asset.describe ?? "").trim()) rowPatch.describe = describe;
    if (prompt && !String(asset.prompt ?? "").trim()) rowPatch.prompt = prompt;
  }
  if (Object.keys(rowPatch).length) await db("o_assets").where("id", assetId).update(rowPatch);

  const nextEntry: ReconcilePlanEntry = { ...entry };
  const name = clean(patch.name);
  const describe = clean(patch.describe);
  const prompt = clean(patch.prompt);
  const gender = clean(patch.gender);
  if (name) nextEntry.name = name;
  if (describe !== undefined) nextEntry.describe = describe;
  if (prompt !== undefined) nextEntry.prompt = prompt;
  if (gender !== undefined) nextEntry.gender = gender;
  plan[entryKey] = nextEntry;
  await writePlan(db, projectId, scriptId, plan);
  return { changed: Object.keys(rowPatch).length > 0 || JSON.stringify(nextEntry) !== JSON.stringify(entry) };
}

// ---------- 确认落库 ----------

export type ConfirmAssetsResult = { created: number; reused: number; linked: number };

/**
 * 批量确认：把认账计划里的资产落进 `o_assets`（新建）+ `o_scriptAssets`（挂链），然后把状态推到 2。
 *
 * 事务内做**全部**写（资产更新 + 挂链 + 状态转移）：中途失败不会留下"资产建了但没挂链"的半份认账。
 * 幂等：重复确认只补缺失的挂链，不会重复建资产（资产 id 已经在计划里）。
 */
export async function confirmAssets(
  db: any,
  opts: { projectId: number; scriptId: number },
): Promise<ConfirmAssetsResult> {
  const { projectId, scriptId } = opts;
  const drafts = await readDraftAssets(db, projectId, scriptId);
  // 零资产集（解析出来就没有角色/场景/道具）是**合法**输入：前端闸门会走到这里。
  // 幂等成功并推进状态，否则会话页永远卡在"待认账"（死锁）。
  if (!drafts.length) {
    await db.transaction(async (trx: any) => {
      await transitionRedrawState(trx, { projectId, scriptId, to: REDRAW_STATE.ASSETS_OK, errorReason: null });
    });
    return { created: 0, reused: 0, linked: 0 };
  }
  const plan = await readPlan(db, projectId, scriptId);
  const missing = drafts.filter((d) => !plan[d.name]?.assetId).map((d) => d.name);
  if (missing.length) {
    throw new AssetReconcileError(
      "还有 " + missing.length + " 条草稿没有处理（既没绑定已有资产、也没新建）：" + missing.join("、"),
    );
  }

  const created = drafts.filter((d) => plan[d.name].kind === "new").length;
  const reused = drafts.length - created;

  const linked = await db.transaction(async (trx: any) => {
    let links = 0;
    for (const d of drafts) {
      const entry = plan[d.name];
      const asset = await trx("o_assets").where({ id: entry.assetId, projectId }).first();
      if (!asset) throw new AssetReconcileError("认账清单里的资产不存在（可能已被删除）：" + entry.assetId);

      // 复用资产：只补空；新建资产：按计划的字段落定（createAsset 已写过，这里兜"用户后来改了但没保存"）
      const rowPatch: Record<string, string> = {};
      if (entry.kind === "new") {
        if (entry.name) rowPatch.name = entry.name;
        if (entry.describe !== undefined) rowPatch.describe = entry.describe;
        if (entry.prompt !== undefined) rowPatch.prompt = entry.prompt;
      } else {
        if (entry.describe && !String(asset.describe ?? "").trim()) rowPatch.describe = entry.describe;
        if (entry.prompt && !String(asset.prompt ?? "").trim()) rowPatch.prompt = entry.prompt;
      }
      if (Object.keys(rowPatch).length) await trx("o_assets").where("id", entry.assetId).update(rowPatch);

      const exists = await trx("o_scriptAssets").where({ scriptId, assetId: entry.assetId }).first();
      if (!exists) {
        await trx("o_scriptAssets").insert({ scriptId, assetId: entry.assetId });
        links += 1;
      }
    }
    await transitionRedrawState(trx, { projectId, scriptId, to: REDRAW_STATE.ASSETS_OK, errorReason: null });
    return links;
  });

  return { created, reused, linked };
}