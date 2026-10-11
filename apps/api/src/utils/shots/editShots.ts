/**
 * 结构化分镜的**编辑层**（分镜台按行编辑 / 引用资产 CRUD）
 *
 * 解决的问题：
 *   · 旧链路「手建分镜选的引用资产切走就丢」—— 因为 `o_assets2Storyboard` 只有 C/R，
 *     没有"改绑定/取消绑定"的入口；新表下绑定是 `o_shotAssets(shotId, assetId)`，增删改都是行级操作。
 *   · 旧链路「编辑要走整段文本」—— 现在按 镜/片段 直接改行。
 *   · 旧链路「时长/绑定/资产存在性全靠模型自检」—— 这里由**代码**校验后再写。
 *
 * 不 import 任何 `@/` 模块（db 注入），便于 `docs/tools/*.cjs` 用真 SQLite 离线验证。
 */

const MAX_SHOT_SEC = 8;
const MAX_SEGMENT_SEC = 15;
const tol = 0.01;

export type EditResult<T = any> = { ok: boolean; errors: string[]; data?: T };

/** 该片段所有镜的时长之和（0.5 秒精度，避免浮点毛刺） */
export async function segmentDuration(db: any, segmentId: number): Promise<number> {
  const rows: any[] = await db("o_shot").where("segmentId", segmentId).select("duration");
  const sum = rows.reduce((a, r) => a + (Number(r.duration) || 0), 0);
  return Math.round(sum * 10) / 10;
}

/** 把 `o_segment.duration` 重算成"镜之和"（片段的时长永远由镜决定，不让它漂） */
export async function recalcSegmentDuration(db: any, segmentId: number): Promise<number> {
  const sum = await segmentDuration(db, segmentId);
  await db("o_segment").where("id", segmentId).update({ duration: sum, updateTime: Date.now() });
  return sum;
}

/** 一条镜的字段校验（只校验"能确定性判定"的部分） */
export async function validateShot(db: any, shot: { duration?: number; assetIds?: number[] }, where = "该镜"): Promise<string[]> {
  const errors: string[] = [];
  if (shot.duration != null) {
    if (!(shot.duration > 0)) errors.push(`${where}：时长必须是正数`);
    if (shot.duration > MAX_SHOT_SEC + tol) errors.push(`${where}：时长 ${shot.duration}s 超过单镜上限 ${MAX_SHOT_SEC}s`);
  }
  if (shot.assetIds && shot.assetIds.length) {
    const ids = [...new Set(shot.assetIds)];
    const hit: any[] = await db("o_assets").whereIn("id", ids).select("id");
    const have = new Set(hit.map((r) => Number(r.id)));
    const missing = ids.filter((id) => !have.has(id));
    if (missing.length) errors.push(`${where}：引用了不存在的资产 ID ${missing.join(", ")}`);
  }
  return errors;
}

/** 片段总时长上限校验（含本次改动后的结果） */
export async function validateSegmentTotal(db: any, segmentId: number, extraErrorsOn: Record<string, number> = {}): Promise<string[]> {
  const sum = await segmentDuration(db, segmentId);
  const extra = Object.values(extraErrorsOn).reduce((a, b) => a + b, 0);
  if (sum + extra > MAX_SEGMENT_SEC + tol) {
    return [`该片段合计 ${Math.round((sum + extra) * 10) / 10}s 超过片段上限 ${MAX_SEGMENT_SEC}s（请拆片段或缩短镜头）`];
  }
  return [];
}

// ============================================================
// 引用资产（o_shotAssets）增删改
// ============================================================

/** 整体设置某镜的引用资产：算出入参差集，多的删、少的加；返回最终列表与增删数 */
export async function setShotAssets(db: any, shotId: number, assetIds: number[]): Promise<{ added: number; removed: number; assetIds: number[] }> {
  const wanted = [...new Set((assetIds ?? []).map(Number).filter((n) => !Number.isNaN(n)))];
  const rows: any[] = await db("o_shotAssets").where("shotId", shotId).select("assetId");
  const have = new Set(rows.map((r) => Number(r.assetId)));
  const toAdd = wanted.filter((id) => !have.has(id));
  const toRemove = [...have].filter((id) => !wanted.includes(id));

  if (toRemove.length) await db("o_shotAssets").where("shotId", shotId).whereIn("assetId", toRemove).delete();
  if (toAdd.length) await db("o_shotAssets").insert(toAdd.map((assetId) => ({ shotId, assetId })));
  return { added: toAdd.length, removed: toRemove.length, assetIds: wanted };
}

/** 读某镜的引用资产（按插入顺序） */
export async function getShotAssets(db: any, shotId: number): Promise<number[]> {
  const rows: any[] = await db("o_shotAssets").where("shotId", shotId).select("assetId");
  return rows.map((r) => Number(r.assetId));
}

// ============================================================
// 镜：改 / 增 / 删
// ============================================================

export type ShotPatch = {
  duration?: number;
  shotSize?: string;
  camera?: string;
  light?: string;
  action?: string;
  dialogue?: string;
  sfx?: string;
  /** 传了就整体设置引用资产（含空数组 = 清空） */
  assetIds?: number[];
};

/**
 * 改一条镜。校验顺序：字段 → 片段总时长 → 落库 → 回填片段时长。
 * 任一校验失败就**不写**（返回 errors），这就是「代码兜底」的意义。
 */
export async function updateShot(db: any, shotId: number, patch: ShotPatch): Promise<EditResult<{ shot: any; assetIds?: number[]; segmentDuration: number }>> {
  const shot = await db("o_shot").where("id", shotId).first();
  if (!shot) return { ok: false, errors: [`镜 ${shotId} 不存在`] };

  const errors = await validateShot(db, patch, `镜${shot.shotIndex}`);

  // 时长变化时校验片段总时长（用"替换后"的值算）
  if (patch.duration != null) {
    const delta = Number(patch.duration) - (Number(shot.duration) || 0);
    errors.push(...(await validateSegmentTotal(db, shot.segmentId, delta > 0 ? { delta } : {})));
  }
  if (errors.length) return { ok: false, errors };

  const fields: Record<string, any> = {};
  for (const k of ["duration", "shotSize", "camera", "light", "action", "dialogue", "sfx"] as const) {
    if (patch[k] !== undefined) fields[k] = patch[k];
  }
  if (Object.keys(fields).length) {
    fields.updateTime = Date.now();
    fields.revision = (Number(shot.revision) || 1) + 1; // 修复/编辑留痕
    await db("o_shot").where("id", shotId).update(fields);
  }

  let assetIds: number[] | undefined;
  if (patch.assetIds !== undefined) {
    const r = await setShotAssets(db, shotId, patch.assetIds);
    assetIds = r.assetIds;
  }
  const seg = await recalcSegmentDuration(db, shot.segmentId);
  const updated = await db("o_shot").where("id", shotId).first();
  return { ok: true, errors: [], data: { shot: updated, assetIds, segmentDuration: seg } };
}

/** 往片段末尾加一条镜（序号接后；时长超限则拒绝） */
export async function addShot(
  db: any,
  segmentId: number,
  shot: { duration: number; shotSize?: string; camera?: string; light?: string; action?: string; dialogue?: string; sfx?: string; assetIds?: number[] },
): Promise<EditResult<{ id: number; shotIndex: number; segmentDuration: number }>> {
  const seg = await db("o_segment").where("id", segmentId).first();
  if (!seg) return { ok: false, errors: [`片段 ${segmentId} 不存在`] };

  const maxRow: any = await db("o_shot").where("segmentId", segmentId).max({ m: "shotIndex" }).first();
  const shotIndex = Number(maxRow?.m ?? 0) + 1;

  const errors = await validateShot(db, shot, `镜${shotIndex}`);
  errors.push(...(await validateSegmentTotal(db, segmentId, { add: Number(shot.duration) || 0 })));
  if (errors.length) return { ok: false, errors };

  const now = Date.now();
  const [id] = await db("o_shot").insert({
    projectId: seg.projectId,
    scriptId: seg.scriptId,
    sceneIndex: seg.sceneIndex,
    sceneTitle: seg.sceneTitle,
    segmentIndex: seg.segmentIndex,
    segmentId,
    shotIndex,
    duration: shot.duration,
    shotSize: shot.shotSize ?? "",
    camera: shot.camera ?? "",
    light: shot.light ?? "",
    action: shot.action ?? "",
    dialogue: shot.dialogue ?? "",
    sfx: shot.sfx ?? "",
    revision: 1,
    createTime: now,
    updateTime: now,
  });
  if (shot.assetIds?.length) await setShotAssets(db, Number(id), shot.assetIds);
  const segDur = await recalcSegmentDuration(db, segmentId);
  return { ok: true, errors: [], data: { id: Number(id), shotIndex, segmentDuration: segDur } };
}

/** 删一条镜（连同它的资产绑定）；删完重排该片段的镜序并回填片段时长 */
export async function deleteShot(db: any, shotId: number): Promise<EditResult<{ segmentId: number | null; segmentDuration: number }>> {
  const shot = await db("o_shot").where("id", shotId).first();
  if (!shot) return { ok: false, errors: [`镜 ${shotId} 不存在`] };
  // 不允许删掉片段里的**最后一条镜**：那会留下"空片段"（时长/绑定/videoDesc 全空，生成端拿不到东西）。
  // 要整段去掉请用「删除片段」。
  const siblings = await db("o_shot").where("segmentId", shot.segmentId).count({ n: "*" }).first();
  if (Number(siblings?.n ?? 0) <= 1) {
    return { ok: false, errors: ["这是该片段最后一条镜，删掉会留下空片段。若要整段删除，请用「删除片段」"] };
  }
  await db("o_shotAssets").where("shotId", shotId).delete();
  await db("o_shot").where("id", shotId).delete();

  // 重排镜序（保证连续；下游按 shotIndex 排序）
  const rest: any[] = await db("o_shot").where("segmentId", shot.segmentId).orderBy("shotIndex", "asc");
  for (let i = 0; i < rest.length; i++) {
    if (Number(rest[i].shotIndex) !== i + 1) await db("o_shot").where("id", rest[i].id).update({ shotIndex: i + 1 });
  }
  const segDur = await recalcSegmentDuration(db, shot.segmentId);
  return { ok: true, errors: [], data: { segmentId: Number(shot.segmentId), segmentDuration: segDur } };
}

// ============================================================
// 片段：改 / 删
// ============================================================

/** 改片段（目前只允许 videoDesc / prompt / state；时长由镜决定，不接受手改） */
export async function updateSegment(db: any, segmentId: number, patch: { videoDesc?: string; prompt?: string; state?: string }): Promise<EditResult<any>> {
  const seg = await db("o_segment").where("id", segmentId).first();
  if (!seg) return { ok: false, errors: [`片段 ${segmentId} 不存在`] };
  const fields: Record<string, any> = { updateTime: Date.now() };
  for (const k of ["videoDesc", "prompt", "state"] as const) if (patch[k] !== undefined) fields[k] = patch[k];
  await db("o_segment").where("id", segmentId).update(fields);
  return { ok: true, errors: [], data: await db("o_segment").where("id", segmentId).first() };
}

/** 删片段（连同它的镜与绑定） */
export async function deleteSegment(db: any, segmentId: number): Promise<EditResult<{ shots: number }>> {
  const seg = await db("o_segment").where("id", segmentId).first();
  if (!seg) return { ok: false, errors: [`片段 ${segmentId} 不存在`] };
  const shots: any[] = await db("o_shot").where("segmentId", segmentId).select("id");
  const shotIds = shots.map((s) => Number(s.id));
  if (shotIds.length) await db("o_shotAssets").whereIn("shotId", shotIds).delete();
  await db("o_shot").where("segmentId", segmentId).delete();
  await db("o_segment").where("id", segmentId).delete();
  return { ok: true, errors: [], data: { shots: shotIds.length } };
}

/**
 * 新建一个片段（分镜面板"加一张卡片"）。
 *
 * 关键点：v2 里**片段时长 = 镜之和**，所以新建时必须同时给一条镜，
 * 否则会出现"时长 0 的空片段"（旧链路"空轨道"的翻版）。要求的时长会被夹到单镜上限内，
 * 想要更长就再加镜（或者之后按行编辑）。
 */
export async function addSegmentWithShot(
  db: any,
  input: {
    projectId: number;
    scriptId: number;
    prompt?: string;
    videoDesc?: string;
    duration?: number;
    state?: string;
    sceneIndex?: number;
    sceneTitle?: string;
    assetIds?: number[];
  },
): Promise<EditResult<{ id: number; segmentIndex: number; shotId: number; duration: number }>> {
  const maxRow: any = await db("o_segment").where("scriptId", input.scriptId).max({ m: "segmentIndex" }).first();
  const segmentIndex = Number(maxRow?.m ?? 0) + 1;
  const now = Date.now();
  const [id] = await db("o_segment").insert({
    projectId: input.projectId,
    scriptId: input.scriptId,
    segmentIndex,
    sceneIndex: input.sceneIndex ?? 0,
    sceneTitle: input.sceneTitle ?? "",
    duration: 0, // 先占位，下面按镜之和回填
    videoDesc: input.videoDesc ?? "",
    state: input.state ?? "未生成",
    prompt: input.prompt ?? "",
    createTime: now,
    updateTime: now,
  });
  const segmentId = Number(id);

  // 夹到单镜上限：多出来的部分要靠"再加镜/拆片段"，不能让一条镜偷偷超限
  const want = Number(input.duration);
  const dur = Number.isFinite(want) && want > 0 ? Math.min(want, MAX_SHOT_SEC) : 1;
  const shotRes = await addShot(db, segmentId, {
    duration: dur,
    action: "（新建）待填写画面描述",
    assetIds: input.assetIds,
  });
  if (!shotRes.ok) {
    // 兜底：新建的镜不合法（理论上不会）→ 回滚刚建的片段，避免留下空片段
    await db("o_segment").where("id", segmentId).delete();
    return { ok: false, errors: shotRes.errors };
  }
  const segDur = await recalcSegmentDuration(db, segmentId);
  return { ok: true, errors: [], data: { id: segmentId, segmentIndex, shotId: shotRes.data!.id, duration: segDur } };
}
