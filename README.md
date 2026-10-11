# 谜沃 / MirrorWorld（miwo）

多租户 AI 短剧生产平台。本仓库由 Toonflow 复制改造而来（品牌与技术标识符已更名）。

**设计文档**：`../../docs/superpowers/specs/2026-10-12-miwo-saas-design.md`
**Phase 0 计划**：`../../docs/superpowers/plans/2026-10-12-miwo-phase0-repo-bootstrap.md`

## 目录

| 目录 | 内容 |
|---|---|
| `apps/api` | 后端（Express + knex） |
| `apps/web` | 前端（Vue 3 + Vite） |
| `packages/shared` | 前后端共享类型（暂空） |
| `deploy` | docker-compose / nginx / systemd / 环境变量示例 |
| `tools` | 仓库级检查脚本 |

## 本机启动

```powershell
pnpm.cmd install
cd apps\api
pnpm.cmd dev
```

要求 Node **22.12–24**、pnpm 10。本机开发不需要 Docker。

### 路由与配置（改动须知）

- **新增/改名 `apps/api/src/routes/**` 下的文件后，重启 `pnpm dev` 即可，`src/router.ts` 会自动重新生成**。
  生成链挂在两处：`apps/api/package.json` 的 `predev`（每次 `pnpm dev` 一次）与 `apps/api/nodemon.json` 的 `exec` 前缀
  （nodemon 每次重启都跑）。**只靠 `predev` 会漏掉"dev 会话内新增路由"**：nodemon 重启走 `exec`，不会再跑 predev，
  症状是新路由返回 404 而没有任何报错（所谓"幽灵 404"）。
  `src/router.ts` 是**提交在仓库里的构建产物**（构建期生成，不再由 `app.ts` 运行期重建）；空清单会被生成器直接拒绝覆盖。
- 配置唯一入口是 `apps/api/src/config.ts`，只认 `MIWO_*` 变量；开发期模板见 `apps/api/.env.example`。
  ⚠ **dev + 局域网/手机浏览器访问**时必须显式设 `MIWO_PUBLIC_BASE_URL`（否则远端浏览器把缺省的 `127.0.0.1` 当自己，媒体全挂）。
- 部署文件与容器 Node 版本要求见 [`deploy/README.md`](deploy/README.md)；一致性由 `node tools/check-deploy-config.cjs` 保证。
