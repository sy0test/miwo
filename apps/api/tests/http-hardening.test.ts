/**
 * Phase 1c Task 6：**运行时与响应硬化**的判别力用例。
 *
 * ── 覆盖（每条都必须能红，见 Task 5+6 报告的红绿两端）──
 *   0. 跨方言运维原语（裁定 §2.5）：sqlite 真跑 + mysql 的 `toSQL()`/SQL 文本**离线形态**；
 *   1. 安全响应头（helmet）：`X-Content-Type-Options: nosniff` / `X-Frame-Options`；
 *   2. `/oss` 的 `Cross-Origin-Resource-Policy` **不得**是 `same-origin`
 *      （helmet 的默认值会让 dev 的跨源图片全被浏览器拒收 —— "接口全正常、页面上一个图都没有"）；
 *   3. CORS 白名单：非白名单 Origin **不回** `Access-Control-Allow-Origin`、
 *      白名单 Origin **精确**回显（旧实现是 `origin: "*"`）；
 *   4. 错误响应脱敏：**真实 UNIQUE 约束冲突** ⇒ 响应体里没有 `UNIQUE`、表名、列名、
 *      绝对路径、堆栈；同时**服务端日志保留**完整信息（含 requestId）；
 *   5. 限流：超过阈值 ⇒ **429**（并明确它是**进程内计数**：多副本/重启不共享）；
 *   6. trust proxy：`app.set("trust proxy", 1)` 后 `X-Forwarded-For` 生效（影响 `req.ip`）。
 *
 * ── 为什么这个文件**不**直接 import `src/app.ts` 的默认导出 ──
 * `app.ts` 的最后一行是 `startServe()`（模块级副作用）：import 它会真起服务、真连库、真跑迁移，
 * 于是"测一个中间件形状"变成"起一个生产进程"。而 `app.ts` 里可被断言的那部分
 * （`applySecurityHeaders` / `corsOrigin` / `errorHandler`）都是**具名导出** ⇒ 这里用**同一份导出**
 * 装配一个只监听回环随机端口的 minimal app：被测的是**产品代码本身**，不是它的复制品。
 * 真实装配顺序（helmet 在静态资源之前、`await dbReady` 在 `server.listen` 之前）由
 * `verify-phase0.cjs` 的端到端启动与 `tests/db-optern-order` 的源码断言作证。
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import knexFactory, { type Knex } from "knex";
import { afterAll, describe, expect, it, vi } from "vitest";
import { allowedOrigins, applySecurityHeaders, corsOrigin, errorHandler } from "@/app";
import { API_LIMIT_DEV, createLimiter, loginLimiter } from "@/middleware/rateLimit";
import { clientNameOf, columnNames, isSqlite, listTables, listTablesSql, tableRowCount } from "@/lib/dbOps";
import { isExportableTable } from "@/lib/tableWhitelist";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-http-hardening-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

interface Reply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 起一个 minimal app（只装被测中间件），跑一条真 HTTP 请求，然后关掉。 */
async function serveAndFetch(
  build: (app: express.Express) => void,
  req: { method?: string; path?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Reply> {
  const app = express();
  build(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const payload = req.body === undefined ? undefined : JSON.stringify(req.body);
    const res = await fetch(`http://127.0.0.1:${port}${req.path ?? "/"}`, {
      method: req.method ?? "GET",
      headers: { ...(payload ? { "Content-Type": "application/json" } : {}), ...(req.headers ?? {}) },
      body: payload,
    });
    const body = await res.text();
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { status: res.status, headers, body };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

/** 常用中间件栈：安全头 + CORS + json（与 `app.ts` 的前半段同序）。 */
function hardeningStack(app: express.Express): void {
  applySecurityHeaders(app);
  app.use(express.json());
}

describe("hw 0. 跨方言运维原语（裁定 §2.5）", () => {
  it("sqlite 真跑：listTables / tableRowCount / columnNames 在一次性库上语义正确", async () => {
    const file = path.join(TMP, "ops-sqlite.sqlite");
    const db: Knex = knexFactory({ client: "better-sqlite3", connection: { filename: file }, useNullAsDefault: true });
    try {
      expect(isSqlite(db), "better-sqlite3 必须被判成 sqlite 家族").toBe(true);
      expect(clientNameOf(db)).toBe("better-sqlite3");
      await db.schema.createTable("o_thing", (t) => {
        t.integer("id").primary();
        t.text("name");
      });
      await db.schema.createTable("knex_migrations", (t) => t.integer("id"));
      await db("o_thing").insert([{ id: 1, name: "a" }, { id: 2, name: "b" }]);

      const tables = await listTables(db);
      expect(tables, "必须列出业务表").toContain("o_thing");
      expect(tables, "knex_% 基础设施表必须被排除（迁移记账表不该被清库接口删掉）").not.toContain("knex_migrations");
      expect(await tableRowCount(db, "o_thing"), "行数必须是真数出来的 2").toBe(2);
      expect(await columnNames(db, "o_thing")).toEqual(["id", "name"]);
      expect(await columnNames(db, "no_such_table"), "表不存在 ⇒ 空数组，不抛").toEqual([]);
    } finally {
      await db.destroy();
    }
  });

  it("mysql 侧**离线形态**：SQL 文本里绝不出现 sqlite_master / PRAGMA（未连真机）", () => {
    const my: Knex = knexFactory({ client: "mysql2" });
    try {
      expect(isSqlite(my)).toBe(false);
      expect(clientNameOf(my)).toBe("mysql2");
      const sql = listTablesSql(my);
      expect(sql, "mysql 分支必须读 information_schema.tables").toContain("information_schema.tables");
      expect(sql, "mysql 没有 sqlite_master").not.toMatch(/sqlite_master/i);
      expect(sql, "mysql 的 sqlite_% 排除规则无意义，不该出现").not.toMatch(/sqlite_/i);
      expect(sql, "必须限定当前库（否则会把实例里别的库的表一起列出来）").toMatch(/table_schema\s*=\s*DATABASE\(\)/i);
      expect(sql, "必须只看基表").toMatch(/table_type\s*=\s*'BASE TABLE'/i);
      expect(sql, "行名统一：mysql 的 table_name 必须被别名成 name").toMatch(/AS\s+name/i);
      expect(listTablesSql(knexFactory({ client: "better-sqlite3", useNullAsDefault: true }))).toContain("sqlite_master");
    } finally {
      void my.destroy();
    }
  });

  it("mysql 侧**离线形态（真跑函数，不连库）**：listTables/tableRowCount 真的按 mysql 字符串发查询", async () => {
    // ⚠ 本机**不起 MySQL**（3307 独占），所以这里用一个**只记录 SQL 的假客户端**把
    //   `listTables` / `tableRowCount` 真的执行一遍：观测到 SQL 才算数（Ruling 243 的口径 ——
    //   "观测不到"不等于"干净"）。这条与上一条的区别：上一条只比 SQL 文本，这条证明**函数真的把它发出去了**。
    const seen: string[] = [];
    const fake: Knex = ((table: string) => ({
      count: (_alias: unknown) => ({
        first: async () => {
          seen.push(`SELECT count(*) AS \`n\` FROM \`${table}\``);
          return { n: 7 };
        },
      }),
    })) as unknown as Knex;
    (fake as unknown as { client: unknown }).client = { config: { client: "mysql2" } };
    (fake as unknown as { raw: unknown }).raw = async (sql: string) => {
      seen.push(sql);
      expect(sql, "假客户端也要挡住 sqlite 方言（否则这条用例自己会假绿）").not.toMatch(/sqlite_master|PRAGMA/i);
      return [{ name: "o_fake_a" }, { name: "o_fake_b" }];
    };
    (fake as unknown as { schema: unknown }).schema = { hasTable: async () => true };
    (fake as unknown as { columnInfo?: unknown }).columnInfo = async () => ({});

    const tables = await listTables(fake);
    expect(tables, "mysql 分支的返回值必须被归一化成排好序的表名数组").toEqual(["o_fake_a", "o_fake_b"]);
    expect(await tableRowCount(fake, "o_fake_a")).toBe(7);

    expect(seen.length, "必须真的发出了两条查询（观测到才算数）").toBe(2);
    expect(seen[0], "第一条必须是 information_schema 那条").toContain("information_schema.tables");
    expect(seen[1], "第二条必须是按表名的 count，且表名来自上一条的结果").toContain("o_fake_a");
    expect(seen.join("\n"), "任何一条都不得出现 sqlite 方言").not.toMatch(/sqlite_master|PRAGMA/i);
  });

  it("白名单语义两端都成立：非白名单表名（含 sqlite_/_ 前缀与基础设施表）一律拒绝", () => {
    expect(isExportableTable("o_project")).toBe(true);
    expect(isExportableTable("knex_migrations"), "迁移记账表不是业务表").toBe(false);
    expect(isExportableTable("sqlite_sequence")).toBe(false);
    expect(isExportableTable("_private")).toBe(false);
    expect(isExportableTable("o_not_declared_in_policies")).toBe(false);
    expect(isExportableTable(123)).toBe(false);
    expect(isExportableTable("")).toBe(false);
  });
});

describe("hw 1-3. helmet / /oss CORP / CORS 白名单", () => {
  it("每个响应都带 nosniff 与 X-Frame-Options（helmet 真的挂上了）", async () => {
    const r = await serveAndFetch(
      (app) => {
        hardeningStack(app);
        app.get("/ping", (_req, res) => res.status(200).send({ ok: true }));
      },
      { path: "/ping" },
    );
    expect(r.status).toBe(200);
    expect(r.headers["x-content-type-options"], "缺 X-Content-Type-Options（helmet 没生效？）").toBe("nosniff");
    expect(r.headers["x-frame-options"], "缺 X-Frame-Options（点劫持防线）").toBeDefined();
  });

  it("/oss 的图片响应**不得**带 Cross-Origin-Resource-Policy: same-origin（否则 dev 页面一张图都没有）", async () => {
    const ossDir = path.join(TMP, "oss");
    fs.mkdirSync(ossDir, { recursive: true });
    fs.writeFileSync(path.join(ossDir, "pixel.txt"), "oss-fixture\n");
    const r = await serveAndFetch(
      (app) => {
        hardeningStack(app);
        app.use("/oss", express.static(ossDir));
      },
      { path: "/oss/pixel.txt" },
    );
    expect(r.status, "静态资源必须真的被读到（否则这条断言是空转）").toBe(200);
    expect(r.body).toContain("oss-fixture");
    const corp = r.headers["cross-origin-resource-policy"];
    expect(corp, "/oss 响应必须显式声明 CORP（helmet 默认 same-origin 会让跨源图片被拒收）").toBeDefined();
    expect(corp, "same-origin 就是那个「接口全正常、图全裂」的症状").not.toBe("same-origin");
    expect(corp).toBe("cross-origin");
  });

  it("CORS：非白名单 Origin 不回 ACAO；白名单 Origin 精确回显（旧实现是 origin:\"*\"）", async () => {
    const allow = "http://127.0.0.1:10599";
    const evil = "https://evil.example";
    const build = (app: express.Express) => {
      applySecurityHeaders(app);
      app.get("/ping", (_req, res) => res.status(200).send({ ok: true }));
    };

    const bad = await serveAndFetch(build, { path: "/ping", headers: { Origin: evil } });
    expect(bad.status, "被拒的来源不该变成 5xx（那是把 CORS 错误当服务端故障）").toBeLessThan(500);
    expect(bad.headers["access-control-allow-origin"], "非白名单来源绝不能回 ACAO").toBeUndefined();

    const good = await serveAndFetch(build, { path: "/ping", headers: { Origin: allow } });
    expect(good.status).toBe(200);
    expect(good.headers["access-control-allow-origin"], "白名单来源必须精确回显（不能是 *）").toBe(allow);
    expect(good.headers["access-control-allow-credentials"]).toBe("true");
    expect(allowedOrigins(), "白名单必须来自产品代码（测试不手写第二份真相）").toContain(allow);

    // 无 Origin（同源/curl/服务端）必须放行：verify-phase0/1b 的脚本就是这类请求
    const noOrigin = await serveAndFetch(build, { path: "/ping" });
    expect(noOrigin.status).toBe(200);
  });

  it("corsOrigin 回调的判定：合法/非法/缺省三条路各自明确（不是靠 cors 的默认行为碰运气）", async () => {
    const cb = corsOrigin();
    const call = (origin: string | undefined) => new Promise<{ err: Error | null; ok?: boolean }>((resolve) => cb(origin, (err, ok) => resolve({ err, ok })));
    const allow = "http://127.0.0.1:10599";
    expect((await call(undefined)).ok, "缺省 Origin ⇒ 放行").toBe(true);
    expect((await call(allow)).ok, "白名单 ⇒ 放行").toBe(true);
    const evil = await call("https://evil.example");
    expect(evil.err, "非法来源**不抛错**（抛错会变成 500 + 误导性服务端日志）").toBeNull();
    expect(evil.ok, "非法来源 ⇒ 不放行").toBe(false);
  });
});

describe("hw 4. 错误响应脱敏（真实 UNIQUE 约束冲突）", () => {
  it("500 响应体不含 UNIQUE/表名/列名/绝对路径/堆栈；日志里保留完整诊断（含 requestId）", async () => {
    const file = path.join(TMP, "leak.sqlite");
    const db: Knex = knexFactory({ client: "better-sqlite3", connection: { filename: file }, useNullAsDefault: true });
    try {
      await db.schema.createTable("o_user", (t) => {
        t.integer("id").primary();
        t.text("username").notNullable().unique();
      });
      await db("o_user").insert({ id: 1, username: "dup-username" });

      const logged: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
      let reply: Reply;
      try {
        reply = await serveAndFetch(
          (app) => {
            hardeningStack(app);
            app.get("/boom", async (req, _res, next) => {
              (req as any).ctx = { requestId: "req-id-under-test" };
              try {
                await db("o_user").insert({ id: 2, username: "dup-username" });
                next(new Error("不该走到这里：重复 username 必须抛唯一约束错"));
              } catch (err) {
                next(err);
              }
            });
            app.use(errorHandler);
          },
          { path: "/boom" },
        );
      } finally {
        spy.mockRestore();
      }

      expect(reply.status, "真实约束冲突必须是 500").toBe(500);
      // 先把"改前是什么样"钉住，避免这条断言变成空转：探针实测响应体是
      // {"code":"SQLITE_CONSTRAINT_UNIQUE"}（send(err)），或默认处理器下的整页 HTML + 绝对路径堆栈。
      expect(reply.body, "响应体不得含约束类型").not.toMatch(/UNIQUE/i);
      expect(reply.body, "响应体不得含表名/列名").not.toMatch(/o_user|username/i);
      expect(reply.body, "响应体不得含依赖绝对路径").not.toMatch(/node_modules|\.pnpm|[A-Za-z]:[\\/]/);
      expect(reply.body, "响应体不得含堆栈").not.toMatch(/\bat \w/);
      expect(reply.body, "响应体不得含 SQL 片段").not.toMatch(/insert into/i);
      expect(reply.body, "对外必须是统一文案").toContain("服务器内部错误");
      expect(reply.body).toMatch(/"code"\s*:\s*500/);

      // 对内：日志必须**保留**可诊断信息（表名/列名/堆栈），并且带上 requestId 可串联
      const text = logged.join("\n");
      expect(text, "日志里必须保留 requestId").toContain("req-id-under-test");
      expect(text, "日志里必须保留原始错误（表/列/约束名）").toMatch(/UNIQUE constraint failed|o_user/);
    } finally {
      await db.destroy();
    }
  });

  it("4xx 的错误文案要透出（否则前端不知道哪里填错），但同样不带堆栈/路径", async () => {
    const r = await serveAndFetch(
      (app) => {
        hardeningStack(app);
        app.get("/bad", (_req, _res, next) => {
          const err: any = new Error("参数不合法：tableName 缺失");
          err.status = 400;
          next(err);
        });
        app.use(errorHandler);
      },
      { path: "/bad" },
    );
    expect(r.status).toBe(400);
    expect(r.body).toContain("参数不合法");
    expect(r.body).not.toMatch(/\bat \w|[A-Za-z]:[\\/]/);
  });
});

describe("hw 5. 限流（429）", () => {
  it(`超过 apiLimiter 阈值 ⇒ 429，且阈值在 dev 也生效（dev=${API_LIMIT_DEV}，旧版是 skip = 永不可达）`, async () => {
    // 用**同一份 createLimiter**装一个小阈值实例（不是复制实现）：这条断言测的是"429 分支可达"，
    // 而"dev 放宽是否真的放宽"由 API_LIMIT_DEV > API_LIMIT_PROD 与下面那条阈值断言共同保证。
    const small = createLimiter({ max: 3, windowMs: 60_000, message: "too many" });
    const statuses: number[] = [];
    const app = express();
    app.use("/rl", small);
    app.get("/rl", (_req, res) => res.status(200).send({ ok: true }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/rl`);
        statuses.push(res.status);
        if (i === 3) {
          expect(res.headers.get("retry-after"), "429 必须带 Retry-After").toBeTruthy();
          const body = await res.json();
          expect(body).toMatchObject({ code: 429, data: null });
        } else {
          await res.text();
        }
      }
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
    expect(statuses, "前 3 次放行、第 4 次 429").toEqual([200, 200, 200, 429]);
    expect(API_LIMIT_DEV, "dev 阈值必须比 prod 宽松（300）").toBeGreaterThan(300);
  });

  it("loginLimiter 全局限流档的两端都在：30 次内放行、第 31 次 429（按 IP+用户名分桶）", async () => {
    const app = express();
    app.use(express.json());
    app.post("/login", loginLimiter, (_req, res) => res.status(200).send({ ok: true }));
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      // ⚠ 用户名必须**固定**：`loginLimiter` 的桶键是 `IP|username`，
      //   每次换 username 就等于换一个桶 ⇒ 永远限不住（第一版就是这么假绿的）。
      let last = 0;
      let firstRejectedAt = -1;
      for (let i = 1; i <= 31; i++) {
        const res = await fetch(`http://127.0.0.1:${port}/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: "rl-fixed-user", password: "x" }),
        });
        await res.text();
        last = res.status;
        if (res.status === 429 && firstRejectedAt === -1) firstRejectedAt = i;
      }
      expect(firstRejectedAt, "第 31 次必须被限流（阈值 30）").toBe(31);
      expect(last).toBe(429);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("hw 6. trust proxy", () => {
  it("app.set(\"trust proxy\", 1) 后 X-Forwarded-For 生效（req.ip = 真实客户端，而不是反代地址）", async () => {
    const withProxy = await serveAndFetch(
      (app) => {
        app.set("trust proxy", 1);
        app.get("/ip", (req, res) => res.status(200).send({ ip: req.ip }));
      },
      { path: "/ip", headers: { "X-Forwarded-For": "203.0.113.9, 10.0.0.1" } },
    );
    expect(JSON.parse(withProxy.body).ip, "trust proxy=1 ⇒ 取 XFF 最右侧的那个（即直接对端）").toBe("10.0.0.1");

    const noProxy = await serveAndFetch(
      (app) => {
        app.set("trust proxy", 0);
        app.get("/ip", (req, res) => res.status(200).send({ ip: req.ip }));
      },
      { path: "/ip", headers: { "X-Forwarded-For": "203.0.113.9, 10.0.0.1" } },
    );
    expect(JSON.parse(noProxy.body).ip, "trust proxy=0 ⇒ 完全忽略 XFF（客户端可伪造 XFF 绕过限流/锁定）").toBe("127.0.0.1");
  });
});
