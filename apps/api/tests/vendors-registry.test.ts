/**
 * Phase 1c Task 8 的**判别力用例**：供应商适配器已"编译期内置"，沙箱执行通道**不存在**。
 *
 * ── 这个文件要钉的五件事 ──
 *   1. 注册表**恰好**是历史那 13 个 id（与已删除的 `apps/api/data/vendor/` 清单逐一对应）；
 *   2. 适配器的导出面**齐**（`getVendorModule("null")` 的 7 个成员逐个断言）+
 *      **回归锚点** `miwo.vendor.baseUrl === "https://api.toonflow.net/v1"`（真实第三方服务地址，
 *      任何改动都必须让本用例变红）；
 *   3. **单例不污染**（本 Task 最容易出的语义回归）：内置化之后模块是**单例**，旧路径
 *      （`runCode` 每次重新执行适配器代码）拿到的是一份新对象。若有人写成
 *      `Object.assign(mod.vendor.inputValues, …)`，A 用户的 key 会留在模块上被 B 用户读到。
 *   4. `getVendorModule("nope")` → `null`（**不抛**：调用方要能区分"不存在"与"加载失败"）；
 *   5. **全仓静态断言**：`vm2` / `sucrase` / `u.vm(` **0 命中**，且 `package.json` 里没有这两个依赖。
 *
 * ── 运行期那一半（"能力不存在"的真进程证据）在哪 ──
 * `tests/vendor-secrets.test.ts` 用**真应用进程**打真 HTTP：
 *   · 旧的三个"提交/执行代码"接口 ⇒ **404**；
 *   · 真进程里的 `require.cache` **观测不到** vm2/sucrase（观测不到 ⇒ 那条用例自己 exit/红）。
 * 静态断言（本文件）证明"源码里没有这个名字"；运行期断言证明"进程里没有这个模块"。
 * 两者缺一不可：只有静态断言的话，"用别的名字 require 进来"照样能溜过去。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getVendorModule, listVendorIds } from "@/vendors";
import { getVendorConfigFor } from "@/utils/vendor";

const API_ROOT = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(API_ROOT, "..", "..");

/** 历史清单（`git show HEAD:apps/api/data/vendor` 的 13 个文件名，去扩展名并排序）。 */
const HISTORICAL_IDS = [
  "atlascloud",
  "deepseek",
  "grsai",
  "klingai",
  "metoken",
  "minimax",
  "miwo",
  "newapi",
  "null",
  "openai",
  "vidu",
  "volcengine",
  "volcengineSd2",
];

describe("Task 8 · 注册表：13 个编译期内置适配器", () => {
  it("★ listVendorIds() 恰好是历史那 13 个 id（多一个/少一个都红）", () => {
    expect([...listVendorIds()].sort()).toEqual(HISTORICAL_IDS);
  });

  it("★ 每个 id 都能取到模块且带 `vendor`（不存在 ⇒ 用例红，而不是「运行期 undefined」）", () => {
    for (const id of HISTORICAL_IDS) {
      const mod = getVendorModule(id);
      expect(mod, `${id} 必须在注册表里`).toBeTruthy();
      expect(mod!.vendor, `${id} 必须导出 vendor`).toBeTruthy();
      expect(String(mod!.vendor.id), `${id} 的 vendor.id 必须等于注册键`).toBe(id);
    }
  });

  it("★ `getVendorModule(\"null\")` 的 7 个导出齐（null 是保留字，注册表用 nullVendor 别名）", () => {
    const mod = getVendorModule("null");
    expect(mod).toBeTruthy();
    for (const fn of ["textRequest", "imageRequest", "videoRequest", "ttsRequest", "checkForUpdates", "updateVendor"]) {
      expect(typeof (mod as Record<string, any>)[fn], `null.ts 必须导出 ${fn}（并是函数）`).toBe("function");
    }
    expect(mod!.vendor, "null.ts 必须导出 vendor").toBeTruthy();
  });

  it("★ 回归锚点：miwo 适配器的 baseUrl 是真实第三方服务地址（改了必须红）", () => {
    // ⚠ 这个地址**不是** `vendor.baseUrl`（适配器的 `VendorConfig` 没有顶层 `baseUrl` 字段）——
    //   它在 `inputValues.baseUrl` 上（真实服务地址，改了就调不通）。Task 12 明令不得改。
    expect(getVendorModule("miwo")!.vendor.inputValues.baseUrl).toBe("https://api.toonflow.net/v1");
    // 顺带把"这是真实第三方服务"的另外两处字面量也钉住（描述里的链接与显示名）
    expect(String(getVendorModule("miwo")!.vendor.description)).toContain("https://api.toonflow.net/");
  });

  it("未知 id ⇒ `null`（不抛：调用方要能区分「不存在」与「加载失败」）", () => {
    expect(getVendorModule("nope")).toBeNull();
    expect(getVendorModule("")).toBeNull();
    // 原型链上的名字不许被当成供应商（`toString` / `constructor` 都不得命中）
    expect(getVendorModule("toString")).toBeNull();
    expect(getVendorModule("constructor")).toBeNull();
  });

  it("★ klingai / vidu 的可选导出**真的缺**（证明导出面不是「人人 7 个函数」的空壳）", () => {
    // 实测：klingai 5 个导出、vidu 4 个（都没有 checkForUpdates/updateVendor）。
    // 如果哪天有人给它们补上，这条会红 —— 那是"适配器能力变了"，必须人工过目。
    expect(getVendorModule("klingai")!.checkForUpdates, "klingai 没有 checkForUpdates").toBeUndefined();
    expect(getVendorModule("vidu")!.updateVendor, "vidu 没有 updateVendor").toBeUndefined();
  });
});

describe("Task 8 · 单例不污染（旧路径每次重新执行代码，内置化之后是共享对象）", () => {
  it("★ 两次取同一 vendor 的模板、各覆盖不同的 apiKey ⇒ 两次彼此独立，且**模块级对象没被改**", () => {
    const id = "deepseek";
    const moduleDefaultApiKey = getVendorModule(id)!.vendor.inputValues.apiKey;
    expect(moduleDefaultApiKey, "前置：模块里的默认 apiKey 必须是空串（否则这条用例无从判断污染）").toBe("");

    const first = getVendorConfigFor(id, { apiKey: "sk-FIRST" });
    const second = getVendorConfigFor(id, { apiKey: "sk-SECOND" });

    expect(first.inputValues.apiKey, "第一次拿到的是自己的 key").toBe("sk-FIRST");
    expect(second.inputValues.apiKey, "第二次拿到的是自己的 key").toBe("sk-SECOND");
    // ★ 判别力：第一次那个对象**不受第二次影响**（旧路径天然成立；单例写法会在这里红）
    expect(first.inputValues.apiKey, "第一次拿到的对象不得被第二次覆盖（单例污染）").toBe("sk-FIRST");
    // ★ 更狠的一条：模块自身的默认值也不能被改（漏了内层拷贝就会红）
    expect(getVendorModule(id)!.vendor.inputValues.apiKey, "模块级 inputValues 绝不能被改写").toBe("");
    // 其余默认值仍在（浅拷贝不是"丢字段"）
    expect(first.inputValues.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(first.models, "models 等字段照旧可用").toBeTruthy();
  });

  it("★ `getVendor(id)` 返回的就是模块单例（文档化的语义：要改请自己浅拷贝）", () => {
    expect(getVendorModule("openai")!.vendor).toBe(getVendorModule("openai")!.vendor);
  });
});

describe("Task 8 · 全仓静态断言：vm2 / sucrase / u.vm( 已不存在", () => {
  /** 显式递归收集待扫文件（只扫源码与工具，不扫 node_modules/build/data 这类产物）。 */
  function collect(dir: string, out: string[] = []): string[] {
    if (!fs.existsSync(dir)) return out;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (["node_modules", "build", "dist", ".git", "data", "oss"].includes(e.name)) continue;
        collect(p, out);
      } else if (/\.(ts|cjs|mjs|js|json)$/.test(e.name) && !e.name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
    return out;
  }

  it("★ `vm2` / `sucrase` / `u.vm(` 在**活代码**里 0 命中；且没有任何 import/require 形态（命中处连文件名行号一起打印）", () => {
    const roots = [path.join(API_ROOT, "src"), path.join(API_ROOT, "scripts"), path.join(REPO_ROOT, "tools")];
    const files = roots.flatMap((r) => collect(r));
    // 自证观测（Ruling 243 口径）：扫不到文件不等于干净
    expect(files.length, `待扫文件数必须像个真实仓库（实际 ${files.length}）—— 否则这条断言是空转`).toBeGreaterThan(150);

    const PATTERNS: Array<[string, RegExp]> = [
      ["vm2", /\bvm2\b/],
      ["sucrase", /\bsucrase\b/],
      ["u.vm(", /u\.vm\s*\(/],
    ];
    /** 只留**活代码**行：整行注释与空行剔除（`// 沙箱（vm2）已删除` 这类说明是必要的记录，不是能力）。 */
    const liveCodeLines = (text: string): Array<{ n: number; line: string }> =>
      text
        .split(/\r?\n/)
        .map((line, i) => ({ n: i + 1, line }))
        .filter(({ line }) => {
          const t = line.trim();
          if (!t) return false;
          if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*")) return false;
          return true;
        });

    const liveHits: string[] = [];
    const importHits: string[] = [];
    for (const f of files) {
      const rel = path.relative(REPO_ROOT, f).split(path.sep).join("/");
      for (const { n, line } of liveCodeLines(fs.readFileSync(f, "utf8"))) {
        for (const [name, re] of PATTERNS) {
          if (!re.test(line)) continue;
          liveHits.push(`${rel}:${n} [${name}] ${line.trim().slice(0, 120)}`);
        }
        // "能力"的最小形态：import / require / await import 把这个模块拉进来
        if (/(?:^|\s)(?:import\b[^;]*|require\s*\([^)]*|await\s+import\s*\([^)]*)(["'])vm2\1|(["'])sucrase\2/.test(line)) {
          importHits.push(`${rel}:${n} ${line.trim().slice(0, 120)}`);
        }
      }
    }
    expect(importHits, `仍有把沙箱模块拉进来的 import/require：\n  ${importHits.join("\n  ")}`).toEqual([]);
    expect(liveHits, `活代码里仍有沙箱执行面的引用：\n  ${liveHits.join("\n  ")}`).toEqual([]);
  });

  it("★ `package.json` 不再声明 sucrase / vm2 依赖（连「装了但没人用」都不允许）", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(API_ROOT, "package.json"), "utf8"));
    const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    expect(Object.keys(all)).not.toContain("sucrase");
    expect(Object.keys(all)).not.toContain("vm2");
  });

  it("★ `data/vendor/` 与 `src/lib/vendor.json` 已删除（沙箱资产与它的入库快照）", () => {
    expect(fs.existsSync(path.join(API_ROOT, "data", "vendor")), "data/vendor 必须不存在").toBe(false);
    expect(fs.existsSync(path.join(API_ROOT, "src", "lib", "vendor.json")), "src/lib/vendor.json 必须不存在").toBe(false);
  });

  it("★ 13 个适配器都是**真模块**：带 `@/vendors/runtime` 的 import，且没有 `exports.` 赋值残留", () => {
    const dir = path.join(API_ROOT, "src", "vendors");
    const adapters = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && f !== "runtime.ts" && f !== "index.ts");
    expect(adapters.length, "适配器文件数").toBe(13);
    for (const f of adapters) {
      const text = fs.readFileSync(path.join(dir, f), "utf8");
      expect(text, `${f} 必须 import @/vendors/runtime`).toContain('from "@/vendors/runtime"');
      expect(text, `${f} 不得再有 exports.X = 赋值（沙箱收集对象）`).not.toMatch(/^\s*exports\.[A-Za-z_$][\w$]*\s*=/m);
      expect(text, `${f} 不得再有 declare const 沙箱全局`).not.toMatch(/^\s*declare\s+const\s+(createOpenAI|zipImage|pollTask|logger|jsonwebtoken|axios|FormData|crypto)\b/m);
    }
  });
});
