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
import path from "node:path";
import isPathInside from "is-path-inside";
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
 * ⚠⚠ **尺子必须是"字节数"而不是 `String.length`**（Phase 1c Task 10 修的真 bug）：
 *   `timingSafeEqual` 比的是 **Buffer 的字节长度**，而 `String.length` 是 **UTF-16 码元数**。
 *   实测（本任务）：`"A".repeat(42) + "€"`（43 个字符 / 45 字节）的 `String.length` 恰好也是 43
 *   ⇒ 长度检查**放行** ⇒ `timingSafeEqual` 抛 `RangeError: Input buffers must have the same byte length`
 *   ⇒ 冒到错误处理器 ⇒ **HTTP 500**。这是**每张图都走**的热路径，而 `sig` 是攻击者完全可控的
 *   query 参数 ⇒ **可远程触发 500**（审查者已复现，本任务在真 HTTP 上取到 `HTTP 500` 原文）。
 *   现在两把尺子都对齐到 UTF-8 字节数，并且整段包在 `try/catch → false` 里：
 *   将来任何"长度/编码"的意外都只会变成一次**普通的拒绝**（403），不再是 500。
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
  try {
    const want = Buffer.from(signMediaSig(relPath, exp), "utf8");
    const got = Buffer.from(sig, "utf8");
    // ⚠ 比 `Buffer` 的**字节长度**，与 `timingSafeEqual` 的判据一致。
    //   写成 `sig.length`（UTF-16 码元）就是上面说的那个 500。
    if (want.length !== got.length) return false;
    return crypto.timingSafeEqual(want, got);
  } catch {
    // 长度不等 / 非法编码等一律当作"签名不对"。
    // ⚠ 这里**不是**掩盖：调用方（`mediaAuthGuard`）的唯一语义就是"合法 ⇒ 放行，其它 ⇒ 403"，
    //   而"算不出来"与"算出来不相等"在**安全结论上完全等价**（都不可信）。
    //   反过来把它们区分开（抛出/500）才是漏洞：它把攻击者可控的输入变成服务端故障。
    return false;
  }
}

/**
 * 把**URL 路径形态**的相对路径归一（去前导分隔符、`\` → `/`），并**判掉 `..` 逃逸**。
 *
 * 越界返回 `null`（调用方一律 `403`）。判据是"归一后的每一段都不能是 `..`"，
 * 而不是"拼出来的绝对路径恰好还在根目录下"：
 *   · 后者依赖 `path.join` 的具体行为（Windows 上 `path.join("D:\\a", "\\x")` 与
 *     `path.join("D:\\a", "D:\\b")` 结果形态不同，随盘符/平台变化）；
 *   · 我们要防的是**输入里带逃逸**，那就直接在输入上判 —— 这样判据与平台无关，
 *     而且**可单测**（不需要造一个"根目录外的真实文件"才能证明它在防）。
 * ⚠ 空路径也返回 `null`：`/oss` 本身不是文件。
 */
export function normalizeMediaRelPathInside(relPath: string): string | null {
  const rel = normalizeMediaRelPath(relPath);
  if (!rel) return null;
  const parts = rel.split("/").filter((p) => p !== "" && p !== ".");
  if (parts.length === 0) return null;
  if (parts.some((p) => p === "..")) return null;
  // ⚠ 段里出现 `:` 一律拒（Windows 专属的两个坑，实测确认）：
  //   · `"/D:/x"` 这种"URL 里塞盘符"的形态在 Windows 上会被 `path.join` 当成**普通相对段**
  //     而**不是**越界（实测 `path.join("C:\\tmp\\oss", "D:\\other\\f.txt")` 仍在 `oss` 内）
  //     ⇒ 它绕过了 `isPathInside`，却把"盘符"写进了文件名；
  //   · NTFS 备用数据流（`file.txt:secret`）同样靠 `:` 打开，属越界读取的另一种形态。
  if (parts.some((p) => p.includes(":"))) return null;
  return parts.join("/");
}

/**
 * 把 `req.path` 解析成挂载点内的绝对路径；**越界返回 `null`**（调用方一律 `403`）。
 *
 * 为什么不能直接 `path.join(rootDir, req.path)`：
 *   · Express 只对 `express.static` 做根目录约束，**不会**替我们校验 `path.join` 的结果；
 *     `/oss/a/../../db2.sqlite` 这类 `req.path` 会**恰好**解析到挂载点之外的真实文件，
 *     而 `/oss` 的缩略图分支最后是 `res.sendFile(...)` —— 那就是"任意文件读取"；
 *   · 缩略图分支还会把拼出来的路径当**写入目标**（`ensureThumbnail` 会 `mkdir -p` 再落盘），
 *     越界就等于把这个服务当成"任意路径写入器"。
 *
 * @param rootDir 挂载点根（`u.getPath("oss")` 等），必须已是绝对路径
 * @param reqPath `req.path`（挂载点**之后**的部分，以 `/` 开头）
 * @returns 绝对路径；越界（含 `..`、空路径）返回 `null`
 */
export function resolveInsideRoot(rootDir: string, reqPath: string): string | null {
  const rel = normalizeMediaRelPathInside(reqPath);
  if (rel === null) return null;
  const abs = path.join(rootDir, rel.split("/").join(path.sep));
  // 双保险：归一已经挡住了 `..`，这里再确认拼出来的绝对路径确实在根内
  //（防"将来有人改归一逻辑"时静默放行 —— 两条判据任意一条成立都不会越界）。
  return isPathInside(abs, rootDir) ? abs : null;
}

/**
 * 把 URL 的 query 串里的 `exp`/`sig` 摘掉（**只摘这两个参数值**，其余原样保留）。
 *
 * 用正则做在**字符串**上，而不是解析 `req.query`：morgan 的 `:url` 是**原始 URL**
 * （`req.originalUrl`），它不经过 `req.query` —— 只改 `req.query` 的话，签名照样被打进日志
 * （实测踩到：`GET /oss/x.bin?exp=123&sig=SUPERSECRET&size=20 200` 原样出现在 stdout）。
 * `exp` 只匹配纯数字（`exp=123`）⇒ 不会误伤 `?size=2000`（`size=` 不是 `exp=`，且数字串边界由 `\d+` 吃满）。
 */
export function redactMediaQueryString(url: string): string {
  // ⚠ 值域用 `[^&#\s]*`（到下一个参数/片段/空白为止）而不是 `[A-Za-z0-9_-]*`：
  //   后者**吃不掉 `.`**（实测：`sig=AbC-_.xyz&size=20` 只被摘成 `sig=***.xyz&size=20`，
  //   尾巴留在日志里）。我们要的是"这个参数的值整个消失"，值域必须按**分隔符**划，不按字符集划。
  return String(url ?? "").replace(/([?&])(exp|sig)=[^&#\s]*/g, "$1$2=***");
}

/**
 * `/oss` 与 `/assets` 的入口守卫。**顺序是刻意的**：
 *   ① 已有 ctx（`optionalMediaAuth` 已按 `Authorization` 建好 ctx）⇒ 直接 next —— 服务端/脚本调用不必签名；
 *   ② 否则看签名；
 *   ③ 都不满足 ⇒ **403**（与 401 区分：401 = 缺令牌，403 = 链接无效/过期；不泄漏"这个文件到底存不存在"）。
 *
 * ⚠⚠ **"已有 ctx"这条分支曾经永远走不到**（Phase 1c Task 10 修的真 bug）：
 *   Phase 1c Task 7 把 `authenticate` 从"挂根"改成 `app.use("/api", …)`，于是 `req.ctx` 只在 `/api`
 *   分支上被建出来 —— 而 `/oss`、`/assets` 根本不在 `/api` 之下 ⇒ **带 Bearer 取媒体一律 403**。
 *   可那时**四处文档**（`app.ts` 的挂载表、本文件注释、报告、e2e）都宣称"Bearer 可用"。
 *   修法（控制器裁定）：在 `/oss`、`/assets` **之前**挂 `optionalMediaAuth`（有 `Authorization`
 *   就验签建 ctx，没有就 `next()`），本条分支于是真的可达。
 *
 * ⚠⚠ 签名从 `req._mediaSig`（`app.ts` 的日志脱敏中间件在**改写 `req.url`/`req.query` 之前**
 *   存下来的那一对原始值）读，**不读 `req.query`**。原因是实测踩到的一个真 bug：
 *   脱敏中间件"把 `q.exp`/`q.sig` 从 query 里摘掉"与守卫"从 query 里读签名"是**同一份数据**，
 *   而脱敏必须**先**跑（否则日志里已经有签名了）⇒ 守卫读到的永远是 `"***"` ⇒ **每一条合法签名都 403**。
 *   修法：脱敏前把原始对**另存一份**给守卫用（`req.query` 那一份继续被脱敏）。
 *   兜底：没有 `_mediaSig` 时仍读 `req.query` —— 于是本守卫可以**单独挂载**（单测就是这样用的）。
 *
 * ⚠ 本守卫**不读 DB、不读密钥之外的任何状态**：每个 `<img>` 一次调用，热路径不能有查询。
 * ⚠ 它**不解析 body / 不写日志**（query 里的 `sig` 是凭据，见文件头与 Task 4 的"凭据不进日志"口径）。
 */
export function mediaAuthGuard(req: Request, res: Response, next: NextFunction): void {
  if ((req as any).ctx) return next();
  const kept = (req as any)._mediaSig as { exp?: string; sig?: string } | undefined;
  const exp = kept ? kept.exp : String(req.query.exp ?? "");
  const sig = kept ? kept.sig : String(req.query.sig ?? "");
  const rel = normalizeMediaRelPath(req.path);
  if (verifyMediaSig(rel, exp, sig)) return next();
  res.status(403).send({ code: 403, data: null, message: "媒体链接无效或已过期" });
}
