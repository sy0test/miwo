/**
 * 媒体短时签名（spec §6.5 第 3/5/6 条）。Phase 1c Task 7。
 *
 * ── 为什么必须有签名，才能把静态目录移到鉴权之后 ──
 * `/oss/xxx.jpg` 是**浏览器自己发起的请求**（`<img src>` / `<video src>` / CSS 背景），
 * 它**不会带 `Authorization` 头**。所以"移到鉴权之后"不能等于"要 Bearer"，
 * 否则页面上的图全裂（症状与"接口全正常但一张图都没有"完全一样）。
 * 签名因此放在 query 串里：`/oss/a/b.jpg?exp=<ms>&sig=<base64url>`，
 * 由**已经过鉴权的接口**（如 `GET /api/production/workbench/getFileUrl`）在请求期生成。
 *
 * ── 域分离（裁定 §2.2：**不复用 JWT 密钥**）──
 * 签名密钥 = `HMAC-SHA256(key="miwo:media-sign:v1", msg=config.jwtSecret)`。
 *   · 它与 `@/auth/secret` 的 JWT 密钥**不是同一把**：拿 JWT 的签名去当媒体签名（或反过来）必然对不上；
 *     JWT 侧换的是 `o_setting.jwtSecret`/`tokenKey`（每请求现读），媒体侧换的是 `MIWO_JWT_SECRET`；
 *   · 代价是"运维只轮换库里的 JWT 密钥"**不会**让媒体签名跟着换（反之亦然）——这是**刻意的**：
 *     媒体签名要走**每个 `<img>` 一次**的验签热路径，去 DB 现读密钥等于给每张图加一次查询；
 *     而 `config.jwtSecret`（`MIWO_JWT_SECRET`，config.ts 已 fail-fast 校验 ≥32 字节）恒有值且是强随机量。
 *     **操作含义（写进报告）**：轮换 `MIWO_JWT_SECRET` ⇒ ① 全员 JWT 失效 ② 已发出的媒体链接立即失效
 *     （两者都是"已登录会话全断"级别的动作，本就该一起做）；只轮换库里的 `jwtSecret` 行 ⇒ JWT 断、媒体链接
 *     在 TTL 内仍可用（它们本来就只对**一个**相对路径有效，且最长 24h）。
 *   · 若要换成独立的媒体密钥（`o_setting.mediaSecret` 之类），必须新增一个"未认证也要读/写 platform 表"
 *     的路径 ⇒ 那要重走 `runAsAuth` 登记（`tools/check-authenticated-writers.cjs` 的精确集合门禁）。
 *     本任务**不新增** storage/密钥行，所以那条门禁的集合原样不变。
 *
 * ── 被签的内容必须包含什么（少一样就是一个漏洞）──
 *   `miwo:media:<相对路径>|<exp>`：
 *   · **必须含相对路径**：否则 A 的签名能拼到 B 的文件上（越权访问他人媒体 = 1b-11 的原始漏洞换个形态）；
 *   · **必须含 exp**：否则改 `exp` 就能把签名无限续命（签名对 exp 无约束 = 永不过期）；
 *   · 域名前缀 `miwo:media:` 是**域分离的第二道**：即使将来有人把 JWT 的签名函数改成同构形状，
 *     两边算出来的串也不同。
 * ⚠ 相对路径在**签名与验签两侧都要归一**（去掉前导斜杠、`\` → `/`）：`/oss/a/b.jpg` 这类请求
 *   在 Express 里 `req.path` 与 `getFileUrl` 得到的形态不同，不归一就会出现"自己签的自己验不过"。
 *
 * ── 实测确认的关键前提：签名 URL **不会被持久化** ──
 * DB 里存的是**相对路径**（`cutSource.ts` 写 `clipRel`、`uploadSource.ts` 写 `coverRel`、
 * `addArtStyle.ts` 写 `imagePath`），所有 `getFileUrl` / `getSmallImageUrl` 调用都发生在**请求期**，
 * 返回的是响应体里的一个字段。⇒ TTL 到期不会让任何历史数据失效（没有历史数据里存着签名）。
 * `apps/api/tests/media-sign.test.ts` 有一条静态断言把这条钉住：**路由里不许把 `getFileUrl` 的返回值
 * 写进 `insert`/`update`**。
 *
 * ── 过期语义与缓存语义的共存（spec §6.5 第 6 条）──
 * 守卫（`mediaAuthGuard`）在 **`express.static` 之前**：所以
 *   · 过期/篡改/无签名 ⇒ **403**，**不**会走 `If-None-Match` 的 304 分支（缓存不能绕过过期）；
 *   · 合法签名 ⇒ `Cache-Control: public, max-age=3600` + 强 `ETag`，浏览器在 1h 内可 304 复用；
 *   · 因为 URL 里有 `exp`/`sig`，**同一份文件在不同请求期拿到的是不同 URL** ⇒ 浏览器缓存按完整 URL 分键，
 *     不会出现"缓存里那把过期的签名被复用"⇒ 这是"签名 TTL(24h) 与缓存 max-age(1h)"能共存的依据：
 *     max-age 必须 **< TTL**，否则缓存里可能留着一把已过期的签名 URL（本实现的 1h < 24h）。
 */
import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { config } from "@/config";

/** 默认 TTL：24h。**必须大于静态资源的 `max-age`**（见文件头"过期语义与缓存语义的共存"）。 */
export const MEDIA_TTL_SEC = 24 * 3600;

/** 域分离前缀（改它等于让所有已发出的媒体链接立即失效）。 */
const DOMAIN = "miwo:media:";

/** 归一：统一分隔符、去掉前导斜杠（两种形态必须算出同一个签名）。 */
export function normalizeMediaRelPath(relPath: string): string {
  return String(relPath ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

/**
 * 媒体签名密钥（域分离，见文件头）。
 *
 * 用 HMAC 而不是把两把密钥拼起来：`HMAC(msg=config.jwtSecret)` 是**单向**的 ——
 * 拿到媒体密钥也推不回 `MIWO_JWT_SECRET`（拼接形态在"媒体密钥泄露"时会连带泄露 JWT 密钥）。
 */
export function mediaSignKey(): Buffer {
  return crypto.createHmac("sha256", DOMAIN).update(String(config.jwtSecret)).digest();
}

/** sig = base64url(HMAC-SHA256(mediaKey, `${DOMAIN}${relPath}|${exp}`)) 截断到 43 字符（=258 bit）。 */
export function signMediaSig(relPath: string, exp: string): string {
  return crypto
    .createHmac("sha256", mediaSignKey())
    .update(`${DOMAIN}${normalizeMediaRelPath(relPath)}|${exp}`)
    .digest("base64url")
    .slice(0, 43);
}

/** 生成 `"exp=<ms>&sig=<base64url>"`（**不带** `?`，调用方决定是 `?` 还是 `&`）。 */
export function signMediaQuery(relPath: string, ttlSec: number = MEDIA_TTL_SEC): string {
  const exp = String(Date.now() + ttlSec * 1000);
  return `exp=${exp}&sig=${signMediaSig(relPath, exp)}`;
}

/**
 * 校验一条媒体签名。`now` 可注入（用例要断言"过期后失效"，不能靠 sleep）。
 *
 * ⚠ 先比 exp 再比签名不会泄漏信息：exp 是**明文**（它本来就在 URL 里），签名才是秘密。
 * ⚠ 长度不同必须**先返回 false**：`crypto.timingSafeEqual` 在长度不等时**抛异常**
 *   （抛出去就是 500 + 一条栈，把"签名不对"变成"服务端故障"，还顺带泄内部信息）。
 */
export function verifyMediaSig(
  relPath: string,
  exp: string | undefined,
  sig: string | undefined,
  now: number = Date.now(),
): boolean {
  if (!exp || !sig) return false;
  if (!/^\d{1,15}$/.test(exp)) return false; // 只接受纯数字毫秒；15 位上限挡住 NaN/Infinity/科学计数法
  if (Number(exp) < now) return false;
  const want = signMediaSig(relPath, exp);
  if (want.length !== sig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(sig));
}

/**
 * `/oss` 与 `/assets` 的入口守卫。**顺序是刻意的**：
 *   ① 已有 ctx（`authenticate` 放行过 `Authorization`）⇒ 直接 next —— 服务端/脚本调用不必签名；
 *   ② 否则看 query 里的 `exp`/`sig`；
 *   ③ 都不满足 ⇒ **403**（与 401 区分：401 = 缺令牌，403 = 链接无效/过期；不泄漏"这个文件到底存不存在"）。
 *
 * ⚠ 本守卫**不读 DB、不读密钥之外的任何状态**：每个 `<img>` 一次调用，热路径不能有查询。
 * ⚠ 它**不解析 body / 不写日志**（query 里的 `sig` 是凭据，见文件头与 Task 4 的"凭据不进日志"口径）。
 */
export function mediaAuthGuard(req: Request, res: Response, next: NextFunction): void {
  if ((req as any).ctx) return next();
  const rel = normalizeMediaRelPath(req.path);
  if (verifyMediaSig(rel, String(req.query.exp ?? ""), String(req.query.sig ?? ""))) return next();
  res.status(403).send({ code: 403, data: null, message: "媒体链接无效或已过期" });
}
