# Miwo 文本模型按次计价与批量提示词预估

**状态：** 设计已批准，待实施计划审阅  
**已确认：** 文本模型支持 token 或 call 单位；按该模型最新生效的 token/call 价格行选择模式；每次 `Ai.Text.invoke` 或 `Ai.Text.stream` 调用最多按选中模式计费一次；进入 Provider 调用阶段后失败或结果不确定的 call 模式请求仍收一次；调用前授权/价格预检失败不收费。

## 目标

支持管理员为文本模型设置按次价格，并保证文本用量记录、实际结算和排队任务预留金额使用同一计价模式。修复 ToonFlow 批量提示词入口错误地按所选视频模型和 `character` 单位估价的问题，不新增 Seedance 字符价格。

## 当前问题

- `o_price` 是只追加价格历史，现有文本调用固定记录 token 用量。
- 价格管理 API 与界面尚不接受 `call` 单位。
- `batchGeneratePrompt` 用前端所选视频模型、JSON 字符数和 `character` 单位估价；实际工作由 worker 对 `universalAi` 每个轨道调用一次文本模型。
- 仅改用 `universalAi` 的 `token` 单价仍不足以估算排队任务：实际消息是在 worker 中基于提示词模板、项目、分镜和素材数据构造的，入队端必须使用同一构造逻辑与文本 Token 估算器。

## 价格模式与历史

- 在现有 `o_price.unit` 字符串中增加 `call`，不新增列、不迁移既有价格数据。
- 管理员界面显示“每次调用”；原有 token、图像、视频和字符单位保持不变。
- 文本模式按指定时刻所有已生效的 `token` 与 `call` 价格历史行确定：两类中 `effectiveFrom` 较新的单位为当前模式；若两类最新生效时间相同，则报歧义并拒绝预估/调用；若没有任一有效行，则报缺少有效文本价格。
- 同一单位在最新生效时间有多条价格行时，沿用现有严格解析规则并报歧义。未来生效行不得提前切换模式。
- 该规则允许使用只追加历史从 token 切换到 call，或之后切回 token；不同单位的历史记录可共存。API 继续禁止同单位同生效时间重复记录。

## 文本 Provider 用量与收费

- `Ai.Text.invoke` 和 `Ai.Text.stream` 在 Provider 分派前使用共享模式解析逻辑。
- token 模式继续按实际输入/输出 Token 记录和结算，缺少实际 Token 用量时沿用现有估算行为。
- call 模式每次 wrapper 调用记录数量为 1、单位为 `call`；如 Provider 返回 Token 指标，仍可保存输入/输出 Token 分析字段，但价格数量必须保持 1，不能再叠加 token 价格。
- 授权/价格预检失败不会创建可计费 Provider 调用。进入 Provider 调用阶段后，call 模式即使响应失败或用量不确定，也记录一次 call；token 模式保留现有 uncertain 用量语义。
- 图片、视频和音频计费语义不变。用量准入、幂等记录、任务冻结与最终结算继续复用现有机制。

## 批量提示词预留

- 视频模型参数仍只用于选择视频提示词模板；实际收费模型必须通过 `universalAi` 现有解析流程解析为真实 `vendorId:model`。
- 提示词输入的组装必须抽取为 route 与 worker 共用的函数，覆盖当前实际传给 `Ai.Text.invoke` 的 system/messages 内容。estimate 使用同一 `estimateInputTokens` 规则，并为每次调用计入与 `Ai.Text.invoke` 一致的最大输出 Token 预算。
- call 模式的预留数量等于批次预计发起的文本调用数（一条轨道一次）；token 模式的预留数量等于每个实际调用的输入估算 Token 与最大输出预算之和。
- 保留入队、冻结、幂等和结算流程。实际消耗仍以 Provider 记录的用量为准；提示词依赖数据在排队期间变化造成的差异由既有结算差额机制处理。
- 空批次不得创建零数量预估；入口 schema 必须显式要求至少一条轨道，回归测试须证明空批次在估价、冻结或入队前返回 400。

## 兼容与安全

- 不新增数据库列或迁移，不写入、删除或改写任何价格历史。
- 不添加 `character` 价格，也不把 JSON/文本原始字符数直接当作 Token 数；使用统一文本请求估算器覆盖 `system` 与 `messages`/`prompt`，保持入队预留与 Provider 准入的算法一致。该算法是跨模型的估算值，不宣称等于供应商 tokenizer 的精确输出。
- `call` 只能由管理员价格 API 写入，其他未列举单位继续拒绝。
- 原有 token-only 文本模型继续按 token 计费；旧任务 payload 仍可由 worker 读取。
- 不改变模型授权、日调用额度、任务队列、任务冻结和账本语义。
- 不提交代码，不操作用户真实数据库。

## 验收标准

1. 管理 API 接受 `call`、拒绝未知单位；价格界面可追加并正确显示“每次调用”。
2. 模式解析遵守生效时间边界、未来价格不提前生效、较新单位可切换模式、token/call 同时以同一最新生效时间出现时明确失败。
3. call 模式下 invoke 与 stream 每次记录 `unit=call, quantity=1`，不会同时按 Token 价格收费；失败/不确定的已进入 Provider 调用仍计一次。
4. token 模式保持实际 Token 计费；缺失价格、授权拒绝和调用前预检失败不产生收费用量。
5. ToonFlow 批量提示词通过真实 `universalAi` 模型估价：call 模式按轨道数，token 模式用共享输入构造和 Token 估算，不查所选 Seedance 的 `character` 价格。
6. 批量任务仍经 `submitBilledJob` 冻结并在终结时按实际 usage 结算；没有绕过 reservation 或产生 token+call 双计费。
7. API 针对价格解析、用量计费、AI wrapper 和批量提示词入口有回归测试；相关 API/Web 类型检查通过。
