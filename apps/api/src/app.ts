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
import jwt from "jsonwebtoken";
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

  app.use(async (req, res, next) => {
    // ⚠ JWT 密钥的来源（Phase 1a / Task 5）：**库里优先，配置兜底**。
    //    · 老库（还有 `o_setting.tokenKey` 行）：行为与以前**一字不差** —— 密钥就是那一行；
    //    · 新库（`002_platform_seed` 明确**不种** `tokenKey`，见 spec §6.2 / Phase 1c）：回退到配置
    //      `MIWO_JWT_SECRET`（`config.ts` 强制 >= 32 字节，所以这个兜底永远有值）。
    //    这正是"把 JWT 密钥从数据库搬进配置"那一步的落点。没有兜底的话，**全新安装的库**
    //    会让**所有**请求都 444（连只读的 `configHealth?summary=1` 都到不了白名单）——
    //    而那个 444 不是任何安全控制：不带 token 的受保护接口**仍然是 401**（下面的分支没动）。
    //    证据：`apps/api/scripts/verify-phase0.cjs` 在全新空库上只跑 `db:migrate` 就要求
    //    `configHealth?summary=1` 返回 200 且 `o_setting` 里**没有** tokenKey（两条断言互为约束）。
    const setting = await u.db("o_setting").where("key", "tokenKey").select("value").first();
    const tokenKey = (setting && setting.value) || config.jwtSecret;
    // ⚠⚠ 下面这一行**当前不可达（unreachable）**，保留它是因为 Phase 1c 会把 `tokenKey` 机制整体替换掉，
    //    那时这里的形状会变；现在就删会丢掉"密钥缺失时该怎么办"的意图（444 + 可读文案）。
    //    不可达的**原因**（Task 5 独立审查实测）：`config.ts:160` 是**模块加载期**的
    //    `export const config = loadConfig()`，而 `loadConfig()` 对 `MIWO_JWT_SECRET` 走 `required()` +
    //    "≥ 32 字节"的 fail-fast；本模块第 19 行 `import { config } from "@/config"` 又在任何请求之前。
    //    所以缺密钥时进程**根本起不来**（抛 ConfigError 退出），能走到中间件时 `config.jwtSecret` 恒非空
    //    → `tokenKey` 恒为真串 → 这个 `if` 永不成立。
    //    **不要**为了让它可达去放宽 `config.ts` 的 fail-fast —— 那是削弱安全校验、把 fail-fast 换成运行期 444。
    //    它也不该被断言成"可达分支"：全仓没有、也不应有覆盖 444 的用例（`tests/auth-token-key.test.ts`
    //    覆盖的是它上面那行的**两条密钥优先级路径**，那才是本阶段真正有分叉的逻辑）。
    if (!tokenKey) return res.status(444).send({ message: "服务器秘钥未配置，请联系管理员" });
    // 从 header 或 query 参数获取 token
    const rawToken = req.headers.authorization || (req.query.token as string) || "";
    const token = rawToken.replace("Bearer ", "");
    // 白名单路径
    if (req.path === "/api/login/login") return next();
    // 配置体检（只读）：放行**仅最小信息**的形式（文件数量 + error 计数），
    // 不返回供应商 id / 模型名 / 路径。这样排查"装全没装全"不必先取 token，
    // 而详细信息仍要登录后才能看。见 utils/configHealth.ts
    if (req.path === "/api/other/configHealth" && String(req.query.summary ?? "") === "1") return next();

    if (!token) return res.status(401).send({ message: "未提供token" });
    try {
      const decoded = jwt.verify(token, tokenKey as string);
      (req as any).user = decoded;
      next();
    } catch (err) {
      return res.status(401).send({ message: "无效的token" });
    }
  });

  const router = await import("@/router");
  await router.default(app);

  // 404 处理
  app.use((_, res, next: NextFunction) => {
    return res.status(404).send({ message: "API 404 Not Found" });
  });

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
