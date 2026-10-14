import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = path.resolve(__dirname, "..");
const ROUTER = path.join(API_ROOT, "src", "router.ts");

function generate() {
  execFileSync(process.execPath, [path.join(API_ROOT, "scripts", "generate-router.ts")], {
    cwd: API_ROOT,
    env: { ...process.env, NODE_OPTIONS: "--import=tsx" },
    stdio: "pipe",
  });
}

/**
 * ⚠ 生成器会**写仓库文件** src/router.ts。
 * 若不加这层快照恢复，任一条用例失败时都会在 router.ts 陈旧的状态下把它改成新内容 →
 * 失败信息与脏工作树混在一起，排查时看到的"失败原因"可能只是上一条用例留下的副作用。
 * 统一：读原文 → 跑断言（可能触发生成）→ 无论成败写回原文。
 */
function withRouterSnapshot(fn: () => void) {
  const original = fs.existsSync(ROUTER) ? fs.readFileSync(ROUTER, "utf8") : null;
  try {
    fn();
  } finally {
    if (original !== null) fs.writeFileSync(ROUTER, original, "utf8");
    else if (fs.existsSync(ROUTER)) fs.unlinkSync(ROUTER);
  }
}

describe("generate-router", () => {
  it("能重新生成 router.ts 且内容稳定（幂等）", () => {
    withRouterSnapshot(() => {
      expect(fs.existsSync(ROUTER)).toBe(true);
      const first = fs.readFileSync(ROUTER, "utf8");
      generate();
      const second = fs.readFileSync(ROUTER, "utf8");
      expect(second).toBe(first);
    });
  });

  /**
   * 已知源文件 → 期望挂载路径。
   *
   * 前三条用例的清单**都来自 router.ts 自身**（条数、hash 都由 router.ts 里已有的挂载重算），
   * 于是对"生成器把 routePath 推错"完全免疫：把 `fileNameToRoutePath` 改成恒返回 "/"，
   * 那些用例仍然全绿（条数不变、hash 自洽）。这里改用**外部真值**：
   * 拿仓库里真实存在的路由文件，断言它在 router.ts 里挂到了正确的路径上。
   * 样本刻意覆盖两级目录（setting/vendorConfig），能同时抓住"丢掉中间目录段"和"漏掉文件名段"两类推错。
   */
  it("已知源文件映射到期望的挂载路径（防止 fileNameToRoutePath 推错）", () => {
    const text = fs.readFileSync(ROUTER, "utf8");
    // 样例取自仓库中真实存在的路由文件
    expect(fs.existsSync(path.join(API_ROOT, "src", "routes", "agents", "clearMemory.ts"))).toBe(true);
    expect(fs.existsSync(path.join(API_ROOT, "src", "routes", "setting", "vendorConfig", "getVendorList.ts"))).toBe(true);
    expect(text).toMatch(/app\.use\("\/api\/agents\/clearMemory", route\d+\)/);
    expect(text).toMatch(/app\.use\("\/api\/setting\/vendorConfig\/getVendorList", route\d+\)/);
    // 反向断言：这两个文件不该被挂到根路径或丢掉中间段
    expect(text).not.toMatch(/app\.use\("\/api\/clearMemory", route\d+\)/);
    expect(text).not.toMatch(/app\.use\("\/api\/vendorConfig\/getVendorList", route\d+\)/);
  });

  it("生成的路由条数与路由文件数一致", () => {
    const text = fs.readFileSync(ROUTER, "utf8");
    const mounts = text.match(/app\.use\("\/api/g) ?? [];

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (p.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    const routeFiles = walk(path.join(API_ROOT, "src", "routes"));

    // ⚠ 这两个数字必须**同时**跟着路由表更新（Phase 1c Task 3：177 → 183，
    //    即 +6 条 `/api/auth/*`；`/api/login/login` 当时**保留**，所以不是 177-1+6）。
    //    ⚠【Phase 1c Task 4】183 → **180**：删掉 3 个危险接口（`/api/test/test`、
    //    `/api/other/deleteAllData`、`/api/setting/fileManagement/openFolder`）。
    //    ⚠【Phase 1c Task 9】180 → **177**：再删 3 个"提交/执行代码"的接口
    //    （`vendorConfig/{addVendor,updateCode,getCodeByLink}`，spec Tier 0 #2/#10）。
    //    ⚠【Phase 1c Task 11】177 → **176**：旧登录路径 `/api/login/login` **整体退役**
    //    （`src/routes/login/login.ts` 删除 + 白名单条目删除）。
    //    它们是"路由表没被静默清空"的外部真值，改数字不是放宽判据（两侧仍然逐项相等）。
    expect(mounts.length).toBe(176);
    expect(routeFiles.length).toBe(176);
  });

  it("router.ts 的 hash 头格式正确，且与路由清单重算结果一致", () => {
    const text = fs.readFileSync(ROUTER, "utf8");
    const m = text.match(/^\/\/ @routes-hash ([a-f0-9]{32})/);
    expect(m).not.toBeNull();

    // 按 generate-router.ts 的规则重算 hash：路由清单 = [{routePath, varName}]
    // routePath 形如 "/login/login"（带前导斜杠）——⚠ Phase 1c Task 11 删掉那条路由后，
    // routePath 的**格式**不变（仍是带前导斜杠的相对路径），只是清单少一条。
    // mount 为 app.use("/api" + routePath, varN)
    const pairRe = /app\.use\("\/api(\/[^"]*)", (route\d+)\)/g;
    const pairs: Array<{ routePath: string; varName: string }> = [];
    for (const mm of text.matchAll(pairRe)) pairs.push({ routePath: mm[1], varName: mm[2] });
    expect(pairs.length).toBe(176);
    const hash = crypto.createHash("md5").update(JSON.stringify(pairs)).digest("hex");
    expect(m![1]).toBe(hash);
  });

  /**
   * ⚠ 静态匹配 `/^\/\/ @routes-hash .../`（带前导 `^`）只锚定**文件首行**，
   * 而生成器的重建正则 `^\/\/\s*@routes-hash\s*([a-z0-9]+)\n` 是同一个锚定口径 ——
   * 若 hash 头被挤到第二行，生成器会判"需重写"，本用例的静态断言却仍能从任意位置匹配到，
   * 两边口径不一致会掩盖问题。这里显式断言"头就在第 1 行"。
   */
  it("hash 头位于文件第 1 行（生成器与校验脚本的锚定口径一致）", () => {
    const lines = fs.readFileSync(ROUTER, "utf8").split("\n");
    expect(lines[0]).toMatch(/^\/\/ @routes-hash [a-f0-9]{32}$/);
  });
});
