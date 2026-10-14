/**
 * Task 4 Step 4：启动路径的**顺序**断言（spec §3.3「启动竞态」）。
 *
 * 为什么用"读源码 + 断言位置"而不是起一次真进程：
 *   1. 真进程只能证明"这一次跑通了"，证明不了"下次有人把 `await dbReady` 挪到 `server.listen` 之后
 *      或在 `utils/db.ts` 里加回 `initDB()` 会不会被发现" —— 而后者才是 spec §3.3 点名的风险。
 *   2. 本仓库是 CJS（`module: CommonJS`），顶层 await 不可用，"db 就绪"是一个**导出的 Promise**；
 *      "谁 await 它、在 listen 之前还是之后"是**文本层面**的不变式，静态断言才是精确的判据。
 *   （运行期的端到端证据是 `scripts/verify-phase0.cjs` 的「C 应用能起」+ Task 4 Step 5 的两次启动。）
 *
 * ⚠ 本文件**不得** import `@/utils/db` 或 `@/utils`：那两个模块在求值时会立刻发起连接 + 跑迁移，
 *   而 `dbReady.catch` 在失败时会 `process.exit(1)` —— 那会把整个 vitest 进程打死
 *   （而不是让这个用例变红）。所以下面一律用 `fs.readFileSync` 读源码，只有最后一条用例
 *   才 import `@/db/connect`（它只建 knex 实例、不碰 utils 链）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-boot-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const API_ROOT = path.resolve(__dirname, "..");
const readSrc = (...parts: string[]) => fs.readFileSync(path.join(API_ROOT, ...parts), "utf8");

/** 去掉注释后的代码（保留换行，避免把"注释里提到 initDB"误判成"代码里用了 initDB"）。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^[ \t]*\/\/.*$/gm, "");
}

describe("启动路径（spec §3.3 启动竞态）", () => {
  it("utils/db.ts 导出 dbReady，且调用方（app.ts）在 listen 之前 await 它", () => {
    const dbSrc = readSrc("src", "utils", "db.ts");
    expect(dbSrc).toMatch(/export const dbReady\s*:\s*Promise<void>/);
    expect(dbSrc).toMatch(/dbReady\.catch\(/);
    // 失败必须退出，而不是像 err.ts 那样只打印
    expect(dbSrc).toMatch(/process\.exit\(1\)/);

    const appSrc = readSrc("src", "app.ts");
    const listenIdx = appSrc.indexOf("server.listen(");
    const readyIdx = appSrc.indexOf("await dbReady");
    expect(listenIdx, "app.ts 里应当有 server.listen(").toBeGreaterThan(-1);
    expect(readyIdx, "app.ts 里应当在 listen 之前 await dbReady").toBeGreaterThan(-1);
    expect(readyIdx, "await dbReady 必须在 server.listen 之前").toBeLessThan(listenIdx);
  });

  it("utils/db.ts 不再在启动路径上调用 initDB / fixDB", () => {
    const dbSrc = readSrc("src", "utils", "db.ts");
    // 允许在注释里提到它们，但不允许有 import 或调用
    const code = stripComments(dbSrc);
    expect(code).not.toMatch(/import\s+initDB/);
    expect(code).not.toMatch(/import\s+fixDB/);
    expect(code).not.toMatch(/\binitDB\s*\(/);
    expect(code).not.toMatch(/\bfixDB\s*\(/);
  });

  it("utils/db.ts 的 dbReady 真的接了 connect()（不是空壳 Promise）", () => {
    const code = stripComments(readSrc("src", "utils", "db.ts"));
    expect(code).toMatch(/import\s*\{[^}]*\bconnect\b[^}]*\}\s*from\s*"@\/db\/connect"/);
    expect(code).toMatch(/await connect\(\)/);
    // "已应用迁移" 是 Step 5 端到端要肉眼确认的那行日志，必须来自 dbReady 里
    expect(code).toMatch(/已应用迁移/);
  });

  it("两个退役的启动期 DDL 模块**已从仓库删除**（Phase 1c Task 5）", () => {
    // ⚠ 这条断言在 Task 5 之前是反向的（"两个文件顶部都标了已停用"）。删文件之后，
    //   真正要钉住的不变式变成"它们不许回来"：一旦有人把任一文件恢复（哪怕只是留着不 import），
    //   本用例立刻红 —— 而"有没有被 import"由 `tools/check-dead-ddl.cjs` 从 app.ts 走 import 图负责。
    for (const f of ["initDB.ts", "fixDB.ts"]) {
      expect(fs.existsSync(path.join(API_ROOT, "src", "lib", f)), `src/lib/${f} 应已在 Phase 1c Task 5 删除`).toBe(false);
    }
    expect(fs.existsSync(path.join(API_ROOT, "src", "core.ts")), "src/core.ts 应已在 Phase 1c Task 5 删除").toBe(false);
  });

  it("connect() 在连不上时给出可操作的报错（不是裸的 tarn 超时）", async () => {
    const { connect } = await import("@/db/connect");
    const cfg = {
      env: "dev",
      port: 10599,
      host: "127.0.0.1",
      dataDir: TMP,
      mediaDir: path.join(TMP, "oss"),
      storageDriver: "local",
      publicBaseUrl: "http://127.0.0.1:10599",
      trustProxy: 0,
      jwtSecret: "x".repeat(48),
      // 指向一个必定连不上的 mysql
      db: { driver: "mysql", host: "127.0.0.1", port: 1, user: "x", password: "x", name: "x", poolMin: 1, poolMax: 1 },
    } as any;
    await expect(connect(cfg)).rejects.toThrow(/无法连接/);
  }, 30000);

  it("mysql 连接配置带 connectTimeout（否则网络抖动时启动会挂很久）", async () => {
    const { DBCONFIG, connectionConfig } = await import("@/db/connect");
    expect(DBCONFIG.connectTimeout).toBeGreaterThan(0);
    const c = connectionConfig({
      db: { driver: "mysql", host: "h", port: 3306, user: "u", password: "", name: "n", poolMin: 1, poolMax: 1 },
    } as any);
    expect(c.connectTimeout).toBe(DBCONFIG.connectTimeout);
  });
});
