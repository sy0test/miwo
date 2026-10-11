# 谜沃部署手册

> 本目录只产出部署文件。**本机没有 Docker**，因此 Phase 0 不做本地容器验证；一致性由 `node tools/check-deploy-config.cjs` 保证。

## 容器/主机 Node 版本要求

**Node `>=22.12 <25`**（`engines.node` 在根 `package.json` 与 `apps/api/package.json` 都是这个范围）。

- 为什么下限是 **22.12** 而不是 22.0：依赖链里的 `is-path-inside@4.0.0` 是**纯 ESM**（`"type":"module"`）且不在 esbuild 的 `external` 列表里，
  产物中会留下字面 `require(ESM)`；Node 直到 **22.12** 才默认允许 `require()` 加载同步 ESM（`--experimental-require-module` 之前的版本会直接抛错）。
- 因此自建镜像（`FROM node:22.x-slim` 之类）必须选 **>=22.12** 的 tag；用 Debian/Ubuntu 的 `nodejs` 系统包时同样要对版本。
- 上限 `<25`：本机实测 v24.21 通过；25.x 未验证，先挡在门外。

## 首次部署（Linux 云服务器）

1. 装 Docker Engine + Compose 插件
2. `git clone` 本仓库到 `/opt/miwo`
3. `cp deploy/.env.example deploy/.env`，填入密钥：
   `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`
4. 把 TLS 证书放到 `deploy/certs/{fullchain.pem,privkey.pem}`
5. `cd deploy && docker compose build && docker compose up -d`
6. 验证：`curl -I https://<域名>/`、`curl https://<域名>/api/other/configHealth?summary=1`

## 环境变量：`MIWO_PUBLIC_BASE_URL` 的使用条件

| 场景 | 要不要显式设 | 说明 |
|---|---|---|
| `MIWO_ENV=prod`（本目录默认） | **必须** | 不设启动即抛 `ConfigError`。媒体走相对路径，本变量只用于生成对外绝对链接。 |
| dev + **只在本机浏览器**访问 | 可不设 | 缺省 `http://<MIWO_HOST>:<MIWO_PORT>`，即 `http://127.0.0.1:10588`。 |
| dev + **局域网/手机浏览器**访问 | **必须显式设本机局域网地址** | 例如 `MIWO_PUBLIC_BASE_URL=http://192.168.1.12:10588`。Task 9 删掉了 `oss.ts` 里"回退到第一个非回环 IPv4"的 `lanMediaBase()`，缺省值里的 `127.0.0.1` 会被远端浏览器当成本机 → **媒体（`/oss`）全部加载失败**（后端进程本身照常启动，所以症状很隐蔽）。 |

## 升级

```bash
cd /opt/miwo && git pull
cd deploy && docker compose build
docker compose up -d          # 迁移在 Phase 1a 起由容器入口执行
```

## 回滚

镜像按 `MIWO_IMAGE_TAG` 固定；回滚 = 改 `MIWO_IMAGE_TAG` 为上一版本后 `docker compose up -d`。
**数据库迁移的回滚在 Phase 1a 定义**（每个迁移必须有 down）。

## 与旧系统共存

旧 ToonFlow 走 Windows `启动ToonFlow服务器.bat`（18080 端口），与本目录无关，互不影响。
