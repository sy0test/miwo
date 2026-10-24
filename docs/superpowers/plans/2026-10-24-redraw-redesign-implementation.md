# 转绘改造 · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development`（推荐）或 `executing-plans` 逐任务实施。步骤用 `- [ ]` 跟踪。
> 每个任务结束时必须能独立验证；前端任务必须按「可见结果」在浏览器里点出来。

**Goal:** 把出海转绘从「解析完停在待对账」补成「上传 → 解析 → 资产认账 → 转绘分镜 → 并排确认 → 带原片参考生成」的可用闭环，并去掉 hypit/WhisperX 外部依赖。

**Architecture:** 保留现有解析层；新增三个后端子系统（原生化预处理、资产认账、转绘分镜）与两条前端页面（会话页、并排确认页）；生成链只做三处改造（描述格式、原片参考、模式守卫）。

**Tech Stack:** TypeScript / Express / knex（MySQL+SQLite）/ Vue 3 + TDesign + Pinia / job 队列（worker 进程）/ faster-whisper（Python 3.11）/ ffmpeg / vitest。

**Spec:** [`../specs/2026-10-24-redraw-redesign.md`](../specs/2026-10-24-redraw-redesign.md)

## Global Constraints

- Node **22.12–24**、pnpm **10**；后端测试 `pnpm --filter @miwo/api exec vitest run <file>`；web 测试 `pnpm --filter @miwo/web exec node --experimental-strip-types --test <file>`。
- **不新增表**；只允许 migration `016_redraw_pipeline` 的两列（`o_project.redrawMaxSegmentSec`、`o_script.redrawState`）。
- **不改生产链**（无 `sourceVideo` 的项目）行为；共享读取路径只允许「按引擎/项目类型分支」。
- 所有新增配置走 `apps/api/src/config.ts`（`MIWO_*`），不允许散落 `process.env`。
- 不提交密钥；模型文件不进 git。
- 每个任务一次提交（中文 commit message），完成后跑对应测试与 `pnpm --filter @miwo/api run typecheck`。
- 前端文案简体中文；新增用户可见文案不得默认英文。

## 实施修正 R1（2026-10-24 独立 review 后补充，**优先于下文任务步骤**）

> reviewer 预审发现 5 类会直接让 CI/门禁变红、或让 M2 前端 404 的问题。每个任务完成前必须按本节补齐对应项。

### G1 路由注册与数量断言（新增任何 `routes/redraw/*` 都要做）

- 新增/改名路由后跑：`pnpm --filter @miwo/api exec node --import=tsx scripts/generate-router.ts`（predev/prebuild 也挂，但提交前要手动确认 `src/router.ts` 已更新）。
- 同步 `apps/api/tests/router-generation.test.ts` 里硬编码的 mounts/routeFiles/hash 数字（当前基线 184；每加一条路由 +1，三处一起改）。

### G2 job 注册与「非计费入队」豁免

- 新 job type 必须：① `jobs/registry.ts` 登记；② `tests/job-registry.test.ts` 的 EXPECTED 集合 + handler 文件数；③ `tests/job-types.test.ts` 的第二份清单。
- `tests/job-enqueue-coverage.test.ts` 要求「路由里出现 `enqueueJobInTransaction(` 就必须同时有 `submitBilledJob(`」。`redraw.prepare` / `redraw.storyboard` **不是计费任务**：在该测试里加显式白名单常量 `NON_BILLED_JOB_TYPES = ["redraw.prepare","redraw.storyboard"]`（带注释说明理由），白名单之外仍保持原断言。
- 路由入队用 `enqueueJobInTransaction`：把「`extractState=0` + 入队」放同一事务，避免中途失败留下永久卡 0。

### G3 部署行（`o_agentDeploy`）必须由迁移补齐

- `seed/o_agentDeploy.ndjson` 只在 002 迁移时 insert-if-absent，**已迁移的库不会拿到新 key**。
- 在 `016_redraw_pipeline` 里显式 insert-if-absent 两行：`redrawAgent:reconcileAgent`、`redrawAgent:storyboardAgent`（模型默认 `newapi:gpt-6.1-sol`）。
- 同步 `seed/o_agentDeploy.ndjson`（新库）与 `tests/migration-seed.test.ts` 的行数断言（当前 19 → 21）。
- `apps/api/src/utils/ai.ts`（**不是** `agents/ai.ts`）的 type/allowlist 两张清单都要加这两个 key。

### G4 租户特例门禁

- 新增 `src/**/*.ts` 后跑 `node tools/check-tenant-exceptions.cjs --record`；新增 `join`/`raw` 必须在 `tenant-exceptions.json` 补 `confirmed/note/phase1b` 证据（照已有条目格式写）。

### G5 配置模板双向守卫

- `tools/check-deploy-config.cjs` 断言 `.env.example` 的 `MIWO_*` 与 `config.ts` 读取双向一致。
- 删除 `MIWO_REDRAW_PREP`、增加 `MIWO_ASR_*` 时，必须同步：`apps/api/.env.example`、`deploy/.env.example`、`apps/api/tests/config-single-source.test.ts`。

### G6 路径修正（按实际仓库）

| 计划原文 | 实际路径 |
|---|---|
| `apps/api/Dockerfile` | `deploy/Dockerfile` |
| `agents/ai.ts` | `apps/api/src/utils/ai.ts` |
| `tools/redraw-prep/...`（样本） | 仓库外 `D:\\sy_workspace\\tools\\redraw-prep\\...` | 

### G7 `redraw.prepare` 的 handler 职责与幂等键

- handler 顺序：`runPrep` → `analyzeRedrawAssets` → 写库/体检 → `extractState=1` + `redrawState=1`。**解析必须在 handler 内**，路由不再 fire-and-forget。
- 幂等键：`redraw.prepare:{projectId}:{scriptId}:{replace ? 1 : 0}`（见 spec §5.6）。

### G8 补齐前端依赖的 4 个接口（并入 Task 6 一起做）

新增路由：`redraw/getScript`、`redraw/updateScript`、`redraw/createAsset`、`redraw/updateAsset`。
- `updateScript` 写 `o_script.content`；返回 `{changed:boolean}`。
- `createAsset` 写 `o_assets`（类型列 + 名称 + 说明 + 提示词），返回 `{id}`；出图复用现有资产出图路由，不新增。
- `updateAsset` 只允许改本集刚建/已绑定的资产，禁止跨租户、禁止覆盖用户已有资产的 prompt（沿用「只补空」口径）。

### G9 M3 解析器与 clip 判据

- 解析器固定用 `apps/api/src/utils/shots/storyboardTable.ts`，并写 `ParsedStoryboard → RedrawSegment[]` 适配层（补 `sourceRange`、资产 ID 映射）。
- 确认覆盖后调 `cutSource({ onlyMissing: true, cleanStale: true })`；**clip 复用判据** = 文件存在且 ffprobe 时长与段时长差 ≤0.1s，否则重切。T13 的继承逻辑与 T14 的重切必须用同一判据函数。

### G10 字体（不塞仓库）

- `deploy/Dockerfile` 运行层 `apt-get install -y fonts-dejavu-core`；预处理器字体默认 `/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf`，可用 `MIWO_GRID_FONT` 覆盖。拼贴图标签只含数字/时间码（ASCII），不需要 CJK 字体。

### G11 每个任务的 DoD（缺一不可）

1. 相关 vitest 全绿；2. `pnpm --filter @miwo/api run typecheck`；3. 新增路由 → G1；4. 新增 job → G2；5. 新增 src 文件 → G4；6. 改配置 → G5；7. 汇报里写「跑了哪些命令、结果如何」。

---

## File Structure（先锁定边界）

### 新增（后端）

```text
apps/api/src/redraw/prep/cuts.ts            切点候选采集 + 聚类（纯函数可测）
apps/api/src/redraw/prep/prep.ts            预处理编排（拼贴图/切点/转写 → 产物目录）
apps/api/src/redraw/state.ts                redrawState 状态机与转移校验
apps/api/src/redraw/assets.ts               草稿/绑定/确认落库
apps/api/src/redraw/storyboard.ts           转绘层 prompt 拼装 + 输出解析 + 校验
apps/api/src/redraw/storyboardWrite.ts      转绘分镜落库（保留 clipPath + 快照）
apps/api/src/redraw/videoDesc.ts            管道格式 videoDesc 投影
apps/api/src/redraw/clipTransport.ts        clip 传输策略（dataurl/url/auto）
apps/api/asr/transcribe.py                  faster-whisper CLI（词级时间戳）
apps/api/asr/requirements.txt
apps/api/scripts/fetch-asr-model.cjs        模型下载/校验
apps/api/scripts/benchmark-asr.cjs          服务器基准测试
apps/api/scripts/probe-30s-reference.cjs    30s + 参考视频探针
```

### 新增（前端）

```text
apps/web/src/stores/redraw.ts               集状态/草稿/绑定/动作
apps/web/src/stores/redrawAgent.ts          socket 会话
apps/web/src/views/redraw/session/index.vue 会话页壳
apps/web/src/views/redraw/session/components/{StatusStepper,ScriptStep,AssetStep,DurationStep,ChatPanel}.vue
apps/web/src/views/redraw/review/index.vue  并排确认
apps/web/src/views/redraw/components/{AssetBindDialog,DiffTable}.vue
apps/web/src/views/assets/components/PendingAssetsPanel.vue
apps/web/src/views/production/node/redrawStatus.vue
```

### 改造（后端）

```text
routes/redraw/analyzeSource.ts              改为入队 redraw.prepare
routes/redraw/getSourceList.ts              补 stage/progress/redrawState
routes/redraw/cutSource.ts                  保持；补 confirm 后自动调用
jobs/registry.ts + tests/job-registry.test.ts  新增两种 job
socket/index.ts + socket/routes/redrawAgent  新命名空间
agents/redrawAgent/{index,tools}.ts          认账 agent
db/migrations/index.ts                       登记 016
utils/redraw.ts                              videoDesc 投影接入
routes/production/workbench/{generateVideoPrompt,generateVideo,batchGenerateVideo}.ts
jobs/handlers/videoGenerate.ts               includeClip / 传输策略
vendors/newapi.ts                            @视频N 锚点 + 参考数量截断
```

### 改造（前端）

```text
router/index.ts                              +2 路由
pages/workbench/index.vue                    转绘菜单顺序
views/project/components/projectDialog.vue   视频模型 + 单段上限
views/inputVideo/index.vue                   状态机/阶段进度/切原片
views/assets/index.vue                       接 PendingAssetsPanel
views/production/index.vue                   按 projectType 选 builder/store
views/production/utils/flowBuilder.ts        useRedrawFlowBuilder
views/production/components/rightChatBox/index.vue  agentType prop
views/production/components/workbench/generate/index.vue  开关/守卫/自动切
views/production/components/workbench/generate/components/track.vue  徽标
```

---

# M1 · 预处理原生化（可见结果：分析能在没有 hypit/WhisperX 的机器上跑完）

## Task 1: 切点聚类与采集

**Files:**
- Create: `apps/api/src/redraw/prep/cuts.ts`
- Test: `apps/api/tests/redraw-cuts.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type CutCandidate = { at: number; score: number };
  export function clusterCuts(cands: CutCandidate[], o?: { gapSec?: number; minShotSec?: number; duration?: number }): number[];
  export async function detectCuts(videoAbs: string, o?: { threshold?: number }): Promise<CutCandidate[]>;
  ```

- [ ] **Step 1: 写失败测试**（覆盖：同一次过渡的多候选合并取最高分；`gap=0.25` 边界；首尾 0.2s 丢弃；最短镜 0.4s 约束；乱序输入）
- [ ] **Step 2: 跑测试确认失败**：`pnpm --filter @miwo/api exec vitest run tests/redraw-cuts.test.ts`
- [ ] **Step 3: 实现 `clusterCuts`**（排序 → 分簇 → 取簇内最高分 → 过滤首尾/最短镜）
- [ ] **Step 4: 实现 `detectCuts`**（`ffmpeg -vf "select='gt(scene,TH)',metadata=print" -an -f null -`，解析 `pts_time` 与 `scene_score`）
- [ ] **Step 5: 跑测试 + typecheck**，提交 `feat(redraw): 原生切点检测`

**可见结果：** `detectCuts` 可对样本视频输出帧级切点；无 UI 变化。

## Task 2: ASR 服务与打包

**Files:**
- Create: `apps/api/asr/transcribe.py`、`apps/api/asr/requirements.txt`、`apps/api/src/utils/asr/index.ts`、`apps/api/scripts/fetch-asr-model.cjs`、`apps/api/tests/asr-adapter.test.ts`
- Modify: `apps/api/Dockerfile`（构建阶段装 Python + venv + 模型）、`.gitignore`（`apps/api/asr/models/`）

**Interfaces:**
- Produces:
  ```ts
  export type AsrWord = { word: string; start: number; end: number };
  export type AsrTranscript = { language: string; duration: number; segments: { start: number; end: number; text: string }[]; words: AsrWord[] };
  export class AsrNoWordTimestampsError extends Error {}
  export async function transcribe(wavAbs: string, o?: { model?: string; language?: string }): Promise<AsrTranscript>;
  ```

- [ ] **Step 1: 写 Python 契约脚本**（`transcribe.py`：入参 `--wav --model --out`；faster-whisper `word_timestamps=True, vad_filter=True, task="transcribe"`；先 `detect_language` 再显式传；无 words 时退出码 3）
- [ ] **Step 2: 写 Node 适配器失败测试**（注入 spawn stub：正常 JSON、退出码 3 → `AsrNoWordTimestampsError`、超时）
- [ ] **Step 3: 实现适配器**（spawn venv python；超时 20min；日志落 `prep.log`）
- [ ] **Step 4: 实现 `fetch-asr-model.cjs`**（固定 revision + SHA256；`--check` 只校验不下载）
- [ ] **Step 5: 更新 Dockerfile**（stage: python3-venv + pip install + 下载 medium；runtime 拷 venv + 模型）
- [ ] **Step 6: 本机验证**：`pnpm --filter @miwo/api exec node scripts/fetch-asr-model.cjs --check`；对 `tools/redraw-prep/probe-audio/zh-real-seg.wav` 跑 `transcribe.py`，确认 `words` 非空
- [ ] **Step 7: 提交** `feat(redraw): 打包本地 Whisper ASR`

**可见结果：** 无 UI；命令行能出词级 JSON。

## Task 3: 预处理编排 + 任务化

**Files:**
- Create: `apps/api/src/redraw/prep/prep.ts`、`apps/api/src/jobs/handlers/redrawPrepare.ts`、`apps/api/tests/redraw-prep.test.ts`
- Modify: `routes/redraw/analyzeSource.ts`（改入队）、`jobs/registry.ts`、`tests/job-registry.test.ts`、`config.ts`（删 `redrawPrepScript`，加 `asr.*`）、`app.ts`（删启动自检）

**Interfaces:**
- Produces: job type `"redraw.prepare"`，payload `{ projectId: number; scriptId: number; replace?: boolean; lang?: string }`
- `runPrep(videoAbs, prepDir, deps): Promise<PrepResult>`（deps 注入 cut/asr/ffmpeg，便于测试）

- [ ] **Step 1: 失败测试**：mock deps 断言产物文件（grid/cuts/transcript/MANIFEST）与 `extractState` 转移（0→1 + `redrawState=1`）；失败时 `-1` 且 `errorReason` 含原因
- [ ] **Step 2: 实现 `runPrep`**（进程内顺序：probe → grid → cuts → wav → asr → 写 MANIFEST；阶段进度写 `redrawStage`）
- [ ] **Step 3: 实现 handler**（租户 ctx；幂等键 `redraw:prepare:{projectId}:{scriptId}:{analysisVersion}`；超时 30min）
- [ ] **Step 4: 路由改入队**（校验项目/源片/未在跑 → `enqueueJob` → 置 0 → 返回 `{jobId}`）
- [ ] **Step 5: 注册 job + 更新注册表断言**；`pnpm --filter @miwo/api exec vitest run tests/job-registry.test.ts tests/redraw-prep.test.ts`
- [ ] **Step 6: 提交** `feat(redraw): 预处理任务化`

**可见结果：** 点「开始分析」后任务中心出现 `redraw.prepare`，服务器无 hypit 也能跑完。

## Task 4: 源片页阶段进度（前端）

**Files:**
- Modify: `routes/redraw/getSourceList.ts`（返回 `redrawState`/`stage`/`progress`）、`apps/web/src/views/inputVideo/index.vue`
- Test: `apps/web/tests/redraw-status.test.mjs`

**Interfaces:**
- 响应新增：`redrawState: number`、`stage: "cut"|"transcribe"|"analyze"|null`、`progress: number|null`

- [ ] **Step 1: 写测试**：`statusView(item)` 映射（0+stage → 「预处理·转写」；-1 → 失败；1 → 「待认账」…）
- [ ] **Step 2: 实现映射函数 + 卡片阶段进度条**（组件内 `<t-progress>`，阶段文案表见 spec §10.10）
- [ ] **Step 3: 跑测试 + `pnpm --filter @miwo/web run build-only`**
- [ ] **Step 4: 浏览器验收**：上传样本 → 开始分析 → 看到三个阶段文案 → 完成变「待认账」
- [ ] **Step 5: 提交** `feat(web): 源片页显示分析阶段进度`

**可见结果：** 输入视频页卡片能显示「预处理·切点 → 预处理·转写 → 解析中」。

---

# M2 · 状态机 + 资产认账（可见结果：会话页三步走完，资产落库）

## Task 5: migration 016 + 状态机 + getEpisodeState

**Files:**
- Create: `apps/api/src/db/migrations/016_redraw_pipeline.ts`、`apps/api/src/redraw/state.ts`、`apps/api/src/routes/redraw/getEpisodeState.ts`、`apps/api/tests/redraw-state.test.ts`
- Modify: `db/migrations/index.ts`、`types/database.d.ts`（跑 `pnpm --filter @miwo/api run db:types` 重新生成）

**Interfaces:**
- `export const REDRAW_STATE = { NONE:0, PARSED:1, ASSETS_OK:2, STORYBOARD_READY:3, CONFIRMED:4, FAILED:-1 } as const`
- `assertRedrawTransition(from, to)`（只允许 0→1→2→3→4、任意→-1、-1→0）
- `getEpisodeState({ projectId, scriptId })` → `{ extractState, redrawState, stage, progress, segmentCount, assetsConfirmed, clipsReady }`

- [ ] **Step 1: migration 失败测试**（sqlite 上 up/down；列存在；回填 `extractState=3 → redrawState=1`）
- [ ] **Step 2: 实现 migration**（两列；回填；down 删列）
- [ ] **Step 3: 状态机测试**（合法/非法转移；`-1` 可重试）
- [ ] **Step 4: 实现 `getEpisodeState` 路由**（zod 校验 projectId/scriptId；租户守卫）
- [ ] **Step 5: 跑测试 + typecheck**，提交 `feat(redraw): 状态机与集状态接口`

**可见结果：** 接口可查一集的完整状态；旧数据 3 自动迁移为 1。

## Task 6: 资产草稿 / 绑定 / 确认 API

**Files:**
- Create: `apps/api/src/redraw/assets.ts`、`routes/redraw/{getAssetDrafts,bindAssetDraft,confirmAssets}.ts`、`apps/api/tests/redraw-assets.test.ts`

**Interfaces:**
- `getDrafts(projectId, scriptId)` → `{ drafts: AssetDraft[]; existing: AssetRow[]; bindings: Record<string, number> }`
- `bindDraft(projectId, scriptId, draftName, assetId)`
- `confirmAssets(projectId, scriptId)` → `{ created: number; reused: number; linked: number }`（事务；成功后 `redrawState=2`）

- [ ] **Step 1: 失败测试**（复用已有资产不新建；新建写 `o_assets`+类型列；重复确认幂等；跨租户拒绝；空绑定报错）
- [ ] **Step 2: 实现 `redraw/assets.ts`**（沿用 `writeRedraw` 的「只补空、不覆盖用户改过的 describe/prompt」口径）
- [ ] **Step 3: 三个路由**（zod + `success/error` 封装 + 归属校验）
- [ ] **Step 4: 跑测试，提交** `feat(redraw): 资产认账接口`

**可见结果：** 用 curl 可完成「绑定 → 确认」，库里出现资产与挂链。

## Task 7: redrawAgent socket 与会话工具

**Files:**
- Create: `apps/api/src/agents/redrawAgent/index.ts`、`apps/api/src/agents/redrawAgent/tools.ts`、`apps/api/src/socket/routes/redrawAgent/index.ts`、`apps/api/tests/redraw-agent-tools.test.ts`
- Modify: `socket/index.ts`（注册命名空间）、`agents/ai.ts`（`redrawAgent:reconcileAgent` 白名单）、`db/migrations/seed/o_agentDeploy.ndjson`（新增部署行，模型沿用 `newapi:gpt-6.1-sol`）

**Interfaces:**
- 工具（名字固定，前端/技能都引用）：`redraw_getScript`、`redraw_updateScript`、`redraw_listAssetDrafts`、`redraw_listProjectAssets`、`redraw_bindDraft`、`redraw_createAsset`、`redraw_updateAsset`、`redraw_confirmAssets`、`redraw_confirmSegmentCap`
- socket 事件：`redraw:updated`（`{ scriptId, kind: "script"|"assets"|"cap" }`）、`redraw:step`（`{ scriptId, step: 1|2|3 }`）

- [ ] **Step 1: 失败测试**（工具参数校验：跨集 assetId 拒绝；`confirmSegmentCap` 改值必须显式 `force:true` 且 4..30）
- [ ] **Step 2: 实现 tools**（全部走 `redraw/assets.ts` 与 `state.ts`，不直写 SQL）
- [ ] **Step 3: 实现 agent/socket**（记忆 `memories`，`agentType=redrawAgent`；重连不清空；每次写后发 `redraw:updated`）
- [ ] **Step 4: 单测 + 本地 socket 冒烟（两个客户端互不串）**，提交 `feat(redraw): 认账会话 agent`

**可见结果：** 会话 socket 可连接，工具调用能改库并推送事件。

## Task 8: 前端 redraw store + 输入页状态机

**Files:**
- Create: `apps/web/src/stores/redraw.ts`、`apps/web/tests/redraw-store.test.mjs`
- Modify: `views/inputVideo/index.vue`（按钮矩阵）、`router/index.ts`（+2 路由占位）

**Interfaces:**
- `useRedrawStore()`：`state`（EpisodeState）、`refresh(scriptId)`、`startAnalysis()`、`cutClips()`、`primaryAction`（computed 返回 `{label, kind, to?}`）

- [ ] **Step 1: 测试 `primaryAction` 矩阵**（redrawState 0/1/2/3/4/-1 与 extractState=0）
- [ ] **Step 2: 实现 store**（axios 调 §10.9 的接口；轮询 3s + 页面隐藏暂停）
- [ ] **Step 3: 改输入页按钮**（主/次按钮按矩阵；切原片进度）
- [ ] **Step 4: 浏览器验收**：按状态看到不同按钮；点「去认账」能跳到会话页（空壳）
- [ ] **Step 5: 提交** `feat(web): 转绘集状态 store 与按钮矩阵`

**可见结果：** 输入页的状态/按钮完全由后端状态驱动。

## Task 9: 会话页壳 + 剧本步骤

**Files:**
- Create: `views/redraw/session/index.vue`、`views/redraw/session/components/{StatusStepper,ScriptStep,ChatPanel}.vue`、`apps/web/tests/redraw-session.test.mjs`
- Modify: `router/index.ts`（`/redraw/session/:scriptId`）

**Interfaces:**
- 步骤闸门：`canGoStep2 = true`（剧本可不改）；`canGoStep3 = assetsAllConfirmed`；`canGenerate = capConfirmed`
- 自动保存：`ScriptStep` 输入 2s 防抖 → `POST /redraw/updateScript`

- [ ] **Step 1: 测试闸门纯函数**（`computeStepAccess(state)`）
- [ ] **Step 2: 页面骨架**（步骤条 + 主区 `<component :is>` + 底部按钮 + 右侧 ChatPanel 占位）
- [ ] **Step 3: 剧本步骤**（textarea 编辑、字数、保存状态、返回时恢复）
- [ ] **Step 4: 浏览器验收**：进入页面看到三步条，能改剧本并保存，刷新后内容在
- [ ] **Step 5: 提交** `feat(web): 转绘会话页与剧本步骤`

**可见结果：** 会话页可打开、可改剧本。

## Task 10: 资产步骤 + 资产页「待确认」面板

**Files:**
- Create: `views/redraw/session/components/AssetStep.vue`、`views/redraw/components/AssetBindDialog.vue`、`views/assets/components/PendingAssetsPanel.vue`、`apps/web/tests/redraw-assets-ui.test.mjs`
- Modify: `views/assets/index.vue`（增加 tab/面板；仅转绘项目可见）

**Interfaces:**
- `AssetStep` props：`{ drafts, existing, bindings }`；emits `bind/create/update/confirm`
- 每条卡片状态机：`pending → bound | created → confirmed`

- [ ] **Step 1: 测试卡片状态推导与「全部确认」可用性**
- [ ] **Step 2: 实现 `AssetStep` + `AssetBindDialog`**（复用选择器：按类型过滤 + 搜索）
- [ ] **Step 3: 实现资产页面板**（复用同一卡片组件，避免两套 UI）
- [ ] **Step 4: 浏览器验收**：会话页确认资产 → 资产页出现该资产 → 状态「资产已确认」
- [ ] **Step 5: 提交** `feat(web): 资产认账步骤与待确认面板`

**可见结果：** 资产从「草稿」变成「确认后的资产」，两边页面同步。

## Task 11: 时长步骤 + 生成入口

**Files:**
- Create: `views/redraw/session/components/DurationStep.vue`、`apps/api/src/routes/redraw/confirmSegmentCap.ts`、`apps/api/tests/redraw-segment-cap.test.ts`
- Modify: `views/redraw/session/index.vue`（底部按钮：生成转绘分镜 → 调 M3 接口）

**Interfaces:**
- `confirmSegmentCap({ projectId, scriptId, seconds, force? })`：读当前 project 值；不同则返回 409 `{ needRerun: true }`，`force:true` 才写
- `DurationStep` props：`{ segments: {index, sourceRange, duration}[], cap: number }`；超限段红标 + 「建议合并/拆分」

- [ ] **Step 1: 后端测试**（范围 4..30；改值 409；force 写入审计）
- [ ] **Step 2: 前端表格 + 校验**（超限不可继续；显示上限来源「sd2.0=15s」）
- [ ] **Step 3: 浏览器验收**：三段时长表显示、确认后「生成转绘分镜」可点
- [ ] **Step 4: 提交** `feat(redraw): 时长确认`

**可见结果：** 三步全部可走完，最后按钮点亮。

---

# M3 · 转绘分镜（可见结果：并排确认页 + 画布节点）

## Task 12: 转绘技能 + 生成任务

**Files:**
- Create: `apps/api/data/skills/feicai/redraw-storyboard-skill/SKILL.md`、`apps/api/src/redraw/storyboard.ts`、`routes/redraw/generateStoryboard.ts`、`jobs/handlers/redrawStoryboard.ts`、`apps/api/tests/redraw-storyboard.test.ts`
- Modify: `jobs/registry.ts` + `tests/job-registry.test.ts`；`seed/o_agentDeploy.ndjson` 加 `redrawAgent:storyboardAgent`；`agents/ai.ts` 白名单

**Interfaces:**
- `buildStoryboardPrompt(input): {system, user}`；`parseStoryboardOutput(text): { segments: RedrawSegment[]; changes: string[] }`
- 校验：段时长 ∈ `[4, min(cap, modelMax)]`；镜时长和=段声明；资产名 ∈ 已确认集合；缺块/超限 → 422（可重试一次）

- [ ] **Step 1: 解析/校验失败测试**（缺 `<changeSummary>`、资产名不存在、时长超限、镜和不等）
- [ ] **Step 2: 实现解析与校验**
- [ ] **Step 3: 实现 job `redraw.storyboard`**（Ai.Text + 计费上下文；成功写 `redrawState=3`）
- [ ] **Step 4: 路由 `generateStoryboard`**（入队 + 幂等）
- [ ] **Step 5: 测试 + 提交** `feat(redraw): 转绘分镜生成`

**可见结果：** 点「生成转绘分镜」后任务中心出现任务，完成后状态变「转绘待确认」。

## Task 13: 转绘分镜落库（保留 clip + 快照）

**Files:**
- Create: `apps/api/src/redraw/storyboardWrite.ts`、`apps/api/tests/redraw-storyboard-write.test.ts`

**Interfaces:**
- `writeRedrawStoryboard(db, { projectId, scriptId, segments })`：
  1. 先快照源片分镜 → `o_agentWorkData.redrawSourceStoryboard`
  2. 事务内删 `manual=0` 段/镜/绑定 → 重建
  3. 按 `segmentIndex + sourceRange` 从旧段继承 `clipPath`

- [ ] **Step 1: 失败测试**（clip 继承；manual 段保留；重复执行幂等；事务失败回滚）
- [ ] **Step 2: 实现**；`Step 3` 跑测试 + typecheck；提交 `feat(redraw): 转绘分镜落库`

**可见结果：** 转绘分镜写进 v2 表，源片版快照可读，已切 clip 不丢。

## Task 14: 并排确认页

**Files:**
- Create: `views/redraw/review/index.vue`、`views/redraw/components/DiffTable.vue`、`routes/redraw/{getStoryboard,confirmStoryboard,rollbackStoryboard}.ts`、tests
- Modify: `router/index.ts`

**Interfaces:**
- 页面数据：`{ source: SegmentView[]; redraw: SegmentView[]; changes: string[] }`
- 差异标注：`added|removed|duration|assets|dialogue`
- 确认：`confirmStoryboard` → 写状态 4 + 触发 `cutSource`（返回 jobId 或同步结果）

- [ ] **Step 1: 差异计算纯函数测试**（段对齐按 index/sourceRange；五类标注）
- [ ] **Step 2: 后端三接口 + 测试**
- [ ] **Step 3: 页面**（左右表格、摘要、差异色、三按钮 + 进度反馈）
- [ ] **Step 4: 浏览器验收**：看到差异 → 确认 → 状态「可生成」；回退可用
- [ ] **Step 5: 提交** `feat(web): 转绘并排确认`

**可见结果：** 并排对比与确认闭环可用。

## Task 15: 生产画布转绘节点 + 对话参数化

**Files:**
- Create: `views/production/node/redrawStatus.vue`
- Modify: `views/production/utils/flowBuilder.ts`（`useRedrawFlowBuilder`）、`views/production/index.vue`、`components/rightChatBox/index.vue`（`agentType` prop）、`pages/workbench/index.vue`（菜单顺序）

**Interfaces:**
- `useRedrawFlowBuilder(redrawStatus)` → 6 节点/5 边（源片/解析/资产/转绘分镜/生成/工作台）
- `rightChatBox` props 增加 `agentType?: "productionAgent" | "redrawAgent"`（默认前者）

- [ ] **Step 1: builder 单测**（节点 id/edges/位置回退）
- [ ] **Step 2: `redrawStatus` 节点组件**（状态徽标 + 点击跳转）
- [ ] **Step 3: production 页按类型切换 builder/store/chat**
- [ ] **Step 4: 菜单顺序**（转绘：inputVideo → production → cornerScape → assets）
- [ ] **Step 5: 浏览器验收**：转绘项目画布 6 节点、点击各节点跳对页面、右侧对话是 redrawAgent
- [ ] **Step 6: 提交** `feat(web): 转绘画布节点与对话`

**可见结果：** 画布能看到转绘全流程状态。

---

# M4 · 生成链（可见结果：一段视频带着原片参考生成出来）

## Task 16: videoDesc 管道格式统一

**Files:**
- Create: `apps/api/src/redraw/videoDesc.ts`、`apps/api/tests/redraw-video-desc.test.ts`
- Modify: `apps/api/src/utils/redraw.ts`（新写一律用新投影；旧函数保留只读兼容）、`redraw/storyboardWrite.ts`

**Interfaces:**
- `buildRedrawSegmentVideoDesc(segment, shots)`：`承接上镜：…` + markdown 行 `| 序号 | 画面描述 | 时长 | 景别 | 运镜 | 光影氛围 | 台词 | 音效 |`
- 函数必须与生产 v2 的 `buildSegmentVideoDesc` **同形**（抽公共断言测试）

- [ ] **Step 1: 测试**（单段/多段；承接句取上一段末镜；转义 `|`）
- [ ] **Step 2: 实现 + 切写入点**
- [ ] **Step 3: 跑测试，提交** `feat(redraw): videoDesc 改为管道格式`

**可见结果：** 新写的 `o_segment.videoDesc` 能被 seedance 模板解析。

## Task 17: 原片参考进提示词

**Files:**
- Modify: `routes/production/workbench/generateVideoPrompt.ts`、`jobs/handlers/promptBatch.ts`、`apps/api/data/modelPrompt/video/seedance2Multi-parameterMode.md`（seed 目录同步）、`vendors/newapi.ts`
- Test: `apps/api/tests/redraw-video-prompt.test.ts`

**Interfaces:**
- prompt 输入新增 `clip?: { fileName: string; durationSec: number }`；模板固定段：`参考素材：@视频1 为本段原片参考…`
- `newapi.buildVideoContent` 的锚点按「素材类型分别计数」；参考视频数量按模型声明截断并 warn

- [ ] **Step 1: 失败测试**（含 clip 时 prompt 有「@视频1」「参考原片」；无 clip 时没有；数量超限 warn）
- [ ] **Step 2: 实现 prompt 注入 + 模板**
- [ ] **Step 3: 适配器锚点修复 + 数量截断**
- [ ] **Step 4: 测试 + 提交** `feat(redraw): 提示词引用原片`

**可见结果：** 生成请求的 prompt 里出现原片引用。

## Task 18: 模式/模型守卫 + includeClip

**Files:**
- Modify: `routes/production/workbench/generateVideo.ts`、`batchGenerateVideo.ts`、`apps/api/tests/redraw-video-guards.test.ts`

**Interfaces:**
- 请求增加 `includeClip?: boolean`（默认 true）
- 守卫：redraw 项目 & 非多参 → 400 `{ code:"REDRAW_MODE_REQUIRED" }`；模型无 `videoReference` → 400 `{ code:"REDRAW_MODEL_UNSUPPORTED" }`
- refs 里 `sources:"clip"` 的项仅在 `includeClip!==false` 时发送

- [ ] **Step 1: 三个守卫的失败测试**
- [ ] **Step 2: 实现守卫与参数透传**
- [ ] **Step 3: 提交** `feat(redraw): 生成守卫`

**可见结果：** 配置不对时前端能拿到明确错误码/文案。

## Task 19: clip 传输策略 + 探针

**Files:**
- Create: `apps/api/src/redraw/clipTransport.ts`、`apps/api/scripts/probe-30s-reference.cjs`、`apps/api/tests/redraw-clip-transport.test.ts`
- Modify: `jobs/handlers/videoGenerate.ts`、`config.ts`（`MIWO_REDRAW_CLIP_TRANSPORT`、`MIWO_VIDEO_JOB_TIMEOUT_MS`）

**Interfaces:**
- `resolveClipRef(clipRel, sizeBytes): Promise<{ kind:"dataurl"|"url"; value:string }>`（阈值默认 20MB）
- 探针：`node scripts/probe-30s-reference.cjs --projectId --scriptId --dry`，真跑时输出 jobId 与最终 URL

- [ ] **Step 1: 策略测试**（阈值内 dataurl / 超阈值 url / url 模式要求 `MIWO_PUBLIC_BASE_URL` 非本机）
- [ ] **Step 2: 接入 videoGenerate handler**（job payload 只存 path，运行时再决定）
- [ ] **Step 3: 写探针脚本**（零成本 dry + 一次真跑模式）
- [ ] **Step 4: 提交** `feat(redraw): clip 传输策略与探针`

**可见结果：** 大 clip 不再必然超时/超限；30s 有验收入口。

## Task 20: 工作台生成面板改造

**Files:**
- Modify: `views/production/components/workbench/generate/index.vue`、`components/track.vue`；`apps/web/tests/redraw-workbench.test.mjs`

**Interfaces:**
- 段卡片状态行：`多参 ✓ / 模型支持参考视频 ✓ / clip 已切 ✓`（任一不满足给原因 + 修复入口）
- 「使用原片参考」开关 → 请求 `includeClip`
- 进入工作台自动切：缺 clip 且 `redrawState>=4` → 调 `cutSource`（带进度与重切）

- [ ] **Step 1: 测试守卫状态推导**（三条件组合 → 禁用原因）
- [ ] **Step 2: 实现开关/状态行/自动切**
- [ ] **Step 3: 浏览器验收**：关掉开关提示；缺 clip 自动切；生成任务进任务中心
- [ ] **Step 4: 提交** `feat(web): 工作台原片参考开关`

**可见结果：** 生成面板能看出「这一段会不会带原片」，并能生成。

## Task 21: E2E 验收与文档

**Files:**
- Create: `apps/api/scripts/verify-redraw-e2e.cjs`（调接口跑完整链路，输出每步断言）
- Modify: `docs/redraw-status-contract.md`、`docs/redraw-todo.md`、`README.md`（转绘段）

- [ ] **Step 1: 写 E2E 脚本**（上传→分析→认账→转绘→确认→切→生成→轮询，支持 `--dry` 到认账为止）
- [ ] **Step 2: 本机真跑一次并记录耗时/结果**
- [ ] **Step 3: 更新两份文档**（现状契约改成新状态机与前端入口；todo 勾掉已做项）
- [ ] **Step 4: 提交** `test(redraw): E2E 验收与文档`

**可见结果：** 一条命令跑完整链路；文档与代码一致。

---

## Self-Review（计划自检）

| Spec 章节 | 覆盖任务 |
|---|---|
| §4 数据/状态机 | T5、T6、T13 |
| §5 预处理原生化 | T1、T2、T3、T4 |
| §6 解析层 | T3、T13 |
| §7 资产认账 | T6、T7、T10 |
| §8 转绘分镜 | T12、T13、T14 |
| §9 生成链 | T16、T17、T18、T19、T20 |
| §10 前端融入 | T4、T8、T9、T10、T11、T14、T15、T20 |
| §11 错误恢复 | T3、T5、T18、T20 |
| §12 验收 | T21（A1~A10 对应到各任务单测 + E2E） |
| §13 风险 | T19（R1/R2/R5）、T2（R3）、T1（R4） |

**未覆盖 / 需在实施前确认：**
- R6 授权问题（用户决策，不属于代码任务）；
- 30s 开放与否依赖 T19 探针结果；
- ASR 默认模型档位依赖 `benchmark-asr` 实测（T2 附带脚本，部署后跑）。

## 执行顺序与依赖

```text
M1: T1 → T2 → T3 → T4
M2: T5 → T6 → T7 → T8 → T9 → T10 → T11
M3: T12 → T13 → T14 → T15
M4: T16 → T17 → T18 → T19 → T20 → T21
```

- T7 依赖 T6；T9/T10/T11 依赖 T8；T14 依赖 T12/T13；T20 依赖 T18/T19。
- 每个任务完成即提交，分支 `feature/redraw-redesign`；M2 结束时跑一次浏览器验收再进 M3。