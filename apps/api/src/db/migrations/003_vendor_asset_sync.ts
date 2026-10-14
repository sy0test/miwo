/**
 * 003_vendor_asset_sync —— 适配器文件的版本对账（**只报告，不写盘**）。
 *
 * ── Phase 1c Task 8 之后它的处境（重要，别照旧注释理解）──
 * 本迁移的**两个输入资产都已删除**：`src/lib/vendor.json`（模板快照，唯一消费者 `fixDB.ts` 已随
 * Task 5 删除）与 `data/vendor/*.ts`（适配器已改成编译期内置的 `src/vendors/*.ts`）。
 * 于是：
 *   · `up` 走 **missingJson / missingDir 分支**：打一行"找不到 …，跳过对账"然后返回
 *     （**刻意不抛** —— 迁移纪律：一个已被删除的可选资产不该让启动失败）；
 *   · 对账本体 `reconcileVendorAssets()` 仍保留并且**仍被单测覆盖**（临时目录造语镜）：它证明
 *     "版本漂移 / 含 CR / 文件缺失"三种情况都会被如实报出来。
 *   · **不删这个迁移**：它已经写进 `knex_migrations` 记账表，删掉会让"已应用列表"与代码对不上
 *     （`verify-phase0` 的 `MIGRATION_ALLOWLIST` 也指着它）。
 *
 * ── 原始背景（Phase 0 的两条 deferred）──
 *   - `src/lib/vendor.json` 里存的适配器源码是**带 `\r\n` 转义的字符串**。
 *     旧 `fixDB.ts:275-286` 会在"适配器版本 < 阈值"时把模板 `writeCode` 回 `data/vendor/*.ts`，
 *     于是把 CR 字节写进仓库文件 → `tools/check-eol.cjs` 报红而 `git status` 仍干净（假红灯）。
 *   - `vendor.json` 的 `miwo.ts` 模板与 `data/vendor/miwo.ts` 有**既有漂移**。
 *
 * 本迁移的处置：**不自动重写任何文件**。
 * 启动期自动改仓库文件本身就是错的（spec §5.2 的迁移纪律："禁止在应用启动路径上执行 DDL/写盘"）。
 * 这样 P2 的触发面被**构造性消除**：没有任何代码路径会在启动时写 `data/vendor/*.ts` 了
 * （Task 8/9 之后连 `data/vendor` 目录都不存在）。
 */
import fs from "node:fs";
import path from "node:path";
import type { Knex } from "knex";

interface VendorJson {
  [file: string]: string;
}

function vendorDir(): string {
  // 与 utils/getPath("vendor") 同源：<MIWO_DATA_DIR>/vendor。
  // 这里不 import config/getPath，因为迁移要能在最小依赖下跑（迁移纪律）。
  const dataDir = process.env.MIWO_DATA_DIR ? path.resolve(process.env.MIWO_DATA_DIR) : path.join(process.cwd(), "data");
  return path.join(dataDir, "vendor");
}

/** 从适配器源码里抠出 `version: "x.y"`（用正则而非 eval —— 迁移不执行第三方代码）。 */
function versionOf(source: string): string | null {
  const m = source.match(/\bversion\s*:\s*["']([^"']+)["']/);
  return m ? m[1] : null;
}

/** 一条对账结果（up 的报告单元；不落库 —— spec 附录 A 里没有这张表，YAGNI）。 */
interface SyncRow {
  file: string;
  templateVer: string | null;
  fileVer: string | null;
  drift: boolean;
  hasCr: boolean;
}

/**
 * 对账本体（纯只读：只 `existsSync` / `readFileSync`，**没有任何 write/append/mkdir**）。
 *
 * ⚠ 幂等：不写盘、不建表、不读 `knex`，所以跑 N 次的结果逐字节相同；`down` 是 no-op。
 *   报告口径（"不要静默"）：**每次跑都打一行汇总**（13 个 / 漂移 N / 含 CR N），
 *   然后**逐行列全部 13 个适配器**（`文件=` / `模板=` / 是否 `[含 CR]`）—— 汇总行负责"一眼看有没有事"，
 *   明细负责"对账结果可抄进工单/报告"。刻意**不**做"只在有差异时才打印"的静默优化：
 *   迁移日志的价值就在于"跑过且看到了什么"，静默等于事后无法证明它跑过。
 *
 * `opts.jsonPath`：模板源的可选覆盖（默认 `<cwd>/src/lib/vendor.json`，与 `up` 一致）。
 *   存在的理由是**可测性**：单测的语镜（fake `MIWO_DATA_DIR`）与进程 cwd 不在同一棵树，
 *   没有这个覆盖就只能靠"临时改 cwd"来造用例 —— 那是会让测试互相踩的写法。
 */
export function reconcileVendorAssets(opts: { jsonPath?: string } = {}): {
  rows: SyncRow[];
  jsonPath: string;
  dir: string;
  missingJson: boolean;
  missingDir: boolean;
} {
  const jsonPath = opts.jsonPath ?? path.join(process.cwd(), "src", "lib", "vendor.json");
  const dir = vendorDir();
  if (!fs.existsSync(jsonPath) || !fs.existsSync(dir)) {
    return { rows: [], jsonPath, dir, missingJson: !fs.existsSync(jsonPath), missingDir: !fs.existsSync(dir) };
  }
  const templates = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as VendorJson;
  const rows: SyncRow[] = [];
  for (const [file, source] of Object.entries(templates)) {
    const onDisk = path.join(dir, file);
    const templateVer = versionOf(source);
    if (!fs.existsSync(onDisk)) {
      rows.push({ file, templateVer, fileVer: null, drift: true, hasCr: false });
      continue;
    }
    const buf = fs.readFileSync(onDisk);
    const fileVer = versionOf(buf.toString("utf8"));
    rows.push({ file, templateVer, fileVer, drift: templateVer !== fileVer, hasCr: buf.includes(0x0d) });
  }
  return { rows, jsonPath, dir, missingJson: false, missingDir: false };
}

export default {
  name: "003_vendor_asset_sync",

  async up(_knex: Knex): Promise<void> {
    const { rows, jsonPath, dir, missingJson, missingDir } = reconcileVendorAssets();
    // 日志里**必须带路径**：模板源缺失/目录缺失都会走"跳过"分支，不带路径的话
    // 事后完全无法判断它当时读的是哪个文件（Task 8 迁移后这是常态分支，实测踩过）。
    if (missingJson) {
      console.log(`[vendor-sync] 找不到 ${jsonPath}，跳过对账`);
      return;
    }
    if (missingDir) {
      console.log(`[vendor-sync] 找不到 ${dir}，跳过对账（本机没有 vendor 资产？）`);
      return;
    }
    const drifted = rows.filter((r) => r.drift);
    const crlf = rows.filter((r) => r.hasCr);
    console.log(`[vendor-sync] 对账 ${rows.length} 个适配器：版本漂移 ${drifted.length}，含 CR 字节 ${crlf.length}`);
    for (const r of rows) {
      // ⚠ `fileVer === null` 有两种含义（文件缺失 / 文件在但没有 version 字段），
      //    行里必须能分辨 —— 否则"vidu.ts 文件=(缺失)"会被读成"文件被删了"（实际它在，只是没有 version）。
      const fileText = r.fileVer ?? (fs.existsSync(path.join(dir, r.file)) ? "(无字段)" : "(文件缺失)");
      console.log(`  ${r.drift ? "⚠" : " "} ${r.file.padEnd(22)} 文件=${fileText} 模板=${r.templateVer ?? "(无字段)"}${r.hasCr ? "  [含 CR]" : ""}`);
    }
    if (crlf.length) {
      console.log(`[vendor-sync] 处置：node tools/normalize-eol.cjs --apply（这能修掉"check-eol 假红灯"）`);
    }
    if (drifted.length) {
      console.log(`[vendor-sync] 处置：版本漂移是**人工决策**（改适配器文件或改 vendor.json），本迁移不代劳。`);
    }
    // ⚠ 这里**故意不写盘**。见文件头注释。
  },

  async down(_knex: Knex): Promise<void> {
    // no-op：本迁移不改变任何持久状态
  },
};
