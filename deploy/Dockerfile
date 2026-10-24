# syntax=docker/dockerfile:1
# 谜沃 / MirrorWorld 后端镜像（多阶段：装依赖 → 构建 → 运行）
#
# ⚠ 本文件**未经本机验证**：开发机没有 Docker，只做到"文件自洽 + 与代码/一致性脚本一致"。
#    真正的镜像构建与容器内运行（api + worker）验证归**部署窗口**（Phase 1d 仍未做，详见 deploy/README.md）。
#
# 基础镜像下限 = 22.12（`engines.node` = ">=22.12 <25"）：
#   依赖链里的 is-path-inside@4.0.0 是纯 ESM 且不在 apps/api/scripts/build.ts 的 external 列表里，
#   打包产物会留下字面 require(ESM)；Node 直到 22.12 才默认允许 require() 同步 ESM。
FROM node:22.12-bookworm-slim AS base

# Node 22.12 自带的 Corepack 缺少 pnpm 当前签名 key；固定升级 Corepack 后仍校验锁定的 pnpm 版本。
RUN npm install --global corepack@0.31.0 \
 && corepack enable \
 && corepack prepare pnpm@10.33.0 --activate

# 少数原生依赖（better-sqlite3 / sqlite3 / sharp）在没有匹配到 prebuild 时会现场编译，
# 所以装依赖的阶段备好工具链（只在中间层，不会进入最终镜像）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# ⚠ 必须带上 .npmrc：仓库把 `enable-pre-post-scripts=true` 放在那里，
#   缺了它 `pnpm --filter @miwo/api build` **不会**执行 prebuild（scripts/generate-router.ts），
#   产出的 data/serve/app.js 里会是陈旧的 src/router.ts 路由表。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/

# ---- 运行期依赖（不含 devDependencies）：最终镜像只拷它的 node_modules ----
# 刻意与下面的 build 阶段各自独立 install（而不是"装全量再 --prod 剪枝"），
# 因为 pnpm 对已存在的 node_modules 做 --prod 剪枝的行为依赖内部状态，独立安装是确定性的。
FROM base AS prod-deps
RUN pnpm install --frozen-lockfile --prod

# ---- ASR 运行期（转绘本地 faster-whisper）：Python venv + 模型 ----
# ⚠ 单独一个 stage：Python/pip/模型只在 so 需要它们的层里，Node 构建层不受影响。
# ⚠ 模型文件**不进 git**（spec §5.5）：这里构建期下载并用 HF tree API 的 lfs.oid（= sha256）校验。
#   ASR_MODEL_REVISION 部署窗口**必须钉到具体 commit**；默认 main 只是让本地/CI 能构建通，
#   按 main 构建出的镜像不可复现（模型仓会漂）。
FROM base AS asr-deps
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY apps/api/asr/requirements.txt /tmp/asr-requirements.txt
RUN python3 -m venv /opt/asr-venv \
 && /opt/asr-venv/bin/pip install --no-cache-dir --upgrade pip \
 && /opt/asr-venv/bin/pip install --no-cache-dir -r /tmp/asr-requirements.txt
ARG ASR_MODEL=medium
ARG ASR_MODEL_REVISION=main
COPY apps/api/scripts/fetch-asr-model.cjs /tmp/fetch-asr-model.cjs
RUN node /tmp/fetch-asr-model.cjs --model "${ASR_MODEL}" --revision "${ASR_MODEL_REVISION}" --out /opt/asr-models

# ---- 构建：prebuild 生成 src/router.ts → esbuild 打包 ----
FROM base AS build
# SPA 是单文件内联打包（viteSingleFile + inlineDynamicImports + assetsInlineLimit=Infinity），
# Rollup 峰值内存实测约 3.4GB（本机 32GB 内存下 Node 默认堆 4288MB 才够）。
# 容器/小内存机器上 Node 会按可用内存把默认堆下调到约 2GB ⇒ vite build 直接 OOM
# （线上实测：FATAL ERROR: Ineffective mark-compacts near heap limit，exit 134）。
# 所以构建阶段显式把堆上限抬到 4GB；本机只需约 2GB 空闲内存的镜像不受影响。
ENV NODE_OPTIONS=--max-old-space-size=4096
RUN pnpm install --frozen-lockfile
# ⚠ 这里的**分层顺序是刻意的**：先前端、后后端，且两者分成两条 RUN。
#   前端是单文件内联打包（实测 10+ 分钟），后端 esbuild 只要几十秒。
#   如果像早期那样 `COPY apps/api` → `COPY apps/web` → 一条 RUN 跑「前端 + 后端」，
#   那么**改一行后端源码**也会让前端那一层缓存失效，每次重打都要再等 10+ 分钟。
#   现在：apps/api 的 COPY/构建放在前端构建**之后** ⇒ 只改后端时前端层直接命中缓存。
#   sync-web-build.cjs 属于 apps/api，单独先拷进来（它只做文件同步，不需要其它源码）。
COPY apps/web apps/web
COPY apps/api/scripts/sync-web-build.cjs apps/api/scripts/sync-web-build.cjs
RUN pnpm --filter @miwo/web run build-only \
 && node apps/api/scripts/sync-web-build.cjs --src apps/web/dist --out apps/api/data/web
COPY apps/api apps/api
RUN pnpm --filter @miwo/api build

# ---- 运行 ----
FROM node:22.12-bookworm-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates ffmpeg fonts-dejavu-core python3 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# pnpm 的 node_modules 里全是相对 symlink（指向 /app/node_modules/.pnpm/...），
# 只要保持 /app 下的相对结构整棵拷贝，软链就仍然有效。
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
# 唯一真实的后端构建产物：esbuild 的 outfile = data/serve/app.js
# （apps/api/scripts/build.ts:44，apps/api/package.json 的 start 也是它；仓库里**不存在** dist/ 产物）。
COPY --from=build /app/apps/api/data/serve ./apps/api/data/serve
# 运行时素材（技能 / 提示词）随镜像带一份，供首次启动播种进 MIWO_DATA_DIR：
#   容器启动时读的是 ${MIWO_DATA_DIR}/{skills,modelPrompt}（见 src/utils/getPath.ts），
#   目录为空时应用照常启动、但技能/提示词功能会静默失效。播种命令见 deploy/README.md。
# ⚠ Phase 1c Task 8：原来这里还有一行 `COPY …/data/vendor`。供应商适配器已改成**编译期内置**的
#   `apps/api/src/vendors/*.ts`（esbuild 把它们打进 `data/serve/app.js`）⇒ 运行期不需要也不存在
#   `data/vendor` 目录。那一行必须一起删：它会让 `docker build` 以 "COPY failed: no source files"
#   失败（`tools/check-deploy-config.cjs` 现在也有断言守着"COPY 的源必须存在"）。
# 转绘预处理（M1）：Python venv + 模型 + transcribe.py。运行时**不联网**、不装依赖。
# 路径与 apps/api/src/utils/asr 的自动查找（打包布局 = data/serve → ../../asr）一致。
COPY --from=asr-deps /opt/asr-venv ./apps/api/asr/.venv
COPY --from=asr-deps /opt/asr-models ./apps/api/asr/models
COPY --from=build /app/apps/api/asr/transcribe.py /app/apps/api/asr/requirements.txt ./apps/api/asr/
# 转绘 ASR / 拼贴图字体的容器内缺省（deploy/.env 可覆盖）
ENV MIWO_ASR_PYTHON=/app/apps/api/asr/.venv/bin/python \
    MIWO_ASR_MODEL_DIR=/app/apps/api/asr/models \
    MIWO_GRID_FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf
COPY --from=build /app/apps/api/data/skills ./apps/api/data/skills
COPY --from=build /app/apps/api/data/modelPrompt ./apps/api/data/modelPrompt
COPY --from=build /app/apps/api/scripts/seed-data-dir.cjs ./apps/api/scripts/seed-data-dir.cjs
COPY --from=build /app/apps/api/data/web ./apps/api/data/web
# WORKDIR 与 apps/api 下 `node data/serve/app.js` 的相对路径必须一致（systemd 单元同理）。
WORKDIR /app/apps/api
CMD ["node","data/serve/app.js"]