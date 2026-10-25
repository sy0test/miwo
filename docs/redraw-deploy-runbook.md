# 转绘改造 · 上线 Runbook（2026-10-24 晚 / 2026-10-25 增量）

> 目标：把 `main` 的改动部署到 `/opt/miwo`（1Panel + Docker Compose + 宿主机 MySQL），
> 并完成一次真机验收。**部署前先在本机跑完最后一段“本地检查”**。

## 2026-10-25 增量（在 2026-10-24 版基础上）

- 原片参考片段**一律静音**（只给画面，避免 Seedance 照搬源片台词/背景音）；旧切片在「重切/确认覆盖」时自动重切成静音。
- 视频生成费用预冻结的 idempotency key 改为**每次提交唯一**（修「同一段重新生成 → 500 idempotency key reused」）。
- 工作台：原片参考卡可预览、素材类型识别修正（带签名的 URL 不再被当成图片）、提示词框内部滚动。
- 确认页：顶部常驻状态条（生成中/已生成/失败/已确认 + 进度）；转绘版**卡片**展示（表格方案已撤销）。
- 资产页固定每行 3 张卡片；切原片改为**段级 sourceRange 优先**（修段内多镜时 9/11 段切不出来的问题）。
- `getEpisodeState` 增加 `job` 字段（当前活跃转绘任务），前端用于显示生成进度。
- 与上一版相比**没有**改流程步骤：仍是 生成转绘分镜 → 并排确认 → 工作台（「跳过两步」的方案已回退）。
- 供应商适配器运行期修正：内置化后除 newapi 外的适配器一直读模块级空凭据（火山引擎「缺少API Key」），
  现改为经 AsyncLocalStorage 注入 DB 里的 inputValues（新增回归用例 `tests/vendor-request-inputs.test.ts`）。

## 0. 本次改动包含什么

- 预处理原生化：原生 ffmpeg 切点 + 本地 faster-whisper（镜像内置 venv + medium 模型），不再依赖 hypit/WhisperX。
- 预处理/解析改为 job（worker 执行），新增状态机与资产认账（会话页 + 资产面板）。
- 转绘分镜生成与并排确认（M3）。
- 前端新增：`/redraw/session/:scriptId`、`/redraw/review/:scriptId`、转绘专用 `/production` 画布、资产页待确认面板。

## 1. 本地检查（必须全绿）

```powershell
cd D:\sy_workspace\code\miwo
# 后端
# ⚠ 全量用例里有并发/超时敏感的用例：必须给独立数据目录 + 放宽单测超时，否则会误红
#   （实测：默认 5s + 并行跑会在 job-gate/auth-service 上抖）
$env:MIWO_DATA_DIR="D:\sy_workspace\.tmp-build\miwo-gate-data"
pnpm --filter @miwo/api exec vitest run --testTimeout=30000
pnpm --filter @miwo/api run typecheck
node tools/check-config-single-source.cjs
node tools/check-deploy-config.cjs
node tools/check-tenant-exceptions.cjs
# 前端
cd apps\web
node --experimental-strip-types --test tests/redraw-logic.test.mjs
cd ../..
# 构建（Windows 下 TEMP 必须换到工作区，否则 esbuild 会报 Access is denied）
$env:TEMP="D:\sy_workspace\.tmp-build"; $env:TMP=$env:TEMP
pnpm --filter @miwo/web run build-only
```

## 2. 本地打包（用 git archive，天然排除 .env / data / node_modules）

```powershell
cd D:\sy_workspace\code\miwo
git status --short           # 必须为空（全部已提交）
$tag = "redraw-" + (Get-Date -Format "yyyyMMdd-HHmm")
git archive --format=zip -o "D:\sy_workspace\.tmp-build\miwo-$tag.zip" HEAD
Get-Item "D:\sy_workspace\.tmp-build\miwo-$tag.zip" | Select-Object Name,Length
```

> 记住 `$tag`，服务器上 `MIWO_IMAGE_TAG` 用同一个字符串。

## 3. 服务器（1Panel 终端 / SSH）

### 3.0 用 1Panel 上传（推荐路径）

1. 1Panel → 「文件」→ 进入 `/opt/miwo` → 上传本机打好的 `miwo-redraw-*.zip`
2. 1Panel → 「主机」→「终端」（或 SSH）→ 按 3.1 解压
3. 构建/启动用 3.3/3.4 的 `docker compose` 命令（1Panel 的「容器」页也能看到 compose 项目状态）

### 3.1 备份 + 解压

```bash
cd /opt/miwo
cp -a deploy/.env "deploy/.env.bak.$(date +%F-%H%M)"
cp -a deploy/docker-compose.yml "deploy/docker-compose.yml.bak.$(date +%F-%H%M)"
unzip -o /opt/miwo/miwo-redraw-YYYYMMDD-HHmm.zip -d /opt/miwo
```

> `deploy/.env` 不在 zip 里，解压不会覆盖它；数据在 `MIWO_DATA_DIR`（`/var/lib/miwo`），也不受影响。

### 3.2 设置镜像 tag（保留旧镜像以便回滚）

```bash
cd /opt/miwo/deploy
sed -i "s/^MIWO_IMAGE_TAG=.*/MIWO_IMAGE_TAG=redraw-YYYYMMDD-HHmm/" .env
grep -E "MIWO_IMAGE_TAG|ASR_MODEL|MIWO_ENV|MIWO_PUBLIC_BASE_URL" .env
# 如果 .env 里没有 ASR 变量，追加（模板见 deploy/.env.example 75-95 行）
grep -q MIWO_ASR_DRIVER .env || cat >> .env <<'EOF'
MIWO_ASR_DRIVER=local
MIWO_ASR_MODEL=medium
MIWO_ASR_MODEL_DIR=/app/apps/api/asr/models
MIWO_ASR_COMPUTE=int8
MIWO_ASR_PYTHON=/app/apps/api/asr/.venv/bin/python
MIWO_ASR_SCRIPT=/app/apps/api/asr/transcribe.py
MIWO_ASR_TIMEOUT_MS=1200000
MIWO_GRID_FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
ASR_MODEL=medium
ASR_MODEL_REVISION=main
EOF
```

> ⚠ `ASR_MODEL_REVISION`：今晚先用 `main` 让构建能过；下次发布请钉到 HuggingFace 模型仓的具体 commit。
> ⚠ 服务器构建需要 ≥4GB 内存 + 5GB 磁盘（vite 构建峰值 3~4GB；ASR 模型 ~1.5GB）。

### 3.3 构建（首次含 ASR，预计 20~40 分钟）

```bash
cd /opt/miwo/deploy
docker compose build api worker 2>&1 | tee /tmp/miwo-build-redraw.log
```

看进度：`tail -f /tmp/miwo-build-redraw.log`。首次会下载 faster-whisper 依赖与 medium 模型（~1.5GB）。

### 3.4 启动

```bash
cd /opt/miwo/deploy
docker compose up -d --force-recreate api worker
docker compose ps
docker compose logs --tail=120 api worker
```

**期望日志**：`已应用迁移：...016_redraw_pipeline`、`[服务启动成功]`；worker 正常轮询。
如果两个服务同时迁移报 “Migration table is already locked”，等 10 秒再 `docker compose restart api`（历史已知现象）。

## 3.5 服务端自检（启动后先跑这 4 条）

```bash
cd /opt/miwo/deploy
# 1) ASR 运行时真的能 import（venv 是悬空链接时 ls 查不出来）
docker compose exec api /app/apps/api/asr/.venv/bin/python -c "import faster_whisper; print('asr ok')"
# 2) 新技能是否被播种到运行时数据目录（seed 已改为「补缺失文件」，不再整目录 skip）
docker compose exec api sh -lc 'ls -l "$MIWO_DATA_DIR/skills/feicai/redraw-storyboard-skill/SKILL.md"'
# 3) 迁移 016 是否应用
docker compose logs api | grep -i "016_redraw_pipeline"
# 4) 部署行是否补齐（1Panel 的 MySQL 终端里跑）
#    SELECT `key` FROM o_agentDeploy WHERE `key` LIKE 'redrawAgent:%';
#    期望两行：redrawAgent:reconcileAgent / redrawAgent:storyboardAgent
```

> ⚠ 如果这个库以前应用过**旧版 016**（只加列、没有 deploy 行），016 不会重跑 ⇒ 第 4 条会缺行。
> 处置：手工执行两条 insert（按 key 判存在），或临时把该行从 `knex_migrations` 删掉后重启让 016 重跑（谨慎，先备份）。
> 今晚的目标库只到 015，正常不会遇到。

## 4. 真机验收（浏览器）

1. `Ctrl+F5` 强刷（前端是单文件内联包，必须强刷）。
2. 打开一个**转绘项目** → `输入视频` 页。
3. 上传一集 60~120 秒源片 → 点「开始分析」→ 卡片应依次显示：`预处理·切点` → `预处理·转写` → `解析中` → `待认账`。
4. 点「去认账」→ 会话页：
   - ① 剧本可改并保存；
   - ② 资产逐条「复用已有 / 新建 / 改名」→ 全部确认；
   - ③ 时长确认 → 点「生成转绘分镜」。
5. 自动进并排确认页：顶部状态条 + 源片版 / 转绘版卡片 / 变更摘要 → 点「确认覆盖并进入制作」。
6. 进入转绘制作画布 → 「打开生成面板」→ 选一段 → 生成：**会带资产图 + 该段原片 clip（静音）作为参考**。
   - 原片参考可在卡片上点「预览」播放（无声是预期）。
   - 提示词引用（`@视频N`）尚未生成，先点「批量生成提示词」再生成视频。
7. 任务中心能看到**图片/提示词**任务；视频任务只在工作台「历史版本」里可见（视频链不写 `o_tasks`，已知）。
8. 同一段生成完再点一次生成应正常（本次修复了 500 idempotency key reused）。

## 5. 失败排查

| 现象 | 排查 |
|---|---|
| 分析秒失败 / errorReason 含 ASR | `docker compose exec api /app/apps/api/asr/.venv/bin/python -c "import faster_whisper; print('asr ok')"`（`ls` 查不出悬空 venv），再查 `MIWO_ASR_*` |
| 分析一直“预处理·转写” | worker 日志：`docker compose logs -f worker`；模型可能下载不完整（构建日志末尾有校验） |
| 迁移报错 | `docker compose logs api | grep -i migration`；016 会加两列并在老库补 deploy 行 |
| 页面 404 / 白屏 | 是否强刷；`docker compose exec api ls -l /var/lib/miwo/web/index.html` 与构建时间 |
| 生成任务永远“生成中” | worker 是否在跑；`docker compose ps` |
| 生成视频 500 / 日志 `idempotency key was reused` | 旧版 billing key 冲突；本版已修（每次提交唯一 key），重新构建即可 |
| 原片参考视频有声音 / Seedance 照搬台词 | 旧切片是带音轨的；点一次「重切 / 确认覆盖」自动重切成静音（本版逻辑），或检查 `ffprobe -select_streams a` 应为空 |

## 6. 回滚

```bash
cd /opt/miwo/deploy
# 1) 恢复 .env（含旧 MIWO_IMAGE_TAG）
cp deploy/.env.bak.YYYY-MM-DD-HHMM .env
# 2) 如果旧镜像还在
docker images | grep miwo-api
docker compose up -d --force-recreate api worker
# 3) 代码回退：重新解压上一版 zip（数据库迁移只加列，向后兼容；不要 down 迁移）
```

## 7. 已知限制（本次不修）

- 原片 clip 已作为参考视频发出且**静音**；但**提示词里还没有 `@视频N` / 原片引用**（M4 剩余项）。
- clip 复用判据：路径 + 文件存在 + **已静音**；时长差 ≤0.1s 的重切判据仍未做（storyboardWrite 只按 segmentIndex 继承）。
- 视频生成任务不进「任务列表」（视频链不写 `o_tasks`，记录在 `o_job` + 工作台「历史版本」）。
- 30s 单段上限未验证，默认 15s。
- ASR 首次真实转写只在部署机验证；本机无 Python 依赖。
- seed-data-dir 现在只补「缺失文件」、不覆盖已有内容：以后**修改已发布的技能/提示词**不会自动下发，需要手工同步或改目录名。
- 界面版权声明/ToonFlow LICENSE 按协议保留（用户知情并接受）。