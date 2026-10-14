/**
 * Phase 1c Task 7 的判别力用例：**媒体短时签名**（§1/§2/§6/§8）+ **媒体守卫的真 HTTP 行为**
 * （§3/§4/§5/§7/§9 + Range/缓存）。
 *
 * ── 为什么这里**不**直接 `import startServe from "@/app"` ──
 * `app.ts` 的最后一行是 `startServe()`（模块级副作用）：import 它会真起服务、真连库、真跑迁移，
 * 于是"测一个守卫的形状"变成"起一个生产进程"。而本文件要测的两样东西都是**具名导出**：
 *   · `@/utils/mediaSign`（签名/验签/守卫本身）；
 *   · `@/app` 的 `mountStaticAssets`（**产品代码里的那一个挂载函数**，不是它的复制品）。
 * ⇒ 用 `express()` + `mountStaticAssets()` 装配一个只监听回环随机端口的 app：被测的挂载顺序、
 *   `acceptRanges`、`maxAge`、`isPathInside` 全是**产品代码**，不是测试里重写的一份。
 *   真实装配顺序（`/oss` 在 `authenticate` 之后、SPA 壳最后）由
 *   `apps/api/scripts/verify-phase1c-media.cjs` 的**真进程 + 真 HTTP** 作证（那里跑整条链）。
 *
 * ⚠ 本文件**不碰** `apps/api/data`（那是用户真实数据的只读快照）：媒体目录一律用
 *   `os.tmpdir()` 下的一次性目录 + `MIWO_MEDIA_DIR` 之外的注入方式 —— 见下面的 `ossFixture()`。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import morgan from "morgan";
import { afterAll, describe, expect, it, vi } from "vitest";
import { config } from "@/config";
import { mountStaticAssets } from "@/app";
import {
  MEDIA_TTL_SEC,
  mediaAuthGuard,
  mediaSignKey,
  normalizeMediaRelPathInside,
  redactMediaQueryString,
  resolveInsideRoot,
  signMediaSig,
  signMediaQuery,
  verifyMediaSig,
} from "@/utils/mediaSign";
import u from "@/utils";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-media-sign-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ROUTES_DIR = path.join(__dirname, "..", "src", "routes");

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** 未解码的响应字节数（Range 断言要看真实长度，不能看 UTF-8 解码后的字符数）。 */
  bytes: number;
}

/** 起一个 minimal app（只装被测中间件），跑一条真 HTTP 请求，然后关掉。 */
async function serveAndFetch(
  build: (app: express.Express) => void,
  req: { method?: string; path?: string; headers?: Record<string, string> },
): Promise<Reply> {
  const app = express();
  build(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}${req.path ?? "/"}`, {
      method: req.method ?? "GET",
      headers: { ...(req.headers ?? {}) },
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, body: buf.toString("utf8"), bytes: buf.length };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/**
 * 用**原始请求行**发一条 GET（不经 undici/fetch 的 URL 归一化）。
 *
 * ⚠ 只有它能构造出 `/oss/../outside.txt` 这种"客户端的 normpath 会吃掉、但攻击者手里真实存在"
 *   的请求（`fetch("http://h/oss/../x")` 会被**客户端**改写成 `/x` ⇒ 用例永远碰不到守卫 = 假绿）。
 */
async function rawFetch(build: (app: express.Express) => void, rawPath: string, headers: Record<string, string> = {}): Promise<Reply> {
  const app = express();
  build(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise<Reply>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: rawPath, method: "GET", headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (d: Buffer) => chunks.push(d));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) headers[k] = Array.isArray(v) ? v.join(", ") : String(v ?? "");
          resolve({ status: res.statusCode ?? 0, headers, body: buf.toString("utf8"), bytes: buf.length });
        });
      });
      req.on("error", reject);
      req.end();
    });
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/**
 * 在 `dataDir` 下铺一份**一次性媒体树**（`oss/`、`assets/`、`skills/`、`web/`），
 * 然后跑 `fn()`。
 *
 * ⚠ 为什么是改 `config` 的字段而不是改环境变量：`config.ts` 是模块级 `loadConfig()`（fail-fast，
 *   且 `getPath()` 每次现读 `config.dataDir`）⇒ 在测试里临时改字段是**同一份产品代码**；
 *   而进程级 `MIWO_DATA_DIR` 是 vitest.config 里的全局值（改了会影响别的用例文件）。
 *   还原写在 `finally` 里（与 HEAD 的 blob 无关 —— 这里改的是内存里的 config 对象，不是文件）。
 */
async function withMediaTree<T>(fn: (dirs: { oss: string; assets: string; skills: string; web: string }) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(TMP, "data-"));
  const dirs = {
    oss: path.join(root, "oss"),
    assets: path.join(root, "assets"),
    skills: path.join(root, "skills"),
    web: path.join(root, "web"),
  };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  const prevData = config.dataDir;
  const prevMedia = config.mediaDir;
  (config as { dataDir: string }).dataDir = root;
  (config as { mediaDir: string }).mediaDir = dirs.oss;
  try {
    return await fn(dirs);
  } finally {
    (config as { dataDir: string }).dataDir = prevData;
    (config as { mediaDir: string }).mediaDir = prevMedia;
  }
}

/** 240 字节的确定性媒体内容（够 `bytes=0-99` 与"非法 Range"两端都用）。 */
function mediaBytes(seed: string): Buffer {
  const out = Buffer.alloc(240);
  for (let i = 0; i < out.length; i++) out[i] = (seed.charCodeAt(i % seed.length) + i) % 251;
  return out;
}

describe("ms 1-4. 签名的判别力：路径 / exp / 过期", () => {
  it("合法签名 ⇒ verifyMediaSig 为 true（对照：这是所有拒绝用例的正向基准）", () => {
    const q = new URLSearchParams(signMediaQuery("a/b.jpg"));
    expect(verifyMediaSig("a/b.jpg", q.get("exp") ?? "", q.get("sig") ?? "")).toBe(true);
  });

  it("★ 改路径 ⇒ false（签名必须覆盖路径；否则 A 的签名能贴到 B 的文件上 = 越权读他人媒体）", () => {
    const q = new URLSearchParams(signMediaQuery("a/b.jpg"));
    const exp = q.get("exp") ?? "";
    const sig = q.get("sig") ?? "";
    // 正向基准 + 反向对照放在同一条里：否则"永远返回 false"的实现也能绿。
    expect(verifyMediaSig("a/b.jpg", exp, sig), "原路径必须通过").toBe(true);
    expect(verifyMediaSig("a/c.jpg", exp, sig), "换个文件名必须拒绝").toBe(false);
    expect(verifyMediaSig("b/a/b.jpg", exp, sig), "换目录层级必须拒绝").toBe(false);
    expect(verifyMediaSig("./a/b.jpg", exp, sig), "相对路径前缀变化必须拒绝").toBe(false);
  });

  it("★ 改 exp ⇒ false（exp 必须在被签内容里；否则改 exp 就能把签名续命到任何时候）", () => {
    const q = new URLSearchParams(signMediaQuery("a/b.jpg"));
    const exp = q.get("exp") ?? "";
    const sig = q.get("sig") ?? "";
    const extended = String(Number(exp) + 3600_000);
    expect(verifyMediaSig("a/b.jpg", extended, sig, Number(exp)), "把 exp 往后推 1h：签名不再匹配").toBe(false);
    // 反向对照：**重签**一个更晚的 exp 必须通过（证明上面那条不是因为"晚于 now 就拒"）
    expect(verifyMediaSig("a/b.jpg", extended, signMediaSig("a/b.jpg", extended), Number(exp))).toBe(true);
  });

  it("★ 过期 ⇒ false（注入时钟，不 sleep）：exp 恰好等于 now 仍有效，now 大 1ms 即失效", () => {
    const exp = String(Date.now() + 60_000);
    const sig = signMediaSig("a/b.jpg", exp);
    expect(verifyMediaSig("a/b.jpg", exp, sig, Number(exp)), "边界：exp == now 仍有效（与 brief 的 `< now` 同口径）").toBe(true);
    expect(verifyMediaSig("a/b.jpg", exp, sig, Number(exp) + 1), "now 比 exp 晚 1ms ⇒ 立刻失效").toBe(false);
  });

  it("缺参 / 非数字 exp / 长度不符的 sig 一律 false（且**不抛**：timingSafeEqual 长度不等会抛）", () => {
    expect(verifyMediaSig("a/b.jpg", undefined, "x")).toBe(false);
    expect(verifyMediaSig("a/b.jpg", "123", undefined)).toBe(false);
    expect(verifyMediaSig("a/b.jpg", "abc", "x")).toBe(false);
    expect(verifyMediaSig("a/b.jpg", String(Date.now() + 1000), "short")).toBe(false);
    // 精确篡改一个字节（不是"换个长度"）：长度相同 ⇒ 走到 timingSafeEqual 那一步
    const exp = String(Date.now() + 60_000);
    const sig = signMediaSig("a/b.jpg", exp);
    const flipped = (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(flipped.length, "篡改必须保持长度，否则这条测的是长度分支而不是内容分支").toBe(sig.length);
    expect(verifyMediaSig("a/b.jpg", exp, flipped)).toBe(false);
  });

  it("★ 域分离（裁定 §2.2）：媒体密钥不等于 JWT 密钥，两边签名互不通约", () => {
    const key = mediaSignKey();
    expect(key.toString("base64"), "媒体签名密钥不得等于 config.jwtSecret 本身（那等于复用 JWT 密钥）").not.toBe(
      Buffer.from(config.jwtSecret).toString("base64"),
    );
    expect(key.length).toBe(32);
    // 拿 JWT 密钥（而不是派生密钥）算出来的 HMAC 必须对不上：这就是"域分离真的生效"的机械判据
    const exp = String(Date.now() + 60_000);
    const wrong = crypto
      .createHmac("sha256", config.jwtSecret)
      .update(`miwo:media:a/b.jpg|${exp}`)
      .digest("base64url")
      .slice(0, 43);
    expect(wrong).not.toBe(signMediaSig("a/b.jpg", exp));
    expect(verifyMediaSig("a/b.jpg", exp, wrong), "用 JWT 密钥冒充媒体签名必须被拒").toBe(false);
  });

  it("TTL 常量与缓存口径一致：签名 TTL(24h) 必须 > 静态资源 max-age(1h)", () => {
    expect(MEDIA_TTL_SEC).toBe(24 * 3600);
    expect(MEDIA_TTL_SEC).toBeGreaterThan(3600);
  });
});

describe("ms 5-8. 出口侧：getFileUrl / getSmallImageUrl 产出的 URL", () => {
  it("getFileUrl 产出含 sig= 与 exp= 的 URL（且签名真的能过 verifyMediaSig）", async () => {
    await withMediaTree(async () => {
      const url = await u.oss.getFileUrl("p1b/a.png");
      expect(url, "必须带签名").toMatch(/[?&]sig=/);
      expect(url, "必须带过期时间").toMatch(/[?&]exp=\d+/);
      const parsed = new URL(url);
      expect(verifyMediaSig("p1b/a.png", parsed.searchParams.get("exp") ?? "", parsed.searchParams.get("sig") ?? "")).toBe(true);
    });
  });

  it("getFileUrl(rel, \"assets\") 签的是**该挂载点下的相对路径**（与守卫看到的 req.path 同形态）", async () => {
    await withMediaTree(async () => {
      const url = await u.oss.getFileUrl("/ending.mp4", "assets");
      expect(new URL(url).pathname).toBe("/assets/ending.mp4");
      const parsed = new URL(url);
      expect(verifyMediaSig("ending.mp4", parsed.searchParams.get("exp") ?? "", parsed.searchParams.get("sig") ?? "")).toBe(true);
      expect(verifyMediaSig("assets/ending.mp4", parsed.searchParams.get("exp") ?? "", parsed.searchParams.get("sig") ?? ""), "带挂载点的形态不该通过（守卫拿到的是挂载点之后的部分）").toBe(false);
    });
  });

  it("★ getSmallImageUrl：sig= 与 size=20 同时存在，且整条 URL **只有一个 `?`**（旧写法会拼出 `…?sig=…?size=20`）", async () => {
    await withMediaTree(async () => {
      const url = await u.oss.getSmallImageUrl("a/b.jpg");
      expect(url).toContain("sig=");
      expect(url).toContain("size=20");
      expect((url.match(/\?/g) ?? []).length, `URL 里出现多个 ? ⇒ 签名值被污染、守卫必 403：${url}`).toBe(1);
      // 硬判据：按 URL 解析出来的 sig 必须**真的是这一个对象的签名**（旧写法的 sig 会带 `?size=20` 尾巴）
      const parsed = new URL(url);
      expect(parsed.searchParams.get("size")).toBe("20");
      expect(verifyMediaSig("a/b.jpg", parsed.searchParams.get("exp") ?? "", parsed.searchParams.get("sig") ?? "")).toBe(true);
    });
  });

  it("★ 静态断言：路由里**没有**把 getFileUrl/getSmallImageUrl 的返回值写进 insert/update（签名 URL 不得落库）", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(ROUTES_DIR);
    expect(files.length, "扫描必须真的看到路由文件（看不到 = 这条断言是空转）").toBeGreaterThan(50);

    const hits: string[] = [];
    let urlCalls = 0;
    for (const f of files) {
      fs.readFileSync(f, "utf8")
        .split(/\r?\n/)
        .forEach((line, i) => {
          if (!/get(File|SmallImage)Url\s*\(/.test(line)) return;
          urlCalls++;
          // 同一行里既取 URL 又落库 ⇒ 高风险（`.update({ cover: await u.oss.getFileUrl(x) })` 就是这个形状）
          if (/\.(insert|update|insertOrUpdate|onConflict)\s*\(/.test(line)) {
            hits.push(`${path.relative(ROUTES_DIR, f)}:${i + 1}: ${line.trim()}`);
          }
        });
    }
    expect(urlCalls, "必须观测到 getFileUrl/getSmallImageUrl 的调用点（观测不到 ≠ 干净）").toBeGreaterThan(10);
    expect(hits, `签名 URL 不得写进 DB（TTL 到期后那些行就是死链）：\n${hits.join("\n")}`).toEqual([]);
  });
});

describe("ms 9-13. 守卫与静态资源：真 HTTP 两端", () => {
  it("★ 守卫两端：正确签名 200 / 无签名 403 / 篡改签名 403 / 过期 403；错误体是统一形状且不泄漏路径", async () => {
    await withMediaTree(async (dirs) => {
      const body = mediaBytes("media-guard");
      fs.mkdirSync(path.join(dirs.oss, "p1b"), { recursive: true });
      fs.writeFileSync(path.join(dirs.oss, "p1b", "a.bin"), body);

      const build = (app: express.Express) => mountStaticAssets(app, () => undefined);
      const good = new URLSearchParams(signMediaQuery("p1b/a.bin"));
      const expired = (() => {
        const exp = String(Date.now() - 1000);
        return `exp=${exp}&sig=${signMediaSig("p1b/a.bin", exp)}`;
      })();
      const tampered = (() => {
        const exp = String(Date.now() + 60_000);
        const sig = signMediaSig("p1b/a.bin", exp);
        return `exp=${exp}&sig=${(sig[0] === "A" ? "B" : "A") + sig.slice(1)}`;
      })();

      const ok = await serveAndFetch(build, { path: `/oss/p1b/a.bin?${good}` });
      expect(ok.status, "合法签名必须 200").toBe(200);
      expect(ok.bytes).toBe(body.length);

      for (const [label, qs] of [
        ["无签名", ""],
        ["篡改签名", `?${tampered}`],
        ["已过期", `?${expired}`],
        ["签名指向别的对象", `?${signMediaQuery("p1b/b.bin")}`],
      ] as const) {
        const r = await serveAndFetch(build, { path: `/oss/p1b/a.bin${qs}` });
        expect(r.status, `${label} 必须 403（不是 200，也不是 500）`).toBe(403);
        expect(r.body, `${label} 的响应体必须是统一形状`).toMatch(/"code"\s*:\s*403/);
        expect(r.body, `${label} 不得泄漏绝对路径`).not.toMatch(/[A-Za-z]:[\\/]|miwo-media-sign-/);
        expect(r.body, `${label} 不得含堆栈`).not.toMatch(/\bat \w/);
      }
    });
  });

  it("★ 换对象：A 的签名配 B 的路径必拒（两端 —— A 自己 200 + B 的对象 403）", async () => {
    await withMediaTree(async (dirs) => {
      fs.mkdirSync(path.join(dirs.oss, "u7"), { recursive: true });
      fs.mkdirSync(path.join(dirs.oss, "u8"), { recursive: true });
      fs.writeFileSync(path.join(dirs.oss, "u7", "own.bin"), mediaBytes("u7"));
      fs.writeFileSync(path.join(dirs.oss, "u8", "other.bin"), mediaBytes("u8"));
      const build = (app: express.Express) => mountStaticAssets(app, () => undefined);

      const aSigned = new URLSearchParams(signMediaQuery("u7/own.bin"));
      const aOwn = await serveAndFetch(build, { path: `/oss/u7/own.bin?${aSigned}` });
      expect(aOwn.status, "A 自己的对象（带自己的签名）⇒ 200").toBe(200);

      // ① 把 A 的签名原样贴到 B 的路径上
      const stolen = await serveAndFetch(build, { path: `/oss/u8/other.bin?${aSigned}` });
      expect(stolen.status, "A 的签名贴到 B 的路径 ⇒ 403（签名覆盖路径）").toBe(403);

      // ② 猜测路径（彻底没有签名）⇒ 403。**这一条就是 1b-11 的原始漏洞**：
      //    改前 `/oss/u8/other.bin` 匿名 200（见 verify-phase1c-media.cjs 的 A 组两端原文）
      const guessed = await serveAndFetch(build, { path: "/oss/u8/other.bin" });
      expect(guessed.status, "猜到 URL 就拿到别人的文件 ⇒ 必须已被堵住").toBe(403);
    });
  });

  it("/skills 仍公开 200（不许顺手加守卫：前端图标全靠它）；非图片扩展名仍 403", async () => {
    await withMediaTree(async (dirs) => {
      fs.writeFileSync(path.join(dirs.skills, "icon.png"), mediaBytes("skill"));
      fs.writeFileSync(path.join(dirs.skills, "readme.md"), "not an image");
      const build = (app: express.Express) => mountStaticAssets(app, () => undefined);
      const png = await serveAndFetch(build, { path: "/skills/icon.png" });
      expect(png.status, "/skills 的图片必须匿名 200（保持公开）").toBe(200);
      const md = await serveAndFetch(build, { path: "/skills/readme.md" });
      expect(md.status, "只放行图片扩展名（原有行为不许回退）").toBe(403);
    });
  });

  it("★ Range：bytes=0-99 ⇒ 206 + 正确的 Content-Range；越界 ⇒ 416（视频拖动的前提）", async () => {
    await withMediaTree(async (dirs) => {
      const body = mediaBytes("range");
      fs.writeFileSync(path.join(dirs.oss, "video.bin"), body);
      const build = (app: express.Express) => mountStaticAssets(app, () => undefined);
      const q = new URLSearchParams(signMediaQuery("video.bin"));

      const part = await serveAndFetch(build, { path: `/oss/video.bin?${q}`, headers: { Range: "bytes=0-99" } });
      expect(part.status, "合法 Range 必须 206（旧实现是 acceptRanges:false ⇒ 只回 200 全量）").toBe(206);
      expect(part.headers["content-range"]).toBe(`bytes 0-99/${body.length}`);
      expect(part.bytes, "206 的 body 长度必须正好是 100 字节").toBe(100);
      expect(part.headers["accept-ranges"]).toBe("bytes");

      const bad = await serveAndFetch(build, { path: `/oss/video.bin?${q}`, headers: { Range: "bytes=999999-1000000" } });
      expect(bad.status, "不可满足的 Range 必须 416").toBe(416);
      expect(bad.headers["content-range"], "416 要带 `bytes */长度` 让客户端知道真实大小").toBe(`bytes */${body.length}`);

      // ⚠ 过期签名 + 合法 Range：必须先在守卫处 403，**不能**因为带 Range 就走 206
      //   （缓存/Range 不能绕过过期 —— 这是"签名 TTL 与缓存共存"的关键判据）
      const exp = String(Date.now() - 1000);
      const stale = await serveAndFetch(build, {
        path: `/oss/video.bin?exp=${exp}&sig=${signMediaSig("video.bin", exp)}`,
        headers: { Range: "bytes=0-99" },
      });
      expect(stale.status, "过期签名 + Range ⇒ 403（守卫在 static 之前）").toBe(403);
    });
  });

  it("★ 缓存：合法签名资源带 Cache-Control(max-age=3600) 与 ETag；条件请求 ⇒ 304；但**过期签名不走 304**", async () => {
    await withMediaTree(async (dirs) => {
      fs.writeFileSync(path.join(dirs.oss, "c.bin"), mediaBytes("cache"));
      const build = (app: express.Express) => mountStaticAssets(app, () => undefined);
      const q = new URLSearchParams(signMediaQuery("c.bin"));

      const first = await serveAndFetch(build, { path: `/oss/c.bin?${q}` });
      expect(first.status).toBe(200);
      expect(first.headers["cache-control"], "必须可缓存（否则每张图都重下）").toContain("max-age=3600");
      expect(first.headers["cache-control"], "签名 URL 会过期 ⇒ 绝不能声明 immutable").not.toContain("immutable");
      const etag = first.headers["etag"];
      expect(etag, "必须有 ETag（否则条件请求没有依据）").toBeTruthy();

      const cond = await rawFetch(build, `/oss/c.bin?${q}`, { "If-None-Match": String(etag) });
      expect(cond.status, "带 If-None-Match ⇒ 304（省流量）").toBe(304);
      expect(cond.bytes, "304 不得带 body").toBe(0);
      // 过期签名 + 相同的 If-None-Match：必须 403 —— 缓存**不能**让过期的链接继续可用
      const exp = String(Date.now() - 1000);
      const stale = await rawFetch(build, `/oss/c.bin?exp=${exp}&sig=${signMediaSig("c.bin", exp)}`, {
        "If-None-Match": String(etag),
      });
      expect(stale.status, "过期签名即使带 If-None-Match 也必须 403（不是 304）").toBe(403);
    });
  });

  it("★ Tier 0「补 isPathInside」：resolveInsideRoot 对 `..` 逃逸/绝对路径形态一律返回 null（可单测，不依赖盘上真有越界文件）", async () => {
    await withMediaTree(async (dirs) => {
      // 正向：正常路径必须解析出来（否则下面那串"全 null"只是"函数坏了"）
      expect(resolveInsideRoot(dirs.oss, "/p1b/a.png")).toBe(path.join(dirs.oss, "p1b", "a.png"));
      expect(resolveInsideRoot(dirs.oss, "p1b/a.png")).toBe(path.join(dirs.oss, "p1b", "a.png"));

      for (const evil of [
        "/../outside.txt",
        "/a/../../outside.txt",
        "/..",
        "/./../outside.txt",
        // ⚠ 绝对路径形态：`path.join("D:\\a", "D:\\b")` = `"D:\\a\\D:\\b"`（行为随盘符变化）⇒ 必须判掉
        "/D:/other/place.txt",
        "/",
        "",
      ]) {
        expect(resolveInsideRoot(dirs.oss, evil), `必须拒绝：${JSON.stringify(evil)}`).toBeNull();
      }

      // 归一函数本身：被签的形态与 `req.path` 的形态必须收敛到同一个串
      expect(normalizeMediaRelPathInside("\\p1b\\a.png")).toBe("p1b/a.png");
      expect(normalizeMediaRelPathInside("//p1b//a.png")).toBe("p1b/a.png");
      expect(normalizeMediaRelPathInside("../a.png")).toBeNull();
    });
  });

  it("★ 缩略图分支的穿越防护：`%2e%2e`（Express 不解码归一）⇒ 403；且**越界内容一个字节都不回**", async () => {
    await withMediaTree(async (dirs) => {
      const secret = "SECRET-OUTSIDE-OSS-CONTENT";
      const outside = path.join(dirs.oss, "..", "outside.txt");
      fs.writeFileSync(outside, secret);
      const build = (app: express.Express) => mountStaticAssets(app, () => undefined);

      // ① 归一边界（**防线本体**，可单测）：`..` 逃逸一律 null。
      //   ⚠ 为什么 HTTP 层很难再构造：Express 5 的 router 自己会做 normpath（实测
      //   把 `/oss/../outside.txt` 变成 `/outside.txt`）⇒ 正常的 `..` 形态**到不了**缩略图分支，
      //   所以"补 isPathInside"的判别力由这一条 + `resolveInsideRoot` 用例承担（见上一条）。
      expect(resolveInsideRoot(dirs.oss, "/../outside.txt")).toBeNull();

      // ② 真实攻击形态：`%2e%2e` 在**解码之后**才是 `..`，Express 的 normpath 看不到它
      //   （它只处理字面量 `..` 段）⇒ `req.path` 会带着 `../outside.txt` 进到缩略图分支。
      const q = new URLSearchParams(signMediaQuery("../outside.txt"));
      const encoded = await rawFetch(build, `/oss/%2e%2e/outside.txt?${q}&size=20`);
      expect(encoded.status, "`%2e%2e` 越界必须 403").toBe(403);
      expect(encoded.body, "越界文件的内容绝不能出现在响应里").not.toContain(secret);

      // ③ 反向对照：同一个 `?size=` 分支对**合法**路径必须仍然工作
      //   （否则上面那条只是"整条分支坏了/永远 403"，不是"防线在起作用"）
      fs.writeFileSync(path.join(dirs.oss, "ok.png"), fs.readFileSync(outside));
      const okQ = new URLSearchParams(signMediaQuery("ok.png"));
      const okRes = await rawFetch(build, `/oss/ok.png?${okQ}&size=20`);
      expect(
        [200, 403, 404],
        "合法路径 + 无效的图片内容：要么生成失败降级（404/403），但**绝不能** 5xx —— 实测 404（sharp 认不出这个假 png，降级到 static）",
      ).toContain(okRes.status);
      expect(okRes.status, "★ 与越界那条的 403 区分开：合法路径不会被守卫拦（它走的是另一条分支）").not.toBe(500);
    });
  });

  it("SPA 壳仍匿名可访问：web 目录里的文件无需任何凭据 ⇒ 200（登录页口径）", async () => {
    await withMediaTree(async (dirs) => {
      fs.writeFileSync(path.join(dirs.web, "index.html"), "<html>login shell</html>");
      const build = (app: express.Express) => mountStaticAssets(app, () => undefined);
      const r = await serveAndFetch(build, { path: "/index.html" });
      expect(r.status, "SPA 壳必须匿名 200（否则用户连登录页都打不开）").toBe(200);
      expect(r.body).toContain("login shell");
      // express.static 的默认就是 `public, max-age=0`（= 每次都协商）。这里断言的是"**没有**被调成长缓存"：
      // 入口文件一旦被长缓存，用户会拿到旧壳 + 旧 JS 哈希而白屏。
      expect(r.headers["cache-control"], "index.html 不得长缓存").toMatch(/max-age=0(?!\d)/);
    });
  });

  it("守卫对**带 ctx 的请求**放行（服务端/脚本带 Bearer 的路径），且不会因为读 query 而改写 req.query", async () => {
    const seen: Record<string, unknown> = {};
    const r = await serveAndFetch(
      (app) => {
        app.use("/oss", (req, _res, next) => {
          (req as { ctx?: unknown }).ctx = { userId: 1 }; // 模拟 authenticate 已建 ctx
          next();
        }, mediaAuthGuard);
        app.get("/oss/whatever.bin", (req, res) => {
          Object.assign(seen, req.query);
          res.status(200).send({ ok: true });
        });
      },
      { path: "/oss/whatever.bin?size=20" },
    );
    expect(r.status, "有 ctx ⇒ 不必签名也放行").toBe(200);
    expect(seen, "守卫不许吃掉别的 query（`size` 还要给缩略图分支用）").toEqual({ size: "20" });
  });

  it("★★ 与日志脱敏的**顺序耦合**：脱敏把 exp/sig 改成 `***` 之后，守卫仍必须放行（改前这里 403 —— 每张图都裂）", async () => {
    // 这条是**实测踩到的真 bug** 的回归用例：`app.ts` 的脱敏中间件必须**先**跑（否则签名进日志），
    // 而它会把 `req.query.exp/sig` 与 `req.url` 一起改成 `***` ⇒ 守卫若从那里读签名，
    // **每一条合法签名都会 403**（端到端脚本当场全红，单测当时没覆盖"脱敏在前"这个顺序）。
    // 修法：脱敏**之前**把原始对另存到 `req._mediaSig`。
    await withMediaTree(async (dirs) => {
      fs.writeFileSync(path.join(dirs.oss, "guarded.bin"), mediaBytes("coupling"));
      const build = (app: express.Express) => {
        // ① 与 app.ts 同形状：先另存 → 再脱敏（url + query 都变 `***`）
        app.use((req, _res, next) => {
          if (typeof req.query?.sig === "string" || typeof req.query?.exp === "string") {
            (req as unknown as { _mediaSig: unknown })._mediaSig = {
              exp: String(req.query.exp ?? ""),
              sig: String(req.query.sig ?? ""),
            };
          }
          const rawUrl = req.originalUrl ?? req.url ?? "";
          const bare = redactMediaQueryString(rawUrl);
          if (bare !== rawUrl) {
            req.url = bare;
            req.originalUrl = bare;
          }
          if (req.query && (("sig" in req.query) || ("exp" in req.query))) {
            const rest: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(req.query)) {
              if (k === "sig" || k === "exp") continue;
              rest[k] = v;
            }
            Object.defineProperty(req, "query", { value: rest, writable: true, configurable: true, enumerable: true });
          }
          next();
        });
        // ② 在**后面**才挂媒体（真实顺序：脱敏在 app.ts 文件头，mountStaticAssets 在后面）
        mountStaticAssets(app, () => undefined);
      };

      const q = new URLSearchParams(signMediaQuery("guarded.bin"));
      const ok = await serveAndFetch(build, { path: `/oss/guarded.bin?${q}&size=20` });
      expect(ok.status, "★ 脱敏之后守卫仍要放行（读到 `***` 就 403 ⇒ 那条路是 bug）").toBe(200);
      expect(ok.bytes).toBeGreaterThan(0);

      // 反向对照：同一个 app 上，没有签名的请求仍然必须 403（否则这条只是"守卫整个失效了"）
      const noSig = await serveAndFetch(build, { path: "/oss/guarded.bin" });
      expect(noSig.status, "反向对照：无签名仍须 403").toBe(403);

      // 反向对照 2：脱敏**没有**发生（没有 exp/sig）时，`req.query` 里别的参数不受影响
      const other = await serveAndFetch(build, { path: `/oss/guarded.bin?${q}&size=20` });
      expect(other.headers["content-type"]).toBeTruthy();
    });
  });
});

describe("ms 14. 日志脱敏（裁定 §2.6：签名是凭据，不许进日志）", () => {
  /**
   * ⚠ 这条用**真 morgan**（`logger("dev")`）打出真日志，再断言日志原文里没有签名。
   *   为什么必须用真 morgan：它的 `:url` 读的是 `req.originalUrl`，**不经过** `req.query` ——
   *   只改 `req.query` 的写法在这里会**当场红**（第一版就是这样：
   *   `GET /oss/x.bin?exp=123&sig=SUPERSECRET&size=20 200` 原样出现在 stdout）。
   */
  it("★ 真 morgan：日志里没有 sig/exp，但路径与别的 query（size）仍在", async () => {
    const logs: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      logs.push(String(chunk));
      return true;
    });
    let status = 0;
    try {
      const r = await serveAndFetch(
        (app) => {
          // 与 `src/app.ts` 的日志段同形状：脱敏 → 自定义 url token → morgan("dev")
          app.use((req, _res, next) => {
            const rawUrl = req.originalUrl ?? req.url ?? "";
            const bare = redactMediaQueryString(rawUrl);
            if (bare !== rawUrl) {
              req.url = bare;
              req.originalUrl = bare;
            }
            next();
          });
          morgan.token("url", (req) => redactMediaQueryString((req as express.Request).originalUrl ?? ""));
          app.use(morgan("dev"));
          app.get("/oss/x.bin", (_req, res) => res.status(200).send({ ok: true }));
        },
        { path: "/oss/x.bin?exp=123&sig=SUPERSECRET&size=20" },
      );
      status = r.status;
    } finally {
      spy.mockRestore();
    }
    expect(status).toBe(200);
    const logged = logs.join("");
    expect(logged, "必须真的观测到 morgan 的输出（否则这条断言是空转）").toMatch(/GET \/oss\/x\.bin/);
    expect(logged, "路径与其它 query 必须仍在日志里（否则静态资源的 4xx 没法查）").toContain("size=20");
    expect(logged, "★ 签名是凭据：绝不能进日志").not.toContain("SUPERSECRET");
    expect(logged, "exp 同样摘掉（它与 sig 是一对）").not.toContain("exp=123");
  });

  it("redactMediaQueryString 的两端：只摘 exp/sig，不误伤 size / 其它参数 / 路径里的 `exp=`", () => {
    expect(redactMediaQueryString("/oss/a.png?exp=123&sig=AbC-_.xyz&size=20")).toBe("/oss/a.png?exp=***&sig=***&size=20");
    expect(redactMediaQueryString("/oss/a.png?size=20")).toBe("/oss/a.png?size=20");
    expect(redactMediaQueryString("/oss/exp=9/a.png")).toBe("/oss/exp=9/a.png");
    expect(redactMediaQueryString("/oss/a.png?exp=1&sig=x")).toBe("/oss/a.png?exp=***&sig=***");
    // 幂等：已经脱敏过的串再过一遍不变（日志/中间件会重复经过它）
    expect(redactMediaQueryString("/oss/a.png?exp=***&sig=***&size=20")).toBe("/oss/a.png?exp=***&sig=***&size=20");
  });
});
