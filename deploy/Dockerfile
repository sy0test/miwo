# syntax=docker/dockerfile:1
# 谜沃 / MirrorWorld 后端镜像（多阶段：装依赖 → 构建 → 运行）
#
# ⚠ 本文件**未经本机验证**：开发机没有 Docker，Phase 0 只做到"文件自洽 + 与代码/一致性脚本一致"。
#    真正的镜像构建与容器内运行验证属于 **Phase 1d 的目标形态**（详见 deploy/README.md）。
#
# 基础镜像下限 = 22.12（`engines.node` = ">=22.12 <25"）：
#   依赖链里的 is-path-inside@4.0.0 是纯 ESM 且不在 apps/api/scripts/build.ts 的 external 列表里，
#   打包产物会留下字面 require(ESM)；Node 直到 22.12 才默认允许 require() 同步 ESM。
FROM node:22.12-bookworm-slim AS base

# pnpm 版本取自根 package.json 的 packageManager（pnpm@10.33.0），用 corepack 固定，避免镜像里 pnpm 漂移。
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

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

# ---- 构建：prebuild 生成 src/router.ts → esbuild 打包 ----
FROM base AS build
RUN pnpm install --frozen-lockfile
COPY apps/api apps/api
RUN pnpm --filter @miwo/api build

# ---- 运行 ----
FROM node:22.12-bookworm-slim AS runtime
WORKDIR /app
# pnpm 的 node_modules 里全是相对 symlink（指向 /app/node_modules/.pnpm/...），
# 只要保持 /app 下的相对结构整棵拷贝，软链就仍然有效。
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /app/apps/api/package.json ./apps/api/package.json
# 唯一真实的后端构建产物：esbuild 的 outfile = data/serve/app.js
# （apps/api/scripts/build.ts:44，apps/api/package.json 的 start 也是它；仓库里**不存在** dist/ 产物）。
COPY --from=build /app/apps/api/data/serve ./apps/api/data/serve
# 运行时素材（技能 / 提示词）随镜像带一份，供**首次部署播种**进 MIWO_DATA_DIR 卷：
#   容器启动时读的是 ${MIWO_DATA_DIR}/{skills,modelPrompt}（见 src/utils/getPath.ts），
#   卷里没有它们时应用照常启动、但技能/提示词功能会静默失效。播种命令见 deploy/README.md。
# ⚠ Phase 1c Task 8：原来这里还有一行 `COPY …/data/vendor`。供应商适配器已改成**编译期内置**的
#   `apps/api/src/vendors/*.ts`（esbuild 把它们打进 `data/serve/app.js`）⇒ 运行期不需要也不存在
#   `data/vendor` 目录。那一行必须一起删：它会让 `docker build` 以 "COPY failed: no source files"
#   失败（`tools/check-deploy-config.cjs` 现在也有断言守着"COPY 的源必须存在"）。
COPY --from=build /app/apps/api/data/skills ./apps/api/data/skills
COPY --from=build /app/apps/api/data/modelPrompt ./apps/api/data/modelPrompt
# WORKDIR 与 apps/api 下 `node data/serve/app.js` 的相对路径必须一致（systemd 单元同理）。
WORKDIR /app/apps/api
CMD ["node","data/serve/app.js"]
