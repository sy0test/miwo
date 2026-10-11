/**
 * 片段级「引用资产」绑定（v2 唯一的手工绑写入入口）。
 *
 * ## 为什么需要（真机 bug）
 * v2 下"给一个片段选资产"这件事**原本没有任何接口落库**：
 *   · 视频工作台里选的素材只进前端 `imageListCache`（Pinia/localStorage）；
 *   · 分镜面板改卡片走的 `batchAddStoryboardInfo` 在 v2 下被改成"只回投影、不写库"。
 * 结果是：关掉工作台再进来（甚至同一浏览器刷新）素材就没了 ——
 * 因为 `initCacheFromTrackList` 会丢弃「有 id 但服务端这次不返回」的条目，
 * 而服务端从来不知道这些绑定（`o_shotAssets` 里没有它们）。
 *
 * ## 真相在文本，所以两处都要改
 * v2 的绑定真相是**分镜表文本**里的 `**引用资产名称** / **引用资产ID**` 两行，
 * 解析后才落 `o_shotAssets`。因此这里：
 *   1. 写 `o_shotAssets`（该片段**所有镜**，与 persistShots 的"片段级资产派发到每一镜"一致）
 *   2. **同步改文本里该片段那两行**（其余逐字不动）—— 不改文本的话，下次再解析会把绑定覆盖回去
 *
 * 不 import 任何 `@/` 模块：便于 `docs/tools/*.cjs` 用真 SQLite 离线验证。
 */
import { setShotAssets } from "./editShots";

const ASSET_NAME_RE = /^(\s*)(\*{0,2})引用资产名称(\*{0,2})(\s*[：:]\s*)(.*)$/;
const ASSET_ID_RE = /^(\s*)(\*{0,2})引用资产ID(\*{0,2})(\s*[：:]\s*)(.*)$/i;
const SEGMENT_HEADING_RE = /^###\s/;

export type BindResult = {
  ok: boolean;
  errors: string[];
  /** 实际落库的资产 id（已按 o_assets 存在性过滤、排序、去重） */
  assetIds: number[];
  /** 文本是否被改动 */
  changedText: boolean;
};

/** 资产存在性权威 = `o_assets`（不是 o_scriptAssets —— 那是"本集挂载"，与存在性无关） */
async function filterExistingAssets(db: any, assetIds: number[]): Promise<number[]> {
  const wanted = [...new Set((assetIds ?? []).map(Number).filter((n) => Number.isFinite(n)))];
  if (!wanted.length) return [];
  const rows: any[] = await db("o_assets").whereIn("id", wanted).select("id");
  return rows.map((r) => Number(r.id)).sort((a, b) => a - b);
}

/** 取资产名称（用于文本里的「引用资产名称」行） */
async function assetNamesOf(db: any, assetIds: number[]): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  if (!assetIds.length) return map;
  const rows: any[] = await db("o_assets").whereIn("id", assetIds).select("id", "name");
  for (const r of rows) map.set(Number(r.id), String(r.name ?? ""));
  return map;
}

/**
 * 只改分镜表文本里**某一个片段**的「引用资产名称 / 引用资产ID」两行；其余行逐字不动。
 *
 * 定位方式：按 `### ` 标题出现的顺序数 —— 解析器就是按文件顺序给 `segmentIndex` 编号的，
 * 所以第 k 个 `### 片段` 块就是 segmentIndex = k 的片段。
 */
export async function syncSegmentAssetLines(db: any, opts: { projectId: number; scriptId: number; segmentIndex: number; assetIds: number[]; assetNames?: Map<number, string> }): Promise<boolean> {
  const { projectId, scriptId, segmentIndex, assetIds } = opts;
  const row: any = await db("o_agentWorkData").where("projectId", String(projectId)).andWhere("episodesId", String(scriptId)).andWhere("key", "productionAgent").first();
  if (!row?.data) return false;
  let parsed: any;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return false;
  }
  const text: string = parsed?.storyboardTable ?? "";
  if (!text.trim()) return false;

  const names = opts.assetNames ?? (await assetNamesOf(db, assetIds));
  const idLine = `**引用资产ID**：[${assetIds.join(", ")}]`;
  const nameLine = `**引用资产名称**：[${assetIds.map((id) => names.get(id) ?? String(id)).join(", ")}]`;

  const lines = text.split(/\r?\n/);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  // 找到目标片段的块范围
  let seen = 0;
  let start = -1;
  let end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    if (SEGMENT_HEADING_RE.test(lines[i])) {
      seen += 1;
      if (seen === segmentIndex) start = i;
      else if (start >= 0) {
        end = i;
        break;
      }
    }
  }
  if (start < 0) return false; // 文本里没有这个片段（例如文本被手动删过）→ 不乱写

  // 在该块内找这两行（片头下面两行；容忍已存在/缺失/顺序不同）
  let idAt = -1;
  let nameAt = -1;
  for (let i = start + 1; i < end; i++) {
    if (ASSET_ID_RE.test(lines[i]) && idAt < 0) idAt = i;
    else if (ASSET_NAME_RE.test(lines[i]) && nameAt < 0) nameAt = i;
  }

  const next = [...lines];
  if (idAt >= 0) next[idAt] = idLine;
  if (nameAt >= 0) next[nameAt] = nameLine;
  if (idAt < 0 || nameAt < 0) {
    // 缺行 → 插在片头之后（名称在前、ID 在后），保持技能里的格式
    const insertAt = start + 1;
    const toInsert: string[] = [];
    if (nameAt < 0) toInsert.push(nameLine);
    if (idAt < 0) toInsert.push(idLine);
    next.splice(insertAt, 0, ...toInsert);
  }

  const newText = next.join(eol);
  if (newText === text) return false;
  parsed.storyboardTable = newText;
  await db("o_agentWorkData").where("projectId", String(projectId)).andWhere("episodesId", String(scriptId)).andWhere("key", "productionAgent").update({ data: JSON.stringify(parsed), updateTime: Date.now() });
  return true;
}

/**
 * 给一个片段设置引用资产：写 `o_shotAssets`（该片段所有镜）+ 同步分镜表文本。
 * `syncText=false` 时只写库（批量场景最后统一刷文本，避免 N 次重写整表）。
 */
export async function bindSegmentAssets(db: any, opts: { projectId: number; scriptId: number; segmentId: number; assetIds: number[]; syncText?: boolean }): Promise<BindResult> {
  const { projectId, scriptId, segmentId } = opts;
  const seg: any = await db("o_segment").where("id", segmentId).first();
  if (!seg) return { ok: false, errors: [`片段 ${segmentId} 不存在`], assetIds: [], changedText: false };

  const valid = await filterExistingAssets(db, opts.assetIds ?? []);
  const dropped = [...new Set((opts.assetIds ?? []).map(Number))].filter((n) => !valid.includes(n));
  const shots: any[] = await db("o_shot").where("segmentId", segmentId).select("id");
  for (const s of shots) await setShotAssets(db, Number(s.id), valid);

  let changedText = false;
  if (opts.syncText !== false) {
    changedText = await syncSegmentAssetLines(db, { projectId, scriptId, segmentIndex: Number(seg.segmentIndex), assetIds: valid });
  }
  return {
    ok: true,
    errors: dropped.length ? [`以下资产不存在于资产库，已忽略：${dropped.join(", ")}`] : [],
    assetIds: valid,
    changedText,
  };
}

/**
 * 把**所有片段**的「引用资产名称/ID」两行刷成库里 `o_shotAssets` 的现状（一次遍历，只重写必要的行）。
 * 面板批量提交后用它统一收口。
 */
export async function syncAllSegmentAssetLines(db: any, opts: { projectId: number; scriptId: number }): Promise<{ segments: number; changed: number }> {
  const segs: any[] = await db("o_segment").where("scriptId", opts.scriptId).orderBy("segmentIndex", "asc");
  let changed = 0;
  for (const seg of segs) {
    const shots: any[] = await db("o_shot").where("segmentId", seg.id).select("id");
    const shotIds = shots.map((s) => Number(s.id));
    const rows: any[] = shotIds.length ? await db("o_shotAssets").whereIn("shotId", shotIds).select("assetId") : [];
    const ids = [...new Set(rows.map((r) => Number(r.assetId)))].sort((a, b) => a - b);
    const did = await syncSegmentAssetLines(db, { projectId: opts.projectId, scriptId: opts.scriptId, segmentIndex: Number(seg.segmentIndex), assetIds: ids });
    if (did) changed++;
  }
  return { segments: segs.length, changed };
}
