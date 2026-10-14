/**
 * ★ C 组复核轮 **N1** 的持久判别力守卫：`check-build.cjs` 的闸门断言必须是**调用形态**，不是裸子串。
 *
 * 缺陷原样：`gate.ts` 的错误文案里就写着 `__setGateFactory()...`，而 `bootstrapJobInfra()` 里是
 * `__setGateFactory(() => createGate(...))` 的**调用**。用裸子串当判据 ⇒ 注释掉 bootstrap 之后
 * 字符串仍在产物里 ⇒ 门禁**EXIT 0 并打印"闸门初始化 ✓"**（同刻真实调用数 = 0）。
 * 这是 Ruling 243 家族"**空转/说谎的检查 = 没有检查**"。
 *
 * 本文件不重跑构建（那是 `check-build.cjs` 的事），只对**已存在的构建产物**做判别力断言：
 *   ① 产物里 `__setGateFactory(` 的**裸子串出现次数 > 调用形态出现次数**（差额即"文案假阳性"）
 *      ⇒ 证明"裸子串判据"确实会误判（不是理论担心）；
 *   ② `check-build.cjs` 里用的判据字面量必须是调用形态 `__setGateFactory(() =>`，
 *      且**不得**回退成裸子串。
 *
 * ⚠ 产物不存在时（干净检出、未构建）本文件**跳过**并打印原因 —— 不把"没构建"伪装成通过，
 *   但也不阻断 `pnpm test`（构建由 `check-build.cjs` 门禁负责）。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = path.resolve(__dirname, "..");
const TOOLS = path.resolve(API_ROOT, "..", "..", "tools");
const BUNDLES = [
  path.join(API_ROOT, "data", "serve", "app.js"),
  path.join(API_ROOT, "data", "serve", "worker.js"),
];
const BARE = "__setGateFactory(";
const CALL = "__setGateFactory(() =>";

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe("N1：check-build 的闸门判据必须是调用形态（不是裸子串）", () => {
  it("★ 判据字面量是调用形态，且 check-build.cjs 里没有把裸子串当判据", () => {
    const src = fs.readFileSync(path.join(TOOLS, "check-build.cjs"), "utf8");
    expect(src, "必须使用调用形态判据").toContain(`const GATE_INIT_TRACE = "${CALL}";`);
    expect(src, "必须把'裸子串不算数'写进失败文案（可诊断）").toContain("GATE_INIT_BARE");
  });

  for (const bundle of BUNDLES) {
    it(`★ 判别力：${path.basename(bundle)} 里裸子串出现次数 > 调用形态次数（差额 = 文案假阳性）`, () => {
      if (!fs.existsSync(bundle)) {
        console.log(`[N1] 跳过：${path.relative(API_ROOT, bundle)} 不存在（未构建；由 check-build.cjs 门禁负责构建）`);
        return;
      }
      const body = fs.readFileSync(bundle, "utf8");
      const bare = count(body, BARE);
      const call = count(body, CALL);
      // eslint-disable-next-line no-console
      console.log(`[N1] ${path.basename(bundle)}: bare=${bare} call=${call}`);
      expect(call, "调用形态必须存在（否则启动链真的没注册闸门）").toBeGreaterThan(0);
      expect(
        bare,
        "裸子串次数应**严格大于**调用形态次数 —— 差额正是 gate.ts 错误文案造成的假阳性；" +
          "若两者相等，说明这条判别力证据本身失效（要么文案改了、要么产物不是本仓构建的）",
      ).toBeGreaterThan(call);
    });
  }
});
