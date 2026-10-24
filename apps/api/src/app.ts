// import "./logger";
import "./err";
import "./env";
import { installProxy } from "./proxy";
import express, { Request, Response, NextFunction } from "express";
import { Server } from "socket.io";
import http from "node:http";
import expressWs from "express-ws";
import logger from "morgan";
import cors from "cors";
import helmet from "helmet";
import path from "path";
import fs from "fs";
import type { Knex } from "knex";
import u from "@/utils";
import { dbReady } from "@/utils/db";
import { startProgressRelay } from "@/jobs/progressRelay";
import { tenantErrorHandler } from "@/middleware/tenant";
import { authenticate, authErrorHandler, optionalMediaAuth } from "@/middleware/auth";
import { apiLimiter } from "@/middleware/rateLimit";
import socketInit, { makeRelayTargetResolver } from "@/socket/index";
import { isEletron } from "@/utils/getPath";
import { ensureThumbnail, ThumbnailSize } from "@/utils/image";
import { mediaAuthGuard, normalizeMediaRelPathInside, redactMediaQueryString, resolveInsideRoot } from "@/utils/mediaSign";
import { parseThumbnailSize } from "@/utils/thumbnail-size";
import isPathInside from "is-path-inside";
import { config } from "@/config";

const app = express();
const server = http.createServer(app);

/**
 * dev 的 Vite 源（**白名单的一部分，不是"放行一切"**）。
 *
 * ⚠ 为什么在 dev 需要它们：页面由 Vite（50188）提供，接口在本进程（10588）⇒ **跨源**。
 *   prod 的页面由 Nginx 同源提供（spec §4.1），所以 prod 的白名单里**只有** `MIWO_PUBLIC_BASE_URL`。
 */
const DEV_ORIGINS: readonly string[] = ["http://127.0.0.1:50188", "http://localhost:50188"];

/**
 * CORS 白名单（Phase 1c Task 6；spec §10.2 Tier 0 #7 要求"白名单"）。
 *
 * ⚠ 旧实现是 `cors({ origin: "*" })` **两处**（HTTP 与 socket.io）⇒ 任意站点都能带上用户凭据
 *   读取接口响应（`credentials` 与 `*` 不能共存，所以"要去掉 `*`"与"要发 refresh Cookie"
 *   是**同一件事**的两面，不是两个可选改动）。
 * ⚠ **不新增环境变量**（裁定 5）：白名单 = `MIWO_PUBLIC_BASE_URL` +（仅 dev）Vite 两个源。
 *   prod 缺失 `MIWO_PUBLIC_BASE_URL` 时 `config.ts` 已经 fail-fast，不会走到这里。
 */
export function allowedOrigins(): string[] {
  const list = [config.publicBaseUrl.replace(/\/$/, "")];
  if (config.env === "dev") list.push(...DEV_ORIGINS);
  return list;
}

/**
 * `cors` 的 origin 回调。
 *
 * ⚠ `origin === undefined`（**同源请求**、curl、服务端调用）必须放行：那类请求本来就不带
 *   `Origin` 头，浏览器同源策略也不参与 —— 挡掉它会把 `verify-phase0/1b` 那些无 Origin 的
 *   端到端脚本一起挡死（它们是"无 Origin"而不是"非法 Origin"）。
 */
export function corsOrigin(): (origin: string | undefined, cb: (e: Error | null, ok?: boolean) => void) => void {
  return (origin, cb) => {
    if (!origin || allowedOrigins().includes(origin)) return cb(null, true);
    // ⚠ **不抛错**（抛错会变成 500 + 一条误导性的服务端错误日志）：回调 `ok=false`
    //   让 cors 中间件**不回** `Access-Control-Allow-Origin` ⇒ 浏览器侧失败，服务端 200/4xx 照常。
    return cb(null, false);
  };
}

/**
 * 安全响应头 + CORS（Phase 1c Task 6）。**HTTP 与 socket.io 共用同一份白名单**。
 *
 * ── helmet 的三处**必须**放宽（照抄文档会打断现有产品）──
 *   · `contentSecurityPolicy: false` —— CSP 属 Nginx 配置（`deploy/nginx.conf`，spec §4.1）：
 *     API 进程在 dev 还会顺带提供 `data/web` 的 SPA，而 25 MB 单文件页面的内联脚本
 *     **必然**违反默认 CSP（症状：页面白屏）。本阶段不做 CSP。
 *   · `crossOriginEmbedderPolicy: false` —— dev 的页面来自 Vite（50188）、媒体来自本进程（10588）
 *     ⇒ **跨源**；COEP 会把跨源资源全部拦掉。
 *   · `crossOriginResourcePolicy: { policy: "cross-origin" }` —— helmet 默认是 `same-origin`，
 *     会让所有 `/oss` 图片被浏览器拒收（症状：登录/接口全正常，页面上一张图都没有）。
 *
 * ⚠ 位置**必须在静态资源（`/oss`）之前**：helmet 是"给每个响应加头"的中间件，
 *   注册在 `express.static` 之后的话，图片响应就**不带** CORP 头（那样这条放宽等于没生效）。
 */
export function applySecurityHeaders(target: express.Express): void {
  target.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  target.use(cors({ origin: corsOrigin(), credentials: true }));
}

/**
 * 错误处理器（Phase 1c Task 6；spec §10.2 Tier 1 #15）。
 *
 * ── 旧实现（`res.status(err.status||500).send(err)`）泄的是什么（实测，不是推测）──
 *   · `send(err)` 这条路上，`Error` 的 `message`/`stack` 是**不可枚举**的 ⇒ 实测响应体只有
 *     `{"code":"SQLITE_CONSTRAINT_UNIQUE"}`：**驱动错误码本身就是一条不该外泄的信息**
 *     （它告诉攻击者"这一列有唯一约束"）；
 *   · 同一次冲突若走到 Express 的**默认**错误处理（`next(err)`，或它之前的任何一环没兜住），
 *     响应体是 HTML 且含**完整 message + 绝对路径堆栈**
 *     （实测原文：`UNIQUE constraint failed: o_user.username` +
 *      `D:\sy_workspace\code\miwo\node_modules\.pnpm\knex@3.3.0…` 共 9 帧）。
 *   ⇒ 表名、列名、约束名、依赖绝对路径全在**响应体**里。
 *
 * ── 新实现 ──
 *   · 服务端日志：`requestId`（来自 `req.ctx`）+ **完整**错误对象（诊断信息只留在日志里）；
 *   · 响应体：**统一形状** `{code, data, message}`；`>=500` 一律回**固定文案**，绝不回
 *     `err.message`（它可能含表名/列名/路径）；`<500` 回 `err.message` 但**不**回堆栈。
 */
export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction): void {
  const status = Number(err?.status) || Number(err?.httpStatus) || 500;
  const requestId = String((req as any)?.ctx?.requestId ?? (req as any)?.tenant?.requestId ?? "");
  console.error(`[error] requestId=${requestId} method=${req.method} path=${req.path}`, err);
  res.status(status).send({
    code: status,
    data: null,
    message: status >= 500 ? "服务器内部错误" : err?.message || "请求失败",
  });
}


/**
 * 静态资源的挂载（Phase 1c Task 7；spec §6.5 的第 1/3/5/6 条）。
 *
 * ── 三档访问口径（这是本 Task 最容易做错的地方：**不是所有静态资源都该锁**）──
 * | 挂载点     | 内容                                   | 口径                                                     |
 * |-----------|----------------------------------------|----------------------------------------------------------|
 * | `/oss`    | 用户媒体（分镜图/参考图/成片/音频）     | **签名或 Bearer**（`mediaAuthGuard`）                     |
 * | `/assets` | 用户产物（片尾素材等）                  | **签名或 Bearer**（同一守卫）                             |
 * | `/skills` | 产品自带的技能图标（随包发布，非用户数据）| **公开**（只放行图片扩展名；spec §6.5 明确"可保持公开"）  |
 * | 其余      | SPA 壳（`data/web` 产物：登录页、静态 JS）| **匿名可访问**（锁掉它 = 用户连登录页都打不开）           |
 *
 * ⚠ 为什么 `/oss` **不能**只要求 Bearer：`<img src>` / `<video src>` 是**浏览器自己**发的请求，
 *   它**不带** `Authorization` 头；只要 Bearer 就等于"页面上的图全裂"。
 *   所以浏览器侧走 query 里的短时签名（`exp`+`sig`，见 `utils/mediaSign.ts`），
 *   服务端/脚本侧仍可直接带 Bearer（`/oss`、`/assets` 之前挂着 `optionalMediaAuth`：
 *   有 `Authorization` 就建 ctx，守卫看到 `req.ctx` 就放行；没有就按签名判）。
 *   ⚠ Phase 1c Task 10 前这句话是**错的**：`authenticate` 只挂 `/api` ⇒ `req.ctx` 在 `/oss` 上
 *   永远是 `undefined` ⇒ 带 Bearer 也一律 403。修法见 `middleware/auth.ts` 的 `optionalMediaAuth`。
 *
 * ⚠ **Range**（Tier 0 #8）：`acceptRanges: true` 是视频拖动的必要条件（206 + `Content-Range`）。
 *   旧实现四处都是 `acceptRanges: false` ⇒ 拖动进度条只能整段重下（或干脆不动）。
 * ⚠ **缓存**（spec §6.5 第 6 条）：`/oss`、`/assets` 是**短时签名** URL ⇒ `max-age` 必须 **< 签名 TTL(24h)**，
 *   本实现取 `1h`；**不设 `immutable`**（`immutable` 的语义是"这个 URL 的内容永不改变"，
 *   而我们的 URL 每个请求期都不同、且到期会 403，宣称 immutable 会让浏览器把过期的签名 URL 长期扣住）。
 *   `/skills` 是随包发布、按文件名版本化的图标 ⇒ 可以按周缓存（`7d`）。
 */
export function mountStaticAssets(target: express.Express, log: (msg: string) => void = console.log): void {
  // ── /oss：用户媒体。守卫 → 缩略图分支 → 静态 ──
  const ossDir = config.storageDriver === "s3" ? path.join(u.oss.rootDir, "oss") : u.getPath("oss");
  if (!fs.existsSync(ossDir)) fs.mkdirSync(ossDir, { recursive: true });
  log(`文件目录: ${ossDir}`);
  const smallImageDir = path.join(ossDir, "smallImage");
  const hydrateS3Media = (root: "oss" | "assets") => (req: Request, res: Response, next: NextFunction): void => {
    if (config.storageDriver !== "s3") return next();
    u.oss.getAbsPath(req.path, root).then(() => next()).catch(() => res.status(404).end());
  };

  /**
   * `?size=<WxH|百分比>` 的缩略图分支。**整体在守卫之后**（否则一个没有签名的请求就能：
   * ① 用 `?size=` 让服务端在任意 `..` 路径上生成缩略图；② 直接 `res.sendFile` 拿到盘上任何文件）。
   *
   * ⚠ 两个路径都必须过 `resolveInsideRoot`（=剥前导分隔符 + `isPathInside`；Tier 0 "补 isPathInside"）：
   *   ① `originalPath` —— `req.path` 里可能带 `..`，Express 只对 `express.static` 做根目录约束，
   *      **不会**替 `path.join` 做；② `smallImagePath` —— 它是**写入目标**，越界就等于把这个服务
   *      当成"任意路径写入器"（`ensureThumbnail` 会 `mkdir -p` 再落盘）。
   * ⚠ 这里**不泄漏路径**：越界一律 `403` + 空 body（不回显请求路径、也不说检查了哪个路径）。
   */
  const thumbnailBranch = (req: Request, res: Response, next: NextFunction): void => {
    const sizes = new URL(req.originalUrl, "http://localhost").searchParams.getAll("size");
    if (sizes.length === 0) return next();
    if (sizes.length !== 1) return void res.status(400).json({ code: 400, message: "size 参数只能出现一次" });
    // ⚠ 越界（含 `..` 逃逸）在**任何 path.join / mkdir / sendFile 之前**就判掉：
    //   后面的 `ensureThumbnail` 会 mkdir -p 再落盘，越界等于把服务变成"任意路径写入器"。
    const rel = normalizeMediaRelPathInside(req.path);
    if (rel === null) return void res.status(403).end();
    const originalPath = path.join(ossDir, rel.split("/").join(path.sep));

    // ⚠ Phase 1e Task 01 Step 3b：`?size=` 的解析抽到 `utils/thumbnail-size.ts`（可单测 + **显式上界**）。
    //   签名是**路径域**的（query 不参与）⇒ 任何拿到过一条合法媒体 URL 的人都能自由改 `size`，
    //   所以"上界"是这块唯一的收口；非法/越界一律 **400**（不再静默降级返回原图）。
    const parsed = parseThumbnailSize(sizes[0]);
    if (!parsed.ok) return void res.status(400).json({ code: 400, message: parsed.reason });
    const sizeSubDir = parsed.subDir;
    const sizeOpts: ThumbnailSize = parsed.opts;

    const ext = path.extname(rel);
    const base = path.posix.basename(rel, ext);
    const dir = path.posix.dirname(rel);
    // 缩略图相对路径：`smallImage/<原目录>/<原名>_<size><ext>`（与旧实现的目录形状逐字一致）
    const smallImageRel = `smallImage/${dir === "." ? "" : `${dir}/`}${base}_${sizeSubDir}${ext}`;
    const smallImagePath = resolveInsideRoot(ossDir, smallImageRel);
    if (!smallImagePath) return void res.status(403).end();
    // 双保险：写入目标必须在 `oss/smallImage` 之内（不是只要"在 oss 内" —— 否则能写到 `oss/` 根下）
    if (!isPathInside(smallImagePath, smallImageDir)) return void res.status(403).end();

    ensureThumbnail(originalPath, smallImagePath, sizeOpts).then(async (thumbnailPath) => {
      if (thumbnailPath) {
        if (config.storageDriver === "s3") await u.oss.writeFile(smallImageRel, await fs.promises.readFile(thumbnailPath));
        res.sendFile(thumbnailPath);
      } else {
        // 缩略图生成失败，降级返回原图
        express.static(ossDir, { acceptRanges: true })(req, res, next);
      }
    });
  };

  target.use(
    "/oss",
    optionalMediaAuth,
    mediaAuthGuard,
    hydrateS3Media("oss"),
    thumbnailBranch,
    express.static(ossDir, { acceptRanges: true, maxAge: "1h", immutable: false }),
  );

  // ── /assets：用户的片尾素材等产物。与 /oss 同一守卫、同一缓存口径 ──
  // ⚠⚠ 未处置项 N4（Phase 1c Task 10 登记，**本轮不改**）：`/assets` 这个挂载点会**遮蔽** SPA 产物里
  //   同名的目录 —— 如果 Phase 3 的前端构建把产物输出到 `web/assets/`（Vite 的默认 `assetsDir` 正是
  //   `assets`！），那么所有 `/assets/*.js|css` 请求会先命中**这个**守卫（用户产物的签名口径）⇒ 无签名
  //   **403** ⇒ 页面**白屏**（而且症状是"接口全正常、只有 JS/CSS 403"，与 1b-11 的"图片全裂"同族）。
  //   现在没炸是因为 `data/web` 目前只有 `index.html`（本轮 e2e 的 SPA 壳夹具也是手写的）。
  //   Phase 3 前端重绘时必须先决定：① 前端改 `build.assetsDir`（推荐），或 ② `/assets` 让位于 SPA。
  //   注意**不能**靠"把 `/assets` 挂到 SPA 之后"来回避：那等于让用户产物裸奔（1b-11 的本体）。
  const assetsDir = config.storageDriver === "s3" ? path.join(u.oss.rootDir, "assets") : u.getPath("assets");
  if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });
  log(`文件目录: ${assetsDir}`);
  target.use(
    "/assets",
    optionalMediaAuth,
    mediaAuthGuard,
    hydrateS3Media("assets"),
    express.static(assetsDir, { acceptRanges: true, maxAge: "1h", immutable: false }),
  );

  // ── /skills：**保持公开**（产品自带的技能图标；前端图标全靠它）──
  const skillsDir = u.getPath("skills");
  if (!fs.existsSync(skillsDir)) fs.mkdirSync(skillsDir, { recursive: true });
  log(`文件目录: ${skillsDir}`);
  target.use(
    "/skills",
    (req, res, next) => {
      // 只允许图片文件访问
      /\.(jpe?g|png|gif|webp|svg|ico|bmp)$/i.test(req.path) ? next() : res.status(403).end();
    },
    express.static(skillsDir, { acceptRanges: true, maxAge: "7d" }),
  );

  // ── SPA 壳（data/web 产物）：**匿名可访问** ──
  // ⚠ 它必须在**最后**：它是"任意路径都可能命中"的静态目录（挂在根上），放在 `/oss` 之类之前
  //   就会把同名文件抢走（历史上 `data/web` 里就出现过与业务同名的资源）。
  // ⚠ 它**不加** `maxAge`：`index.html` 是入口文件，长缓存会让用户拿到旧壳（旧 JS 哈希）而白屏。
  //   `apps/web` 的构建产物带内容哈希，走的是 `webDir` 里的静态 JS，由 `Last-Modified`/`ETag` 协商即可。
  const webDir = u.getPath("web");
  if (fs.existsSync(webDir)) {
    log(`静态网站目录: ${webDir}`);
    target.use(express.static(webDir, { acceptRanges: true }));
  } else {
    console.warn("静态网站目录不存在:", webDir);
  }
}

async function checkPermissions() {
  if (!isEletron()) return true;
  const userDataPath = u.getPath();
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    const testFile = path.join(userDataPath, ".access_test");
    fs.writeFileSync(testFile, "test");
    fs.unlinkSync(testFile);
  } catch (e) {
    const { dialog, app } = require("electron");
    const { response } = await dialog.showMessageBox({
      type: "warning",
      title: "权限不足",
      message: "应用无法访问数据目录",
      detail: `无法读写以下目录：\n${userDataPath}\n\n请联系管理员授予权限，或以管理员身份运行本程序。`,
      buttons: ["确认退出"],
      defaultId: 0,
    });
    if (response === 0) {
      app.quit();
    }
  }
}

export default async function startServe(randomPort: Boolean = false) {
  // 必须在任何出网调用之前装配，否则厂商适配器会以直连方式发出第一批请求
  await installProxy();

  // ⚠ trust proxy（spec §10.3 / §4.3）：**必须在任何读 `req.ip` 的中间件之前**设置。
  //   它决定 `req.ip` 是否采信 `X-Forwarded-For`：prod ≥1（Nginx 反代，spec §4.1），dev 默认 0
  //   （直连，任何客户端都能伪造 XFF ⇒ 采信它等于让限流/锁定计数被一条头绕过）。
  //   值来自 config.trustProxy（MIWO_TRUST_PROXY，config.ts 已做 fail-fast 校验）。
  app.set("trust proxy", config.trustProxy);

  await checkPermissions();

  await u.writeVersion();
  // ⚠ socket.io 的 CORS 与 HTTP 共用**同一份白名单**（原来两处都是 `origin: "*"`，Task 6 同批改）。
  //   socket 的**鉴权归属校验**（"这个 socket 属于哪个租户"）是 spec Tier 0 #9，归 Phase 1e；
  //   本阶段如实登记：这里收掉的是**跨源读取面**，不是 socket 的授权模型。
  const io = new Server(server, { cors: { origin: allowedOrigins(), credentials: true } });
  socketInit(io);

  expressWs(app);

  /**
   * 日志脱敏（Phase 1c Task 7，裁定 §2.6）。
   *
   * ⚠ 媒体签名（`?exp=&sig=`）是**凭据**：它能换成一次成功的静态资源读取。
   *   Task 4 已经因为"URL 会被访问日志/反代日志/浏览器历史记下来"取消了 `?token=`，
   *   媒体签名允许出现在 query 串里（`<img src>` 带不了头），但**必须**满足同一口径：不进日志。
   *
   * ⚠⚠ **只改 `req.query` 是不够的（实测踩到）**：morgan 的 `:url` 是 `req.originalUrl`，
   *   **不经过** `req.query` —— 第一版就是这样，签名原样出现在 stdout
   *   （实测原文 `GET /oss/x.bin?exp=123&sig=SUPERSECRET&size=20 200`）。
   *   所以两手都要做：
   *     ① 覆盖 `morgan` 的 `url` token（见下），让它读的是脱敏后的串；
   *     ② 仍然把 `exp`/`sig` 从 `req.query` 里摘掉 —— 下游任何"顺手把 query 记下来"的代码
   *        （含我们没预料到的第三方中间件）也拿不到签名。
   * ⚠ 只摘 `exp`/`sig`，其余 query（`size=20` 等）原样保留：`size` 是缩略图分支要读的参数，
   *   而且它对诊断有用（"这一张是不是走了缩略图路径"一眼可见）。
   * ⚠ 不能改成"整条 URL 不记"：那样静态资源的 4xx/5xx 就没法从日志里查了。
   */
  app.use((req, _res, next) => {
    // ⚠⚠ **先另存**：守卫（`mediaAuthGuard`）要用的那一对原始值必须在 `req.url` 被改写**之前**拿到。
    //   否则"脱敏"会把守卫的输入也一起吃掉 ⇒ 每一条合法签名都 403（实测踩到，端到端脚本当场全红）。
    if (typeof req.query?.sig === "string" || typeof req.query?.exp === "string") {
      (req as any)._mediaSig = { exp: String(req.query.exp ?? ""), sig: String(req.query.sig ?? "") };
    }
    const rawUrl = req.originalUrl ?? req.url ?? "";
    const bare = redactMediaQueryString(rawUrl);
    if (bare !== rawUrl) {
      // ⚠ 必须改 `req.url`/`req.originalUrl` 本身，**不能只改 `req.query`**（实测踩到）：
      //   morgan 的 `:url` 读的是 `req.originalUrl`；只改 `req.query` 的话签名照样进日志。
      //   实测：改成 `req.url` 之后路由照常（`size` 仍在 query 里），而日志与 `req.originalUrl` 都是脱敏串。
      req.url = bare;
      req.originalUrl = bare;
    }
    if (req.query && (("sig" in req.query) || ("exp" in req.query))) {
      const rest: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(req.query)) {
        if (k === "sig" || k === "exp") continue;
        rest[k] = v;
      }
      // 第二手：`req.query` 也摘干净 —— 下游任何"顺手把 query 记下来"的代码（含我们没预料到的
      // 第三方中间件）都拿不到签名。Express 5 的 `req.query` 是 getter；
      // `Object.defineProperty` 用同名自有属性覆盖它（直接赋值在 getter-only 属性上会抛）。
      Object.defineProperty(req, "query", { value: rest, writable: true, configurable: true, enumerable: true });
    }
    next();
  });
  // 第三手（冗余但便宜）：morgan 的自定义 `url` token **覆盖**内置的那个（内置的就是 `req.originalUrl`）。
  // 前两手已经够用；这一手保证"将来有人把中间件顺序调了"时日志里依然没有签名。
  logger.token("url", (req: Request) => redactMediaQueryString(req.originalUrl ?? req.url ?? ""));
  app.use(logger("dev"));
  // ⚠ 安全头（helmet）+ CORS 必须在**静态资源之前**（否则 `/oss` 的图片响应不带 CORP 头，
  //   而那条放宽正是为了让 dev 的跨源图片能显示）。见 applySecurityHeaders 的文件注释。
  applySecurityHeaders(app);
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));

  // 租户上下文的建立点（spec §6.4）。实现见 src/middleware/auth.ts（Phase 1c Task 3 起的唯一实现；
  // 旧名 `tenantContextMiddleware` 由 src/middleware/tenant.ts 再导出）：
  // 验签（**库值优先 + 配置兜底**，Phase 1a Task 5 的现状语义，见 src/auth/secret.ts）→ 建 ctx（AsyncLocalStorage）
  // → 在同一个 `run()` 里 next()，于是下游所有 handler（含它们内部的 await）都带 ctx。
  // ⚠ 白名单路径（登录/注册/refresh / configHealth?summary=1）在验签之前 next()：**天然无 ctx**，不许塞假 ctx。
  // ⚠ 新形状 token（typ/tv）会**每请求**从 DB 复核 status/tokenVersion，role 也只信 DB（spec §7.3）。
  // ⚠ 这里曾是"唯一一处还没有 ctx 就要读库"的地方（bootstrap 读 `o_setting.tokenKey`）；
  //    现在那一步在 `@/auth/secret` 里，仍然走 platform 表的"无 ctx 放行读"，**不**需要 systemDb。
  // ⚠ `apiLimiter`：**dev 走 3000/分钟**（放宽而不是关闭 —— 超阈值仍会 429，
  //   见 `middleware/rateLimit.ts` 与 `tests/http-hardening.test.ts` 的限流用例）。
  app.use(apiLimiter);
  // ⚠⚠ Phase 1c Task 7：**鉴权只挂 `/api`**（原来是 `app.use(authenticate)`，即挂在整个进程的根上）。
  //   "挂根上"在本 Task 之前是无害的 —— 因为静态资源注册在它**之前**，请求先被静态处理器接走了。
  //   本 Task 把静态资源**移到鉴权之后**，于是"挂根上"立刻变成：SPA 壳（`/`）与 `/oss` 都会先撞
  //   `authenticate` ⇒ 匿名访问 `/` 得 **401**、**登录页打不开**（这是本目标"可打开页面"口径的红线）。
  //   挂到 `/api` 之后语义**逐字未变**：`router.ts` 里所有路由都是 `app.use("/api/...")`，
  //   以前是在根上跑一次 `authenticate` 再进 `/api` 分支，现在是在 `/api` 分支上跑一次。
  //   ⚠ 白名单判定**不受影响**：Express 在 `app.use("/api", fn)` 里把 `req.path` 切成**挂载点之后**
  //     的部分（`/api/login/login` → `/login/login`），所以这里必须把前缀传给 `authenticate`
  //     让它拼回全路径再比白名单（`isAuthWhitelisted` 的集合本身**没动**，见 middleware/auth.ts）。
  app.use("/api", (req, res, next) => authenticate(req, res, next, "/api"));

  // ── 以下都是**静态资源**，全部在鉴权之后（spec §6.5）──
  // 三档访问口径必须分清楚（分界依据见各挂载点的注释与 `tools/media-sign.ts` 文件头）：
  //   · `/oss`、`/assets` = **用户媒体/产物** ⇒ 要签名（浏览器）或 Bearer（服务端）；
  //   · `/skills`        = 产品自带的技能图标 ⇒ **保持公开**（spec §6.5 明说可公开，只放行图片扩展名）；
  //   · SPA 壳（web 产物）= **匿名可访问**（否则登录页都打不开）。
  mountStaticAssets(app);

  const router = await import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "API 404 Not Found" });
  });

  // 隔离/策略错误 → 403/500（响应体只有 {code, message}）；认证类错误 → 401/403/409/400（Task 3）；
  // 其它错误原样交给下面的既有处理器。
  // ⚠ 顺序重要：两个处理器都在既有错误中间件**之前**（下面那个不调 `next(err)`，注册在它之后就永远轮不到）。
  app.use(tenantErrorHandler);
  app.use(authErrorHandler);
  // 错误处理（Phase 1c Task 6：统一 `{code,data,message}` + 500 类不回内部文案，见 errorHandler 的文件注释）
  app.use(errorHandler);

  // 非 Electron（纯 Node：dev / 服务器模式）的端口与监听地址一律来自 config（MIWO_PORT / MIWO_HOST）。
  // ⚠ `PORT` 自 Task 9 起**不再被读取**：dev 的 10588 与服务器的 18080 都由 MIWO_PORT 决定。
  // Electron 走 randomPort=true（端口由主进程分配），不受此影响 —— 此时固定绑回环。
  const port = randomPort ? 0 : config.port;
  const bindHost = randomPort ? "127.0.0.1" : config.host;

  // ⚠ 迁移必须在**开始接请求之前**完成（spec §3.3「启动竞态」，Phase 1a / Task 4）。
  //    这里而不是上面：`await import("@/router")` 会加载全部路由模块，但**只加载、不执行**
  //    业务逻辑；真正"开始对外服务"的时刻是下面的 `server.listen`。所以把这道闸门放在它**紧前面**。
  //    （⚠ 刻意不写出上面那次 `await import` 的**行号**：Phase 1c Task 6 在文件头加了几个具名导出，
  //     行号已经漂过两次，写死行号只会制造下一条陈旧陈述。）
  //    `dbReady` 是 `utils/db.ts` 在模块求值时启动的（连接 → 跑迁移），这里只等它 ——
  //    若它失败，`dbReady.catch` 已 process.exit(1)，不会走到 listen。
  //    ⚠ 必须在监听调用的**回调之外** await：写在那个回调里等于端口已经先监听了，
  //    竞态原样保留（这正是本 Task 要修的东西）。
  //    ⚠ 本注释与下面的 await 之间**不要**再写出真正的监听调用字面量：测试
  //    （tests/db-boot-order.test.ts）用 `indexOf` 取那串文本**第一次**出现的位置，
  //    在注释里出现就会把注释当成"真正的监听调用"，断言随之失真。
  await dbReady;

  return await new Promise((resolve) => {
    server.listen(port, bindHost, async () => {
      const address = server.address();
      const realPort = typeof address === "string" ? address : address?.port;
      /**
       * Phase 1d Task 8：**进度 relay 必须在 listen 之后启动**（spec §9.2 / §9.3）。
       *
       * 它做的事：worker（独立进程）只把状态写进 `o_job`，这里用**复合游标 (updatedAt,id)** 轮询
       * "哪些任务变了"，再 `to(\`user:{userId}\`).emit("job:update")`（载荷是白名单，见 progressRelay 文件头）。
       * 放在 listen 回调里（而不是更早）有两个理由：① 端口没起来就轮询没有意义（事件没订阅者）；
       * ② `closeServe()` 里 `relay.stop()` 是**唯一**的清理点 —— 测试里先 listen 再 close 必须能停表，
       * 否则 vitest 会留下活动定时器（实测会挂住进程）。
       *
       * ⚠⚠ **review-C F3（High）**：这里原来直接把**根 `io`** 交给 relay，而 room 是在
       *   `/api/socket/productionAgent` **namespace 内** join 的 ⇒ 真客户端**一条都收不到**。
       *   现在改传 `makeRelayTargetResolver(io)`：把每个事件发给该 room 真正被订阅的 namespace。
       */
      const relay = startProgressRelay({ db: u.db as unknown as Knex, io, targetOf: makeRelayTargetResolver(io), log: (m) => console.log(m) });
      const stopRelay = (): void => {
        relay.stop();
        server.removeListener("close", stopRelay);
      };
      // `close` 是「所有连接都断了」才触发；SIGTERM/SIGINT 是进程退出的入口。两条都挂。
      server.on("close", stopRelay);
      process.once("SIGTERM", stopRelay);
      process.once("SIGINT", stopRelay);
      console.log(`[服务启动成功]: http://localhost:${realPort}`);
      /**
       * 转绘 ASR 自检（M1 原生化）。
       *
       * 预处理不再 spawn 外部 redraw-prep.cjs（那个依赖 hypit + 本机 WhisperX，交付不可用）；
       * 现在解析前的前置步骤都在进程内完成，转写这一步靠本地 faster-whisper（Python 子进程）。
       * 这里只说清"这台机器准备成什么样"：driver=off 时点「开始分析」会在转写阶段失败，
       * 与其让用户看到一个中途失败的任务，不如启动时就说。
       */
      if (config.asr.driver === "off") {
        console.warn("[redraw] MIWO_ASR_DRIVER=off：转绘「开始分析」会在预处理·转写阶段失败（解析需要词级时间戳）");
      } else {
        console.log(`[redraw] ASR 驱动: ${config.asr.driver}（模型 ${config.asr.model} / ${config.asr.compute}）`);
      }
      resolve(realPort);
    });
  });
}

// 支持await关闭
export function closeServe(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (server) {
      server.close((err?: Error) => {
        if (err) return reject(err);
        console.log("[服务已关闭]");
        resolve();
      });
    } else {
      resolve();
    }
  });
}

const isElectron = typeof process.versions?.electron !== "undefined";
if (!isElectron) startServe();