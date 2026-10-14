/**
 * Phase 1c Task 4 的**收权矩阵 + 审计 + 特权原语 + L3** 判别力用例。
 *
 * ── 这个文件要钉的五件事（brief Step 4 + 控制器裁定 §2/§4）──
 *   1. **收权矩阵**：spec §7.3 的每条接口 —— 无 token **401** / 普通 token **403** / admin 非 401·403。
 *      逐条参数化（26 条），**不是**"某一条 403 就宣称矩阵通过"；另有一条用例用 `fs` 复核
 *      每个源文件里都真的挂了 `requireAdmin`（防止"用例绿但代码没改"）。
 *   2. **`?token=` 查询串已取消**（裁定 §2.3）：查询串带 token ⇒ **401**；头带 token ⇒ 200。
 *   3. **`loginConfig` 的"本人 + 管理员"语义** + **L3**（改用户名撞唯一键 ⇒ 409，不是 500）。
 *   4. **审计日志真的落库**：直读 `o_auditLog` 断言有对应行（不是只看 API 返回）。
 *      覆盖：登录成功 / 登录失败（账号不存在）/ 锁定 / 登出（令牌吊销）/ 改密 / 邀请码消费 /
 *      以及所有经特权原语（`src/db/noContext.ts`）代行的 platform 写。
 *
 * ⚠ 真路由 + 真中间件链（与 `src/app.ts` 同形状），只监听回环随机端口；
 *   库用 `vitest.config.ts` 的 `MIWO_DATA_DIR`（`D:\tmp\miwo-test-data`，仓库外），
 *   **不碰** `apps/api/data/db2.sqlite`（Ruling 170：用户真实快照永远只读）。
 * ⚠ 账号与用户名都带随机 TAG ⇒ 用例在共享测试库上可重入（不依赖"库是空的"）。
 * ⚠ **admin 令牌用新形状**（`{uid,role,tv,typ}`，由 `signToken` 签、`authenticate` 每请求从 DB
 *   复核 role）而不是旧形状 `{id:1}`：后者走 `roleOfUserId` 的过渡桥接，**只对 id===1 返回 admin**，
 *   在本文件里会得到 role=user ⇒ admin 那一列会静默变成"永远 403"。新形状才是 spec §7.3 的判据。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbReady, systemDb } from "@/utils/db";
import { authenticate, authErrorHandler } from "@/middleware/auth";
import { tenantErrorHandler } from "@/middleware/tenant";
import { AUDIT_ACTIONS } from "@/utils/audit";
import { registerWithInvite } from "@/auth/service";
import { hashPassword } from "@/auth/password";
import { signToken } from "@/auth/tokens";
import { resolveJwtSecret } from "@/auth/secret";

import vendorGetVendorList from "@/routes/setting/vendorConfig/getVendorList";
import vendorAddVendor from "@/routes/setting/vendorConfig/addVendor";
import vendorAddVendorModel from "@/routes/setting/vendorConfig/addVendorModel";
import vendorDeleteVendor from "@/routes/setting/vendorConfig/deleteVendor";
import vendorDelVendorModel from "@/routes/setting/vendorConfig/delVendorModel";
import vendorEnableVendor from "@/routes/setting/vendorConfig/enableVendor";
import vendorGetCodeByLink from "@/routes/setting/vendorConfig/getCodeByLink";
import vendorModelTest from "@/routes/setting/vendorConfig/modelTest";
import vendorUpdateCode from "@/routes/setting/vendorConfig/updateCode";
import vendorUpdateVendorInputs from "@/routes/setting/vendorConfig/updateVendorInputs";
import vendorUpVendorModel from "@/routes/setting/vendorConfig/upVendorModel";
import vendorImageTest from "@/routes/setting/vendorConfig/modelTest/imageTest";
import vendorTextTest from "@/routes/setting/vendorConfig/modelTest/textTest";
import vendorVideoTest from "@/routes/setting/vendorConfig/modelTest/videoTest";
import agentSetKey from "@/routes/setting/agentDeploy/agentSetKey";
import agentDeployAgentModel from "@/routes/setting/agentDeploy/deployAgentModel";
import agentGetAgentDeploy from "@/routes/setting/agentDeploy/getAgentDeploy";
import agentGetAgentUseMode from "@/routes/setting/agentDeploy/getAgentUseMode";
import agentUpdateAgentModel from "@/routes/setting/agentDeploy/updateAgentModel";
import agentUpdateUseMode from "@/routes/setting/agentDeploy/updateUseMode";
import promptUpdatePrompt from "@/routes/setting/promptManage/updatePrompt";
import modelMapSavePrompt from "@/routes/setting/modelMap/savePrompt";
import modelMapUpdatePrompt from "@/routes/setting/modelMap/updatePrompt";
import modelMapDeletePrompt from "@/routes/setting/modelMap/deletePrompt";
import modelMapBindingPrompt from "@/routes/setting/modelMap/bindingPrompt";
import skillSaveSkillContent from "@/routes/setting/skillManagement/saveSkillContent";
import loginConfigGetUser from "@/routes/setting/loginConfig/getUser";
import loginConfigUpdateUserPwd from "@/routes/setting/loginConfig/updateUserPwd";
import authLoginRoute from "@/routes/auth/login";
import authLogoutRoute from "@/routes/auth/logout";

const TAG = `authz${crypto.randomBytes(4).toString("hex")}`;
const PW = "pw-authz-123456";
const USER = `${TAG}_user`;
const ADMIN = `${TAG}_admin`;

const API_ROOT = path.resolve(__dirname, "..");
const createdUsers: string[] = [];
const createdInvites: string[] = [];
let userId = 0;
let adminId = 0;
let userToken = "";
let adminToken = "";
let srv: { port: number; close: () => Promise<void> };

/** 每个用例一个独立客户端 IP（避开注册/登录限流；见 auth-service.test.ts 的同款注释）。 */
let ipSeq = 0;
function nextIp(): string {
  ipSeq += 1;
  return `10.11.${Math.floor(ipSeq / 200)}.${(ipSeq % 200) + 1}`;
}

interface Reply {
  status: number;
  body: any;
  raw: string;
}

function request(
  port: number,
  method: string,
  reqPath: string,
  body?: unknown,
  opts: { token?: string; ip?: string } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: reqPath,
        timeout: 20000,
        headers: {
          ...(opts.token ? { Authorization: opts.token } : {}),
          ...(opts.ip ? { "X-Forwarded-For": opts.ip } : {}),
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          let parsed: any = raw;
          try {
            parsed = JSON.parse(raw);
          } catch {
            /* 保留原文 */
          }
          resolve({ status: res.statusCode || 0, body: parsed, raw });
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const MODEL_TEXT = { type: "text", name: "n", modelName: "m", think: false };

/**
 * §7.3 的收权矩阵（**每一行对应一个源文件**）。
 *
 * ⚠ 清单是手工维护的：新增"只有管理员能打"的接口必须在这里加行，否则这条用例失去覆盖
 *   —— 这正是下面那条"源文件里必须真的有 requireAdmin"的复核要兜住的（防清单与代码反向漂移）。
 * ⚠ 请求体必须**通过 zod**：挂载顺序是 `validateFields` → `requireAdmin`（brief Step 2 的原话），
 *   所以过于离谱的 body 会先吃 400。这里的 body 全部对真实数据无害（假 id / 校验必败的类型）。
 */
const ADMIN_ONLY_ROUTES: ReadonlyArray<{
  source: string;
  method: "GET" | "POST";
  mount: string;
  body?: unknown;
}> = [
  // ---- vendorConfig 整族 13 条 ----
  { source: "src/routes/setting/vendorConfig/getVendorList.ts", method: "POST", mount: "/api/setting/vendorConfig/getVendorList" },
  { source: "src/routes/setting/vendorConfig/addVendor.ts", method: "POST", mount: "/api/setting/vendorConfig/addVendor", body: { tsCode: "export default {}" } },
  { source: "src/routes/setting/vendorConfig/addVendorModel.ts", method: "POST", mount: "/api/setting/vendorConfig/addVendorModel", body: { id: "authz-absent", model: MODEL_TEXT } },
  { source: "src/routes/setting/vendorConfig/deleteVendor.ts", method: "POST", mount: "/api/setting/vendorConfig/deleteVendor", body: { id: "authz-absent" } },
  { source: "src/routes/setting/vendorConfig/delVendorModel.ts", method: "POST", mount: "/api/setting/vendorConfig/delVendorModel", body: { id: "authz-absent", modelName: "m" } },
  { source: "src/routes/setting/vendorConfig/enableVendor.ts", method: "POST", mount: "/api/setting/vendorConfig/enableVendor", body: { id: "authz-absent", enable: 0 } },
  { source: "src/routes/setting/vendorConfig/getCodeByLink.ts", method: "POST", mount: "/api/setting/vendorConfig/getCodeByLink", body: { link: "https://example.invalid/x" } },
  { source: "src/routes/setting/vendorConfig/modelTest.ts", method: "POST", mount: "/api/setting/vendorConfig/modelTest", body: { modelName: "m", type: "text", id: "authz-absent" } },
  { source: "src/routes/setting/vendorConfig/updateCode.ts", method: "POST", mount: "/api/setting/vendorConfig/updateCode", body: { id: "authz-absent", tsCode: "export default {}" } },
  { source: "src/routes/setting/vendorConfig/updateVendorInputs.ts", method: "POST", mount: "/api/setting/vendorConfig/updateVendorInputs", body: { id: "authz-absent", inputValues: { apiKey: "AUTHZ-HACKED-KEY" } } },
  { source: "src/routes/setting/vendorConfig/upVendorModel.ts", method: "POST", mount: "/api/setting/vendorConfig/upVendorModel", body: { id: "authz-absent", modelName: "m", model: MODEL_TEXT } },
  { source: "src/routes/setting/vendorConfig/modelTest/imageTest.ts", method: "POST", mount: "/api/setting/vendorConfig/modelTest/imageTest", body: { modelName: "m", id: "authz-absent", prompt: "p", imageBase64: "" } },
  { source: "src/routes/setting/vendorConfig/modelTest/textTest.ts", method: "POST", mount: "/api/setting/vendorConfig/modelTest/textTest", body: { modelName: "m", id: "authz-absent", messages: [] } },
  { source: "src/routes/setting/vendorConfig/modelTest/videoTest.ts", method: "POST", mount: "/api/setting/vendorConfig/modelTest/videoTest", body: { modelName: "m", id: "authz-absent", mode: "singleImage", prompt: "p", videos: [], audios: [], images: [] } },
  // ---- agentDeploy 整族 6 条（Phase 1b 收尾轮已收权，一并纳入矩阵防回退）----
  { source: "src/routes/setting/agentDeploy/agentSetKey.ts", method: "POST", mount: "/api/setting/agentDeploy/agentSetKey", body: { key: "" } },
  { source: "src/routes/setting/agentDeploy/deployAgentModel.ts", method: "POST", mount: "/api/setting/agentDeploy/deployAgentModel", body: { items: [] } },
  { source: "src/routes/setting/agentDeploy/getAgentDeploy.ts", method: "POST", mount: "/api/setting/agentDeploy/getAgentDeploy" },
  { source: "src/routes/setting/agentDeploy/getAgentUseMode.ts", method: "GET", mount: "/api/setting/agentDeploy/getAgentUseMode" },
  { source: "src/routes/setting/agentDeploy/updateAgentModel.ts", method: "POST", mount: "/api/setting/agentDeploy/updateAgentModel", body: { id: 1, name: "x", model: "y" } },
  { source: "src/routes/setting/agentDeploy/updateUseMode.ts", method: "POST", mount: "/api/setting/agentDeploy/updateUseMode", body: { agentUseMode: "999" } },
  // ---- 提示词 / 模型绑定 / 技能（平台资产）----
  { source: "src/routes/setting/promptManage/updatePrompt.ts", method: "POST", mount: "/api/setting/promptManage/updatePrompt", body: { id: 999999, data: "AUTHZ-HACKED" } },
  { source: "src/routes/setting/modelMap/savePrompt.ts", method: "POST", mount: "/api/setting/modelMap/savePrompt", body: { name: "authz-fixture", data: "AUTHZ-HACKED", type: "image" } },
  { source: "src/routes/setting/modelMap/updatePrompt.ts", method: "POST", mount: "/api/setting/modelMap/updatePrompt", body: { name: "authz-fixture", data: "AUTHZ-HACKED", type: "image" } },
  { source: "src/routes/setting/modelMap/deletePrompt.ts", method: "POST", mount: "/api/setting/modelMap/deletePrompt", body: { path: "authz-fixture.md" } },
  { source: "src/routes/setting/modelMap/bindingPrompt.ts", method: "POST", mount: "/api/setting/modelMap/bindingPrompt", body: { vendorId: "authz-absent", model: "m", path: "p", fileName: "f" } },
  { source: "src/routes/setting/skillManagement/saveSkillContent.ts", method: "POST", mount: "/api/setting/skillManagement/saveSkillContent", body: { path: "authz-fixture.md", content: "AUTHZ-HACKED" } },
];

/** 与 `src/app.ts` 同形状的中间件链（真路由 + 真中间件）。 */
async function serve() {
  const app = express();
  app.set("trust proxy", true);
  app.use(express.json());
  app.use(authenticate);
  app.use("/api/setting/vendorConfig/getVendorList", vendorGetVendorList);
  app.use("/api/setting/vendorConfig/addVendor", vendorAddVendor);
  app.use("/api/setting/vendorConfig/addVendorModel", vendorAddVendorModel);
  app.use("/api/setting/vendorConfig/deleteVendor", vendorDeleteVendor);
  app.use("/api/setting/vendorConfig/delVendorModel", vendorDelVendorModel);
  app.use("/api/setting/vendorConfig/enableVendor", vendorEnableVendor);
  app.use("/api/setting/vendorConfig/getCodeByLink", vendorGetCodeByLink);
  app.use("/api/setting/vendorConfig/modelTest", vendorModelTest);
  app.use("/api/setting/vendorConfig/updateCode", vendorUpdateCode);
  app.use("/api/setting/vendorConfig/updateVendorInputs", vendorUpdateVendorInputs);
  app.use("/api/setting/vendorConfig/upVendorModel", vendorUpVendorModel);
  app.use("/api/setting/vendorConfig/modelTest/imageTest", vendorImageTest);
  app.use("/api/setting/vendorConfig/modelTest/textTest", vendorTextTest);
  app.use("/api/setting/vendorConfig/modelTest/videoTest", vendorVideoTest);
  app.use("/api/setting/agentDeploy/agentSetKey", agentSetKey);
  app.use("/api/setting/agentDeploy/deployAgentModel", agentDeployAgentModel);
  app.use("/api/setting/agentDeploy/getAgentDeploy", agentGetAgentDeploy);
  app.use("/api/setting/agentDeploy/getAgentUseMode", agentGetAgentUseMode);
  app.use("/api/setting/agentDeploy/updateAgentModel", agentUpdateAgentModel);
  app.use("/api/setting/agentDeploy/updateUseMode", agentUpdateUseMode);
  app.use("/api/setting/promptManage/updatePrompt", promptUpdatePrompt);
  app.use("/api/setting/modelMap/savePrompt", modelMapSavePrompt);
  app.use("/api/setting/modelMap/updatePrompt", modelMapUpdatePrompt);
  app.use("/api/setting/modelMap/deletePrompt", modelMapDeletePrompt);
  app.use("/api/setting/modelMap/bindingPrompt", modelMapBindingPrompt);
  app.use("/api/setting/skillManagement/saveSkillContent", skillSaveSkillContent);
  app.use("/api/setting/loginConfig/getUser", loginConfigGetUser);
  app.use("/api/setting/loginConfig/updateUserPwd", loginConfigUpdateUserPwd);
  // 真登录/登出路由（本文件要产真令牌，并验证登出的令牌吊销审计）
  app.use("/api/auth/login", authLoginRoute);
  app.use("/api/auth/logout", authLogoutRoute);
  // 受保护接口替身：**只有**带 ctx 才答 200（`?token=` 用例要用它证明"真能通"）
  app.get("/api/project/ping", (_req, res) => res.status(200).send({ code: 200, data: "pong", message: "pong" }));
  app.use(tenantErrorHandler);
  app.use(authErrorHandler);
  app.use((err: any, _req: any, res: any, _next: any) => res.status(err?.status || 500).send({ message: err?.message }));
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { port: (server.address() as any).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

async function auditRows(action: string, target: string): Promise<any[]> {
  return systemDb("o_auditLog").where({ action, target }).orderBy("id", "desc");
}

/**
 * 现造一条**当前有效**的新形状 access 令牌（不经过登录接口 ⇒ 不受"上一个用例把口令改了 /
 * 把 tokenVersion++ 了"的影响）。
 *
 * ⚠ 为什么需要它：`changePassword`/`updateUserPwd` 都会 `tokenVersion++` ⇒ 之前拿到的令牌
 *   **立刻失效**（这正是 spec §7.2 要的行为）。用例之间如果不重新造令牌，"前一个用例把口令改了"
 *   会以"401 登录状态已失效"的形式**污染后面所有用例**（第一版就是这么红的，而报错指向完全无关的地方）。
 */
async function freshToken(username: string): Promise<string> {
  const row: any = await systemDb("o_user").where("username", username).first();
  expect(row, `前置：${username} 行必须存在`).toBeTruthy();
  const secret = await resolveJwtSecret();
  const role = row.role === "admin" ? "admin" : "user";
  return `Bearer ${signToken({ uid: Number(row.id), role, tv: Number(row.tokenVersion ?? 0), typ: "access" }, secret)}`;
}

beforeAll(async () => {
  await dbReady;
  // ① 普通用户：走**真注册流程**（同一条链路上产生的审计行也顺便被覆盖）。
  //    注册方式钉成 invite（005_accounts 的默认值）并自造邀请码 —— 不依赖共享测试库的当前开关。
  await systemDb("o_setting").insert({ key: "registrationMode", value: "invite" }).onConflict("key").merge();
  const bootstrapInvite = `${TAG}_bootstrap`;
  await systemDb("o_invite").insert({ code: bootstrapInvite, createdBy: 1, maxUses: 5, usedCount: 0, expiresAt: null, disabled: 0, createdAt: Date.now() });
  createdInvites.push(bootstrapInvite);
  const user = await registerWithInvite({ username: USER, password: PW, inviteCode: bootstrapInvite, ip: nextIp() });
  userId = user.id;
  createdUsers.push(USER);

  // ② 管理员：直接建行（与 bootstrap 管理员流程同义）—— 角色只信 DB（spec §7.3）
  await systemDb("o_user").insert({
    username: ADMIN,
    email: null,
    passwordHash: await hashPassword(PW),
    role: "admin",
    status: "active",
    tokenVersion: 0,
    mustChangePassword: 0,
    createdAt: Date.now(),
    lastLoginAt: null,
  });
  createdUsers.push(ADMIN);
  const adminRow: any = await systemDb("o_user").where("username", ADMIN).first();
  adminId = Number(adminRow.id);

  srv = await serve();

  // ③ 两个令牌：普通用户走真登录；管理员走 `signToken`（新形状 = 生产路径；
  //    旧形状 `{id:N}` 会被 roleOfUserId 判成 user，N≠1 时 admin 那一列永远 403 ⇒ 假红）
  const login = await request(srv.port, "POST", "/api/auth/login", { username: USER, password: PW }, { ip: nextIp() });
  expect(login.status, `普通用户登录必须 200：${login.raw.slice(0, 200)}`).toBe(200);
  userToken = String(login.body?.data?.token ?? "");
  const secret = await resolveJwtSecret();
  adminToken = `Bearer ${signToken({ uid: adminId, role: "admin", tv: Number(adminRow.tokenVersion ?? 0), typ: "access" }, secret)}`;
  expect(userToken.startsWith("Bearer ")).toBe(true);
  // 前置（防假绿）：普通令牌必须**不是** admin，admin 令牌必须**是** admin
  const pingUser = await request(srv.port, "GET", "/api/setting/agentDeploy/getAgentUseMode", undefined, { token: userToken });
  expect(pingUser.status, "前置：普通令牌打 admin-only 接口必须 403（否则矩阵那一列无从判断）").toBe(403);
  const pingAdmin = await request(srv.port, "GET", "/api/setting/agentDeploy/getAgentUseMode", undefined, { token: adminToken });
  expect(pingAdmin.status, "前置：admin 令牌必须真的被认成 admin（200）").toBe(200);
}, 180000);

afterAll(async () => {
  await srv?.close();
  if (createdInvites.length) await systemDb("o_invite").whereIn("code", createdInvites).del();
  if (createdUsers.length) await systemDb("o_user").whereIn("username", createdUsers).del();
  await systemDb("o_auditLog").whereIn("target", [USER, ADMIN]).del();
  await systemDb("o_auditLog").where("target", "like", `o_invite:%`).where("detail", "like", `%${TAG}%`).del().catch(() => {});
  await systemDb("o_loginAttempt").whereLike("username", `${TAG}%`).del();
});

describe("§7.3 收权矩阵（无 token 401 / 普通 token 403 / admin 非 401·403）", () => {
  it("★ 每条接口三列逐条断言（26 条，失败时列出全部不满足项）", async () => {
    const failures: string[] = [];
    for (const row of ADMIN_ONLY_ROUTES) {
      const noToken = await request(srv.port, row.method, row.mount, row.body, { ip: nextIp() });
      if (noToken.status !== 401) failures.push(`${row.mount} 无 token 期望 401，实际 ${noToken.status}：${noToken.raw.slice(0, 160)}`);
      const asUser = await request(srv.port, row.method, row.mount, row.body, { token: userToken, ip: nextIp() });
      if (asUser.status !== 403) failures.push(`${row.mount} 普通 token 期望 403，实际 ${asUser.status}：${asUser.raw.slice(0, 160)}`);
      const asAdmin = await request(srv.port, row.method, row.mount, row.body, { token: adminToken, ip: nextIp() });
      if (asAdmin.status === 401 || asAdmin.status === 403) {
        failures.push(`${row.mount} admin 期望非 401/403（200/400/500 都算"收权生效但业务另有判断"），实际 ${asAdmin.status}：${asAdmin.raw.slice(0, 160)}`);
      }
    }
    expect(failures, `收权矩阵有 ${failures.length} 条不满足：\n  - ${failures.join("\n  - ")}`).toEqual([]);
    expect(ADMIN_ONLY_ROUTES.length, "矩阵条数（防清单被误删）").toBe(26);
  }, 240000);

  it("★ 矩阵清单与源码一致：每个源文件都真的挂了 requireAdmin（防'用例绿但代码没改'）", () => {
    const missing: string[] = [];
    for (const row of ADMIN_ONLY_ROUTES) {
      const abs = path.join(API_ROOT, row.source);
      expect(fs.existsSync(abs), `${row.source} 必须存在（矩阵清单指向真实文件）`).toBe(true);
      if (!/\brequireAdmin\b/.test(fs.readFileSync(abs, "utf8"))) missing.push(row.source);
    }
    expect(missing, `以下源文件没有 requireAdmin：\n  - ${missing.join("\n  - ")}`).toEqual([]);
  });
});

describe("令牌载体：查询串形态已取消（控制器裁定 §2.3）", () => {
  it("★ `?token=` ⇒ 401（token 不许进 URL / 访问日志 / Referer）；同一条令牌放 Authorization 头 ⇒ 200", async () => {
    // 前置：这条令牌在**头**里是有效的（否则下面的 401 可能只是"令牌本来就没用"）
    const viaHeader = await request(srv.port, "GET", "/api/project/ping", undefined, { token: userToken });
    expect(viaHeader.status, "同一令牌走 Authorization 头必须 200").toBe(200);

    const bare = userToken.replace(/^Bearer\s+/i, "");
    const viaQuery = await request(srv.port, "GET", `/api/project/ping?token=${encodeURIComponent(bare)}`, undefined, { ip: nextIp() });
    expect(viaQuery.status, `查询串带 token 必须 401，实际 ${viaQuery.status}：${viaQuery.raw.slice(0, 200)}`).toBe(401);
    expect(viaQuery.raw).toMatch(/未提供token|无效的token/);

    // 整段 "Bearer xxx" 塞进查询串（有人会这么写）也必须 401
    const viaQueryBeat = await request(srv.port, "GET", `/api/project/ping?token=${encodeURIComponent(userToken)}`, undefined, { ip: nextIp() });
    expect(viaQueryBeat.status, "查询串带 'Bearer xxx' 也必须 401").toBe(401);
  }, 60000);
});

describe("loginConfig：本人 + 管理员（含 L3 唯一性预检）", () => {
  it("getUser：无参 ⇒ 本人（不含 passwordHash）；`?id=别人` 普通用户 403 / admin 200", async () => {
    const self = await request(srv.port, "GET", "/api/setting/loginConfig/getUser", undefined, { token: userToken });
    expect(self.status, `本人读自己必须 200：${self.raw.slice(0, 200)}`).toBe(200);
    expect(self.body?.data?.name).toBe(USER);
    expect(self.raw, "绝不能回 passwordHash").not.toContain("passwordHash");

    const other = await request(srv.port, "GET", `/api/setting/loginConfig/getUser?id=${adminId}`, undefined, { token: userToken });
    expect(other.status, `普通用户查别人必须 403，实际 ${other.status}`).toBe(403);

    const adminReads = await request(srv.port, "GET", `/api/setting/loginConfig/getUser?id=${adminId}`, undefined, { token: adminToken });
    expect(adminReads.status, `admin 查别人必须 200：${adminReads.raw.slice(0, 200)}`).toBe(200);
    expect(adminReads.body?.data?.name).toBe(ADMIN);
    expect(adminReads.raw).not.toContain("passwordHash");
  }, 60000);

  it("★ L3：改用户名撞唯一键 ⇒ 409（不是 500、不回显约束名），且原行没被改 + 有审计", async () => {
    const row: any = await systemDb("o_user").where("username", USER).first();
    expect(row, "前置：USER 行必须存在").toBeTruthy();
    const res = await request(
      srv.port,
      "POST",
      "/api/setting/loginConfig/updateUserPwd",
      { id: Number(row.id), name: ADMIN },
      { token: userToken, ip: nextIp() },
    );
    expect(res.status, `撞唯一键必须 409，实际 ${res.status}：${res.raw.slice(0, 240)}`).toBe(409);
    expect(res.raw, "不得回显数据库约束名").not.toMatch(/UNIQUE|constraint/i);
    const after: any = await systemDb("o_user").where("id", Number(row.id)).first();
    expect(String(after.username), "被拒的改名必须零副作用").toBe(USER);
    const rows = await auditRows(AUDIT_ACTIONS.USER_PROFILE_UPDATE, `o_user:${Number(row.id)}`);
    expect(rows.some((r) => String(r.detail ?? "").includes("username-taken")), "被拒的改名必须落审计").toBe(true);
  }, 60000);

  it("本人改口令（旧口令）⇒ 200 + tokenVersion++ + 审计；普通用户改他人 ⇒ 403", async () => {
    const row: any = await systemDb("o_user").where("username", USER).first();
    const newPw = `${PW}-new`;
    try {
      const selfToken0 = await freshToken(USER); // ≈ 矩阵用过的同一条令牌（口令变更前有效）
      const other = await request(
        srv.port,
        "POST",
        "/api/setting/loginConfig/updateUserPwd",
        { id: adminId, name: ADMIN, password: "whatever-123456" },
        { token: selfToken0, ip: nextIp() },
      );
      expect(other.status, `普通用户改他人必须 403，实际 ${other.status}`).toBe(403);

      const tvBefore = Number(((await systemDb("o_user").where("id", Number(row.id)).first()) as any)?.tokenVersion ?? 0);
      const self = await request(
        srv.port,
        "POST",
        "/api/setting/loginConfig/updateUserPwd",
        { id: Number(row.id), name: USER, password: newPw, oldPassword: PW },
        { token: selfToken0, ip: nextIp() },
      );
      expect(self.status, `本人改口令必须 200：${self.raw.slice(0, 240)}`).toBe(200);
      const after: any = await systemDb("o_user").where("id", Number(row.id)).first();
      expect(Number(after.tokenVersion), "改密必须 tokenVersion++（旧令牌立即失效）").toBe(tvBefore + 1);
      expect(String(after.username)).toBe(USER);
      expect(String(after.passwordHash), "口令绝不能明文落库").not.toContain(newPw);
      // ⚠ `tokenVersion++` 的**行为证据**：旧令牌立刻 401（"旧令牌立即失效"不是文档，是实测）
      const stale = await request(srv.port, "GET", "/api/setting/loginConfig/getUser", undefined, { token: selfToken0 });
      expect(stale.status, "改密之后旧令牌必须立刻 401").toBe(401);

      const pwdRows = await auditRows(AUDIT_ACTIONS.PASSWORD_CHANGE, USER);
      expect(pwdRows.length, "改密必须落审计").toBeGreaterThanOrEqual(1);
      const writeRows = await auditRows(AUDIT_ACTIONS.PLATFORM_WRITE, `o_user:${Number(row.id)}`);
      expect(writeRows.some((r) => String(r.detail ?? "").includes("loginConfig.updateUserPwd")), "经特权原语代行的写必须落审计").toBe(true);
    } finally {
      // 恢复原口令（**用新令牌**：刚才的 selfToken0 已随 tokenVersion++ 失效）—— 不让失败/成功
      // 的中间态泄漏到后面所有用例（第一版就是漏了这一步，后面全变成"401 登录状态已失效"）。
      const rowNow: any = await systemDb("o_user").where("id", Number(row.id)).first();
      if (rowNow) {
        const tokenNow = await freshToken(USER);
        const back = await request(
          srv.port,
          "POST",
          "/api/setting/loginConfig/updateUserPwd",
          { id: Number(row.id), name: USER, password: PW, oldPassword: newPw },
          { token: tokenNow, ip: nextIp() },
        );
        expect(back.status, `改回原口令必须 200：${back.raw.slice(0, 200)}`).toBe(200);
        userToken = await freshToken(USER);
      }
    }
  }, 90000);

  it("旧口令给错 ⇒ 400 且口令没变（“给了就必须对”这条判据的判别力）", async () => {
    // 现造令牌：不依赖上一个用例是否把 tokenVersion 推进过
    const token = await freshToken(USER);
    const row: any = await systemDb("o_user").where("username", USER).first();
    const hashBefore = String(row.passwordHash ?? "");
    const res = await request(
      srv.port,
      "POST",
      "/api/setting/loginConfig/updateUserPwd",
      { id: Number(row.id), name: USER, password: "brand-new-pw-123456", oldPassword: "definitely-wrong" },
      { token, ip: nextIp() },
    );
    expect(res.status, `旧口令错必须 400，实际 ${res.status}：${res.raw.slice(0, 200)}`).toBe(400);
    const after: any = await systemDb("o_user").where("id", Number(row.id)).first();
    expect(String(after.passwordHash), "被拒的改密必须零副作用").toBe(hashBefore);
    const rows = await auditRows(AUDIT_ACTIONS.USER_PROFILE_UPDATE, `o_user:${Number(row.id)}`);
    expect(rows.some((r) => String(r.detail ?? "").includes("old-password-wrong")), "被拒的改密必须落审计").toBe(true);
  }, 60000);
});

describe("审计日志真的落库（直读 o_auditLog，不是只看 API 返回）", () => {
  it("★ 登录成功 / 登录失败（账号不存在）/ 锁定 ⇒ 各有对应的审计行", async () => {
    // ① 成功
    const ok = await request(srv.port, "POST", "/api/auth/login", { username: USER, password: PW }, { ip: nextIp() });
    expect(ok.status, `登录必须 200：${ok.raw.slice(0, 200)}`).toBe(200);
    expect((await auditRows(AUDIT_ACTIONS.LOGIN_SUCCESS, USER)).length, "成功登录必须落 auth.login.success").toBeGreaterThanOrEqual(1);

    // ② 失败（账号不存在）：用带 TAG 的不存在用户名，避免污染别人的锁定计数
    const ghost = `${TAG}_ghost`;
    const bad = await request(srv.port, "POST", "/api/auth/login", { username: ghost, password: "wrong-pw-123456" }, { ip: nextIp() });
    expect(bad.status).toBe(401);
    const failRows = await auditRows(AUDIT_ACTIONS.LOGIN_FAIL, ghost);
    expect(failRows.length, "失败登录必须落 auth.login.fail").toBeGreaterThanOrEqual(1);
    expect(String(failRows[0]?.detail ?? ""), "失败原因要可判别（账号不存在）").toContain("no-such-user");

    // ③ 锁定：连错 5 次之后的第 6 次必须落 auth.login.locked，且 o_loginAttempt 真的有 lockedUntil
    const lockUser = `${TAG}_lock`;
    await systemDb("o_user").insert({
      username: lockUser, email: null, passwordHash: await hashPassword(PW),
      role: "user", status: "active", tokenVersion: 0, mustChangePassword: 0, createdAt: Date.now(), lastLoginAt: null,
    });
    createdUsers.push(lockUser);
    const lockIp = nextIp();
    for (let i = 0; i < 5; i += 1) {
      await request(srv.port, "POST", "/api/auth/login", { username: lockUser, password: `wrong-${i}` }, { ip: lockIp });
    }
    const locked = await request(srv.port, "POST", "/api/auth/login", { username: lockUser, password: PW }, { ip: lockIp });
    expect(locked.status, "锁定期内正确口令也必须 401").toBe(401);
    expect((await auditRows(AUDIT_ACTIONS.LOGIN_LOCKED, lockUser)).length, "触发锁定必须落 auth.login.locked").toBeGreaterThanOrEqual(1);
    const attempt: any = await systemDb("o_loginAttempt").where({ username: lockUser, ip: lockIp }).first();
    expect(Number(attempt?.lockedUntil), "锁定行也必须在库里（审计不是替代品）").toBeGreaterThan(Date.now() - 60_000);
  }, 180000);

  it("★ 登出（令牌吊销）与邀请码消费 ⇒ 各有对应的审计行（且审计不抄邀请码）", async () => {
    // ① 登出：为这个用例单独登录一次（登出会把 tokenVersion++，不污染矩阵用的令牌）
    const login = await request(srv.port, "POST", "/api/auth/login", { username: USER, password: PW }, { ip: nextIp() });
    expect(login.status).toBe(200);
    const token = String(login.body?.data?.token ?? "");
    const out = await request(srv.port, "POST", "/api/auth/logout", undefined, { token });
    expect(out.status, `登出必须 200：${out.raw.slice(0, 200)}`).toBe(200);
    expect((await auditRows(AUDIT_ACTIONS.LOGOUT, USER)).length, "登出必须落 auth.logout（令牌吊销）").toBeGreaterThanOrEqual(1);

    // ② 邀请码消费：注册一个新用户（走 service，邀请码由本文件自造）
    const inviteCode = `${TAG}_invite_${crypto.randomBytes(3).toString("hex")}`;
    const newUser = `${TAG}_invited_${crypto.randomBytes(3).toString("hex")}`;
    await systemDb("o_invite").insert({ code: inviteCode, createdBy: 1, maxUses: 1, usedCount: 0, expiresAt: null, disabled: 0, createdAt: Date.now() });
    createdInvites.push(inviteCode);
    createdUsers.push(newUser);
    const created = await registerWithInvite({ username: newUser, password: PW, inviteCode, ip: nextIp() });
    const inviteRow: any = await systemDb("o_invite").where("code", inviteCode).first();
    const consumeRows = await auditRows(AUDIT_ACTIONS.INVITE_CONSUMED, `o_invite:${Number(inviteRow.id)}`);
    expect(consumeRows.length, "邀请码消费必须落 auth.invite.consume").toBeGreaterThanOrEqual(1);
    // ⚠ 邀请码的**码本身**绝不能出现在审计里（它等于开通权限）
    expect(String(consumeRows[0]?.detail ?? ""), "审计不得抄一份邀请码").not.toContain(inviteCode);
    expect(String(consumeRows[0]?.target ?? "")).not.toContain(inviteCode);

    // ③ 注册的 platform 写也要有审计行
    const writeRows = await auditRows(AUDIT_ACTIONS.PLATFORM_WRITE, `o_user:${created.id}`);
    expect(writeRows.some((r) => String(r.detail ?? "").includes("register.createUser")), "注册建号必须落 platform.write").toBe(true);
  }, 90000);
});
