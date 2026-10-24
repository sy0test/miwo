# 转绘（出海转绘）现状契约

> 更新时间：2026-10-21 ｜ 适用仓库：`code/miwo`
> 定位：**把"现在代码里真正成立的事实"写下来**，与设计文档互补。
> 设计见 [`superpowers/specs/2026-10-05-redraw-three-layer-pipeline-design.md`](superpowers/specs/2026-10-05-redraw-three-layer-pipeline-design.md)，
> A 层实现记录见 [`superpowers/plans/2026-10-05-redraw-A-analysis-layer.md`](superpowers/plans/2026-10-05-redraw-A-analysis-layer.md)，
> 待办见 [`redraw-todo.md`](redraw-todo.md)。

## 0. 一句话状态

**解析层（第 1~4 步）已在 miwo 跑通并本机实测；写入口径已迁 v2 结构化分镜（`o_segment`/`o_shot`/`o_shotAssets`，
不再写 legacy 的 `o_storyboard`/`o_videoTrack`）；按片段的切原片也已跑通。关联层、转绘层（B/C 层）尚未实现。**
"转绘功能"目前 = 上传源片 → 预处理 → 模型解析 → 落库（剧本 / 导演计划 / 资产草稿 / 源片分镜表）→ 按片段切原片参考。

## 1. 链路与代码入口

| 步骤 | 入口 | 落点 | 现状 |
|---|---|---|---|
| 1 上传源片 | `POST /api/redraw/uploadSource?projectId=&name=`（原始字节流） | `o_script.sourceVideo` + `coverPath` + `sortIndex`（从文件名解） | ✅ |
| 2 列表 | `POST /api/redraw/getSourceList` | 读 `o_script` + 统计分镜（v2 `o_segment` 与 legacy `o_storyboard` **逐集相加**） | ✅ |
| 3 预处理 | `POST /api/redraw/analyzeSource`（先 spawn 外部 `redraw-prep.cjs`） | `data/redraw-prep/<projectId>/<scriptId>/`（grid / cuts / transcript / MANIFEST） | ✅（外部脚本，见 §5） |
| 4 解析 | 同上的后半段；也可单独 `POST /api/redraw/analyzeVideo`（`dryRun` 只拼 prompt） | `o_script.content`、`o_agentWorkData`（导演计划 + 资产草稿）、**v2** `o_segment`（片段）+ `o_shot`（镜）+ `o_shotAssets`（绑定） | ✅ |
| 5 切原片 | `POST /api/redraw/cutSource` | **v2：按片段切** → `o_segment.clipPath` + OSS `redraw-clip/<scriptId>/seg-N.mp4` | ⚠️ 后端在、**前端无入口** |
| 6 关联层（资产对账） | —— | 设计：`o_assets` + `o_scriptAssets` + 绑定 key | ❌ 未实现 |
| 7 转绘层 | —— | 设计：源片分镜表 + 绑定 + 导演计划 + 目标国 → 转绘分镜表 → 覆盖分镜表 | ❌ 未实现 |

后端代码位置：`apps/api/src/routes/redraw/*`、`apps/api/src/utils/redraw.ts`、`apps/api/src/utils/redrawAnalyze.ts`。
技能：`apps/api/data/skills/feicai/redraw-analysis-skill/{SKILL.md,localization-guide.md,speech-rate.md}`。

## 2. 数据契约（改这里会影响模型 ↔ 代码的一致性）

### 2.1 解析层输出：固定四个块

`<scriptBody>` 剧本 ｜ `<directorPlan>` 导演计划 ｜ `<assetSheet>` 资产清单 ｜ `<storyboardTable>` 源片分镜表

解析端用 `extractBlock` 逐个取；缺任何一个都按失败处理（`redrawAnalyze.ts`）。
**契约必须四处同步**：技能「输出格式」/「执行流程」第 5 步 /「硬性约束」第 8 条 / `redrawAnalyze.ts` 的 prompt 契约行。

### 2.2 工作区 key（`o_agentWorkData`，靠 `key` 区分）

| key | 内容 | 谁写 |
|---|---|---|
| `redrawDirectorPlan` | `{ plan: string }` | 解析层 |
| `redrawAssetDraft` | `{ assets: RedrawAsset[] }`（**不落 `o_assets`**，等关联层认账） | 解析层 |
| `redrawStage` | `{ stage, at }` 转绘进度（`analysis` 等） | 解析层 |

⚠ 读这些行**必须带 `key` 过滤**：同一 `(projectId, episodesId)` 下还有 `productionAgent` 主键行，`.first()` 不带 key 会拿到别的形状。

### 2.3 `o_script.extractState` 状态机

`0 跑` → `1 成` / `-1 败` / `2 等待（预处理完、未解析）` / **`3 待对账`（解析完、未与用户认账）**

解析成功写 `3`；体检有 error 级问题写 `-1` 并写 `errorReason`（界面只在 -1 时展示）。

### 2.4 `o_storyboard.videoDesc` 的 12 槽位

由 `composeVideoDesc()`（`apps/api/src/utils/redraw.ts`）拼成 `（字段1、字段2、…）`，**顺序固定、缺一不可、缺的留空占位**：

`画面描述、场名、引用资产名(/)、时长(Ns)、景别、运镜、角色动作、情绪、光影氛围、台词(无台词)、音效、引用资产ID(/)`

下游视频提示词技能**按顿号位置**解析，少一个就整体错位。

### 2.5 相关表/列

- `o_project`：`targetCountry`（**转绘的定义性输入**，缺了解析层直接 400）
- `o_script`：`sourceVideo`、`coverPath`、`sortIndex`、`extractState`
- **v2（转绘现在的写入口径）**
  - `o_segment`：`segmentIndex`（全片连续）、`sceneIndex/sceneTitle`、`duration`、`videoDesc`（**整段** 12 槽位聚合）、
    `sourceRange`（**015 新增**，段内镜区间合并）、`clipPath`（**015 新增**，按段切出的原片参考视频）、`manual`、`state`
  - `o_shot`：`shotIndex`（**片段内** 1..N）、`duration`、`shotSize/camera/light/action/dialogue/sfx`、
    `sourceRange`（**015 新增**，镜级展示/核对）
  - `o_shotAssets`：片段级资产**派发到每一镜**（与生产链同口径）
- legacy（仅迁移前的旧集还会读）：`o_storyboard`（`sourceRange`/`clipPath`/`originDialogue`）、`o_videoTrack`

## 3. 引擎：转绘已迁 v2

- 生产链与转绘链现在**同写 v2**（`o_segment`/`o_shot`/`o_shotAssets`，`o_setting.shotsEngine` 默认 `v2`）。
- 2026-10-21 起 `writeRedraw` 不再写 `o_storyboard`/`o_videoTrack`；`replace: true` 时会**顺带清掉**该集残留的 legacy 行。
- 读侧统一：`getGenerateData` 的 `isSegments` 分支按片段出段，`clipPath` 取 `o_segment.clipPath`；
  `getFlowData` 对转绘集现在能返回 `storyboard`（15 段），画布的分镜节点不再空白。
- 旧的逐集降级（`trackTableForScript`）保留 —— 只为没迁移的老集服务。
- 迁移代价：`o_segment`/`o_shot` 各加了一列（`sourceRange`；`o_segment` 还有 `clipPath`），见 migration `015_redraw_v2`。

## 4. 前端现状

| 页面/位置 | 现状 |
|---|---|
| 项目类型 `redraw` + 目标国家 | ✅ 项目弹窗与建项目接口都支持 |
| `/inputVideo`（源片页） | ✅ 上传 / 列表 / 封面 / 集号 / 状态（0/1/2/3/-1）/ 开始分析 |
| 菜单 | ✅ `script` 对转绘隐藏、`inputVideo` 仅转绘可见 |
| `/production` 页 | ⚠️ **节点重排仍未做**（全量 grep 无 `sourceVideo/projectType` 命中），但画布的分镜节点现在能显示 v2 的段 |
| 工作台 | ✅ 走 `getGenerateData` 的 v2 分支：一段一条；每段的素材排里带 `sources:"clip"` 的原片参考（一段一个 `seg-N.mp4`） |
| 提示词生成 | ✅ `generateVideoPrompt` 按片段取 `storyboardItemsForSegment` → 用整段 `videoDesc` 出提示词 |
| 切原片按钮 | ❌ 无（后端已改成按段切） |

调用的接口只有三个：`/redraw/getSourceList`、`/redraw/uploadSource`、`/redraw/analyzeSource`。

## 5. 外部依赖与配置

| 依赖 | 说明 |
|---|---|
| `MIWO_REDRAW_PREP`（`config.redrawPrepScript`） | 预处理脚本路径。**缺省空 = 未配置**（不再写死开发机绝对路径）：未配置时 `app.ts` 启动自检打 warn，`analyzeSource` 返回可操作的 500。本机开发在 `apps/api/.env` 里显式指向 `redraw-prep.cjs` |
| ffmpeg / ffprobe | `MIWO_FFMPEG_PATH` / `MIWO_FFPROBE_PATH`，缺省走 PATH |
| hypit CLI + WhisperX 服务 | 预处理脚本内部依赖：切点检测走 `hypit media boundaries`，转写走 `:8765` 的 WhisperX。**这是交付硬阻塞**，见 `redraw-todo.md` §1 |
| 模型部署 | `o_agentDeploy.redrawAgent:analysisAgent` 决定解析用哪个模型；脚本读取 `redrawAgent:analysisAgent` 这个 key |
| 计费 | 模型调用要求：用户在该模型组里 + 模型有生效价格。**文本模型已统一改成「按每次调用（call）、单价 0」**（`gpt-6-luna` / `gpt-5.5` / `gpt-6.1-sol` 各一条 call 价格行），所以解析调用不再有"按 token 预授权数千元"的问题 |

### 5.1 模型选择（实测结论，2026-10-21）

| 模型 | 中继通道 | 收图 | 解析输出合规性 |
|---|---|---|---|
| `newapi:gpt-5.5` | ❌ 无（`No available channel`） | - | 不可用 |
| `newapi:gpt-6-luna` | ✅ | ✅ | ❌ 片段时长算术不过自检（头写 11s、镜时长之和 29s） |
| `newapi:gpt-6.1-sol` | ✅ | ✅ | ✅ **error=0 通过**（本次基线用它） |

⚠ 换模型后必须重跑一次解析并看 `issues`：`checkRedrawOutput` 的 error 级会直接把 `extractState` 置 -1。

## 6. 已做过的验证（2026-10-21，本机 miwo_test / MySQL 8.4）

| 验证 | 方法 | 结果 |
|---|---|---|
| 后端类型检查 | `pnpm exec tsc --noEmit`（`apps/api`） | exit 0 |
| 上传 + 列表 | 真 HTTP + 132s/480×854 源片 | 200，封面/集号/`extractState` 正常 |
| 预处理（含转写） | `analyzeSource?prepOnly=1` | 60s，产出 `grid`(1) + `cuts.json`(7.7KB) + `transcript.json`(40.7KB) + `MANIFEST.md` |
| prompt 拼装 | `analyzeVideo?dryRun=1` | system 15887 字符 / user 8228 字符 / 1 张图；含「输出格式/assetSheet/storyboardTable」 |
| 写库（租户守卫 + MySQL） | 合成数据直接调 `writeRedraw` | 1 分镜 + 1 轨道，`userId` 自动注入，bigint/列类型正常；跑完清理 |
| 模型调用 | `u.Ai.Text("redrawAgent:analysisAgent")` | 修复部署行 + 计费口径后成功出字（见 §5.1） |
| **完整解析（E2E，v2 写入口径）** | `analyzeSource` 真跑（预处理 + gpt-6.1-sol 解析） | **231s**：`extractState=3`；`o_segment` 16 行 / `o_shot` 19 行 / legacy 0 行；`issues` error=0；`seg.videoDesc` 为**整段** 12 槽位聚合 |
| 按片段切原片 | `cutSource`（真 ffmpeg，132s 源片） | **6.3s**：16/16 段切出 `seg-N.mp4`，`o_segment.clipPath` 全部写入，`issues=0` |
| 读链路（v2） | `getSourceList` / `getGenerateData` / `getFlowData` | 列表 `storyboards=16 / shots=19 / analyzed=true`；工作台 `trackList=16`、每段 1 条 `sources:"clip"`（0 张空文卡）；`getFlowData.storyboard=16`、`hasStructuredShots=true` |
| 提示词生成 | `generateVideoPrompt`（trackId=片段 id） | 200 / 7.3s，产出 681 字提示词，整段描述（镜头1/2/3）+ 资产名正确进 prompt |

## 7. 本机环境踩到的坑（与代码无关，但会让人误以为代码坏了）

1. **分析模型曾经选错**：种子原本指向 `newapi:gpt-5.5`，但本机中继**没有 gpt-5.5 通道**
   （`No available channel for model gpt-5.5`）。改用 `gpt-6-luna` 能跑通但**输出不合规**
   （片段头写 11s、镜时长之和 29s → 体检 error）。最终 `gpt-6.1-sol` 通过（§5.1）。
   **种子已改**（`seed/o_agentDeploy.ndjson` 行 19 = `newapi:gpt-6.1-sol`）。
2. **模型授权走「用户组 → 模型组」**，新账号默认没有任何组 → 调模型直接 `无权使用模型`。
   手测账号需要：加入用户组 + 模型模型组里含该模型 + 账户余额（call/0 下余额不再是瓶颈）。
3. **预处理脚本不再有缺省路径**：`MIWO_REDRAW_PREP` 缺省空（未配置），启动自检会 warn，
   `analyzeSource` 返回可操作 500。它仍依赖 hypit/WhisperX（见 `redraw-todo.md` §1）。
4. **文本模型计价口径已改**：新增 `unit=call`、`unitPriceMicro=0` 的价格行（三个文本模型各一条），
   解析调用按"每次调用 × 0"计费，不再有基于 token 估算的巨额预授权。

## 8. 未实现 / 与设计文档的差距（下一步工作）

| # | 缺口 | 设计依据 |
|---|---|---|
| 1 | **关联层**（解析名 → 用户已有资产的对账；落 `o_assets`+`o_scriptAssets`+绑定 key） | spec §6 |
| 2 | **转绘层**（源片分镜表 + 绑定 + 导演计划 + 目标国 → 转绘分镜表 → 覆盖分镜表） | spec §7 |
| 3 | `cutSource` 前端入口（切原片；转绘层/工作台原片参考依赖它） | TODO §3 |
| 4 | production 页按 `sourceVideo` 分流 + 节点重排 | spec §9 / TODO §3 |
| 5 | 预处理原生重写（去掉 hypit/WhisperX 依赖） | TODO §1（硬阻塞） |
| 6 | 「待对账」之后的 UI 动作（进入关联层） | spec §8 |

## 9. 决策记录

- **2026-10-21：转绘写入口径"彻底迁 v2"—— 已落地**。`writeRedraw` 不再写 `o_storyboard`/`o_videoTrack`，
  改建 `o_segment`（片段）+ `o_shot`（镜，片段内 1..N）+ `o_shotAssets`（片段级资产派发到每镜）；
  `o_segment.videoDesc` 存**整段** 12 槽位聚合；切原片**按段**（`o_segment.clipPath`，`seg-N.mp4`）；
  迁移前残留的 legacy 行在 `replace` 时清掉；测试数据不迁移（丢弃重跑）。
  实现：migration `015_redraw_v2`、`utils/redraw.ts`、`routes/redraw/cutSource.ts`、
  `workbench/getGenerateData.ts`、`generateVideo.ts`/`batchGenerateVideo.ts`（clip 按引擎切表）。
- **2026-10-21：转绘的输出颗粒度 = 片段（段）**（用户口径：一整个分镜的描述，而不是段内每镜的描述）。
  因此**不加** `o_shot.desc` 列、也不把段拆成多张界面卡；界面计数 = 片段数（`已分析 · N 个分镜`）。
- **2026-10-21：文本模型计价口径 = 按每次调用（`unit=call`）、单价 0**（用户口径：本意按每次调用收费，当前设 0）。

