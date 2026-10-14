/**
 * Task 10 / **Phase 1c Task 8 迁移后**：`003_vendor_asset_sync` 的判据。
 *
 * ── Task 8 之前这个文件测的是什么 ──
 * "`src/lib/vendor.json`（13 个适配器模板的入库快照）与 `data/vendor/*.ts` 的版本对账"：
 * `up` 只报告不写盘、`down` no-op、`\r\n` 假红灯面被构造性消除。
 *
 * ── Task 8 之后为什么必须重写 ──
 * 那两个资产**被删除了**（适配器改成编译期内置的 `src/vendors/*.ts`，`vendor.json` 的唯一消费者
 * `fixDB.ts` 已在 Task 5 删除）。旧用例会 `JSON.parse(readFileSync(src/lib/vendor.json))` ⇒ ENOENT。
 * 于是本文件改成钉**删除之后的不变式**（比"字面形态不在"更强的说法）：
 *   1. `src/lib/vendor.json` 与 `data/vendor/` **根本不存在**（写盘面 + 对账面同时消失）；
 *   2. `up` 在"模板源缺失"时**如实打一行报告并跳过**（不静默、也不抛 —— 迁移纪律：迁移不能因为
 *      一个已被删除的可选资产而让启动失败）；
 *   3. 对账本体仍是**纯只读**（用临时目录造语镜验证它真能报漂移/缺失/CR 三种情况）；
 *   4. 启动链（`db/**`、`utils/db.ts`、`app.ts`）里**没有任何**"写 vendor 文件"的代码形态；
 *   5. `src/**` 全树里 `writeCode(` / `tempOnsert(` 这些形态**一处都没有**（改前的允许清单
 *      `addVendor.ts` / `updateCode.ts` 已随 Task 9 删除 ⇒ 允许清单本身消失）。
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
 *  ⚠ Phase 1c Task 5：`lib/initDB.ts` / `lib/fixDB.ts` 已**删除**，不再进这份清单。 */
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

/** "写 vendor 文件"的代码形态。 */
const VENDOR_WRITE = [
  { name: "tempOnsert(", re: /tempOnsert\s*\(/ },
  { name: "writeCode(", re: /writeCode\s*\(/ },
  // 直接拿 vendor 路径去写盘（`getPath("vendor")` / `"vendor"` 拼出来的路径）
  { name: "getPath(\"vendor\") 附近写盘", re: /getPath\(\s*["']vendor["']\s*\)[\s\S]{0,400}?(writeFileSync|appendFileSync|createWriteStream|mkdirSync\()/ },
  { name: "writeFileSync(含 vendor 的路径)", re: /writeFileSync\([^)]{0,200}vendor/ },
  { name: "writeFileSync(\"…/vendor/\")", re: /writeFileSync\(\s*["'][^"']*vendor[\\/]/ },
  { name: "createWriteStream(含 vendor 的路径)", re: /createWriteStream\([^)]{0,200}vendor/ },
];

const rel = (p: string) => path.relative(API_ROOT, p).replace(/\\/g, "/");

describe("003_vendor_asset_sync（Phase 1c Task 8 迁移后：资产已删，只留只读对账）", () => {
  it("★ `src/lib/vendor.json` 与 `data/vendor/` **已删除**（对账面与写盘面同时消失）", () => {
    expect(fs.existsSync(path.join(API_ROOT, "src", "lib", "vendor.json")), "src/lib/vendor.json 应已在 Task 8 删除").toBe(false);
    expect(fs.existsSync(path.join(API_ROOT, "data", "vendor")), "data/vendor/ 应已在 Task 8 删除").toBe(false);
  });

  it("★ 模板源缺失时 `up` **如实报告并跳过**（不静默、不抛；迁移不许因已删资产让启动失败）", async () => {
    const prev = process.env.MIWO_DATA_DIR;
    // 一个**存在**的数据目录 + 一个**不存在**的模板源 ⇒ 命中 missingJson 分支
    const dataDir = path.join(TMP, "no-template");
    fs.mkdirSync(path.join(dataDir, "vendor"), { recursive: true });
    process.env.MIWO_DATA_DIR = dataDir;
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
    try {
      await expect(migration.up({} as any)).resolves.toBeUndefined();
      const text = logs.join("\n");
      expect(text, "必须打一行说明（静默跳过 = 事后无法证明它跑过）").toMatch(/找不到 .*vendor\.json.*跳过对账/);
    } finally {
      spy.mockRestore();
      if (prev === undefined) delete process.env.MIWO_DATA_DIR;
      else process.env.MIWO_DATA_DIR = prev;
    }
  });

  it("对账本体仍是**纯只读**：真仓库没有模板源时 rows 为空、missingJson=true（不猜）", () => {
    const prev = process.env.MIWO_DATA_DIR;
    process.env.MIWO_DATA_DIR = path.join(TMP, "readonly-nowhere");
    try {
      const r = reconcileVendorAssets({ jsonPath: path.join(TMP, "definitely-absent.json") });
      expect(r.missingJson, "模板源不存在 ⇒ missingJson=true（调用方据此打'跳过'，不是当成 0 漂移）").toBe(true);
      expect(r.rows, "没有模板就没有行 —— 不许凭空造").toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.MIWO_DATA_DIR;
      else process.env.MIWO_DATA_DIR = prev;
    }
  });

  it("对账**真的会报**：版本不一致 / 文件缺失 / 含 CR 三种情况都被逐行打出来（不静默）", async () => {
    const dataDir = path.join(TMP, "data2");
    const vdir = path.join(dataDir, "vendor");
    fs.mkdirSync(vdir, { recursive: true });
    // ⚠ 语镜要**从 cwd 上凑齐**：`migration.up()` 走的是**默认**模板源
    //   （`<cwd>/src/lib/vendor.json`，见 003 的 `reconcileVendorAssets`），它不接受 jsonPath 覆盖。
    //   Task 8 之后仓库里已经没有 `src/lib/vendor.json` 了，所以这里临时把 cwd 换成一次性目录，
    //   并在里面放一份合成模板 —— 这样测的是**迁移本体**，而不是"被参数绕过的那个函数"。
    //   ⚠ cwd 是进程级共享状态：必须在 finally 里**精确还原**（不是"设成某个默认值"）。
    const tplDir = path.join(TMP, "tpl2");
    const jsonPath = path.join(tplDir, "src", "lib", "vendor.json");
    fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
    fs.writeFileSync(
      jsonPath,
      JSON.stringify({
        "a.ts": 'const vendor = { id: "a", version: "1.0" };\n',
        "b.ts": 'const vendor = { id: "b", version: "1.0" };\n',
        "c.ts": 'const vendor = { id: "c", version: "1.0" };\n',
      }),
      "utf8",
    );
    // 第一个：版本故意写错（漂移）；第二个：带 CR（假红灯面）；第三个：干脆不写（缺失）
    fs.writeFileSync(path.join(vdir, "a.ts"), "const vendor = { id: 'a', version: '0.0' };\n", "utf8");
    fs.writeFileSync(path.join(vdir, "b.ts"), "const vendor = { id: 'b', version: '1.0' };\r\n", "utf8");
    const prev = process.env.MIWO_DATA_DIR;
    const prevCwd = process.cwd();
    process.env.MIWO_DATA_DIR = dataDir;
    process.chdir(tplDir);
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { rows } = reconcileVendorAssets({ jsonPath });
      expect(rows.length).toBe(3);
      const byName = new Map(rows.map((r) => [r.file, r]));
      expect(byName.get("a.ts")!.drift, "版本 0.0 ≠ 模板 1.0 → 必须报漂移").toBe(true);
      expect(byName.get("b.ts")!.hasCr, "写进去的 CR 字节 → 必须报 [含 CR]").toBe(true);
      expect(byName.get("c.ts")!.fileVer, "缺失文件 → 文件版本为 null").toBeNull();
      expect(byName.get("c.ts")!.drift, "缺失文件 → 必须报漂移").toBe(true);

      const logs: string[] = [];
      spy.mockImplementation((...args: unknown[]) => void logs.push(args.map(String).join(" ")));
      await migration.up({} as any);
      const text = logs.join("\n");
      expect(text).toMatch(/对账 \d+ 个适配器：版本漂移 \d+，含 CR 字节 \d+/);
      expect(text, "漂移行必须逐行出现").toContain("a.ts");
      expect(text, "含 CR 的行必须带标记").toMatch(/b\.ts[^\n]*\[含 CR\]/);
      expect(text, "含 CR 时应给出处置建议").toContain("normalize-eol");
    } finally {
      spy.mockRestore();
      process.chdir(prevCwd);
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

  it("★ `src/**` 全树里**一处**写盘形态都没有（Task 9 把最后两个允许项也删了）", () => {
    // 改前这里有一条 `ALLOW = ["…/addVendor.ts", "…/updateCode.ts"]`（请求期的供应商配置页写盘点）
    // + 一条"允许清单必须真的在用"的反向断言。Task 9 删掉那两个路由之后，`writeCode` 本身也
    // 不再是 `utils/vendor.ts` 的导出了 ⇒ 允许清单**消失**，"反向断言"没有对象。
    // 这比"清单为空"更强：不是"没人用了"，是**没有那个能力**了。
    const hits: string[] = [];
    for (const p of allSrcTs()) {
      const code = stripComments(fs.readFileSync(p, "utf8"));
      for (const pat of VENDOR_WRITE) if (pat.re.test(code)) hits.push(`${rel(p)} → ${pat.name}`);
    }
    expect(hits, `仍有 vendor 写盘形态（Task 8/9 之后不应存在）：\n  ${hits.join("\n  ")}`).toEqual([]);
    // 自证观测：全树确实扫到了文件（"一个都没扫到"不等于"干净"，Ruling 243 口径）
    expect(allSrcTs().length, "src/** 下必须有 .ts 被扫到（否则这条断言是空转）").toBeGreaterThan(100);
  });

  it("两个会写 vendor 文件的旧模块**已删除**（Phase 1c Task 5；比「字面形态不在」更强的不变式）", () => {
    for (const f of ["fixDB.ts", "initDB.ts"]) {
      expect(fs.existsSync(path.join(API_ROOT, "src", "lib", f)), `src/lib/${f} 应已在 Phase 1c Task 5 删除`).toBe(false);
    }
  });
});
