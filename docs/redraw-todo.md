# 转绘 · 交付前待办（miwo 版）

> 继承自 `toonflow-upstream/TODO-redraw.md`（2026-09-30）。那份文件在迁 miwo 时被 bootstrap 计划当临时文件删掉了，
> 2026-10-21 恢复并更新到 miwo 语境。
> 现状事实见 [`redraw-status-contract.md`](redraw-status-contract.md)；设计见
> [`superpowers/specs/2026-10-05-redraw-three-layer-pipeline-design.md`](superpowers/specs/2026-10-05-redraw-three-layer-pipeline-design.md)。

## 1. 预处理原生重写 ⭐ 唯一的硬阻塞（**仍未做**）

现状（miwo 也一样）：`apps/api/src/routes/redraw/analyzeSource.ts` 用 `spawn` 调外部脚本 `redraw-prep.cjs`：
脚本内部 shell 调 **hypit CLI**（切点检测）与 **hypit lab 里的 WhisperX 服务（:8765，转写）**。

把它当产品运行前提 = 交付时要捎上 hypit 仓库 + 一套本地服务，与「hypit 只当参考不引代码」和私有化交付冲突。

**2026-10-21 已做的前置工作（不是重写，只是让"没配/配错"不再静默）**：
`MIWO_REDRAW_PREP` 的缺省值**从开发机绝对路径改成空（未配置）**；`app.ts` 启动自检会打印
`[redraw] 预处理脚本: …` / `[redraw] 未配置 MIWO_REDRAW_PREP …` / `指向的文件不存在`；路由在未配置/文件不存在时
分别返回可操作的 500。**本机开发需在 `apps/api/.env` 里显式设置该变量**（已设）。
→ 但「原生重写」本身**仍未做**，它仍是交付硬阻塞。

要重写两块（拼贴图那步可以照搬，纯 ffmpeg）：

| 阶段 | 现状 | 重写要点 |
|---|---|---|
| 切点检测 | `hypit media boundaries` 拿候选 + 本地 `cluster(gap=0.25s)` | native ffmpeg 复现不出同一批候选（实测 51 vs 59），要重做评分函数并**重新验一遍第 4~7 步** —— 切点表是 skill 的权威输入（「镜头边界一律取自切点表」），换检测器 = 分镜边界换一套 |
| 转写 | `hypit transcribe` → 本地 whisperx 服务 + hypit 的 venv | 方案未定。WhisperX 本身是开源包，可自建 venv / 换别的 ASR；**语种必须先本地检出再显式传**（给错语种 Whisper 会去「翻译」而不是转写，产出通顺但整段改写，且置信度高到看不出来） |

替换点只有一个：`analyzeSource.ts` 的 `PREP_SCRIPT` + `runPrep()`，下游（解析/落库/切片/生成）一行不用动。
**产物契约别动**：`grid/*.jpg` + `cuts.txt` + `transcript.json` + `MANIFEST.md`
（MANIFEST 里的「采样密度」和「时长」是解析端的唯一权威）。

## 2. 真跑视频生成：凭据已变（**部分过期，待复测**）

原 TODO 说「第 7 步接好了但发不出去：`volcengine` 的 `inputValues` 全空、`newapi` 的视频是空桩」。
**miwo 现状已变**：`newapi` 有 key、视频模型 `seedance-2-0` / `seedance-2-5-nsfw` 已配置且有价格与授权。
仍需确认的两点（转绘特有）：

- 转绘要让**每镜带原片片段作参考**，适配器必须能把视频上传换 URL；
  `volcengine.ts` 是把 data URL 直塞 `video_url` 的，用不了；`volcengineSd2` 走 TOS。
- `seedance-2-0` 在 newapi 适配器里是否支持 `videoReference`（参考视频）需要实测。

探针（零成本）：`D:\sy_workspace\tools\redraw-prep\gen-video.cjs <projectId> <scriptId> --dry`。

## 3. 前端（**一半已做**）

后端接口都在（`project/addProject` 收 `targetCountry`；`redraw/uploadSource`、`redraw/getSourceList`、`redraw/analyzeSource`）。

| 项 | 状态 |
|---|---|
| 项目类型「出海转绘」+ 目标国家 | ✅ 已做（`projectDialog.vue`） |
| `/inputVideo` 页：批量上传（原始字节流、`name` 走 query） | ✅ 已做 |
| 视频卡：首帧封面 + 名称 + 「开始分析」+ 状态（0 转圈 / -1 红叹号 errorReason / **3 待对账**） | ✅ 已做 |
| **production 页节点重排 + 按 `sourceVideo` 分流**（原视频节点 → 派生资产 → 分镜表 → 视频工作台） | ❌ **未做**（production 页/store 全量无 `sourceVideo/projectType` 命中） |
| **切原片（`cutSource`）入口** | ❌ 未做（后端在、前端没有按钮） |

## 4. 其它已记录的小问题（**仍有效**）

- 第 6 步资产生图的**图注语言会漂**（中文/西语混），出图路由用 `assetsGenerate/batchGenerateImageAssets`（读 `o_assets.prompt`，不覆写）。
- 上传页还没有**删除/重命名源片**的入口（后端只有同名重传幂等 + `project/delProject` 连带清理）。

## 5. miwo 迁移新增的三件事（2026-10-21，**均已处置**）

1. **种子部署模型错 → ✅ 已修**：`o_agentDeploy.ndjson` 里 `redrawAgent:analysisAgent` 原来指向
   `newapi:gpt-5.5`（本机中继无通道）。现改为 **`newapi:gpt-6.1-sol`**。
   附实测结论：`gpt-6-luna` 能收图但片段时长算术不过自检（头写 11s、镜时长之和 29s）；
   `gpt-6.1-sol` 通过（error=0）。**换模型后必须看 `issues`**，error 级会把 `extractState` 置 -1。
2. **计费预授权偏大 → ✅ 已修（改口径，不改代码）**：用户口径是"LLM 按每次调用收费，当前设 0"。
   已给三个文本模型各追加一条 `unit=call`、`unitPriceMicro=0` 的价格行；计费代码本来就支持 call 口径
   （quantity=1）。解析调用不再有按 token 估算的巨额预授权。
3. **文档回迁 → ✅ 已做**：本文件 + `redraw-status-contract.md` + 两份 2026-10-05 的 spec/plan 已进仓库。

## 6. 顺手修掉的一个误报

`RedrawAnalyzeResult.assets` 原来取 `Object.keys(written.assetIds).length`，而解析层固定 `skipAssets`
（资产等关联层认账）⇒ 恒为 0，于是所有失败文案都写成「解析出了 **0** 个资产」，把"明明解析出 8 个"
误报成"一个都没解析出来"。现在 `assets` = **解析出来的数量**，新增 `writtenAssets` = 实际写库行数。

## 7. 写入口径迁 v2（2026-10-21 **已完成**）

- `writeRedraw` 不再写 `o_storyboard` / `o_videoTrack`：片段 → `o_segment`，镜 → `o_shot`
  （`shotIndex` **片段内** 1..N），绑定 → `o_shotAssets`（片段级资产派发到每镜）。
- `o_segment.videoDesc` = **整段** 12 槽位聚合（画面描述/动作/台词/音效按「；」连、景别/运镜/情绪/光影去重按「、」；
  时长取镜时长之和；资产名与 ID 取并集）—— 与用户口径一致：一个分镜（段）一条描述。
- 新列（migration `015_redraw_v2`）：`o_segment.sourceRange` / `o_segment.clipPath` / `o_shot.sourceRange`。
- 切原片改为**按段**：`cutSource` 产出 `redraw-clip/<scriptId>/seg-<segmentIndex>.mp4`，写 `o_segment.clipPath`。
- **测试数据不迁移**（用户口径）：dev 里的测试集直接重跑解析即可。
- 实测（本机）：`o_segment` 15 / `o_shot` 19 / legacy 0；cut 15/15 段 5.5s；工作台 15 段、每段 1 条 clip；
  `getFlowData.storyboard=15`；`generateVideoPrompt` 200 / 681 字。

