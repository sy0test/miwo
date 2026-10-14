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
import u from "@/utils";
import { dbReady } from "@/utils/db";
import { tenantErrorHandler } from "@/middleware/tenant";
import { authenticate, authErrorHandler } from "@/middleware/auth";
import { apiLimiter } from "@/middleware/rateLimit";
import socketInit from "@/socket/index";
import { isEletron } from "@/utils/getPath";
import { ensureThumbnail, ThumbnailSize } from "@/utils/image";
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

  app.use(logger("dev"));
  // ⚠ 安全头（helmet）+ CORS 必须在**静态资源之前**（否则 `/oss` 的图片响应不带 CORP 头，
  //   而那条放宽正是为了让 dev 的跨源图片能显示）。见 applySecurityHeaders 的文件注释。
  applySecurityHeaders(app);
  app.use(express.json({ limit: "100mb" }));
  app.use(express.urlencoded({ extended: true, limit: "100mb" }));

  // oss 静态资源
  const ossDir = u.getPath("oss");
  if (!fs.existsSync(ossDir)) {
    fs.mkdirSync(ossDir, { recursive: true });
  }
  console.log("文件目录:", ossDir);
  app.use(
    "/oss",
    (req, res, next) => {
      // 如果传参 type=small，则返回小图
      if (req.query.size) {
        const size = req.query.size as string;
        const smallImageBaseDir = path.join(ossDir, "smallImage");
        const originalPath = path.join(ossDir, req.path);

        // 解析 size 参数
        let sizeSubDir: string;
        let sizeOpts: ThumbnailSize | undefined;

        // 判断是否为 WIDTHxHEIGHT 格式，如 "200x300"：等比压缩到指定宽高边界
        const dimensMatch = size.match(/^(\d+)x(\d+)$/i);
        // 判断是否为百分比格式，如 "30"、"30%"：等比压缩到原图的指定百分比
        const percentMatch = size.match(/^(\d+(?:\.\d+)?)\s*%?$/);

        if (dimensMatch) {
          const w = parseInt(dimensMatch[1], 10);
          const h = parseInt(dimensMatch[2], 10);
          sizeSubDir = `${w}x${h}`;
          sizeOpts = { type: "dimensions", width: w, height: h };
        } else if (percentMatch) {
          const pct = parseFloat(percentMatch[1]);
          sizeSubDir = `${percentMatch[1]}p`;
          sizeOpts = { type: "percentage", value: pct };
        } else {
          // 无效的 size 参数，降级返回原图
          express.static(ossDir, { acceptRanges: false })(req, res, next);
          return;
        }

        const ext = path.extname(req.path);
        const base = path.basename(req.path, ext);
        const dir = path.dirname(req.path);
        const smallImagePath = path.join(smallImageBaseDir, dir, `${base}_${sizeSubDir}${ext}`);

        ensureThumbnail(originalPath, smallImagePath, sizeOpts).then((thumbnailPath) => {
          if (thumbnailPath) {
            res.sendFile(thumbnailPath);
          } else {
            // 缩略图生成失败，降级返回原图
            express.static(ossDir, { acceptRanges: false })(req, res, next);
          }
        });
        return;
      }
      next();
    },
    express.static(ossDir, { acceptRanges: false }),
  );
  // skills 静态资源
  const skillsDir = u.getPath("skills");
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }
  console.log("文件目录:", skillsDir);
  // 只允许图片文件访问
  app.use(
    "/skills",
    (req, res, next) => {
      /\.(jpe?g|png|gif|webp|svg|ico|bmp)$/i.test(req.path) ? next() : res.status(403).end();
    },
    express.static(skillsDir, { acceptRanges: false }),
  );

  // assets 静态资源
  const assetsDir = u.getPath("assets");
  if (!fs.existsSync(assetsDir)) {
    fs.mkdirSync(assetsDir, { recursive: true });
  }
  console.log("文件目录:", assetsDir);
  app.use("/assets", express.static(assetsDir, { acceptRanges: false }));

  // data/web 静态网站
  const webDir = u.getPath("web");
  if (fs.existsSync(webDir)) {
    console.log("静态网站目录:", webDir);
    app.use(express.static(webDir, { acceptRanges: false }));
  } else {
    console.warn("静态网站目录不存在:", webDir);
  }

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
  app.use(authenticate);

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
      console.log(`[服务启动成功]: http://localhost:${realPort}`);
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
