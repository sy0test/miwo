/**
 * ★ review-C F4（High）的**机械守卫**：**每个已注册的业务类型都必须有"入队调用点"**。
 *
 * 为什么换掉 brief 原来的判据：brief 用 `git grep '\.then\(async'` = 0 命中来证明"六个入口都改了"，
 * 而第 6 个入口 `batchGeneratePrompt` 写的是 `pLimit(...)` + `Promise.all(tasks)` ⇒ **不匹配那个正则**，
 * 于是"0 命中"却**漏掉了它**（review-C 实测：`prompt.batch` handler 注册了但无任何调用方 = 死代码）。
 * ⇒ 判据必须按**类型**而不是按"某种写法"来守：对每个类型断言
 *      ① 路由层存在一条 `enqueueJob({ type: "<type>" ... })`；
 *      ② 该路由**不再**做进程内 fire-and-forget（不含 `pLimit(` / `Promise.all(tasks)`）。
 *
 * ⚠ 这是一条**源码级**断言（不是行为断言）：新增第 7 个入口忘了入队时，它会红。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { JOB_DEFINITIONS } from "@/jobs/registry";

const API_ROOT = path.resolve(__dirname, "..");
const ROUTES_ROOT = path.join(API_ROOT, "src", "routes");
/** handler 包住的类型允许"由另一个类型复用"（video.batchGenerate 与 video.generate 共用 runItems）。 */
const SELFTEST_EXEMPT = new Set(["selftest.sleep"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

const ROUTE_FILES = walk(ROUTES_ROOT).map((p) => ({ p, src: fs.readFileSync(p, "utf8") }));
const rel = (p: string): string => path.relative(API_ROOT, p).replace(/\\/g, "/");

/** 剥掉行注释与整行块注释（保持行号），避免"注释里解释这个写法"被当成"代码里还在用"。 */
function stripComments(src: string): string {
  return src
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*\/\*.*$/, ""))
    .join("\n");
}

describe("入队覆盖度（review-C F4 的机械守卫）", () => {
  it("★ 每个注册的业务类型都有一条路由级 enqueueJob 调用点", () => {
    const missing: string[] = [];
    for (const def of JOB_DEFINITIONS) {
      if (SELFTEST_EXEMPT.has(def.type)) continue; // 运维冒烟任务由 CLI 入队（Task 10），无用户入口
      const needle = new RegExp(`type:\\s*"${def.type.replace(".", "\\.")}"`);
      const hit = ROUTE_FILES.some((f) => f.src.includes("enqueueJob(") && needle.test(f.src));
      if (!hit) missing.push(def.type);
    }
    expect(missing, `以下类型没有任何路由入队（handler 是死代码）—— 新增入口必须同批接入队`).toEqual([]);
  });

  it("★ 六个业务入队路由**不得**再有进程内 fire-and-forget（pLimit / Promise.all(tasks)）", () => {
    // 哪些路由是"入队型"：只要文件里出现 enqueueJob( 就适用
    const enqueueRoutes = ROUTE_FILES.filter((f) => f.src.includes("enqueueJob("));
    expect(enqueueRoutes.length, "入队路由数量异常（少于 6 说明有入口回退了）").toBeGreaterThanOrEqual(6);
    for (const f of enqueueRoutes) {
      // ⚠ 先剥注释：路由的**解释性注释**里会引用这些写法（"原来是 pLimit + Promise.all(tasks)"），
      //   不剥注释会把"解释为什么改掉它"判成"还在用"。判据只看**代码**。
      const src = stripComments(f.src);
      expect(src, `${rel(f.p)} 仍用 pLimit（进程内并发不受队列/闸门管辖）`).not.toContain("pLimit(");
      expect(src, `${rel(f.p)} 仍有 Promise.all(tasks) 的进程内 fire-and-forget`).not.toContain("Promise.all(tasks)");
    }
  });

  it("★ 被入队的类型集合与注册表一致（没有'注册了没人投递'的类型）", () => {
    const enqueued = new Set<string>();
    for (const def of JOB_DEFINITIONS) {
      const needle = new RegExp(`type:\\s*"${def.type.replace(".", "\\.")}"`);
      if (ROUTE_FILES.some((f) => f.src.includes("enqueueJob(") && needle.test(f.src))) enqueued.add(def.type);
    }
    const expected = JOB_DEFINITIONS.map((d) => d.type).filter((t) => !SELFTEST_EXEMPT.has(t)).sort();
    expect([...enqueued].sort()).toEqual(expected);
  });
});
