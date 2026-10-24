# 转绘（出海转绘）改造设计

- 日期：2026-10-24
- 状态：**待评审**（与用户逐节讨论后的收敛稿；标「待定」的条目尚未拍板）
- 目标仓库：`code/miwo`（本设计只针对 miwo；`toonflow-upstream` 仅作行为基线参考）
- 相关文档：[`redraw-status-contract.md`](../../redraw-status-contract.md)、[`redraw-todo.md`](../../redraw-todo.md)、[`2026-10-05-redraw-three-layer-pipeline-design.md`](2026-10-05-redraw-three-layer-pipeline-design.md)（旧三层设计，部分已过时）

---

## 0. 一句话结论

保留现有「解析层」（上传 → 预处理 → 一次模型解析 → v2 段/镜落库），**新增**三件事：
**预处理原生化（去掉 hypit/WhisperX）**、**资产认账层（对话 + 面板，把解析草稿变成用户确认的资产）**、**转绘分镜层（目标国版分镜，并排确认后覆盖）**；
同时改造生成链，让每一段带上**原片参考视频**并让提示词真正引用它。数据上只加两列，不新增表。

---

## 1. 目标与用户流程

### 1.1 目标形态（已与用户确认，2026-10-24）

```text
1. 项目设置：选视频模型 → 定「单段上限」（sd2.0=15s / sd2.5=30s，默认 15）
2. 上传源片 → 开始分析
     产出：源片侧（剧本 o_script.content、源片分镜表）
           转绘侧（目标国资产草稿、导演计划、目标国分镜待生成）
3. 转绘会话（agent 带用户过三个确认点，所有决定落库）
     ① 剧本：改台词/剧情
     ② 资产：角色/场景/道具 → 复用已有 / 改名 / 改性别 / 出图草稿
     ③ 时长：按第 1 步的上限复核每段多长
4. 生成目标国分镜表（一次模型调用）
5. 并排「源片版 / 转绘版」→ 用户确认才覆盖
6. 视频工作台：每段带原片 clip + 转绘提示词，逐段生成（可关闭原片参考）
```

### 1.2 为什么是对话而不是纯页面（用户口径）

- 用户可能有**现成资产**要替换原片角色；
- 用户可能想改角色**性别/姓名/设定**，这是模型解析不出来的；
- 用户需要决定**每段切多长**（受视频模型上限约束）。
→ 对话负责「问 + 拍板 + 落库」，批量改字仍交给结构化面板（见 §7.3）。

### 1.3 不在范围

- 不改造普通项目（无 `sourceVideo`）的生产链；
- 不做镜级参考视频（模型只接受段级；`o_shot` 只有 `sourceRange`）；
- 不迁移历史数据（用户已确认测试集重跑）；
- 不做多语言配音/TTS 成片（本轮只到「生成转绘视频片段」）。

---

## 2. 现状（代码事实，2026-10-24 只读调查）

> ⚠ 口径提醒：`writeRedraw` 的 v2 实现目前只在**未提交→已提交的基线**里（本仓库 451c5c5 已含）；`015_redraw_v2.ts` 与 `docs/` 已随基线入库。

| 环节 | 现状 |
|---|---|
| 上传 / 列表 / 分析入口 | ✅ 已有（`routes/redraw/{uploadSource,getSourceList,analyzeSource,analyzeVideo}`） |
| 预处理 | ⚠ 外部脚本 `redraw-prep.cjs`：hypit CLI 切点 + 本机 WhisperX 转写；**服务器不可用** |
| 解析 | ✅ 一次模型调用 → 剧本 / 导演计划 / 资产草稿 / 源片分镜表；写 v2（`o_segment`/`o_shot`/`o_shotAssets`） |
| 切原片 | ✅ 后端按段切 `seg-N.mp4` 写 `o_segment.clipPath`；**前端无入口** |
| 资产认账 | ❌ 未实现（资产草稿只写不读，不落 `o_assets`） |
| 转绘分镜 | ❌ 未实现（`extractState=3` 是死端点） |
| 工作台读段 | ✅ 一段一条；素材排可带 clip |
| 原片参考送生成 | ⚠ 代码已通（clip→base64→newapi `reference_video`），**零次端到端实测** |
| 提示词引用原片 | ❌ 拼 prompt 时 clip 被丢弃；模板只定义 `@图片N` |
| 状态机 | ⚠ `extractState=3` 之后无出口；进程中断卡 `0` 无自愈 |

**与生成模板的格式冲突（重要）**：转绘写 12 槽顿号 `videoDesc`（`composeSegmentVideoDesc`），而 seedance 多参模板按「承接句 + 管道 + 序号N」解析（`modelPrompt/video/seedance2Multi-parameterMode.md`）。→ 转绘若用 seedance，景别/运镜/光影/音效会被静默丢弃。

---

## 3. 关键决策

| # | 决策 | 理由 | 备选（放弃原因） |
|---|---|---|---|
| D1 | 预处理原生化：**本地 faster-whisper + 原生 ffmpeg 切点** | 用户要求打包进仓库、不依赖 hypit/WhisperX | 中继 ASR：实测该中继无 audio 渠道（`model_not_found`） |
| D2 | 模型文件**不进 git**，Docker 构建时下载并固化进镜像 | 仓库不会被 0.8~1.7G 模型撑爆；构建可复现 | 模型入库：克隆/推送不可行 |
| D3 | 新增 `o_script.redrawState`，`extractState` 回归「解析跑没跑完」 | 现状 3 是死端点、语义混用 | 继续用 extractState：状态不够，且影响生产链读侧 |
| D4 | 资产认账 = 对话驱动 + 结构化面板 | 用户要能换现成资产/改性别姓名；批量改字用面板更快更准 | 纯对话（慢、易漏）；纯页面（无法自然询问） |
| D5 | 转绘分镜由**一次独立模型调用**产出，并排确认后覆盖 | 与用户流程一致；可控、可回退 | 解析层直接出目标国版（一次调用过长、无法在中间认账） |
| D6 | 分镜描述统一为**生产 v2 同款「承接句 + 管道 + 序号」** | 下游 seedance 模板只认这个；生产链已这么写 | 保留 12 槽顿号：需改模板，且与生产链分裂 |
| D7 | 每段默认带原片 clip，可逐段关闭；项目必须多参模式 | 模型要看到原片才谈得上「转绘」 | 强制带：用户有时要纯文生 |
| D8 | clip 传输默认 data URL，**超过阈值或供应商要求时切签名 URL** | dev 下公网不可达；URL 方案要求 `MIWO_PUBLIC_BASE_URL` 公网可达 | 一开始就 URL：本地无法验证 |
| D9 | 30s 单段上限**先探针验证再开放**，默认 15s | 「30s + 参考视频」未实测；30s clip 体积大 | 直接默认 30s：风险与费用都高 |
| D10 | 预处理+解析进**任务队列**（worker 执行），不再路由内 fire-and-forget | 进程重启可恢复；ASR 耗时长 | 保持现状：卡 0 无自愈 |
| D11 | 转绘项目只允许选**支持参考视频**的视频模型（newapi 的 seedance 2.0/2.5） | 只有这类模型能吃 `reference_video`；也是 D6 管道格式的下游前提 | 允许任意模型：原片参考发不出去，且管道格式与通用模板不兼容 |

---

## 4. 数据模型

### 4.1 新增列（migration `016_redraw_pipeline`）

```ts
o_project: redrawMaxSegmentSec  integer  default 15   // 4..30，解析前读取
o_script:  redrawState          smallint default 0    // 见 §4.2
```

回填：`UPDATE o_script SET redrawState=1 WHERE extractState=3`（旧的「待对账」）。

### 4.2 状态机

| redrawState | 含义 | 谁写 |
|---|---|---|
| 0 | 未开始 | 默认 / 重传源片 |
| 1 | 已解析，待资产认账 | 解析成功 |
| 2 | 资产已确认 | 认账会话「确认资产」 |
| 3 | 转绘分镜已出，待确认 | 转绘层写库后 |
| 4 | 已确认，可生成 | 用户点「确认覆盖」 |
| -1 | 失败 | 任一环节失败（errorReason 同步写） |

`extractState` 只保留 0 跑 / 1 成 / 2 等待 / -1 败（转绘不再写 3）。

### 4.3 工作区 key（`o_agentWorkData`，必须带 key 过滤）

| key | 内容 | 写方 |
|---|---|---|
| `redrawDirectorPlan` | `{plan}` | 解析层（现有） |
| `redrawAssetDraft` | `{assets: RedrawAsset[]}` | 解析层（现有） |
| `redrawAssetBindings` | `{draftName: assetId}` | 认账层 |
| `redrawSourceStoryboard` | 源片分镜快照（段/镜 JSON），用于并排对比 | 转绘层覆盖前 |
| `redrawChatSummary` | 会话摘要 + 三个确认点的结论 | 认账层 |
| `redrawStage` | `{stage, at}` 进度（沿用） | 各层 |

### 4.4 `o_segment` / `o_shot` 约定

- `o_segment.videoDesc`：**生产 v2 形状** —— `承接上镜：…` + 若干行 `| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |`（由 `o_shot` 结构化列确定性投影，见 §9.2）。
- `o_segment.sourceRange` / `clipPath`：切原片后写入；**转绘分镜覆盖时按 `segmentIndex + sourceRange` 匹配保留 `clipPath`**，不再被重跑抹掉。
- `o_shot.sourceRange`：镜级核对用。

### 4.5 不新增表

资产 = `o_assets` + `o_scriptAssets`；绑定 = `o_agentWorkData`；对比快照 = `o_agentWorkData`。

---

## 5. 预处理原生化（替换 `MIWO_REDRAW_PREP`）

### 5.1 产物契约（**不变**）

```text
<prepDir>/grid/grid-01.jpg …   拼贴图（带编号 + 时间码）
<prepDir>/cuts.json / cuts.txt  切点表
<prepDir>/transcript.json       转写稿（词级）
<prepDir>/MANIFEST.md           采样密度/时长/语种等
<prepDir>/prep.log              全量日志
```

下游 `redrawAnalyze.ts` 与技能**一行不改**。

### 5.2 切点检测（原生）

1. `ffmpeg -vf "select='gt(scene,TH)',metadata=print" -f null -` 取候选；
2. 聚类：相邻候选间隔 `≤0.25s` 视为同一次过渡，取分数最高者；
3. 约束：最短镜长 `≥0.4s`；距片头/片尾 `<0.2s` 的候选丢弃；
4. `TH` 默认 0.3，可按集调；输出帧级时间戳。

⚠ **验收口径**：不要求与 hypit 完全相同，要求「主要切点不漏、边界误差 ≤0.1s」；用 2~3 集真实源片做人工比对，结果写进验收记录。

### 5.3 转写（本地 faster-whisper）

- 位置：`apps/api/asr/`（Python 3.11 + faster-whisper，锁版本）；Node 侧 `utils/asr/` 以 `spawn` 调用。
- 输入：ffmpeg 抽 `16k 单声道 wav`；输出 JSON：

```json
{ "language": "zh", "duration": 132.4,
  "segments": [{ "start": 0.0, "end": 2.3, "text": "…" }],
  "words": [{ "word": "第一句", "start": 0.12, "end": 0.86 }] }
```

- 规则：
  1. **先检语种**（faster-whisper `detect_language`，取前 30s），再以显式 `language` 转写；
  2. `task="transcribe"`，禁止 translate；
  3. **`words` 为空即失败**（台词配额需要词级时间戳，不许静默降级）；
  4. `vad_filter=true` 跳过静音；
  5. 并发上限 1（CPU 密集），超时 20min/集。
- 模型：默认 `medium` int8（待 benchmark 定），可切 `small` / `large-v3`；`MIWO_ASR_MODEL` 控制。

### 5.4 拼贴图

- 复用现有参数：1s/格、12 列、格宽 120px、每页最多 12 行；`ffmpeg tile` 渲染。
- 字体：仓库内自带 CJK 字体（`apps/api/assets/fonts/`），替换现在写死的 Windows 路径。
- 产物与 MANIFEST 格式不变。

### 5.5 打包与配置

| 项 | 做法 |
|---|---|
| 模型下载 | `apps/api/scripts/fetch-asr-model.cjs`，固定 revision + SHA256，下载到 `MIWO_ASR_MODEL_DIR` |
| Docker | 构建阶段安装 Python + venv + 模型，**运行时不联网**；镜像增量约 +0.9GB（medium） |
| 配置 | `MIWO_ASR_DRIVER=local|relay|off`、`MIWO_ASR_MODEL`、`MIWO_ASR_MODEL_DIR`、`MIWO_ASR_COMPUTE=int8` |
| 开发机 | 同一脚本下载到本地缓存；`MIWO_REDRAW_PREP` 变量与外部脚本**删除** |

### 5.6 任务化

新增 job kind `redraw.prepare`：worker 内执行「预处理 → 解析 → 落库」，路由只入队并置 `extractState=0`；失败或超时按 job 机制重试/失败；进程重启后可续跑（幂等键 = `projectId:scriptId:analysisVersion`）。

---

## 6. 解析层（保留，做小调整）

保留现有技能与四块契约（`<scriptBody>`/`<directorPlan>`/`<assetSheet>`/`<storyboardTable>`），调整：

1. 调用改由 `redraw.prepare` job 执行（§5.6）。
2. 成功写：`o_script.content`、`o_agentWorkData`（导演计划/资产草稿/stage）、`o_segment`/`o_shot`（源片分镜）、`extractState=1`、**`redrawState=1`**。
3. 体检 error 级：整集失败（`-1`），但**写库与体检放在同一事务**或先体检后写库（修掉现在「失败也已落库」的问题）。
4. 失败可重试：`redrawState` 保持 0/-1，不挡重跑。

---

## 7. 资产认账层（B 层）

### 7.1 会话 agent

- 新增 socket 命名空间 `/api/socket/redrawAgent`（与 `productionAgent`/`scriptAgent` 并列），新增部署 key `redrawAgent:reconcileAgent`（`o_agentDeploy` + `ai.ts` 白名单）。
- 记忆：复用 `memories` 表，`agentType=redrawAgent`，isolationKey 含 `projectId + scriptId`；**重连不清空**（无有效集号不发请求、后端返空不覆盖界面）。
- 会话职责：按「剧本 → 资产 → 时长」顺序推进，每步结束落库并更新 `redrawState`。

### 7.2 工具集（建议）

| 工具 | 作用 |
|---|---|
| `redraw_getScript` / `redraw_updateScript` | 读/改 `o_script.content`（带变更摘要） |
| `redraw_listAssetDrafts` | 读 `redrawAssetDraft`（解析草稿） |
| `redraw_listProjectAssets` | 读项目已有 `o_assets`（供用户挑现成的） |
| `redraw_bindDraft` | 草稿名 → 已有 assetId（写 `redrawAssetBindings`） |
| `redraw_createAsset` | 按草稿新建资产（名称/类型/说明/出图提示词，**目标国语言**） |
| `redraw_updateAsset` | 改名称/性别/外观设定（仅限本集新资产或用户确认覆盖） |
| `redraw_confirmAssets` | 汇总确认：写 `o_assets` + `o_scriptAssets`，`redrawState=2` |
| `redraw_confirmSegmentCap` | **确认**单段上限（读 `o_project.redrawMaxSegmentSec`）；若要改值，提示「需要重跑解析」，并由用户显式确认后才写 4..30 |

约束：所有写操作必须带 `projectId/scriptId` 归属校验（沿用租户守卫）；每次写返回 diff 供界面展示。

### 7.3 资产面板（与对话并存的「结构化改法」）

- 位置：资产页新增「本集待确认资产」分区（仅转绘项目、`redrawState=1|2` 可见）。
- 每条卡片：类型、解析名、目标国名、说明、出图提示词、操作「复用已有（选择器）/ 改名 / 改性别 / 出图草稿 / 确认」。
- 底部「全部确认」= 调 `redraw_confirmAssets`。
- 面板与对话共享同一份 `redrawAssetBindings`，任意一侧修改后另一侧刷新。

### 7.4 跨集合并

- 项目内同名（目标国名 + 类型）资产默认指向同一条 `o_assets`；对话在发现相似名时主动问「是不是同一个人」。
- 用户在会话里的指认写入 `redrawAssetBindings`（按集），下集解析出同义名时优先复用。

### 7.5 落库规则

- 只写「用户确认过」的资产；草稿永不直接进 `o_assets`。
- 已有资产只补空字段，不覆盖用户改过的 `describe/prompt`（沿用 `writeRedraw` 现有口径）。
- 确认后本集 `o_scriptAssets` 建立挂链；后续转绘层引用它。

---

## 8. 转绘分镜层（C 层）

### 8.1 输入与调用

一次模型调用（部署 key `redrawAgent:storyboardAgent`，技能新增 `apps/api/data/skills/feicai/redraw-storyboard-skill/`）：

```text
输入：源片分镜（段/镜 + sourceRange + 12 字段）
      已确认资产（名称 / ID / 类型 / 说明 / 目标国设定）
      剧本（用户改后版本）
      导演计划（目标国适配策略）
      目标国家 + 单段上限
输出：目标国版分镜表 + 变更摘要
```

### 8.2 输出契约（两块，缺一失败）

```text
<redrawStoryboard>
## 场1：…
### 片段一（约10s）
**引用资产名称**：[…]
**引用资产ID**：[…]
| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |
…
</redrawStoryboard>
<changeSummary>
- 角色「沈公子」→「Lucia（女）」…
- 第 3 段时长 12s → 15s（适配单段上限）…
</changeSummary>
```

- 单段时长必须落在 `[4, min(cap, 模型上限)]`，段内镜时长之和 = 段头声明。
- 资产名与 ID 必须来自已确认资产（不许新造名字）。
- 台词为目标国语言，括号内回译（沿用现有语言政策）。

### 8.3 解析与落库

1. 解析表格 → 段/镜结构（复用 `parseStoryboardTable` 的容错）；
2. 覆盖前把当前源片分镜快照写入 `redrawSourceStoryboard`；
3. 事务内：保留 `o_segment.clipPath`（按 `segmentIndex + sourceRange` 匹配）→ 删除自动段（`manual=0`）→ 重建 `o_segment`/`o_shot`/`o_shotAssets`；
4. 写 `o_segment.videoDesc`（§9.2 形状）；
5. `redrawState=3`，等待确认。

### 8.4 并排确认（前端）

- 转绘项目的 production 页新增「转绘确认」节点：左源片版（`redrawSourceStoryboard`）、右转绘版（当前 `o_segment`）、底部变更摘要。
- 操作：确认覆盖（`redrawState=4`）/ 重跑转绘层 / 回退到源片版。
- 确认覆盖后**自动切原片**（`cutSource`，按最终段集合）；段集合变化时清掉旧 clip 并重切。
- 生成前若发现某段缺 `clipPath`，界面提示「先切原片」，不静默降级为纯文生。

---

## 9. 生成链路改造

### 9.1 模式约束

- 转绘项目必须为**多参模式**（`o_project.mode` 是 JSON 数组）；否则生成接口返回 400，提示「转绘项目需使用多参模式」。
- 转绘项目绑定的视频模型必须在能力表里声明 `videoReference`（当前 = newapi `seedance-2-0` / `seedance-2-5-nsfw`）；否则 400 并提示换模型。
- 每段请求带 `includeClip`（默认 true）；前端素材排可取消勾选原片。

### 9.2 描述格式统一

- `o_segment.videoDesc` 由 `buildRedrawSegmentVideoDesc(segment, shots)` 生成：
  `承接上镜：…`（同场景上一段末镜摘要）+ `| 序号1 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |` 逐镜行。
- 兼容：老的 12 槽顿号数据按原样读（不迁移），只是新写一律管道格式。

### 9.3 原片参考进提示词

1. `generateVideoPrompt` / `promptBatch` 的输入增加 clip 信息（路径、时长、段号）；
2. 视频提示词技能模板（seedance 多参）增加固定段：
   `参考素材：@视频1 为本段原片参考，角色站位/动作/运镜以其为准，画面风格按目标国资产与视觉风格重绘。`
3. 适配器：`@视频N` 锚点按「素材类型分别计数」翻译，修复现在「总序号」与前端编号不一致的问题；
4. 参考视频数量按模型声明截断（2.0：3；2.5：10），超出的给 warn，不静默丢。

### 9.4 clip 传输

| 模式 | 条件 | 行为 |
|---|---|---|
| `auto`（默认） | clip ≤ 阈值（默认 20MB）且供应商接受 data URL | base64 data URL |
| `url` | clip 超阈值 / 探针证明必须 URL | 文件已在媒体存储 → `getFileUrl` 24h 签名 URL；要求 `MIWO_PUBLIC_BASE_URL` 公网可达 |
| `dataurl` | 强制调试 | 始终 base64 |

### 9.5 时长上限

- 默认 `redrawMaxSegmentSec=15`；30 仅在真机探针通过后开放（`MIWO_REDRAW_30S_VERIFIED=1` 才允许选择）。
- job 超时 15min 与 newapi 内部 30min 轮询冲突：转绘视频 job 超时改为可配置，默认 `MIWO_VIDEO_JOB_TIMEOUT_MS=1800000`（30min+）。

---

## 10. 前端融入设计（做完能看到的界面）

> 原则：**不新开一套壳**。全部页面都在现有 `pages/workbench` 外壳里，复用现有路由、顶栏、TDesign 组件、生成面板与任务中心；
> 转绘只增加两条路由、一个资产面板、一组画布节点和一个生成开关。每个里程碑结束都能在浏览器里点出来（§10.11）。

### 10.1 页面地图

| 路由 / 位置 | 现状 | 改造 |
|---|---|---|
| `/project` 项目列表 | 已有；新建/编辑弹窗已有「出海转绘 + 目标国家」 | 弹窗（转绘类型时）增加「视频模型」「单段上限」；卡片显示 `出海转绘 · 目标国 · 15s/段` |
| `/inputVideo` 源片页 | 已有：上传/列表/封面/开始分析/重跑 | 状态改由 `redrawState` 驱动；主按钮按状态切换；增加分析阶段进度、切原片入口 |
| **`/redraw/session/:scriptId`** | 无 | **新增**：转绘会话页（三步确认 + 右侧对话） |
| **`/redraw/review/:scriptId`** | 无 | **新增**：源片版 / 转绘版并排确认 |
| `/assets` 资产页 | 已有资产中心 | 顶部增加「本集待确认资产」面板（仅转绘项目、`redrawState=1|2`） |
| `/production` 生产画布 | 已有 6 个固定节点 + 右侧对话抽屉 | 转绘项目换成转绘节点组；右侧对话切 `redrawAgent` |
| 生成面板（workbench 节点弹窗） | 已有分段生成 | 每段增加「原片参考」开关与状态徽标；进入时自动切原片 |
| `/task` 任务中心 | 已有 | 复用：预处理、解析、转绘分镜、视频生成都出现在这里 |

### 10.2 导航与菜单

- 转绘项目顶栏顺序改为：`inputVideo → production → cornerScape → assets`（其他项目类型不变）。
- 实现位置：`pages/workbench/index.vue` 的 `rightBtnList` 按 `project.projectType` 重排（现有 `onlyRedraw`/`hideRedraw` 机制扩展）。
- 所有转绘入口统一带 `projectId`（从 project store 取）+ `scriptId`（从 URL/当前集）。

### 10.3 输入视频页（改造）

每张源片卡按 `redrawState` 变主按钮，**这是用户唯一需要记住的入口**：

```text
┌──────────────────────────────┐
│ [封面]  第 3 集 · 圣修学院    │
│ 状态：待认账（黄）            │
│ ─────────────────────────    │
│ [ 去认账 ]        [重新分析]  │
└──────────────────────────────┘
```

| redrawState / extractState | 标签 | 主按钮 | 次按钮 |
|---|---|---|---|
| 0 + extractState=0 | 分析中：`预处理·切点` → `预处理·转写` → `解析中`（阶段文案来自 job 进度） | 禁用 | — |
| 0 | 待分析 | 开始分析 | 预览源片 |
| -1 | 失败（悬停看 errorReason） | 重试分析 | 查看日志 |
| 1 | **待认账** | **去认账**（→ `/redraw/session/:id`） | 重新分析 |
| 2 | 资产已确认 | 生成转绘分镜（→ 会话页第 3 步） | 继续认账 |
| 3 | 转绘待确认 | 去确认（→ `/redraw/review/:id`） | 重跑转绘 |
| 4 | 可生成 | 去制作（→ `/production`） | 重新分析 |

- 分析中的阶段进度：卡片内显示细进度条 + 文案（由 job 的 `progress.stage` 提供）；失败时就地展开原因，不弹窗。
- 「切原片」在 `redrawState>=3` 时出现在次按钮；已切完显示「已切 N 段 · 重切」。

### 10.4 转绘会话页 `/redraw/session/:scriptId`（新增）

```text
┌──────────────────────────────────────────────────────────────────────┐
│ ← 返回   第3集 · 圣修学院                                            │
│  [① 剧本 ✓] ──── [② 资产 ●] ──── [③ 时长 ○]        [转绘助手] 按钮  │
├──────────────────────────────────────────┬───────────────────────────┤
│ 主区（随步骤切换）                        │ 右侧对话（可收起）        │
│                                          │ 助手：角色「沈公子」在项目 │
│ ① 剧本                                  │ 里没有，要新建还是复用？   │
│    Markdown/文本编辑器                   │                           │
│    [保存草稿]（自动保存 2s 防抖）         │ 你：复用「沈砚」          │
│                                          │ 助手：已绑定，接下来……    │
│ ② 资产                                  │                           │
│    ┌─────────┐ ┌─────────┐ ┌─────────┐   │ ┌───────────────────────┐ │
│    │角色 沈公子│ │场景 旧礼堂│ │道具 账本 │   │ 输入…                 │ │
│    │→ Lucia  │ │→ 圣修礼堂│ │→ 账本   │   │ [快捷]确认本类 全部确认│ │
│    │[复用][改名][改性别][出图]│ …        │ └───────────────────────┘ │
│ ③ 时长                                  │                           │
│    段号 | 源片区间 | 当前时长 | 上限 15s  │                           │
│    1    | 0.0-11.2 | 11s ✓              │                           │
│    2    | 11.2-24.0| 13s ✓              │                           │
├──────────────────────────────────────────┴───────────────────────────┤
│ [上一步]   [保存并继续]                          [生成转绘分镜 →]      │
└──────────────────────────────────────────────────────────────────────┘
```

交互规则：

- **双向联动**：对话里做的操作（绑定/新建/改名）通过 socket 事件 `redraw:updated` 推给主区，主区立即刷新；主区操作也会同步进对话历史（系统消息）。
- **步骤闸门**：①剧本可跳过（不改直接继续）；②资产必须全部处理完（每条「已确认」）才能进③；③时长确认后才能点「生成转绘分镜」。
- **退出可续**：所有状态在库里（`redrawState` + 工作区 key）；刷新/断线回来停在同一页同一集。
- **不打断**：对话框断开重连不清空（沿用生产链修过的护栏）。

### 10.5 资产页「本集待确认资产」面板（改造）

```text
┌ 资产中心 ─────────────────────────────────────────────────────────┐
│ [全部资产] [本集待确认 · 3]  ← 新 tab，仅转绘项目出现              │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ 角色 · 沈公子  →  Lucia（女）        [复用已有▾] [改名] [改性别]│ │
│ │ 说明：……  出图提示词：……                       [出图草稿] [✓] │ │
│ ├──────────────────────────────────────────────────────────────┤ │
│ │ 场景 · 旧礼堂  →  Saint Academy Hall  [复用已有▾] …            │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                    [全部确认（3）]  [去会话页]     │
└───────────────────────────────────────────────────────────────────┘
```

- 复用选择器：弹出项目已有资产列表（按类型过滤、支持搜索），选中即绑定。
- 「出图草稿」调现有资产生图链路，出图后原地显示缩略图。
- 面板与会话页共享同一份数据；任意一侧确认后另一侧刷新。

### 10.6 并排确认页 `/redraw/review/:scriptId`（新增）

```text
┌ 第3集 · 圣修学院   源片版 vs 转绘版        [返回会话] [工作台] ┐
├ 变更摘要 ───────────────────────────────────────────────────┤
│ · 角色「沈公子」→「Lucia」（女）                              │
│ · 段 3 时长 12s → 15s（达单段上限）                           │
│ · 台词 4 句已译为目标国语言                                    │
├───────────────┬─────────────────────────────────────────────┤
│ 源片分镜       │ 转绘分镜                                     │
│ 段1 11s        │ 段1 11s   （不变，灰）                       │
│ 段2 13s        │ 段2 13s   （时长变化，黄）                   │
│ 段3 12s        │ 段3 15s   （资产替换 + 时长，红/黄）          │
├───────────────┴─────────────────────────────────────────────┤
│ [回退到源片版]   [重跑转绘层]        [确认覆盖并进入制作]      │
└─────────────────────────────────────────────────────────────┘
```

- 差异高亮规则：新增段=绿、删除段=红、时长变化=黄、资产替换=蓝、台词变化=下划线。
- 确认覆盖 = 写库 + 自动切原片（进度在按钮上）+ `redrawState=4`，然后跳 `/production`。
- 「回退到源片版」只换显示与工作区快照，不删转绘结果，可再次重跑。

### 10.7 生产画布（production）转绘版

转绘项目的画布不跑 `productionAgent` 的 6 节点，改成 6 个转绘节点（只读状态 + 跳转）：

| 节点 | 显示 | 点击 |
|---|---|---|
| 源片 | 封面 + 集名 + 分析状态 | 去 `/inputVideo` |
| 解析结果 | 剧本摘要（前 3 行） | 去 `/redraw/session` 第①步 |
| 资产 | 「已确认 3 / 草稿 5」 | 去资产页「本集待确认」 |
| 转绘分镜 | 段数 + 待确认/已确认 | 去 `/redraw/review` |
| 生成 | 已生成 N/总段数 | 打开工作台弹窗 |
| 工作台 | 视频列表缩略 | 打开工作台 |

- 右侧对话抽屉：`rightChatBox` 增加 `agentType` prop（现在写死 `productionAgent`），转绘项目传 `redrawAgent`。
- 实现：`flowBuilder.ts` 增加 `useRedrawFlowBuilder`（节点/边独立），`production/index.vue` 按 `projectType === "redraw"` 选择 builder 与 store。

### 10.8 工作台（生成面板）改造

```text
┌ 段 3 · 15s ────────────────────────────────────────────────┐
│ [原片参考 clip 缩略]  ☑ 使用原片参考（@视频1）              │
│ 提示词：[可编辑 textarea]                     [生成视频]     │
│ 状态：多参 ✓ · 模型支持参考视频 ✓ · clip 已切 ✓             │
└────────────────────────────────────────────────────────────┘
```

- 进入工作台时：若本集有段缺 `clipPath`，自动调 `cutSource` 并显示进度；失败给「重切」按钮。
- 生成前守卫（不满足就禁用按钮并在状态行说明原因）：
  1. 项目是多参模式；2. 视频模型声明 `videoReference`；3. 装了 worker。
- 生成请求带 `includeClip`；关闭开关时提示「本段将不参考原片」。
- 生成任务进入现有任务中心，出片后在同一面板预览（复用现有视频预览）。

### 10.9 组件 / store / 接口清单

**新增页面与组件**

| 文件 | 职责 |
|---|---|
| `views/redraw/session/index.vue` | 会话页壳：步骤条 + 主区路由 + 底部操作 |
| `views/redraw/session/components/ScriptStep.vue` | 剧本编辑与保存 |
| `views/redraw/session/components/AssetStep.vue` | 待确认资产卡片与操作 |
| `views/redraw/session/components/DurationStep.vue` | 段时长表与上限提示 |
| `views/redraw/session/components/ChatPanel.vue` | 对话（复用现有聊天样式） |
| `views/redraw/review/index.vue` | 并排确认、差异高亮、确认/回退/重跑 |
| `views/redraw/components/StatusStepper.vue` | 三步条（两个页面共用） |
| `views/redraw/components/AssetBindDialog.vue` | 复用已有资产选择器 |

**改造文件**

| 文件 | 改动 |
|---|---|
| `router/index.ts` | 增加 `/redraw/session/:scriptId`、`/redraw/review/:scriptId`（挂在 workbench 子路由） |
| `pages/workbench/index.vue` | 转绘菜单顺序；可选新增「转绘」快捷入口 |
| `views/project/components/projectDialog.vue` | 视频模型 + 单段上限（转绘类型） |
| `views/inputVideo/index.vue` | 状态机、阶段进度、切原片、跳转按钮 |
| `views/assets/index.vue` | 「本集待确认资产」tab/面板（可拆 `components/PendingAssetsPanel.vue`） |
| `views/production/index.vue` | 按 projectType 选 builder/store |
| `views/production/utils/flowBuilder.ts` | 新增 `useRedrawFlowBuilder` |
| `views/production/components/rightChatBox/index.vue` | `agentType` 参数化（默认 productionAgent） |
| `views/production/components/workbench/generate/index.vue` | 原片参考开关、守卫状态行、缺 clip 自动切 |
| `views/production/components/workbench/generate/components/track.vue` | 段卡片徽标「含原片参考」 |

**新增 store**

| 文件 | 职责 |
|---|---|
| `stores/redraw.ts` | 当前集状态（`extractState/redrawState/stage`）、草稿、绑定、段时长、动作（confirm/bind/generate/rollback/cut） |
| `stores/redrawAgent.ts` | socket `/api/socket/redrawAgent`、消息列表、步骤状态、重连恢复 |

**前端依赖的后端接口（需在里程碑里实现）**

| 接口 | 用途 |
|---|---|
| `POST /redraw/getEpisodeState` | 一次拿齐：extractState、redrawState、阶段进度、段数、资产确认数、clip 状态 |
| `POST /redraw/getScript` / `updateScript` | 会话页第①步（读/存剧本） |
| `POST /redraw/getAssetDrafts` | 草稿 + 项目已有资产 + 当前绑定 |
| `POST /redraw/bindAssetDraft` | 草稿 → 已有资产 |
| `POST /redraw/confirmAssets` | 批量确认并落库 |
| `POST /redraw/generateStoryboard` / `getStoryboard` | 生成/读取转绘分镜 |
| `POST /redraw/confirmStoryboard` / `rollbackStoryboard` | 覆盖确认 / 回退 |
| `POST /redraw/cutSource` | 已有，补前端调用 |
| socket `redrawAgent` | 对话与 `redraw:updated` 事件 |

### 10.10 状态、文案与异常展示规范

| 场景 | 规范 |
|---|---|
| 加载 | 骨架屏（列表/卡片），按钮就地 loading，不整页转圈 |
| 空 | 每页给「下一步做什么」的空态文案 + 主按钮（例：无源片 → 「上传源片」） |
| 错误 | 卡片内联 + 悬停原因；全局错误用 `$message.error`；不吞 400 原文（沿用计费页映射过的已知原因） |
| 禁用 | 必须给原因（tooltip 或状态行），不允许「灰着但不说为什么」 |
| 阶段文案 | 预处理·切点 / 预处理·转写 / 解析中 / 等待认账 / 转绘生成中 / 切原片中 / 生成视频中 |
| 数据刷新 | 状态页 3s 轮询（沿用 inputVideo 现有做法）；socket 事件到达时立即刷新 |

### 10.11 每个里程碑完成后，浏览器里能看到什么

| 里程碑 | 可见结果（验收人操作路径） |
|---|---|
| **M1** 预处理原生化 | 源片卡点「开始分析」→ 卡片显示「预处理·切点 → 预处理·转写 → 解析中」三个阶段；完成变「待认账」；切原片后能预览每段 clip。**不需要任何新页面。** |
| **M2** 状态机 + 资产认账 | 「去认账」→ 进入会话页，走完 ①剧本 ②资产 ③时长；资产页出现「本集待确认」并完成确认；回输入页状态变「资产已确认」。**新页面：会话页。** |
| **M3** 转绘分镜 | 输入页点「生成转绘分镜」→ 进度完成后「去确认」→ 并排页看到源片版/转绘版/差异摘要 → 确认覆盖 → 状态「可生成」；生产画布出现 6 个转绘节点。**新页面：并排确认页 + 画布。** |
| **M4** 生成链 | 工作台每段有「使用原片参考」开关与徽标；缺 clip 自动切；守卫不满足时按钮禁用并写明原因；生成任务进任务中心，出片可预览。**改造生成面板。** |

---

## 11. 错误处理与恢复

| 场景 | 处理 |
|---|---|
| 进程中断卡 `extractState=0` | 启动自检 + `db:repair-stuck` 纳入转绘：超时（>2h）的 0 → `-1` 并写原因 |
| 同名重传 | 检查 `o_segment`（不再只看 `o_storyboard`）；已解析需显式 `replace` 才覆盖 |
| 解析中途失败 | 事务回滚或标记失败，不留半份分镜 |
| ASR 失败 / 无 words | 明确报错「词级时间戳缺失」，不降级 |
| 切点检测 0 个候选 | 报错并附诊断（阈值/时长），不生成空分镜 |
| 转绘层缺资产绑定 | 拒绝生成，提示回认账 |
| worker 未运行 | 前端提示「生成任务未启动」，不显示「生成中」假象 |
| 对话断线 | 从记忆表恢复；空结果不覆盖界面 |

---

## 12. 验收标准（可执行）

| # | 断言 | 方法 |
|---|---|---|
| A1 | 预处理产物四件齐全，`transcript.json` 有非空 `words[]` | 样本视频跑 `redraw.prepare` |
| A2 | 切点不漏主要切点，边界误差 ≤0.1s | 2~3 集人工比对记录 |
| A3 | 解析成功：`extractState=1`、`redrawState=1`、`o_segment`>0、`o_assets`=0 | 单测 + 真跑 |
| A4 | 资产确认：`o_assets`=N、`o_scriptAssets`>0、`redrawState=2` | 单测 |
| A5 | 转绘层：`redrawState=3`、段时长在范围内、`videoDesc` 为管道格式、原 `clipPath` 保留 | 单测 |
| A6 | 确认覆盖：`redrawState=4`、快照可回退 | 单测 |
| A7 | 生成请求含 clip：payload 有 `video_url`，prompt 含 `@视频1` 与「参考原片」 | 单测（mock vendor） |
| A8 | 多参模式守卫：非多参项目生成返回 400 | 单测 |
| A9 | 端到端：2 分钟源片 → 解析 → 认账 → 转绘 → 生成一段 15s 视频成功 | 真机（服务器） |
| A10 | 中断恢复：kill worker 后重启，任务可续/可重试，不永久卡 0 | 真机 |

---

## 13. 风险与待验证

| # | 风险 | 处理 |
|---|---|---|
| R1 | 「30s + 参考视频」未实测 | 先 15s；30s 探针通过再开放 |
| R2 | 中继是否透传 `metadata.content` | 先做 1 次真机探针（小段） |
| R3 | CPU 转写耗时 | 部署后跑 `benchmark-asr`，据此定模型档位 |
| R4 | 原生切点与 hypit 差异导致分镜变化 | 人工比对验收；必要时调阈值 |
| R5 | 参考视频体积导致请求过大 | 阈值 + URL 兜底 |
| R6 | 版权/授权（ToonFlow 补充协议：不得删除界面标识/版权信息；≥2 第三方分发需商业授权） | **需用户确认授权状态**；本设计不动 LICENSE 与界面版权声明 |
| R7 | 转绘层模型输出跑偏（新造资产名/时长超限） | 解析后强校验 + 失败重试一次 + 人工确认 |

---

## 14. 里程碑

| 里程碑 | 内容 | 依赖 |
|---|---|---|
| M1 | 预处理原生化（切点 + ASR + 拼贴图）+ job 化 | 无 |
| M2 | 状态机 + 资产认账（agent + 面板） | M1 |
| M3 | 转绘分镜层 + 并排确认 | M2 |
| M4 | 生成链改造（格式/提示词/clip/守卫）+ 真机 E2E | M3 + R1/R2 探针 |

---

## 15. 已拍板（2026-10-24 用户确认）

| # | 结论 |
|---|---|
| 1 | **30s**：先 15s 跑通；30s 需探针通过后再开放（`MIWO_REDRAW_30S_VERIFIED=1`） |
| 2 | **ASR 默认模型 = medium** int8（镜像 +约 0.9GB）；部署后跑 benchmark 再决定是否降档 |
| 3 | **授权口径（用户声明）**：仅借用开源沙箱内容、后续功能已改写、不对外推广 ToonFlow，暂不申请商业授权。**本设计不动 LICENSE 与界面版权声明** |
| 4 | **D11 成立**：所有转绘开发目标模型统一为 **seedance**（2.0 / 2.5） |
| 5 | **分支流程**：设计、实现都在 `feature/redraw-redesign`；测试通过后合进 `main` |

## 16. 交付节奏（2026-10-24 晚）

目标：**今晚完成可部署版本并上线**。按依赖与风险切两批：

| 批次 | 内容 | 部署后用户能看到 |
|---|---|---|
| **今晚必达（M1+M2+M3）** | 预处理原生化（切点+本地 ASR）、任务化、状态机、资产认账（会话页+面板）、转绘分镜生成、并排确认、画布节点 | 上传源片→分析（无需 hypit/WhisperX）→去认账→改剧本/选资产/确认时长→生成转绘分镜→并排确认→工作台能看到**带资产绑定**的新分段并生成视频 |
| **下一批（M4）** | videoDesc 管道格式、提示词引用原片、模式/模型守卫、clip 传输策略、工作台开关 | 生成时真正带**原片参考视频**（需先做 30s/传输探针） |

说明：M1+M2+M3 做完，生成链路已经能吃到**转绘分镜 + 资产绑定**（`o_shotAssets`），只是还不会把原片 clip 塞进请求；M4 再补参考视频与提示词。这样今晚能上线可用的转绘闭环，M4 的未知项（中继是否透传、30s 是否可行）不会阻塞发布。