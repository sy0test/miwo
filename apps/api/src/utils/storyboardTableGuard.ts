/**
 * 分镜表覆盖保护。
 *
 * 背景（真实事故）：分镜表是前端「剥标签」写进工作区的——前端取模型回复里
 * `<storyboardTable>…</storyboardTable>` 的内层文本，直接赋给 flowData.storyboardTable，
 * 再整块 POST 给 saveFlowData 覆盖落库。模型在正文里**举例/追问/拒答**时若写出一对空壳标签
 * （如「以完整的 <storyboardTable>...</storyboardTable> 格式写入工作区」），前端会把它当数据抽出，
 * 结果 1.9 万字的分镜表被 `...` 覆盖。
 *
 * 这里做的是兜底防线：新值明显不是分镜表、而库里已有一份真分镜表时，保留库里那份。
 * 判据故意收窄（必须有 markdown 表头「序号 / 画面描述」且有一定体量），
 * 以免拦住用户在工作台对话框里的手工编辑。
 */

/** 一段文本是否「像一份分镜表」：含 markdown 表头（序号 + 画面描述）。 */
export function looksLikeStoryboardTable(v: unknown): boolean {
  if (typeof v !== "string") return false;
  return v.includes("|") && v.includes("序号") && v.includes("画面描述");
}

/**
 * 数一份分镜表里的**数据行**（已排除 markdown 表格的表头行与 `|---|` 分隔行）。
 *
 * 为什么要数行数：`looksLikeStoryboardTable()` 只判「像不像表」，一张只剩一行、
 * 却照样带表头的残缺表它照样放行。真跑遇到过「整份分镜表被覆盖成只剩一个镜头」——
 * 覆盖源是**流式过程中被剥出来的半截标签**（正文里举例的面板标签也会被当成数据）。
 * 体量下限（200 字）挡不住它：一个场头 + 一行长画面描述 + 一行动辄五六十字的台词音效，
 * 轻松超过 200 字。
 *
 * 表头行与分隔行的判据：**单元格里出现 序号/画面描述 这类列名**，或**整行都是 `---` 连字符**。
 * 两处都按「行内是否含列名」判，而不是按位置 —— 位置会在「场头/片段头」穿插时错位。
 */
export function countStoryboardRows(v: unknown): number {
  if (typeof v !== "string") return 0;
  let n = 0;
  for (const raw of v.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s/g, "")))) continue; // 分隔行
    if (cells.some((c) => c === "序号" || c === "画面描述" || c === "源片区间")) continue; // 表头行
    n++;
  }
  return n;
}

/** 体量下限：正常分镜表远大于此；低于它的非表格文本视为占位/空壳。 */
const MIN_TABLE_CHARS = 200;

/**
 * 新表相对旧表**允许收缩到的最少行数**（达不到就保留旧表）。
 *
 * 只声明「新值不是表」是不够的：真跑那次的覆盖值本身就是一张合法但残缺的表，
 * 所以这里改判**结构性收缩** —— 旧表 20 行、新表 1 行，必然不是「用户手工改成短表」，
 * 而是覆盖源坏了。留 50% 余量是因为用户确实可能手工删掉相当一部分行。
 */
const MAX_SHRINK_RATIO = 0.5;

export interface GuardResult {
  /** 应当落库的分镜表值 */
  value: unknown;
  /** 是否拦下了新值、保留了库里那份 */
  restored: boolean;
  /** 供日志用的说明（未拦截时为 null） */
  reason: string | null;
}

/**
 * 决定 storyboardTable 该落哪个值。
 * @param incoming 前端提交的新值
 * @param prevDataRaw 库里该行 data 列的原始 JSON 字符串（可能为空/损坏）
 */
export function guardStoryboardTable(incoming: unknown, prevDataRaw: unknown): GuardResult {
  // 显式清空（""）先单独早退，单独一行、不与其他判断挤在一个 `||` 里。
  // 放行是**用户意图**：前端把这一栏置空，就是要清掉旧表（重跑分镜表前的清场）。
  // 之前它和 `looksLikeStoryboardTable(incoming)` 写在同一个条件里，一旦该表达式
  // 的求值被任何前置改动影响，空串就会掉进下面「结构性收缩」分支、被当成残表而恢复旧表 ——
  // 症状是用户永远清不掉分镜表。早退分支不该与别的判据共享入口。
  if (incoming === "") return { value: "", restored: false, reason: null };

  if (looksLikeStoryboardTable(incoming)) {
    const prevTable = readPrevTable(prevDataRaw);
    // 只判「是不是表」会漏掉真跑那次事故：覆盖值本身是一张**只剩一行的残表**。
    // 因此再加一道**结构性收缩**判据 —— 旧表在多行、新表只剩一小撮时，保留旧表。
    if (looksLikeStoryboardTable(prevTable)) {
      const prevRows = countStoryboardRows(prevTable);
      const nextRows = countStoryboardRows(incoming);
      if (prevRows >= 4 && nextRows < prevRows * MAX_SHRINK_RATIO) {
        return {
          value: prevTable,
          restored: true,
          reason: `新分镜表行数从 ${prevRows} 掉到 ${nextRows}（不足 ${Math.round(MAX_SHRINK_RATIO * 100)}%），疑为残缺表覆盖，已保留库中原分镜表`,
        };
      }
    }
    return { value: incoming, restored: false, reason: null };
  }
  // 非字符串（含 undefined：本次提交没带这一栏）→ 不当作清空，保留库里那份
  const isString = typeof incoming === "string";
  if (isString && incoming.length >= MIN_TABLE_CHARS) {
    // 体量够大，可能只是用户改写成了非表格式：不拦，避免误伤手工编辑
    return { value: incoming, restored: false, reason: null };
  }

  const prevTable = readPrevTable(prevDataRaw);
  if (!looksLikeStoryboardTable(prevTable)) {
    // 库里也没有真表 —— 没有可保护的东西，放行
    return { value: incoming, restored: false, reason: null };
  }

  const shown = isString ? JSON.stringify(incoming.length > 40 ? incoming.slice(0, 40) + "…" : incoming) : String(incoming);
  return {
    value: prevTable,
    restored: true,
    reason: `新值不像分镜表（${isString ? incoming.length : 0} 字：${shown}），已保留库中原分镜表（${(prevTable as string).length} 字）`,
  };
}

/** 从 `o_agentWorkData.data` 原始 JSON 里取出上一版分镜表；坏了就返回 undefined */
function readPrevTable(prevDataRaw: unknown): unknown {
  try {
    return JSON.parse(String(prevDataRaw ?? "{}"))?.storyboardTable;
  } catch {
    return undefined;
  }
}
