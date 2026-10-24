# 转绘 A · 解析层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **迁移说明（2026-10-21 从 toonflow-upstream 迁入 miwo）**
> 本计划已完成并随代码迁入 miwo：文中 `src/…` = `apps/api/src/…`，`code/toonflow-web/src/…` = `apps/web/src/…`。
> 文中「本仓库不是 git 仓库 / 仓库没有测试框架 / 前端 type-check 是坏的」等**环境约束已过期**：
> miwo 有 git、有 vitest、有 `pnpm typecheck`。任务清单保留原样作为实现记录，不要按它的环境约束办事。
> 现状与差距见 [`docs/redraw-status-contract.md`](../../redraw-status-contract.md)。

**Goal:** 让转绘解析层除了现有的资产清单与分镜表，再产出**剧本**与**导演计划**并真正落库，同时把「解析完成」从一个终态改成「待对账」的中间态。

**Architecture:** 复用现有的一次调用内核 `analyzeRedrawAssets`（`src/utils/redrawAnalyze.ts`），把它的输出契约从两个块扩到四个块；新块用已有的、标签无关的 `extractBlock` 取出，剧本写进 `o_script.content`、导演计划写进 `o_agentWorkData`。不新增表、不新增列、不改调用结构。

**Tech Stack:** Node + TypeScript（`tsx` 直跑）、Express、knex + better-sqlite3、Vue 3 + TDesign（前端仅一处状态渲染）。

**Spec:** `D:/sy_workspace/docs/superpowers/specs/2026-10-05-redraw-three-layer-pipeline-design.md`（§4 数据落点、§5 解析层、§8 状态机）

## Global Constraints

- **零新表、零新列**。剧本 → `o_script.content`；导演计划 → `o_agentWorkData`。两张表都已存在。
- **语言政策**（既定，不得偏离）：说明性文字全中文；只有资产名与台词译文用目标国语言；`原台词` 照录不译。
- **输出契约必须四处同步**。这四个地方任何一个漏改，模型与代码就对不上：
  1. `data/skills/feicai/redraw-analysis-skill/SKILL.md` 的 `[输出格式]`
  2. 同文件 `[执行流程]` 第五步
  3. 同文件 `[硬性约束]` 第 8 条
  4. `src/utils/redrawAnalyze.ts` 的 prompt 契约行（现为第 179 行 `"按 [输出格式] 输出 \`<assetSheet>\` 与 \`<storyboardTable>\` 两个块。"`）
- **仓库没有测试框架**。验证一律用 `scratch-*.ts` + `npx tsx`（仓库既有 8 个 `scratch-*` 脚本，`scratch-redraw-parse.ts` 是转绘解析的验证基线）。类型安全用 `yarn lint`（= `tsc --noEmit`）。
- **本仓库不是 git 仓库**（`git rev-parse` 报 not a repository）。因此**没有提交步骤** —— 每个任务末尾改为「列出改动文件」，人工确认。
- **前端 `yarn type-check` 本来就是坏的**（TS5103），不要拿它当门禁，也不要去修它。
- 不要动 `code/seedance_flow/` 下的任何文件 —— 那是只读参考副本。

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `data/skills/feicai/redraw-analysis-skill/SKILL.md` | 技能的输出契约正文 | 改 4 处（输出格式块 ×3、执行流程 ×1、硬性约束 ×1、frontmatter ×1） |
| `scratch-verify-redraw-contract.ts` | 断言四处契约同步一致 | 新建 |
| `src/utils/redraw.ts` | `writeRedraw` 落库 | 改：加 `skipAssets` 开关（解析层不建资产行） |
| `src/utils/redrawAnalyze.ts` | 解析内核：调模型、解析四块、落库 | 改：契约行、解析、三个 persist、返回类型 |
| `src/routes/redraw/analyzeSource.ts` | 界面「开始分析」入口 | 改 1 行：成功后状态 1 → 3 |
| `code/toonflow-web/src/views/inputVideo/index.vue` | 源片卡片，渲染状态 | 加一个 `extractState === 3` 分支 |
| `code/toonflow-web/src/locales/language/*.json` | 文案 | 7 个语言文件各加 1 个 key |

---

### Task 1: 技能输出契约加两个块，并立一道同步护栏

两个新块是**全新**的（全仓库没有任何 `<scriptBody>` / `<directorPlan>` 字面量）。这一步先把技能正文改对，同时留下一个断言脚本，防止后四处契约各自漂移。

**Files:**
- Create: `scratch-verify-redraw-contract.ts`
- Modify: `data/skills/feicai/redraw-analysis-skill/SKILL.md`

**Interfaces:**
- Consumes: 无
- Produces: 技能正文里的四个块标签 `<scriptBody>` / `<directorPlan>` / `<assetSheet>` / `<storyboardTable>` —— Task 2 的解析代码依赖这四个标签名逐字一致。

- [ ] **Step 1: 写护栏脚本（此时必然失败）**

新建 `scratch-verify-redraw-contract.ts`（放在仓库根，与既有 `scratch-*.ts` 同级）：

```ts
// 临时验证脚本：转绘技能的「输出块契约」在技能正文的几处声明里是否一致。
// 跑法：在仓库根执行 npx tsx scratch-verify-redraw-contract.ts
import fs from "fs";
import path from "path";

const SKILL = path.resolve(process.cwd(), "data/skills/feicai/redraw-analysis-skill/SKILL.md");
const src = fs.readFileSync(SKILL, "utf8");

const BLOCKS = ["<scriptBody>", "<directorPlan>", "<assetSheet>", "<storyboardTable>"];

/** 取 `[小节名]` 到下一个 `[小节名]`（或文件尾）之间的正文 */
function section(name: string): string {
  const start = src.indexOf(`[${name}]`);
  if (start < 0) throw new Error(`技能里找不到小节 [${name}]`);
  const rest = src.slice(start + name.length + 2);
  const next = rest.search(/\n\[[^\]]+\]/);
  return next < 0 ? rest : rest.slice(0, next);
}

const ok: string[] = [];
const fail: string[] = [];
const check = (name: string, cond: boolean) => (cond ? ok : fail).push(name);

const fmt = section("输出格式");
const flow = section("执行流程");
const hard = section("硬性约束");

// 1) 四个块的写法必须在 [输出格式] 里各自出现
for (const b of BLOCKS) check(`[输出格式] 声明了 ${b}`, fmt.includes(b));

// 2) [输出格式] 的开头必须说「四个块」，且不能再留着「两个块」
check("[输出格式] 说「四个块」", /四个块/.test(fmt));
check("[输出格式] 不再说「两个块」", !/两个块/.test(fmt));

// 3) [执行流程] 第五步与 [硬性约束] 第 8 条都按「四个」计数
check("[执行流程] 说「四个 XML 块」", /四个\s*XML\s*块/.test(flow));
check("[硬性约束] 说「四个 XML 块」", /四个\s*XML\s*块/.test(hard));

// 4) 防误伤：改契约时别把「块内禁止嵌套 XML」这条守卫一起改掉了。
//    注：这里原本还想断言「分镜表仍 12 列」，但 SKILL.md 里那句话的措辞没逐字核对过，
//    写死正则会给出假失败 —— 先不加。要加就按技能正文里的实际写法填正则。
check("[输出格式] 仍禁止嵌套 XML", /禁止嵌套/.test(fmt));

console.log("PASS:", ok.length);
ok.forEach((o) => console.log("  ✓", o));
if (fail.length) {
  console.log("FAIL:", fail.length);
  fail.forEach((f) => console.log("  ✗", f));
  process.exit(1);
}
console.log("\n全部通过");
```

- [ ] **Step 2: 跑它，确认它失败**

Run: `npx tsx scratch-verify-redraw-contract.ts`
Expected: FAIL。至少这几条挂掉 —— `[输出格式] 声明了 <scriptBody>`、`[输出格式] 声明了 <directorPlan>`、`[输出格式] 说「四个块」`、`[执行流程] 说「四个 XML 块」`、`[硬性约束] 说「四个 XML 块」`。

- [ ] **Step 3: 改技能正文 —— 开头的块数声明**

在 `SKILL.md` 的 `[输出格式]` 里，把这两行：

```
      两个块：`<assetSheet>` 与 `<storyboardTable>`。
      各自**一次性输出**，块内只放纯 markdown，**禁止嵌套任何其他 XML 标签**。
```

改成：

```
      四个块：`<scriptBody>`、`<directorPlan>`、`<assetSheet>` 与 `<storyboardTable>`。
      各自**一次性输出**，块内只放纯 markdown，**禁止嵌套任何其他 XML 标签**。
```

- [ ] **Step 4: 改技能正文 —— 插入两个新块，并把原有两块改编号**

在 `[输出格式]` 里，把 `      ---------- 块一：资产清单 ----------` 这一行**替换**为下面这一整段（即：新块插在资产清单之前，资产清单从「块一」变「块三」）：

```
      ---------- 块一：剧本 ----------

      <scriptBody>
      ## 场1：江边教学楼走廊

      午后。Emily 攥着手机站在走廊尽头，指节因为用力而泛白。她盯着屏幕，
      像是在等一个不会来的消息。手机震了一下，她几乎是立刻低头去看。
      （镜头 1-2）

      她猛地把手机扣在膝上，站起身，椅子向后刮过地面，快步朝门口走去。
      她没有回头。
      （镜头 3-4）
      </scriptBody>

      这是**给人读的剧本**：把分镜表里逐镜的画面连成能顺着读下去的叙述。
      用途是让人一眼看出这一集讲了什么、和源片是不是一回事。

      - **按场分段**，每段末尾用「（镜头 起-止）」标注对应的分镜表 `序号`。
      - 只写画面里**看得见**的东西：谁在做什么、什么表情、动作怎么变化。
        不写心理推断，不写「她意识到」这类判断。
      - 台词写**中文回译**（即 `台词` 列括号里的那句），**不写目标国语言**——
        目标国语言的定稿在分镜表 `台词` 列，剧本只负责让人读懂，不制造第二份译文。
      - 光影、色调、BGM 一律不进剧本。
      - 人名、地名用目标国化之后的写法，**其余正文一律中文**（见 [语言政策]）。
      - 长度随片长走，不注水、不漏场次。

      ---------- 块二：导演计划 ----------

      <directorPlan>
      ## 目标国适配
      本次把故事整体挪到当代{目标国}：人种按 {目标国} 写，校园制服改为西装式校服，
      「青云令」替换为家族信物。

      ## 语言处理
      台词用当代{目标国}口语，不用书面语；受时长配额挤压时优先砍修饰语，不改信息。

      ## 节奏与情绪
      前段压着演，情绪在走廊那场爆开；整体不加快，保留原片的留白。
      </directorPlan>

      这是**本次转绘的策略说明**，不是剧情复述。源片的导演意图已经拍出来了，
      这里说的是「从源片到目标国版本，这次打算怎么改」。

      - `目标国适配`：人种 / 服饰 / 场景 / 文化符号的替换原则与本次取舍。
      - `语言处理`：目标国语言的语气与用词基调，以及台词超时长时的处理倾向。
      - `节奏与情绪`：整片的节奏基线与情绪落点。
      - 只写这次**打算怎么做**，不逐镜复述分镜表。

      ---------- 块三：资产清单 ----------
```

- [ ] **Step 5: 改技能正文 —— 分镜表的块编号**

把 `      ---------- 块二：分镜表 ----------` 这一行改成：

```
      ---------- 块四：分镜表 ----------
```

- [ ] **Step 6: 改技能正文 —— 执行流程第五步**

在 `[执行流程]` 里，把：

```
    **第五步 · 一次性输出**
        按 [输出格式] 输出两个 XML 块。此后不再调用任何工具，任务终止。
```

改成：

```
    **第五步 · 一次性输出**
        按 [输出格式] 输出四个 XML 块。此后不再调用任何工具，任务终止。
```

- [ ] **Step 7: 改技能正文 —— 硬性约束第 8 条**

在 `[硬性约束]` 里，把：

```
    8. 两个 XML 块各一次性输出，禁止拆成多次。
```

改成：

```
    8. 四个 XML 块各一次性输出，禁止拆成多次。
```

- [ ] **Step 8: 改技能正文 —— frontmatter 描述**

把 `SKILL.md` 头部的 frontmatter `description` 一行：

```yaml
description: 出海转绘 · 源视频拆解技能。把源视频的拼贴图、帧级切点表与词级转写稿，一次性拆解为「目标国资产清单」与「分镜表」。
```

改成：

```yaml
description: 出海转绘 · 源视频拆解技能。把源视频的拼贴图、帧级切点表与词级转写稿，一次性拆解为「剧本」「导演计划」「目标国资产清单」与「分镜表」。
```

- [ ] **Step 9: 跑护栏，确认全绿**

Run: `npx tsx scratch-verify-redraw-contract.ts`
Expected: PASS，9 项全过（4 条块声明 + 「四个块」 + 不再有「两个块」 + 执行流程 + 硬性约束 + 禁止嵌套）。

- [ ] **Step 10: 记录改动文件**

本仓库无 git，手工确认本任务只动了这两个文件：
- `data/skills/feicai/redraw-analysis-skill/SKILL.md`（改）
- `scratch-verify-redraw-contract.ts`（新建）

---

### Task 2: 解析内核出四个块，三个新产物落库（且不碰 `o_assets`）

**Files:**
- Modify: `src/utils/redraw.ts`（给 `writeRedraw` 加 `skipAssets`）
- Modify: `src/utils/redrawAnalyze.ts`
- Test: `scratch-verify-redraw-persist.ts`（新建）

**Interfaces:**
- Consumes: Task 1 定下的四个标签名 `<scriptBody>` / `<directorPlan>` / `<assetSheet>` / `<storyboardTable>`。
- Produces:
  - `RedrawAnalyzeResult` 新增两个字段 `scriptBodyChars: number`、`directorPlanChars: number`（只回长度不回正文，避免把整份剧本塞进 HTTP 响应）。
  - `writeRedraw` 新增可选参数 `skipAssets?: boolean`（转绘层 Task C 不传它，保持默认 false）。
  - 落库副作用：`o_script.content` = 剧本正文；`o_agentWorkData` 两行 —— `key: "redrawDirectorPlan"` 存导演计划、`key: "redrawAssetDraft"` 存资产清单草稿。**`o_assets` 一行都不新增**（spec §5/§12）。

- [ ] **Step 1: 写失败测试**

新建 `scratch-verify-redraw-persist.ts`（仓库根）：

```ts
// 临时验证脚本：解析层两个新块的落库行为。
// 不调模型 —— 直接把「模型回复」当成字符串喂给解析与落库的那几个函数。
// 跑法：在仓库根执行 npx tsx scratch-verify-redraw-persist.ts
import fs from "fs";
import os from "os";
import path from "path";
import { extractBlock } from "@/utils/redraw";

const ok: string[] = [];
const fail: string[] = [];
const check = (name: string, cond: boolean) => (cond ? ok : fail).push(name);

const REPLY = [
  "<scriptBody>",
  "## 场1：江边教学楼走廊",
  "午后。Emily 攥着手机站在走廊尽头。",
  "</scriptBody>",
  "<directorPlan>",
  "## 目标国适配",
  "整体挪到当代{目标国}。",
  "</directorPlan>",
  "<assetSheet>",
  "## 角色",
  "### Emily（源片：苏晚卿）",
  "- 说明：约 24 岁东亚女性。",
  "- 出图提示词：{视觉风格}风格，画面比例16:9，……",
  "</assetSheet>",
  "<storyboardTable>",
  "## 场1：走廊 ｜ 参演角色：Emily",
  "### 片段一（4s）",
  "**引用资产名称**：[Emily]",
  "| 序号 | 源片区间 | 画面描述 | 时长 | 景别 | 运镜 | 角色动作 | 情绪 | 光影氛围 | 原台词 | 台词 | 音效 |",
  "|------|---------|---------|------|------|------|---------|------|---------|-------|------|------|",
  "| 1 | 0.000-3.233 | 她攥紧手机。 | 4 | 近景 | 缓推 | 攥紧手机 | 压抑的隐忍 | 午后侧逆光，冷调 | 你到底有没有在听我说话？ | Emily说：『Are you even listening to me?（你到底有没有在听我说话？）』 | 音效：手机震动声 |",
  "</storyboardTable>",
].join("\n");

// 1) 四个块都能被已有的 extractBlock 取出来（它是标签无关的，不需要为新块改它）
check("取得到 <scriptBody>", !!extractBlock(REPLY, "scriptBody"));
check("取得到 <directorPlan>", !!extractBlock(REPLY, "directorPlan"));
check("剧本块内容正确", extractBlock(REPLY, "scriptBody")!.includes("江边教学楼走廊"));
check("导演计划块内容正确", extractBlock(REPLY, "directorPlan")!.includes("目标国适配"));

// 2) 缺块时必须被认出来（四个块逐个抠掉，缺哪个就要报哪个）
for (const tag of ["scriptBody", "directorPlan", "assetSheet", "storyboardTable"]) {
  const without = REPLY.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`), "");
  check(`抠掉 <${tag}> 后取不到它`, extractBlock(without, tag) === null);
}

// 3) 落库的三个 helper 必须存在且可导入（签名对不上就导不进来）
const mod = await import("@/utils/redrawAnalyze");
check("导出了 persistScriptBody", typeof (mod as any).persistScriptBody === "function");
check("导出了 persistDirectorPlan", typeof (mod as any).persistDirectorPlan === "function");
check("导出了 persistAssetDraft", typeof (mod as any).persistAssetDraft === "function");
check("导出了 DIRECTOR_PLAN_KEY", typeof (mod as any).DIRECTOR_PLAN_KEY === "string");
check("导出了 ASSET_DRAFT_KEY", typeof (mod as any).ASSET_DRAFT_KEY === "string");

// 4) writeRedraw 必须长出了 skipAssets 开关 —— 解析层靠它不建 o_assets 行
check(
  "writeRedraw 有 skipAssets",
  /skipAssets/.test(fs.readFileSync(path.resolve(process.cwd(), "src/utils/redraw.ts"), "utf8")),
);

console.log("PASS:", ok.length);
ok.forEach((o) => console.log("  ✓", o));
if (fail.length) {
  console.log("FAIL:", fail.length);
  fail.forEach((f) => console.log("  ✗", f));
  process.exit(1);
}
console.log("\n全部通过");
```

- [ ] **Step 2: 跑它，确认它失败**

Run: `npx tsx scratch-verify-redraw-persist.ts`
Expected: FAIL 于最后六条 —— 三个 persist helper、两个 key 常量，以及 `writeRedraw 有 skipAssets`（都还不存在）。前面 8 条（4 条 `extractBlock` 取值/内容 + 4 条抠块）应当已经 PASS —— `extractBlock` 本来就是标签无关的，新块不需要改它。

- [ ] **Step 3: 加常量与三个落库 helper**

在 `redrawAnalyze.ts` 里，`const AGENT_KEY = "redrawAgent:analysisAgent";` 之后追加：

```ts
/**
 * `o_agentWorkData` 的一行 upsert。键法与读法照 `routes/production/getFlowData.ts:18-21`：
 * where 用 String()、insert 用数字；`key` 是区分同一集里不同产物的唯一开关。
 */
async function upsertWorkData(projectId: number, episodesId: number, key: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value);
  const hit = await u
    .db("o_agentWorkData")
    .where("projectId", String(projectId))
    .andWhere("episodesId", String(episodesId))
    .andWhere("key", key)
    .first();
  if (hit) {
    await u.db("o_agentWorkData").where("id", hit.id).update({ data, updateTime: Date.now() });
    return;
  }
  await u.db("o_agentWorkData").insert({
    projectId,
    episodesId,
    key,
    data,
    createTime: Date.now(),
    updateTime: Date.now(),
  });
}

/** 导演计划的工作区 key */
export const DIRECTOR_PLAN_KEY = "redrawDirectorPlan";
/** 资产清单草稿的工作区 key —— 解析层不落 o_assets，草稿先存这儿等关联层认账 */
export const ASSET_DRAFT_KEY = "redrawAssetDraft";

/** 把剧本写进 o_script.content —— 剧本页与生产页读的就是这一列 */
export async function persistScriptBody(scriptId: number, body: string): Promise<void> {
  await u.db("o_script").where("id", scriptId).update({ content: body.trim() });
}

/** 导演计划落工作区 */
export async function persistDirectorPlan(projectId: number, episodesId: number, plan: string): Promise<void> {
  await upsertWorkData(projectId, episodesId, DIRECTOR_PLAN_KEY, { plan: plan.trim() });
}

/**
 * 资产清单草稿落工作区 —— **不进 `o_assets`**。
 * spec §5：资产要等关联层跟用户认完账才落库；§12 的验收就是「解析层跑完，`o_assets` 没有新增行」。
 */
export async function persistAssetDraft(projectId: number, episodesId: number, sheet: RedrawAssetSheet): Promise<void> {
  await upsertWorkData(projectId, episodesId, ASSET_DRAFT_KEY, { assets: sheet.assets });
}
```

> `RedrawAssetSheet` 若不在该文件已有的 `from "./redraw"` 导入列表里，补进去。

- [ ] **Step 4: 给 `writeRedraw` 加 `skipAssets`**

在 `src/utils/redraw.ts` 的 `writeRedraw` 里，**三处**改动。

**(a)** 签名解构那一行：

```ts
  const { projectId, scriptId, sheet, board, replace = false } = opts;
```

改成：

```ts
  const { projectId, scriptId, sheet, board, replace = false, skipAssets = false } = opts;
```

**(b)** `opts` 类型里，`replace` 那个字段之后加：

```ts
    /**
     * 不建 `o_assets` 行，只写分镜。解析层用 —— 资产要先经关联层跟用户认账，
     * 此时落库等于绕过用户。源片分镜表的资产槽留空（12 槽不错位），绑定等转绘层补。
     */
    skipAssets?: boolean;
```

**(c)** 资产循环（`// ---- 1. 资产：同名同类型复用 ----` 下面、以 `const assetIds: Record<string, number> = {};` 开头的那段 `for`）外面包一层条件，**循环体一行不改**：

```ts
  const assetIds: Record<string, number> = {};
  if (!skipAssets) {
    for (const a of sheet.assets) {
      // ……原样保留……
    }
  }
```

**(d)** 分镜循环里收集 `missing` 的那两行：

```ts
      const id = assetIds[n];
      if (id === undefined) missing.add(n);
      else ids.push(id);
```

改成：

```ts
      const id = assetIds[n];
      // skipAssets 下 assetIds 本来就是空的 —— 「缺资产」是这一步的本意，不是要报的错
      if (id === undefined) {
        if (!skipAssets) missing.add(n);
      } else ids.push(id);
```

- [ ] **Step 5: 跑测试，确认全绿**

Run: `npx tsx scratch-verify-redraw-persist.ts`
Expected: PASS，14 项全过（8 条块相关 + 3 个 persist helper + 2 个 key 常量 + 1 条 `skipAssets`）。

- [ ] **Step 6: 改 prompt 契约行**

在 `redrawAnalyze.ts` 里，把：

```ts
      "按 [输出格式] 输出 `<assetSheet>` 与 `<storyboardTable>` 两个块。",
```

改成：

```ts
      "按 [输出格式] 输出 `<scriptBody>`、`<directorPlan>`、`<assetSheet>` 与 `<storyboardTable>` 四个块。",
```

- [ ] **Step 7: 改解析段，四个块都取、缺一即失败**

在 `redrawAnalyze.ts` 里，把现有的这一段：

```ts
  const sheetBlock = extractBlock(reply, "assetSheet");
  const boardBlock = extractBlock(reply, "storyboardTable");
  if (!sheetBlock || !boardBlock) {
    const miss = [!sheetBlock && "<assetSheet>", !boardBlock && "<storyboardTable>"].filter(Boolean).join(" ");
    fail(422, `模型回复里缺块：${miss}。回复 ${reply.length} 字符，原文已存 ${dump}`);
  }
```

整个替换为：

```ts
  const scriptBlock = extractBlock(reply, "scriptBody");
  const planBlock = extractBlock(reply, "directorPlan");
  const sheetBlock = extractBlock(reply, "assetSheet");
  const boardBlock = extractBlock(reply, "storyboardTable");
  if (!scriptBlock || !planBlock || !sheetBlock || !boardBlock) {
    const miss = [
      !scriptBlock && "<scriptBody>",
      !planBlock && "<directorPlan>",
      !sheetBlock && "<assetSheet>",
      !boardBlock && "<storyboardTable>",
    ]
      .filter(Boolean)
      .join(" ");
    fail(422, `模型回复里缺块：${miss}。回复 ${reply.length} 字符，原文已存 ${dump}`);
  }
```

- [ ] **Step 8: 让 `writeRedraw` 跳过资产，并插入三个 persist**

在同文件，把落库那一行 `const written = await writeRedraw(u.db, { projectId, scriptId: sid, sheet, board, replace });`（`redrawAnalyze.ts:240`）改成带 `skipAssets: true`，并紧跟其后（原有 `dialogue-map.md` 落盘之前）插入三个调用：

```ts
  // 解析层只写分镜、不建资产：资产要等关联层跟用户认完账（spec §5）。
  const written = await writeRedraw(u.db, { projectId, scriptId: sid, sheet, board, replace, skipAssets: true });

  // 剧本、导演计划、资产清单草稿 —— 三个新产物，和分镜表同一次调用产出。
  // 都放在 writeRedraw 之后：它负责建/复用 o_script 行。
  await persistScriptBody(sid, scriptBlock!);
  await persistDirectorPlan(projectId, sid, planBlock!);
  await persistAssetDraft(projectId, sid, sheet);
```

> 文件里这一行的变量名是 `sid`（`resolveScriptId` 的返回值），不是 `scriptId`。按实际名写。

- [ ] **Step 9: 扩 `RedrawAnalyzeResult` 与返回值**

类型里加两个字段：

```ts
  /** 剧本正文字符数（只回长度，不回正文 —— 正文在 o_script.content） */
  scriptBodyChars: number;
  /** 导演计划字符数（同上，正文在 o_agentWorkData） */
  directorPlanChars: number;
```

`return { ... }` 里对应加：

```ts
    scriptBodyChars: scriptBlock!.trim().length,
    directorPlanChars: planBlock!.trim().length,
```

- [ ] **Step 10: 类型检查**

Run: `yarn lint`
Expected: 无输出（`tsc --noEmit` 干净）。若报 `RedrawAnalyzeResult` 缺字段，说明 Step 9 只改了一处 —— 类型和返回都要加。

- [ ] **Step 11: 真跑一次，确认三个产物进了库、`o_assets` 没动**

先记下当前资产行数：

```bash
npx tsx -e "import u from '@/utils'; (async()=>{ console.log('资产行数', (await u.db('o_assets').where('projectId',<projectId>).count({n:'*'}).first()).n); process.exit(0); })()"
```

启动后端（`yarn dev`），对一个已有源片的集跑一次分析（界面点「开始分析」，或直接 `POST /api/redraw/analyzeSource`，body `{ "projectId": <projectId>, "scriptId": <scriptId> }`），再跑：

```bash
npx tsx -e "import u from '@/utils'; (async()=>{ const P=<projectId>, S=<scriptId>; const s=await u.db('o_script').where('id',S).first(); console.log('剧本长度', (s.content||'').length); const w=await u.db('o_agentWorkData').where('episodesId',String(S)); const plan=w.find(r=>r.key==='redrawDirectorPlan'); const draft=w.find(r=>r.key==='redrawAssetDraft'); console.log('导演计划', plan? JSON.parse(plan.data).plan.slice(0,50):'（缺）'); console.log('资产草稿', draft? JSON.parse(draft.data).assets.length+' 条':'(缺)'); console.log('资产行数', (await u.db('o_assets').where('projectId',P).count({n:'*'}).first()).n); console.log('分镜数', (await u.db('o_storyboard').where('scriptId',S).count({n:'*'}).first()).n); process.exit(0); })()"
```

Expected: `剧本长度` 几千字符；`导演计划` 打出开头一段中文；`资产草稿` 是正数条；`分镜数` 大于 0；**`资产行数` 与上一步完全相等** —— 这是 spec §12 的验收点（解析层不建资产）。

若 `导演计划` 是「（缺）」，回到 Step 8 检查插入位置是否在 `writeRedraw` 之后、变量名是否用了文件里实际的 `sid`。若 `资产行数` 变多了，说明 `skipAssets: true` 没传进去。

- [ ] **Step 12: 记录改动文件**

- `src/utils/redraw.ts`（改）
- `src/utils/redrawAnalyze.ts`（改）
- `scratch-verify-redraw-persist.ts`（新建）

---

### Task 3: 状态改为「待对账」，并在源片页渲染出来

解析完成后不再直接算成功 —— 它进入一个中间态 `3`，等关联层把资产认完、转绘层出了新分镜表，才由转绘层置为 `1`。

**Files:**
- Modify: `src/routes/redraw/analyzeSource.ts`
- Modify: `code/toonflow-web/src/views/inputVideo/index.vue`
- Modify: `code/toonflow-web/src/locales/language/{zh-CN,zh-TW,en,ja_JP,ru_RU,th_TH,vi-VN}.json`

**Interfaces:**
- Consumes: Task 2 落下的剧本与导演计划（本任务不读它们，只是状态衔接）
- Produces: `extractState === 3` 这一档的口径 —— 后续 A 之后的所有计划（B 关联层、C 转绘层）都以它作为「解析完、待对账」的判据。

- [ ] **Step 1: 确认没有任何代码对状态做穷举判断**

Run: `grep -rn "extractState" src/ --include=*.ts | grep -E "===|==|!=|where|switch"`

Expected: 只有两处数值谓词 —— `src/routes/redraw/analyzeSource.ts:56` 的 `=== 0`（防重入）与 `src/routes/script/extractAssets.ts:161` 的 `== 2`（基座资产提取取待处理行）。两处都不认 `3`，所以新增 `3` 不会被误抓；`src/lib/fixDB.ts:39` 的「启动时把卡住的 0 改成 -1」也碰不到它。若有第三处，先停下来评估。

- [ ] **Step 2: 改后端状态值**

在 `src/routes/redraw/analyzeSource.ts` 里，把成功那一行：

```ts
            await u.db("o_script").where("id", scriptId).update({ extractState: 1, errorReason: null });
```

改成：

```ts
            // 3 = 待对账：解析出来了，但还没跟用户的资产认过账、也还没出转绘分镜表。
            // 转绘层跑完才会置 1（见 redraw 三层设计的 §8）。
            await u.db("o_script").where("id", scriptId).update({ extractState: 3, errorReason: null });
```

同一文件里，若 `-1`（体检没过）与 `prepOnly` 的 `2` 分支上方有描述状态值的注释，一并补一句 `3`。**不要动** `0` 的写入与 `=== 0` 的防重入判断。

- [ ] **Step 3: 加文案 key**

在 7 个语言文件里，各自 `workbench.inputVideo` 对象内、`"analyzed"` 之后插入一个 key：

`src/locales/language/zh-CN.json`：

```json
"pendingReconcile": "待对账",
```

`src/locales/language/zh-TW.json`：

```json
"pendingReconcile": "待對帳",
```

`src/locales/language/en.json`：

```json
"pendingReconcile": "Pending review",
```

`src/locales/language/ja_JP.json`：

```json
"pendingReconcile": "確認待ち",
```

`src/locales/language/ru_RU.json`：

```json
"pendingReconcile": "Ожидает проверки",
```

`src/locales/language/th_TH.json`：

```json
"pendingReconcile": "รอตรวจสอบ",
```

`src/locales/language/vi-VN.json`：

```json
"pendingReconcile": "Chờ đối chiếu",
```

Run（确认 7 个文件都改到了、JSON 都还能解析）：

```bash
node -e "for (const f of ['zh-CN','zh-TW','en','ja_JP','ru_RU','th_TH','vi-VN']) { const j=require('./src/locales/language/'+f+'.json'); const v=j.workbench.inputVideo.pendingReconcile; console.log(f, v ? 'OK '+v : '缺失'); }"
```

Expected: 7 行 `OK <该语言文案>`，无「缺失」。

- [ ] **Step 4: 源片卡片加一个状态分支**

在 `code/toonflow-web/src/views/inputVideo/index.vue` 里，状态区块（现在是 `=== 0` 的 loading、`=== -1` 的 tooltip、`item.analyzed` 的 success tag、以及兜底的 default tag），在 `-1` 那个 tooltip 之后、`item.analyzed` 那行之前插入：

```html
    <t-tag v-else-if="item.extractState === 3" theme="warning" variant="light">
      {{ $t("workbench.inputVideo.pendingReconcile") }}
    </t-tag>
```

同一文件里，把类型声明那行的注释补上新档：

```ts
  extractState: number | null; // -1 失败 0 正在提取 1 成功 2 等待提取 3 待对账
```

**不要动** `analyzingCount`（它按 `=== 0` 过滤，`3` 不该触发轮询，这是对的）。

- [ ] **Step 5: 起前端，肉眼确认**

Run: `cd D:/sy_workspace/code/toonflow-web && yarn dev`，开一个转绘项目，进「输入视频」页。

Expected: 刚跑完分析的那一集，卡片上显示黄色「待对账」标签，而不是灰的「未分析」或绿的「已分析」。重新分析按钮仍可点（因为防重入只认 `0`）。

- [ ] **Step 6: 记录改动文件**

- `src/routes/redraw/analyzeSource.ts`（改）
- `code/toonflow-web/src/views/inputVideo/index.vue`（改）
- `code/toonflow-web/src/locales/language/*.json`（7 个）

---

## 完成本计划后系统的状态

- 分析一次，库里会多出：`o_script.content` 里的剧本、`o_agentWorkData` 里的两行（`redrawDirectorPlan` 导演计划、`redrawAssetDraft` 资产草稿）、以及 `o_storyboard` 里的源片分镜表（资产槽留空）。
- **`o_assets` / `o_scriptAssets` 一行都不新增** —— 资产要等关联层认账。所以 cornerScape 在这一步还看不到任何新资产，这是对的。
- 该集状态停在 `3`（待对账），**这是预期的** —— 转绘层还没建，暂时没有东西把它推到 `1`。在计划 B、C 落地之前，所有转绘集都会停在「待对账」。

## 已知取舍

- **解析层不落 `o_assets` —— 本次新挖出来的一处改动。** spec §5 要求资产等关联层认账，§12 验收也写着解析层跑完「`o_assets` 没有新增行」；但现有 `writeRedraw` 是**无条件**写资产行的（`redraw.ts:613-645`）。补法是给它加一个 `skipAssets` 开关（Task 2 Step 4），而不是让解析层另写一套分镜落库 —— 分镜那部分的逻辑（12 槽 `videoDesc`、`o_videoTrack` 分组、trackId 错开）不该有两份。
  - **顺带补一处 spec 空白**：§6 说关联层「读解析层的资产清单」，可清单若谁都不落库，关联层无物可读。所以 Task 2 把清单草稿存进 `o_agentWorkData` 的 `redrawAssetDraft`（与导演计划同表同写法，零新表）。**这是本计划替你定的**；若你想让清单以别的方式送到关联层，改动点只在 `persistAssetDraft` 一处。
  - 代价：源片分镜表的资产槽（12 槽里的最后一槽）留空。转绘层重出时会填。源片版本本来就是给人看的对比稿，不绑资产符合语义。
- **两个新块设为必需**（缺一个就 422）。好处是技能漂移会当场暴露；代价是模型输出变长、截断风险上升。若真实跑下来 422 变多，退路是只对 `<scriptBody>` 严格、`<directorPlan>` 缺失时记警告。**先按严格做，跑几次再定。**
- **技能里「已有资产用于复用」那段文字保留不动**（`[输入]` 第 4 条、`[执行流程]` 第三步）。因为代码注入的永远是「（无）」，那段目前是休眠的；资产认账已经归到关联层去做，所以这里**不去动它**，避免无谓改动。
- **源片分镜表仍是解析层直接写进 `o_storyboard`**。转绘层将来覆盖它 —— 那部分不在本计划内。
