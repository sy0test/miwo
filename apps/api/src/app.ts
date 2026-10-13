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
import path from "path";
import fs from "fs";
import u from "@/utils";
import { dbReady } from "@/utils/db";
import { tenantContextMiddleware, tenantErrorHandler } from "@/middleware/tenant";
import socketInit from "@/socket/index";
import { isEletron } from "@/utils/getPath";
import { ensureThumbnail, ThumbnailSize } from "@/utils/image";
import { config } from "@/config";

const app = express();
const server = http.createServer(app);

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

  await checkPermissions();

  await u.writeVersion();
  const io = new Server(server, { cors: { origin: "*" } });
  socketInit(io);

  expressWs(app);

  app.use(logger("dev"));
  app.use(cors({ origin: "*" }));
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

  // 租户上下文的建立点（spec §6.4）。实现见 src/middleware/tenant.ts：
  // 验签（**库里优先 + config.jwtSecret 兜底**，Phase 1a Task 5 的现状语义）→ 建 ctx（AsyncLocalStorage）
  // → 在同一个 `run()` 里 next()，于是下游所有 handler（含它们内部的 await）都带 ctx。
  // ⚠ 白名单两条路径（登录 / configHealth?summary=1）在验签之前 next()：**天然无 ctx**，不许塞假 ctx。
  // ⚠ 这里是**唯一**一处"还没有 ctx 就要读库"的地方（bootstrap 读 `o_setting.tokenKey`；platform 表
  //    读在守卫里无 ctx 也放行，所以它**不需要**、也**不许**走 `systemDb` 那个绕过口）。
  app.use(tenantContextMiddleware);

  const router = await import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "API 404 Not Found" });
  });

  // 隔离/策略错误 → 403/500（响应体只有 {code, message}）；其它错误原样交给下面的既有处理器。
  // ⚠ 顺序重要：下面的既有错误中间件不调 `next(err)`，本行注册在它**之后**就永远轮不到。
  app.use(tenantErrorHandler);
  // 错误处理
  app.use((err: any, _: Request, res: Response, __: NextFunction) => {
    res.locals.message = err.message;
    res.locals.error = err;
    console.error(err);
    res.status(err.status || 500).send(err);
  });

  // 非 Electron（纯 Node：dev / 服务器模式）的端口与监听地址一律来自 config（MIWO_PORT / MIWO_HOST）。
  // ⚠ `PORT` 自 Task 9 起**不再被读取**：dev 的 10588 与服务器的 18080 都由 MIWO_PORT 决定。
  // Electron 走 randomPort=true（端口由主进程分配），不受此影响 —— 此时固定绑回环。
  const port = randomPort ? 0 : config.port;
  const bindHost = randomPort ? "127.0.0.1" : config.host;

  // ⚠ 迁移必须在**开始接请求之前**完成（spec §3.3「启动竞态」，Phase 1a / Task 4）。
  //    这里而不是上面：`await import("@/router")`（第 178 行）会加载全部路由模块，但**只加载、不执行**
  //    业务逻辑；真正"开始对外服务"的时刻是下面的 `server.listen`。所以把这道闸门放在它**紧前面**。
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
