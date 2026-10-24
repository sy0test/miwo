# 转绘三层流水线 · 设计

日期：2026-10-05
状态：已与用户逐块确认，待评审

> **迁移说明（2026-10-21 从 toonflow-upstream 迁入 miwo）**
> 本文写成时仓库还是 `toonflow-upstream` + `toonflow-web`，文中的 `src/…`、`code/toonflow-web/src/…`
> 在 miwo 里分别对应 `apps/api/src/…`、`apps/web/src/…`。
> 代码迁移只做了三处适配：`config.ts`（`MIWO_REDRAW_PREP` 等）、OSS 签名读写（`u.oss.writeFile/deleteFile/getFileUrl`）、
> AI 计费上下文（`currentAiBillingContext()`）。**转绘的写入路径仍为 legacy `o_storyboard`/`o_videoTrack`，
> 这与 v2 结构化分镜并行存在、且是设计内决定**（依据 `docs/legacy-retirement-plan.md`「转绘链保留」）。
> 现状与差距见 [`docs/redraw-status-contract.md`](../../redraw-status-contract.md)。

## 1. 背景与目标

转绘项目现在的链路是「一源片 → 一次分析 → 直接出资产表 + 分镜表」，中途没有任何人工介入。本次重构把它拆成**三层**，并调整页面顺序。

要解决的问题：

1. **资产前置**。让用户先在资产页自建角色/场景/道具，转绘时按名对应复用 —— 从根上避开「同一实体跨集换了叫法 → 被建成两条资产」。
2. **解析结果真正落库**。现在转绘链路从不写 `o_script.content`，剧本页渲染转绘行时那一栏是空的；用户要能看到并确认分析结果。
3. **把角色设定的权利交还用户**。姓名、男女、外观由用户定，AI 只出草稿供修改，不让用户从零空想。
4. **前端尽量不动**。「越少改动前端越好，省得发明创造」是本次的硬约束。

## 2. 现状（已核实的代码事实）

- 只有两个 agent 部署槽位在场：`scriptAgent`、`productionAgent`（[src/agents/](src/agents/)）。另有一个 `redrawAgent` 槽位（基行 + `redrawAgent:analysisAgent` 子键）已在 [fixDB.ts:197](src/lib/fixDB.ts#L197) 与 [initDB.ts:270](src/lib/initDB.ts#L270) 注册。
- `redrawAgent:analysisAgent` **不是 agentic loop**：`redrawAnalyze.ts` 拿这个 key 查部署（模型/参数），把 skill 当 system prompt，**一次调用**出结果（[redrawAnalyze.ts:28](src/utils/redrawAnalyze.ts#L28)）。两个入口分别是 `POST /api/redraw/analyzeVideo` 与 `POST /api/redraw/analyzeSource`。
- 现在的输出契约只有两块：`<assetSheet>` + `<storyboardTable>`（[redrawAnalyze.ts:179](src/utils/redrawAnalyze.ts#L179) 附近）。**不产剧本正文**，`## 已有资产` 那一节是硬编码的 `（无）`（[redrawAnalyze.ts:158](src/utils/redrawAnalyze.ts#L158)）。
- `writeRedraw`（[src/utils/redraw.ts:600](src/utils/redraw.ts#L600) 起）：
  - 资产按 `projectId + name + type` **复用**，且只补空、不覆盖用户改过的 `describe`/`prompt`；
  - 分镜是**先删后建**，必须显式传 `replace: true`；
  - 关联走中间表 `o_assets2Storyboard`，分组走 `o_videoTrack` + `o_storyboard.trackId`。
- `o_storyboard` 已有 `sourceRange`（该镜对应源片区间）与 `clipPath`（按 sourceRange 切出的原片片段）两列，注释写明后者是「工作台把它作为参考视频挂到该镜所在轨道」（[initDB.ts:512](src/lib/initDB.ts#L512)）。
- 前端顶栏菜单是数据驱动的 `rightBtnList`，`showMenu()` 已按 `project.projectType === "redraw"` 分支，已有 `onlyRedraw` / `hideRedraw` 两个标记（[pages/workbench/index.vue:89-108](D:/sy_workspace/code/toonflow-web/src/pages/workbench/index.vue#L89)）。
- 抽屉 `rightChatBox` 是纯聊天壳，`agentType` 写死 `"productionAgent"`（[components/rightChatBox/index.vue](D:/sy_workspace/code/toonflow-web/src/views/production/components/rightChatBox/index.vue)）。

## 3. 页面与顺序

- **资产页**：用户先在这里建号角色/场景/道具（现有功能，不动）。
- **剧本页（script）**：批量上传源片。**纯上传、不解析** —— 一源片一集，落一条 `o_script`（现有行为，不动）。
- **生产页（production）**：三层都跑在这。按「这一集有没有 `sourceVideo`」分流 —— 有 → 转绘链路；没有 → 现有 `productionAgent` 原流程（一行不碰）。
- **菜单顺序**：`cornerScape` 与 `production` **仅在转绘项目里**对调。转绘项目下右上角四个图标变为 `inputVideo / production / cornerScape / assets`；其他项目类型顺序不变。实现即在 `rightBtnList` 里按 `projectType` 决定这两项的先后。

## 4. 数据落点 —— 零新表、零新列

| 产物 | 落地 |
|---|---|
| 剧本（分镜表叙述版） | `o_script.content` |
| 导演计划（转绘策略） | `o_agentWorkData`（key-value 工作区，基座 `<scriptPlan>` 就这么存） |
| 源片分镜表 / 转绘分镜表 | `o_storyboard`（**同一份**，见 §7） |
| 资产 | `o_assets` + `o_scriptAssets`（挂剧本） |
| 资产 × 分镜 | `o_assets2Storyboard` |
| 切片 | `o_storyboard.clipPath` |
| 解析名 → assetId 绑定 | `o_agentWorkData`（转绘层的输入，非持久映射） |
| 流程状态 | `o_script.extractState`（新增一档） |

## 5. 解析层

**形状**：扩 `redrawAgent:analysisAgent` 的既有一次调用，输出契约从两块扩到四块：

- `<scriptBody>` 剧本 —— 分镜表的自然语言叙述版，逐镜顺下来，与分镜表一一对应。
- `<directorPlan>` 导演计划 —— 本次转绘的策略（目标国文化适配、语言、节奏）。源片本身已提供导演意图，所以这里承载的是"转绘目标"，不是"怎么导"。
- `<storyboardTable>` 源片分镜表 —— 不变。
- `<assetSheet>` 资产清单 —— 不变。

**落库**：

- 剧本站 → `o_script.content`
- 导演计划 → `o_agentWorkData`
- 源片分镜表 → `o_storyboard`（本层跑一次 `writeRedraw`）
- 资产清单 → **不落 `o_assets`**（草稿态，等关联层确认）
- `extractState` → 新增「待对账」档

**语言**：沿用既定语言政策 —— 说明性文字全中文，只有资产名与台词译文用目标国语言。

**为什么剧本跟着同一次调用出**：剧本既然是分镜表的叙述版，同一份分析顺带产出几乎不要钱，且**正文与分镜不可能对不上**。

## 6. 关联层

**形状**：抽屉聊天。新增一个 socket agent（第三个 socket 命名空间），由 `redrawAgent` 派生 —— 与 `scriptAgent`/`productionAgent` 并存。

**agent 做什么**：

1. 读解析层的资产清单，按 `projectId` 查 `o_assets`。
2. 分三类（角色/场景/道具）列出源片里出现的全部资产。
3. **项目里已有** → 问用户：「解析出的『沈公子』对应你哪个已有资产？」
4. **项目里没有** → agent 用**现有资产提示词链路**（`buildAssetPromptSystem()` + 白底政策 `withOpaqueWhiteCanvas`）出一版草稿，**带着转绘目标的提示词给用户改**，不让用户空想。
5. 每问完一类即落库：`o_assets` + `o_scriptAssets`。

**绑定关系是这一步唯一的"新东西"，但不新表。** 绑定 = 解析名 → assetId，它是**转绘层的输入**而非持久映射 —— 存进 `o_agentWorkData` 一个 key。转绘层读到它后，输出的分镜引用**用户绑定的最终资产名**，`writeRedraw` 按名一查就命中用户那条，不会另建。

**这一步是跨集消歧的落点**：第 1 集叫「沈辞」、第 2 集叫「沈公子」，靠用户指认合并到同一条资产上 —— 这正是资产前置 + 对账要兜住的场景。

## 7. 转绘层

**形状**：一次 LLM 调用（同解析层的形状）。

**输入**：源片分镜表 + 绑定好的资产（§6 的绑定 key）+ 导演计划 + 目标国。

**输出**：转绘分镜表。每镜带 `sourceRange` 指向源片区间、`duration` 参照源片时长（技能里的拆镜/延镜规则会调整它）；提示词里带一句"角色站位参考原片"，让 seedance 自己去读挂上的参考视频（**站位不在我们内部处理**）。

**落库**：`writeRedraw` 以 `replace: true` **原地覆盖** `o_storyboard`，资产绑 `o_assets2Storyboard`。

**「源片分镜表 vs 转绘分镜表对比」怎么落**：不落第二张表。源片版是解析层写进 `o_storyboard` 的那份，转绘层覆盖前把新旧摆一起给用户看一眼；用户点头后才覆盖。这样**一张表、一套绑定、同一个函数调两次**。

代价（已知并接受）：中间态（源片版）待在正式表里。用户在关联层中断时，`o_storyboard` 里留着一份源片分镜 —— 它不是脏数据（本身是一份有效的源片分镜），`extractState` 标着"待对账"，重跑覆盖即可。

## 8. 状态机

`o_script.extractState` 现有取值：`0` 跑、`1` 成、`-1` 败、`2` 等待。

新增一档「待对账」，覆盖「解析完 → 转绘完」之间的整段（含关联层的多轮对话）。拟定取 `3`，**落地前须确认没有地方按枚举全集判断**。

流转：`2 等待` → `0 跑`（解析）→ `3 待对账` → `0 跑`（转绘）→ `1 成` / `-1` 败。

## 9. 前端改动 —— 就三处

1. `rightChatBox` 的 `agentType` 参数化（现在写死 `productionAgent`），并接上新的 redraw 会话 store。
2. production 页按 `sourceVideo` 分流到转绘链路。
3. 菜单顺序：转绘项目里 `cornerScape` 与 `production` 对调。

后端对应改动：新增一个 socket 命名空间（[src/socket/index.ts](src/socket/index.ts) 的映射表加一项 + 一个路由文件）；新 agent 的部署行（基行 + 子键，照 `redrawAgent` 的现有写法补 `fixDB`）；新 key 加进 `ai.ts` 的 `AiTypeValues` 白名单。

## 10. 完全不动

- 视频工作台 —— 切片参考已经接线通了（medias 塞一条 `sources:"clip"` 就自动挂参考）。
- 第 5·7 步接线与切源片逻辑。
- cornerScape 页面本身（只是多了一个"等生产页跑完"的数据前置）。
- vendor 适配器与资产出图/润色路由。

## 11. 开放问题

1. **`extractState` 新档取值** —— 落地前确认无枚举全集判断。
2. **cornerScape 的"缺失"判定规则** —— 关联层落库后，`o_assets` 里每条都是"有名有设定、没图"。缺图的判定是「有行且 `imageId` 为空」，与现有行为一致，需在实现时确认。
3. **关联层的工具集** —— agent 落库需要哪些工具（写 `o_assets`、写 `o_scriptAssets`、写绑定 key），在实现计划里定。

## 12. 验收

- 转绘项目下右上角四个图标顺序为 `inputVideo / production / cornerScape / assets`；非转绘项目顺序不变。
- 走完解析层后：`o_script.content` 有剧本、`o_agentWorkData` 有导演计划、`o_storyboard` 有源片分镜表、`o_assets` **没有**新增行。
- 关联层对话结束后：`o_assets` 落齐三类资产，`o_scriptAssets` 有挂链，绑定 key 写进 `o_agentWorkData`。
- 跑完转绘层后：`o_storyboard` 只剩转绘分镜表（源片版被覆盖），`o_assets2Storyboard` 有绑定，`extractState = 1`。
- 同一实体跨集换叫法时，经关联层指认后**不产生第二条资产**。
