/**
 * 本集约定（`o_script.brief`）
 *
 * 解决的实际 bug：用户在对话里说「台词用剧本里的英文台词」，到阶段4 就丢了 —— 因为
 * 「用户约定」既不在剧本里、也不在导演计划里，只活在被压缩的会话记忆里；而**执行层/监督层
 * 根本不读记忆**，决策层又只能把它塞进 ≤100 字的派发文案（还不落库，事后无法审计）。
 *
 * 做法：把约定变成**集级数据**（`o_script.brief`），由**代码**在每次派发时拼进上下文
 * （与 `modelInfo` 的视觉风格/画面比例同一条通道），于是四层都能看到，且不参与记忆压缩。
 *
 * 纯函数部分（parse/build/merge）不依赖数据库，便于离线验证。
 */

export type EpisodeBrief = {
  /** 用户提的硬约束，逐条原文（如「台词只保留英文题词口播」） */
  constraints: string[];
  /** 台词语言口径：source=照抄剧本原文 / en=只用英文 / zh=只用中文 / target=目标国语言 */
  dialogueLanguage?: "source" | "en" | "zh" | "target" | string;
  /** 台词来源：script-original=必须能在剧本正文里逐字找到（默认）/ free=允许改写 */
  dialogueSource?: "script-original" | "free";
  /** 其他自由备注 */
  notes?: string;
  updatedAt?: number;
};

const EMPTY: EpisodeBrief = { constraints: [] };

/** 从数据库里的原始文本解析（坏数据不抛异常，退回空约定） */
export function parseBrief(raw: string | null | undefined): EpisodeBrief {
  if (!raw) return { ...EMPTY, constraints: [] };
  try {
    const j = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!j || typeof j !== "object") return { ...EMPTY, constraints: [] };
    return {
      constraints: Array.isArray(j.constraints) ? j.constraints.map((s: unknown) => String(s)).filter(Boolean) : [],
      dialogueLanguage: j.dialogueLanguage,
      dialogueSource: j.dialogueSource === "free" ? "free" : j.dialogueSource === "script-original" ? "script-original" : undefined,
      notes: j.notes,
      updatedAt: typeof j.updatedAt === "number" ? j.updatedAt : undefined,
    };
  } catch {
    // 旧数据可能是纯文本（非 JSON）—— 当一条约束收下，总比丢掉强
    return { constraints: [String(raw).trim()].filter(Boolean) };
  }
}

/** 合并（新值覆盖旧值，constraints 去重追加） */
export function mergeBrief(prev: EpisodeBrief | null, patch: Partial<EpisodeBrief>): EpisodeBrief {
  const base = prev ?? { ...EMPTY, constraints: [] };
  const constraints = [...new Set([...(base.constraints ?? []), ...(patch.constraints ?? [])].map((s) => s.trim()).filter(Boolean))];
  return { ...base, ...patch, constraints, updatedAt: Date.now() };
}

/**
 * 拼成可注入每一层的文本块（空约定返回 ""，不污染 prompt）。
 * 注入点：决策层 + 各执行层 + 监督层（只走代码，不依赖模型自觉复述）。
 */
export function buildBriefBlock(brief: EpisodeBrief | null | undefined): string {
  if (!brief) return "";
  const lines: string[] = [];
  for (const c of brief.constraints ?? []) lines.push(`- ${c}`);
  if (brief.dialogueLanguage === "en") lines.push("- 台词语言：**只用英文**（剧本里的英文原文；不要输出中文台词、不要中英双语）");
  if (brief.dialogueLanguage === "zh") lines.push("- 台词语言：**只用中文**");
  if (brief.dialogueLanguage === "target") lines.push("- 台词语言：**目标国语言**");
  if (brief.dialogueSource === "script-original") lines.push("- 台词来源：**必须逐字来自剧本原文**，不得改写、不得翻译（与「台词零删改」铁律一致）");
  if (brief.dialogueSource === "free") lines.push("- 台词来源：允许在保持语义的前提下改写");
  if (brief.notes) lines.push(`- 备注：${brief.notes}`);
  if (!lines.length) return "";
  return `## 本集约定（用户明确要求，硬约束，任何阶段都不得违反）\n${lines.join("\n")}`;
}

/** 由约定推导校验选项（「台词必须来自剧本」只在约定明确时才强制） */
export function briefValidationHints(brief: EpisodeBrief | null | undefined): { requireDialogueFromScript: boolean } {
  return { requireDialogueFromScript: brief?.dialogueSource === "script-original" };
}

// ============================================================
// 数据库读写（db 注入，便于脱离应用验证）
// ============================================================

export async function loadBrief(db: any, scriptId: number): Promise<EpisodeBrief | null> {
  const row = await db("o_script").where("id", scriptId).select("brief").first();
  if (!row) return null;
  const brief = parseBrief(row.brief);
  return brief.constraints.length || brief.dialogueLanguage || brief.notes ? brief : null;
}

export async function saveBrief(db: any, scriptId: number, brief: EpisodeBrief): Promise<void> {
  const next = { ...brief, updatedAt: Date.now() };
  await db("o_script").where("id", scriptId).update({ brief: JSON.stringify(next) });
}
