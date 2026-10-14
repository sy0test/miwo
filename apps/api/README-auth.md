# 账号、鉴权与升级手册（Phase 1c）

> 面向**运维**：升级一台已经在跑的谜沃实例、创建第一个管理员、决定谁能注册。
> 面向**实现者**：账号模型的列与策略归属、令牌语义、已知限制。
> 本文件是 Phase 1c 的交付物之一（Task 12）；验收命令见最后一节。

---

## ① 账号模型

### `o_user`（§7.1 的 9 列 + `mustChangePassword` + 自增主键，共 10 列）

| 列 | 类型 | 语义 |
|---|---|---|
| `id` | `bigint unsigned` 自增主键 | 租户 id；**旧库的 id 值在升级时保真带入** |
| `username` | `varchar(64)` NOT NULL **唯一** | 登录名（3..64 字符） |
| `email` | `varchar(191)` 可空 **唯一** | 本阶段只占位，不用于登录/找回 |
| `passwordHash` | `varchar(255)` NOT NULL 默认 `''` | **argon2id**（`$argon2id$v=19$m=19456,t=2,p=1$…`）。空串 = 任何口令都过不了 |
| `role` | `varchar(16)` NOT NULL 默认 `user` | `user` \| `admin`。**每个请求从 DB 现读**，不信 token 里的值 |
| `status` | `varchar(16)` NOT NULL 默认 `active` | `active` \| `disabled`。非 `active` 一律登录失败/令牌失效 |
| `tokenVersion` | `int unsigned` NOT NULL 默认 `0` | 令牌代际；`++` 即让该账号已签发的**全部**令牌立即失效 |
| `mustChangePassword` | `bool` NOT NULL 默认 `0` | 首次登录强制改密的标志（**只回标志，不拦接口**，见已知限制） |
| `createdAt` | `bigint`（毫秒）NOT NULL | |
| `lastLoginAt` | `bigint`（毫秒）可空 | |

### 随账号一起建出来的 4 张表（`005_accounts`）

| 表 | 作用 |
|---|---|
| `o_invite` | 邀请码：`code`（唯一）/`createdBy`/`maxUses`/`usedCount`/`expiresAt`/`disabled`/`createdAt` |
| `o_userSetting` | 7 个**用户级**平台键从 `o_setting` 迁到这里（`(userId,key)` 复合主键） |
| `o_loginAttempt` | 登录失败计数：`(username,ip)` 复合主键 / `failedCount` / `lockedUntil` / `firstFailedAt` |
| `o_auditLog` | 审计：`userId`/`role`/`action`/`target`/`detail`/`requestId`/`ip`/`createdAt`。**只追加**，没有 update/delete 路径 |

### 2 张配额骨架表（`006_quota_grants`）

| 表 | 列 |
|---|---|
| `o_account` | `userId`（主键）/ `balanceMicro` / `frozenMicro` / `version` / `updatedAt` —— 金额一律**整数微元**（1 元 = 1 000 000） |
| `o_modelGrant` | 自增 id / `userId` / `agentKey` / `vendorId` / `model` / `enabled` / `dailyLimit` / `createdAt` |

⚠ **本阶段不计费**：`o_account` 只是空行，`o_modelGrant` **没有任何执行点**（`resolveModelName()` 不看它）。
真正扣费与额度拦截在 Phase 2。现在给用户"额度"的唯一手段是管理员人工开通 + 平台 key。

### 策略归属（`src/db/policies.ts`，由 `tools/check-tenant-policies.cjs` 与建表清单三方对齐）

- `tenant`：`o_account`、`o_modelGrant`（以及 20 张业务租户表）—— 读写都被 `userId` 条件限定；
- `platform`：`o_user`、`o_invite`、`o_loginAttempt`、`o_userSetting`、`o_auditLog`、`o_setting` ——
  **读放行**（登录发生在建 ctx 之前，必须能读 `o_user`），**写要求 `role=admin`**，或由特权原语
  （`src/db/noContext.ts` 的系统身份）代行。

---

## ② 升级顺序（**照这个顺序做，不要跳步**）

```powershell
# 0) 停服务，然后**备份**（备份必须落在仓库外；apps/api/data 里的东西会被打进安装包）
Copy-Item <数据目录>\db2.sqlite D:\sy_workspace\.db-backups\db2.pre-1c.sqlite

# 1) 迁移到最新（目标必须显式给出）
cd apps\api
$env:MIWO_DATA_DIR="<数据目录>"; pnpm.cmd run db:migrate

# 2) **创建管理员** —— 升级后第一件事（旧账号全是 disabled，见下）
$env:MIWO_BOOTSTRAP_PASSWORD="<一次性口令>"
pnpm.cmd run db:bootstrap-admin -- --username=admin --apply

# 3) 发邀请码 → 用户重新注册
#    （邀请码管理 HTTP 接口不在 Phase 1c 范围内；本阶段直插 o_invite 一行，
#      见 scripts/seed-manual-test.ts 的写法）
```

**为什么"创建管理员"是第一步而不是最后一步（裁定 1c-25）**：

`005_accounts` 把老 `o_user` 的**明文**口令行一律迁成 `status='disabled'` + `passwordHash=''`。
空串哈希过不了任何 argon2 校验 ⇒ **升级完之后库里一个能登录的账号都没有**。
明文口令**绝不迁移**是刻意的：把一个可登录的弱口令账号带进新系统，比"要求重新注册"糟得多。
所以升级流程是 **引导管理员 → 发邀请码 → 用户重新注册**，没有第三条路。

**关于 `002_platform_seed` 与老库里的 `o_setting.tokenKey`（裁定 1c-26）**：

老库/真实库里有一行 `o_setting.tokenKey`（旧 JWT 密钥）。改前 `002` 见到它就**抛错**，
而删它的是 `005` —— `002` 跑在 `005` 之前，于是**真实升级路径在 002 就断了**（鸡生蛋）。
现在 `002` 把它**改名**成 `jwtSecret`：
- 同一把密钥仍在库里 ⇒ 老令牌继续有效（不会因为一次升级把所有人踢下线）；
- 运维显式设过 `jwtSecret` 时**不覆盖**，只删旧键；
- 幂等（跑第二遍什么也不做）；**全新库完全不受影响**（`o_setting` 键集合逐字不变）。
判据：`tests/accounts-migration.test.ts` 的「002 容忍旧库的 tokenKey」用例 +
`verify:phase1c` 的迁移链实跑（红端原文见 `task-12-report.md`）。

> ⚠ **不支持在老库上原地跑迁移**（`createTable` 不幂等，见根 `README.md`「迁移纪律」）。
> 老数据进新库走 **导出 → 导入 → 比对**（`db:export` / `db:import` / `db:compare`）。

`db:bootstrap-admin` 的行为细则：

| 情形 | 行为 |
|---|---|
| 库里没有同名用户 | 新建：`role=admin`、`status=active`、`mustChangePassword=1`、argon2id 哈希，写一条 `o_auditLog`（`action=admin.bootstrap`） |
| 同名用户**已存在**（任意状态） | **拒绝**，退出码 **3**，不覆盖、不改口令（重置走 HTTP 的管理员接口） |
| 同名用户存在且 `status='disabled'`（005 迁来的旧行） | 同上拒绝，并提示加 `--reset-legacy` 显式重开通 |
| 加 `--reset-legacy` 且该行是 `disabled` | 改成 `active`/`admin`/`mustChangePassword=1` + 新哈希，审计 `action=admin.bootstrap.resetLegacy` |
| 不加 `--apply`（**默认**） | DRY-RUN：只打印将要做什么，**一行都不写** |
| 目标解析成仓库内 dev 库 | 护栏拒绝（退出码 1），除非显式 `--allow-repo-dev-db` / `MIWO_ALLOW_REPO_DEV_DB=1`（且要求先有可恢复点） |

口令来源优先级：`--password-env=<变量名>` → `MIWO_BOOTSTRAP_PASSWORD` → 交互式输入。
口令策略：≥ 8 字符、**不得包含用户名**。⚠ **没有** `--password=`：argv 会进 shell history 与进程列表。

---

## ③ 注册模式（`registrationMode`）

平台键 `o_setting.registrationMode`，三态，**默认 `invite`**：

| 值 | 语义 |
|---|---|
| `invite`（默认） | 注册必须带一个可用的邀请码（`o_invite`：未禁用、未过期、`usedCount < maxUses`） |
| `open` | 任何人可注册，**不需要**邀请码 |
| `closed` | 注册一律 403 |

**如何切换**：改 `o_setting` 里那一行的 `value`（管理员在"设置 → 数据库"里改，或 SQL 直改）。
非这三个值 / 缺行 / 读不出来 ⇒ **一律按最严的 `invite`**（fail-closed）。
邀请码消费是**事务内带条件更新**（`where usedCount = <读到的值>`）⇒ 并发超发会以 `INVITE_RACE`(409) 失败，不会超发。

---

## ④ 令牌生命周期与吊销语义

| 令牌 | 形态 | 存放 | 寿命 |
|---|---|---|---|
| access | `{uid, role, tv, typ:"access", jti, iat, exp}`，HS256 | 响应体 `data.token`，**带 `Bearer ` 前缀**（前端存**内存**） | **15 分钟** |
| refresh | `{uid, role, tv, typ:"refresh", …}` | **只有** `Set-Cookie: miwo_rt=…`，`HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=604800`（prod 另加 `Secure`） | **7 天** |

- 验签密钥的优先级（**每请求现读**）：`o_setting.jwtSecret` → `o_setting.tokenKey`（旧位置，兼容）→ `config.jwtSecret`（`MIWO_JWT_SECRET`，恒有值兜底）；
- **媒体链接**用的是**另一把**密钥（`HMAC(key="miwo:media-sign:v1", msg=MIWO_JWT_SECRET)`）：
  轮换 `MIWO_JWT_SECRET` ⇒ ①全员 JWT 失效 ②已发出的媒体链接立即失效（两者本就该一起做）；
  只轮换库里的 `jwtSecret` 行 ⇒ JWT 断、媒体链接在其 24h TTL 内仍可用；
- `authenticate` 中间件**每请求**复核 DB 里的 `role`/`status`/`tokenVersion` ⇒ 停用账号、改密、
  登出都**不需要**等令牌自然过期就立即生效；
- **刷新会轮转**：`POST /api/auth/refresh` 用旧 refresh 换一对新令牌并重新下发 Cookie。

> ⚠⚠ **代价（务必让用户知道）：登出会让该账号的*所有*设备立即失效。**
> `POST /api/auth/logout` 与改密一样做 `tokenVersion++` —— 这是 spec §7.2 的字面要求
> （"登出即吊销"），代价是同一账号在另一台设备/另一个标签页上的会话**也会立刻断**。
> 本设备自己的 refresh Cookie 同时被清掉。

---

## ⑤ 登录锁定

`src/auth/attempts.ts`（纯函数，参数写死、不是运维旋钮）：

| 参数 | 值 |
|---|---|
| 触发阈值 `MAX_FAILED` | **5** 次连续失败 |
| 锁定 `LOCK_MS` | **15 分钟** |
| 衰减 `DECAY_MS` | **30 分钟**（距上次失败超过 30 分钟，计数从头开始 —— 否则"几天里偶尔打错 5 次"会被当成爆破） |

- 计数键是 **`(username, ip)`**（`o_loginAttempt` 复合主键）⇒ 同一账号从不同 IP 打，各算各的；
- 账号不存在时走**哑验证**（真实 argon2id 代价）抹平时序差；
- 失败文案统一为"账号或口令错误（还可尝试 N 次）"⇒ **不泄露账号是否存在**；
- 锁定期间所有尝试都被拒（不区分口令对错）。

---

## ⑥ 运维接口开关（`allowDbAdminOps`）

平台键 `o_setting.allowDbAdminOps`，**默认 `0`（关闭）**。它只控制
**清表 / 清库 / 导入 / 导出** 这几个"数据库运维"接口；关闭时它们返回统一文案的 403。

- 读值口径是**最严解析**：读不到 / 值不是 `"1"` / 抛错 ⇒ 一律 `false`（fail-closed）；
- 它**不控制任何启动路径行为**（启动期读不到就当关闭）；
- 为什么用平台键而不是环境变量：那两个开关**天然是运行时可变的运维决定**，而新增环境变量要同时改
  `deploy/.env.example` + `apps/api/.env.example` + `tools/check-deploy-config.cjs` 的白名单三处。
  代价（如实登记）：**"库都坏了要清库"时没法靠它** —— 那种场景走停服窗口里的脚本。

---

## ⑦ 已知限制（**明确交接，不是"已完成"**）

1. **没有 refresh 重用检测**：轮转后的旧 refresh 一直到 7 天过期都仍可用；`tokenVersion` 只能整体吊销。
2. **没有找回密码**：只支持"已登录改密" + 管理员重置（找回入口要 SMTP，属 Phase 2 运营后台）。
3. **没有短信/邮件**：`o_user.email` 只是占位列。
4. **锁定按 `(username, ip)`**：换 IP 就能绕过锁定计数（有意的取舍：单键锁定会让攻击者用一个 IP
   把某个账号锁死）。
5. **`mustChangePassword` 只回标志**：`/api/auth/me` 与登录响应里回 `true`，由**前端**强制跳改密页；
   后端**不**对其它接口一律 403（那会把管理员在改密前锁在门外）。⇒ 直接拿 access 打 API 是**能通的**。
6. **静默续期后不重新水合 `role`/`mustChangePassword`**：刷新只换令牌，前端内存里的这两项不更新
   （只影响 UI 展示；后端每请求从 DB 现读，权限判定不受影响）。
7. **socket.io 的归属校验没做**（Tier 0 #9 → Phase 1e）：`projectId`/`isolationKey` 仍由客户端指定；
   但握手已用 access token，业务读路径已受租户守卫约束。
8. **上传没有魔数/大小校验**（Tier 1 #14 → Phase 1e）。
9. **生成/上传接口没有限流**（只有登录/注册/全局三档）。
10. **媒体签名 24h TTL + `Cache-Control: public` 偏宽**（N3，Phase 1c Task 10 登记，本轮不改）；
    硬约束 `max-age(1h) < TTL(24h)` 成立，所以不是漏洞，是口径选择。
11. **`/assets` 会遮蔽将来的 SPA 产物目录**（N4）：Phase 3 前端重绘时必须先决定
    "前端改 `build.assetsDir`"还是"`/assets` 让位"，否则 `/assets/*.js` 会 403 ⇒ 页面白屏。
12. **`src/types/database.d.ts` 未重生成**（`db:types` 与新 schema 有漂移）。
13. **MySQL 全线未实测**（本机不启 MySQL；见第 ⑧ 节与 `task-12-report.md` 的「未验证项」）。

### deferred 登记表（从 Phase 0 / 1a / 1b 账本落进 Phase 1c 的条目）

| # | 条目（来源） | 本阶段处置 | 落点 |
|---|---|---|---|
| 1 | Phase 0 ledger：`err.ts` 吞掉未处理拒绝（Tier 1 #16） | ✅ 做 | T6 |
| 2 | Phase 0 ledger：出网代理变量的旧名重命名 | ✅ 做（→ `MIWO_PROXY`；旧名的废弃留档在 `apps/api/src/proxy.ts` 与两个 `.env.example` 里） | T10 |
| 3 | Phase 0 ledger：`initDB.ts:24` 明文默认口令 | ✅ 做（旧行禁用 + 引导命令） | T1 / T5 / T12 |
| 4 | Phase 0 ledger：备份文件名前缀的品牌收口（含前端同名前缀） | ✅ 做 | T4 / T11 |
| 5 | Phase 0 ledger：片尾素材的显示名品牌收口 | ✅ 做（+ 删对应豁免） | T9 / T10 |
| 6 | Phase 0 ledger：`NOTICES.txt` 仍列 electron 系许可证 | ✅ 做 | T5 |
| 7 | Phase 0 ledger：`src/core.ts` 与 `check-copy` 阈值一起删 | ✅ 做 | T5 |
| 8 | Phase 1a Ruling 12：`check-copy` 阈值下调随真正删文件的 Task | ✅ 做（下限 = 删除后实测值） | T5 |
| 9 | Phase 1a deferred #7：删 `lib/initDB.ts`/`lib/fixDB.ts` + 阈值 | ✅ 做 | T5 |
| 10 | Phase 1a deferred #8：`o_user` 重建（argon2id/role/tokenVersion/删 `admin/admin123`） | ✅ 做 | T1 |
| 11 | Phase 1a deferred #9：`tokenKey` 移出 DB + 7 个用户级键迁 `o_userSetting` | ✅ 做 | T1 / T3 |
| 12 | Phase 1a deferred #14（部分）：品牌残留必须动的三处 | ✅ 做；其余随 T8 目录搬迁自然消失/重新豁免 | T8 / T9 / T10 |
| 13 | Phase 0 终审：README"配置唯一入口"失真 + `ossURL` 无门禁 | ✅ 做（新门禁 + README 改实测口径） | T10 |
| 14 | Phase 0 ledger：`tenant-exceptions.json` 的 note 把 §7.3 写成"Phase 1b" | ✅ 做（`--record` 后逐条改写口径） | T4 |
| 15 | Phase 0 ledger：`.dockerignore` 缺失（N1，"1d 准入前必修"） | ⛔ 不做（1d） | 本条 |
| 16 | Phase 1a deferred #16：`deploy/` 容器路径整体未验证 + `seed/*.ndjson` 容器侧拷贝 | ⛔ 不做（1d）；T8 已保证"删掉 `data/vendor` 后 Dockerfile 仍自洽" | 本条 |
| 17 | Phase 1a deferred #4：`knex_migrations`/`knex_migrations_lock` 的策略声明 | ⛔ 不做（1b）；本阶段**已核对**它们在 `policies.ts` 里声明 | T3 |
| 18 | Phase 1a deferred #5/#6：`o_project.id` 去 `Date.now()`、35 处 `insertId` 语义复核 | ⛔ 不做（1b） | 本条 |
| 19 | spec Tier 1 #14（上传魔数/大小）、#18（24 条路由补 `validateFields`） | ⛔ 不做（1e / 1d）；1c 保证**新增与改动**的路由都有 `validateFields` | 本条 |
| 20 | spec Tier 0 #9（socket 归属校验） | ⛔ 不做（1e）；T6 只把 socket 的 CORS 收进白名单 | 本条 |
| 21 | spec §11.1 的"找回密码入口" | ⛔ 不做（Phase 2；需要 SMTP） | 本条 |
| 22 | spec §6.5 的 Storage 抽象与租户前缀 key | ⛔ 不做（1e）；1c 已把签名形状定成 `Storage` 接口要的样子 | 本条 |
| 23 | **Phase 1b deferred #16：`verify:manual-test` 跑不起来** | ✅ 做（Task 12 重写为"新库迁移 → 夹具种子 → 起服务 → 打印 URL"） | T12 |
| 24 | Phase 1b ledger 1b-16：浏览器级手工验收**未做** | ⚠ 仍**未做**（本环境无浏览器自动化、`apps/web` 无测试运行器）⇒ 只把入口修好并给出点检清单 | T12 + 根 README |
| 25 | N3（媒体 24h TTL + `public` 偏宽） | ⛔ 不做（Phase 2/后续） | 根 README 已知问题 §2 |
| 26 | N4（`/assets` 会遮蔽将来的 SPA 产物目录） | ⛔ 不做（Phase 3 前必须拍板） | 根 README 已知问题 §2 |
| 27 | `types/database.d.ts` 未重生成 | ⛔ 不做 | 本条 |
| 28 | 静默续期后不重新水合 `role`/`mustChangePassword`（只影响 UI） | ⛔ 不做 | 第 ⑦ 节第 6 条 |
| 29 | **MySQL 全线未实测** | ⚠ 本机不启 MySQL；CI 的 `mysql` job 是替代口径 | `task-12-report.md` |
| 30 | **`verify:phase0` 在干净 CI checkout 里跑不过**（依赖被 gitignore 的基线 + 仓库外两个旧仓） | ⛔ 不做（已登记在 `check-ci-yaml` 的 `CI_EXEMPT`） | 根 README「已知问题」 |

---

## ⑧ 验收命令

```powershell
cd D:\sy_workspace\code\miwo
& pnpm.cmd run verify:phase1c        # A–H 组（真进程 + 真 HTTP）+ M 组（MySQL，本机显式"未实测"）
```

`verify-phase1c.cjs` 的组别：A 源码前置 / B 应用能起 / C 引导与注册 / D 登录与会话 /
E 跨租户隔离 / F 收权 / G 安全面 / H 干净收尾 / M MySQL 口径（**未实测时不计入通过数**）。
它自己在 `%TEMP%`（CI 上 `runner.temp`）下开一次性数据目录，**绝不碰 `apps/api/data`**。

**人工点检（浏览器）**：

```powershell
pnpm.cmd run verify:manual-test      # 构建前端 → 新库迁移 → 建管理员 → 种夹具 → 起服务 → 打印 URL
pnpm.cmd run verify:manual-test -- -Stop
```

它打印的 URL 后面跟四步清单（登录 → 注册第二个用户 → 建项目 → 看到媒体），
管理员口令按**每次运行随机生成**并打印在末尾；⬜ 但**浏览器级验收本阶段仍未做**
（见 deferred #24）—— 脚本只保证"入口真的能起、页面真的能打开"。

**相关的单测**（CI 每轮跑）：

```powershell
cd apps\api
pnpm.cmd exec vitest run tests/accounts-migration.test.ts tests/auth-service.test.ts `
  tests/auth-tokens.test.ts tests/auth-password.test.ts tests/authorization.test.ts `
  tests/http-hardening.test.ts tests/media-sign.test.ts
```
