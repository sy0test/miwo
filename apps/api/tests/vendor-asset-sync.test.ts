/**
 * Task 10：`003_vendor_asset_sync` 的判据（Phase 0 的两条 deferred）。
 *
 * 覆盖五件事：
 *   1. `up` **只报告不写盘**（内容与 mtime 都不变）；
 *   2. `down` 是 no-op；
 *   3. **启动链**（`src/db/**`、`src/utils/db.ts`、`src/app.ts`；Phase 1c Task 5 起
 *      `src/lib/{initDB,fixDB}.ts` 已删除、不再在链上）
 *      里不再有任何"写 vendor 文件"的代码形态 —— 这是"构造性消除 `\r\n` 假红灯"的守卫，
 *      **有判别力**：把 `writeCode(...)` 临时加回 `src/db/**` 下的任一文件必须让本用例变红；
 *   4. `src/**` 全树里**只有** `utils/vendor.ts` 写 `data/vendor/*.ts`（其余调用方都是**请求期**的
 *      供应商配置页接口，不在启动路径上，brief Step 2 的 `git grep` 期望值就是它们）；
 *   5. 真仓库的 `data/vendor/*.ts` 当前不含 CR 字节。
 *
 * ⚠ 本文件**不得** import `@/utils` / `@/utils/db`：那会把 knex/连接链拖进来
 *   （`db-boot-order.test.ts` 文件头记录了同一个坑）。这里只读源码文本 + 只跑迁移本体。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import migration, { reconcileVendorAssets } from "@/db/migrations/003_vendor_asset_sync";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-vendor-sync-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

const API_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(API_ROOT, "src");

/** 去掉注释（保留换行）：注释里**故意**留了"不要恢复 tempOnsert/writeCode"的横幅，不能当代码命中。 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")).replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 启动链上的文件（按目录/文件枚举，避免"以后新增的文件悄悄绕过守卫"）。
 *  ⚠ Phase 1c Task 5：`lib/initDB.ts` / `lib/fixDB.ts` 已**删除**，不再进这份清单
 *    （它们曾经是启动链上"会写 vendor 文件"的地方，现在连文件都没有了）。 */
function startupFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(path.join(SRC, "db"));
  for (const rel of ["utils/db.ts", "app.ts"]) out.push(path.join(SRC, ...rel.split("/")));
  return out;
}

/** `src/**` 全部 .ts（含测试脚本外的源码），用于"谁在写 vendor 文件"的全树点名。 */
function allSrcTs(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".ts")) out.push(p);
    }
  };
  walk(SRC);
  return out;
}

/** "写 vendor 文件"的代码形态（不含 `utils/vendor.ts` 里的定义本身）。 */
const VENDOR_WRITE = [
  { name: "tempOnsert(", re: /tempOnsert\s*\(/ },
  { name: "writeCode(", re: /writeCode\s*\(/ },
  // 直接拿 vendor 路径去写盘（`getPath("vendor")` / `"vendor"` 拼出来的路径）
  { name: "getPath(\"vendor\") 附近写盘", re: /getPath\(\s*["']vendor["']\s*\)[\s\S]{0,400}?(writeFileSync|appendFileSync|createWriteStream|mkdirSync\()/ },
  // `writeFileSync(<含 vendor 的路径>)` / `writeFile("vendor/...")`
  { name: "writeFileSync(含 vendor 的路径)", re: /writeFileSync\([^)]{0,200}vendor/ },
  { name: "writeFileSync(\"…/vendor/\")", re: /writeFileSync\(\s*["'][^"']*vendor[\\/]/ },
  { name: "createWriteStream(含 vendor 的路径)", re: /createWriteStream\([^)]{0,200}vendor/ },
];

const rel = (p: string) => path.relative(API_ROOT, p).replace(/\\/g, "/");

describe("003_vendor_asset_sync（Phase 0 deferred：vendor.json 与 data/vendor 的漂移 / \\r\\n 假红灯）", () => {
  it("up 只报告不写盘：跑之前/之后的文件 mtime 与内容都不变", async () => {
    // 造一个假的 MiWO_DATA_DIR 与 vendor 目录
    const dataDir = path.join(TMP, "data");
    const vdir = path.join(dataDir, "vendor");
    fs.mkdirSync(vdir, { recursive: true });
    // 用真仓库的 vendor.json 当模板源（只读）
    const repoVendorJson = path.join(API_ROOT, "src", "lib", "vendor.json");
    const templates = JSON.parse(fs.readFileSync(repoVendorJson, "utf8"));
    const first = Object.keys(templates)[0];
    const target = path.join(vdir, first);
    fs.writeFileSync(target, "// 故意不一致的版本\nconst vendor = { id: 'x', version: '0.1' };\n", "utf8");
    const before = fs.readFileSync(target);
    const mtimeBefore = fs.statSync(target).mtimeMs;

    const prev = process.env.MIWO_DATA_DIR;
    process.env.MIWO_DATA_DIR = dataDir;
    try {
      await migration.up({} as any);
      await new Promise((r) => setTimeout(r, 30));
      expect(fs.readFileSync(target)).toEqual(before); // 内容一字不改
      expect(fs.statSync(target).mtimeMs).toBe(mtimeBefore); // 连 mtime 都不动
    } finally {
      if (prev === undefined) delete process.env.MIWO_DATA_DIR;
      else process.env.MIWO_DATA_DIR = prev;
    }
  });

  it("down 是 no-op（跑完不改变任何东西）", async () => {
    await expect(migration.down({} as any)).resolves.toBeUndefined();
  });

  it("对账**真的会报**：版本不一致 / 文件缺失 / 含 CR 三种情况都被逐行打出来（不静默）", async () => {
    const dataDir = path.join(TMP, "data2");
    const vdir = path.join(dataDir, "vendor");
    fs.mkdirSync(vdir, { recursive: true });
    const templates = JSON.parse(fs.readFileSync(path.join(API_ROOT, "src", "lib", "vendor.json"), "utf8")) as Record<string, string>;
    const files = Object.keys(templates);
    // 第一个：版本故意写错（漂移）；第二个：带 CR（假红灯面）；第三个：干脆不写（缺失）
    fs.writeFileSync(path.join(vdir, files[0]), "const vendor = { id: 'a', version: '0.0' };\n", "utf8");
    fs.writeFileSync(path.join(vdir, files[1]), "const vendor = { id: 'b', version: '9.9' };\r\n", "utf8");
    const prev = process.env.MIWO_DATA_DIR;
    process.env.MIWO_DATA_DIR = dataDir;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { rows } = reconcileVendorAssets();
      expect(rows.length).toBe(files.length);
      const byName = new Map(rows.map((r) => [r.file, r]));
      expect(byName.get(files[0])!.drift, "版本 0.0 ≠ 模板 → 必须报漂移").toBe(true);
      expect(byName.get(files[1])!.hasCr, "写进去的 CR 字节 → 必须报 [含 CR]").toBe(true);
      expect(byName.get(files[2])!.fileVer, "缺失文件 → 文件版本为 null").toBeNull();
      expect(byName.get(files[2])!.drift, "缺失文件 → 必须报漂移").toBe(true);

      const logs: string[] = [];
      spy.mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
      await migration.up({} as any);
      const text = logs.join("\n");
      expect(text).toMatch(/对账 \d+ 个适配器：版本漂移 \d+，含 CR 字节 \d+/);
      expect(text, "漂移行必须逐行出现").toContain(files[0]);
      expect(text, "含 CR 的行必须带标记").toMatch(new RegExp(`${files[1].replace(".", "\\.")}[^\\n]*\\[含 CR\\]`));
      expect(text, "含 CR 时应给出处置建议").toContain("normalize-eol");
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.MIWO_DATA_DIR;
      else process.env.MIWO_DATA_DIR = prev;
    }
  });

  it("启动链（db/**、utils/db.ts、app.ts）没有任何写 vendor 文件的代码", () => {
    const hits: string[] = [];
    for (const p of startupFiles()) {
      const code = stripComments(fs.readFileSync(p, "utf8"));
      for (const pat of VENDOR_WRITE) if (pat.re.test(code)) hits.push(`${rel(p)} → ${pat.name}`);
    }
    expect(hits, `启动链上仍会写 vendor 资产：\n  ${hits.join("\n  ")}`).toEqual([]);
  });

  it("src/** 全树里只有 utils/vendor.ts 写 vendor 文件（其余调用方都在请求期路由里）", () => {
    const hits: string[] = [];
    for (const p of allSrcTs()) {
      if (p.endsWith(path.join("utils", "vendor.ts"))) continue;
      const code = stripComments(fs.readFileSync(p, "utf8"));
      for (const pat of VENDOR_WRITE) if (pat.re.test(code)) hits.push(`${rel(p)} → ${pat.name}`);
    }
    // 允许清单：**请求期**的供应商配置页接口（用户点"保存/新增供应商"时才写盘，不是启动期）。
    // 允许条目只能是这两个文件 —— 任何新出现的写盘点都要人工过一遍再进这份清单。
    const ALLOW = ["src/routes/setting/vendorConfig/addVendor.ts", "src/routes/setting/vendorConfig/updateCode.ts"];
    const unexpected = hits.filter((h) => !ALLOW.some((a) => h.startsWith(a + " → ")));
    expect(unexpected, `新出现的 vendor 写盘点（需人工确认是否在请求期）：\n  ${unexpected.join("\n  ")}`).toEqual([]);
    // 反向断言：允许清单本身必须"真的在用"（不然清单会随重构悄悄失效）
    for (const a of ALLOW) expect(hits.some((h) => h.startsWith(a + " → ")), `${a} 不再是写盘点，请从允许清单里删掉`).toBe(true);
  });

  it("两个会写 vendor 文件的旧模块**已删除**（Phase 1c Task 5；比「字面形态不在」更强的不变式）", () => {
    // Task 5 之前这条用例读 `src/lib/fixDB.ts` 断言"`code ?? \"\"` / tempOnsert / writeCode / vendor.json
    // 的字面形态都不在了"。文件被删之后，更强的说法是"它们根本不存在" —— 写盘面**构造性消失**。
    for (const f of ["fixDB.ts", "initDB.ts"]) {
      expect(fs.existsSync(path.join(API_ROOT, "src", "lib", f)), `src/lib/${f} 应已在 Phase 1c Task 5 删除`).toBe(false);
    }
  });

  it("真仓库的 data/vendor/*.ts 当前不含 CR 字节（否则 check-eol 会假红灯）", () => {
    const dir = path.join(API_ROOT, "data", "vendor");
    // ⚠ 原来是 `if (!fs.existsSync(dir)) return;`（**静默早退**）——本文件的改动把这两条用例推到
    //    了 `tools/check-test-early-return.cjs` 的判据里，于是它被如实报红。这里**不是**为了让门禁
    //    变绿而放宽：`data/vendor` 是**仓库内**的受控资产（`check-copy.cjs` 断言它有 13 个 .ts），
    //    它不在磁盘上本身就是**应失败**的状态，不是"该跳过"。改成显式失败（含可执行的修复提示）。
    expect(fs.existsSync(dir), `缺少受控资产目录 ${dir}（它应由 git 跟踪带下来，缺了说明 checkout 不完整）`).toBe(true);
    const withCr = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && fs.readFileSync(path.join(dir, f)).includes(0x0d));
    expect(withCr, `这些适配器文件含 CR，跑 tools/normalize-eol.cjs --apply 修复：${withCr.join(", ")}`).toEqual([]);
  });

  it("真仓库 13 个适配器都是合法 UTF-8 且无 NUL（对账读的是 utf8；也有别的工具会读它们）", () => {
    const dir = path.join(API_ROOT, "data", "vendor");
    expect(fs.existsSync(dir), `缺少受控资产目录 ${dir}（同上：受控资产不在磁盘上 = 应失败，不是该跳过）`).toBe(true);
    const bad: string[] = [];
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".ts"))) {
      const buf = fs.readFileSync(path.join(dir, f));
      // 严格 UTF-8：坏字节会让 readFileSync(utf8) 静默变成 U+FFFD，别等下游去发现
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(buf);
      } catch {
        bad.push(`${f}（不是合法 UTF-8）`);
      }
      if (buf.includes(0x00)) bad.push(`${f}（含 NUL 字节）`);
    }
    expect(bad, `这些适配器不是干净文本：${bad.join(", ")}`).toEqual([]);
  });

  it("对账只报告、不猜：没有 `version` 字段的适配器记成 (无)/null，且磁盘与模板一致时不算漂移", async () => {
    // vidu.ts 是真实存在的例子：它**没有** `version` 字段（磁盘与 vendor.json 都没有）。
    // 先在**真仓库**语镜下确认这条边界（磁盘侧 null === 模板侧 null → 不算漂移）。
    // ⚠ 语镜要显式给：vitest 的 `MIWO_DATA_DIR` 是 `D:\tmp\miwo-test-data`（可能不存在），
    //    而模板源默认取 `<cwd>/src/lib/vendor.json` —— 这里两个都按**仓库绝对路径**传，不靠 cwd。
    const repoData = path.join(API_ROOT, "data");
    const repoJson = path.join(API_ROOT, "src", "lib", "vendor.json");
    const prevData = process.env.MIWO_DATA_DIR;
    process.env.MIWO_DATA_DIR = repoData;
    let realRows;
    try {
      realRows = reconcileVendorAssets({ jsonPath: repoJson }).rows;
    } finally {
      if (prevData === undefined) delete process.env.MIWO_DATA_DIR;
      else process.env.MIWO_DATA_DIR = prevData;
    }
    const real = realRows.find((x) => x.file === "vidu.ts");
    expect(real, "真仓库的 vidu.ts 必须在对账表里（13 个之一）").toBeDefined();
    expect(real!.fileVer, "vidu.ts 磁盘侧没有 version 字段").toBeNull();
    expect(real!.templateVer, "vendor.json 的 vidu.ts 模板也没有 version 字段").toBeNull();
    expect(real!.drift, "两侧都解析不到 version → 不报漂移（不猜）").toBe(false);

    // 再在临时语镜下确认反向：磁盘解析不到而模板有 → 必须报漂移（"解析不到"不等于"没问题"）
    const dataDir = path.join(TMP, "data3");
    const vdir = path.join(dataDir, "vendor");
    fs.mkdirSync(vdir, { recursive: true });
    const jsonPath = path.join(API_ROOT, "src", "lib", "vendor.json");
    const templates = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as Record<string, string>;
    const first = Object.keys(templates)[0];
    fs.writeFileSync(path.join(vdir, first), "const vendor = { id: 'x' };\n", "utf8");
    const prev = process.env.MIWO_DATA_DIR;
    process.env.MIWO_DATA_DIR = dataDir;
    try {
      const { rows } = reconcileVendorAssets({ jsonPath });
      const r = rows.find((x) => x.file === first)!;
      expect(r.fileVer).toBeNull();
      expect(r.templateVer).not.toBeNull();
      expect(r.drift, "磁盘解析不到 version 而模板有 → 必须报漂移").toBe(true);
      // 缺失文件同理必须报（不是静默跳过）
      const missing = rows.find((x) => x.file === "vidu.ts")!;
      expect(missing.fileVer).toBeNull();
      expect(missing.drift, "文件缺失 → 必须报漂移").toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MIWO_DATA_DIR;
      else process.env.MIWO_DATA_DIR = prev;
    }
  });
});
