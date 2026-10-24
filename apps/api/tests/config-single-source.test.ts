/**
 * Phase 1c Task 10：配置外置收口的**判别力用例**。
 *
 * ── 这个文件测什么 ──
 *   1. 四个新 config 字段的**缺省值**（`ossUrl`/`ffmpeg`/`proxyUrl` 必须与改动前逐字一致）；
 *   2. `loadConfig` 的校验对它们**真的生效**（`MIWO_FFMPEG_TIMEOUT_MS=abc` ⇒ `ConfigError`，
 *      而不是像改动前那样 `Number("abc")` = NaN ⇒ 超时变成"永不超时"）；
 *   3. 显式配置能覆盖缺省（`MIWO_FFMPEG_PATH=/usr/bin/ffmpeg`）；
 *   4. `TOONFLOW_PROXY` **不再被读取**（重命名后旧名必须彻底无效）—— 这条是"重命名真的做了"的判据；
 *   5. 门禁 `tools/check-config-single-source.cjs` 的**判别力自证**：临时加一处违规 ⇒ 它必须红，
 *      还原 ⇒ 绿。⚠ 这里**不真改仓库文件**（用例必须可重入、并发安全）：改为在临时目录里铺一份
 *      最小 `src/` 树 + 用 `--root` 让门禁扫那里。见下面 `runGate` 的说明。
 *
 * ⚠ **`redrawPrepScript` 是一次有意的行为变更（2026-10-21）**：
 *   改动前 `analyzeSource.ts:33` 的缺省值是 `D:/sy_workspace/tools/redraw-prep/redraw-prep.cjs`
 *   （开发机绝对路径）。那个缺省只在本机成立，换机器/容器后 `existsSync` 为假 ⇒ 转绘「开始分析」
 *   直接 500，且没有任何提示说明是"没配脚本"。现在缺省改为**空串（= 未配置）**，
 *   由 `app.ts` 启动自检 + `analyzeSource` 的可操作报错兜住。
 *   本机需要跑转绘时在 `apps/api/.env` 里显式设 `MIWO_REDRAW_PREP`。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
// 走 `@/config` 别名（与 config.test.ts 同口径：别名被误删时这里会红，而不是测试变成"看不见"）
import { ConfigError, config, loadConfig } from "@/config";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const GATE = path.join(REPO_ROOT, "tools", "check-config-single-source.cjs");
const API_SRC = path.join(REPO_ROOT, "apps", "api", "src");

const base = {
  MIWO_ENV: "dev",
  MIWO_PORT: "10599",
  MIWO_HOST: "127.0.0.1",
  MIWO_DATA_DIR: "D:\\tmp\\miwo-data",
  MIWO_JWT_SECRET: "x".repeat(48),
} as NodeJS.ProcessEnv;

/**
 * `redrawPrepScript` 的缺省值现在是**空串（= 未配置）**。
 *
 * 原来这里钉的是 `D:/sy_workspace/tools/redraw-prep/redraw-prep.cjs` —— 那是**开发机绝对路径**，
 * 换个机器/容器后 `existsSync` 为假，转绘「开始分析」直接 500 且没人知道原因。
 * 现在「未配置」是一等状态：启动自检打 warn，路由返回可操作报错。
 */
const REDRAW_PREP_DEFAULT = "";

describe("cfgs 1-3. 新字段的缺省值 / 校验 / 覆盖", () => {
  it("★ 缺省值：ossUrl=''、ffmpeg={ffmpeg,ffprobe,600000}、redrawPrepScript=**空串（未配置）**、proxyUrl=''", () => {
    const c = loadConfig({ ...base });
    expect(c.ossUrl, "缺省必须是空串（= 不覆盖前缀；改动前 `process.env.ossURL && !== ''` 也是这个语义）").toBe("");
    expect(c.ffmpeg.path, "缺省 ffmpeg（= 改动前 `FFMPEG_PATH || 'ffmpeg'`）").toBe("ffmpeg");
    expect(c.ffmpeg.probePath, "缺省 ffprobe").toBe("ffprobe");
    expect(c.ffmpeg.timeoutMs, "缺省 600000 = 10 分钟（= 改动前 `10 * 60 * 1000`）").toBe(600000);
    expect(c.redrawPrepScript, "★ 缺省必须是空串：不允许再写死开发机绝对路径（换机器即 500）").toBe(
      REDRAW_PREP_DEFAULT,
    );
    expect(c.proxyUrl, "缺省空串（= 不显式指定代理）").toBe("");
  });

  it("★ 非法 MIWO_FFMPEG_TIMEOUT_MS ⇒ ConfigError（改动前 Number('abc')=NaN ⇒ 永不超时，是静默的可用性缺陷）", () => {
    expect(() => loadConfig({ ...base, MIWO_FFMPEG_TIMEOUT_MS: "abc" })).toThrow(ConfigError);
    // 下界也是判据：0/负数会让 execFile 立刻超时（比"永不超时"更难查）
    expect(() => loadConfig({ ...base, MIWO_FFMPEG_TIMEOUT_MS: "0" })).toThrow(/MIWO_FFMPEG_TIMEOUT_MS/);
    expect(() => loadConfig({ ...base, MIWO_FFMPEG_TIMEOUT_MS: "-1" })).toThrow(/MIWO_FFMPEG_TIMEOUT_MS/);
    // 反向对照：合法值必须通过（否则上面三条只是"这个字段根本读不了"）
    expect(loadConfig({ ...base, MIWO_FFMPEG_TIMEOUT_MS: "1000" }).ffmpeg.timeoutMs).toBe(1000);
  });

  it("★ 显式配置覆盖缺省（四处），且空串/纯空白按'未设置'处理（与 optional() 的既有口径一致）", () => {
    const c = loadConfig({
      ...base,
      MIWO_FFMPEG_PATH: "/usr/bin/ffmpeg",
      MIWO_FFPROBE_PATH: "/usr/bin/ffprobe",
      MIWO_FFMPEG_TIMEOUT_MS: "5000",
      MIWO_REDRAW_PREP: "/opt/redraw.cjs",
      MIWO_PROXY: "http://127.0.0.1:7890",
      MIWO_OSS_URL: "https://cdn.example.com",
    });
    expect(c.ffmpeg).toEqual({ path: "/usr/bin/ffmpeg", probePath: "/usr/bin/ffprobe", timeoutMs: 5000 });
    expect(c.redrawPrepScript).toBe("/opt/redraw.cjs");
    expect(c.proxyUrl).toBe("http://127.0.0.1:7890");
    expect(c.ossUrl).toBe("https://cdn.example.com");

    // 空白 = 未设置（`optional()` 把 undefined 与纯空白统一处理）
    const blank = loadConfig({ ...base, MIWO_FFMPEG_PATH: "   ", MIWO_REDRAW_PREP: "", MIWO_PROXY: "  " });
    expect(blank.ffmpeg.path).toBe("ffmpeg");
    expect(blank.redrawPrepScript, "空白按未设置处理 ⇒ 回到空缺省（不是回落到某个开发机路径）").toBe(REDRAW_PREP_DEFAULT);
    expect(blank.proxyUrl).toBe("");
  });

  it("★★ TOONFLOW_PROXY **不再被读取**（重命名后旧名必须彻底无效 —— 这就是'重命名真的做了'的判据）", () => {
    const legacyOnly = loadConfig({ ...base, TOONFLOW_PROXY: "http://legacy-proxy.invalid:1" });
    expect(legacyOnly.proxyUrl, "旧名 TOONFLOW_PROXY 不得再产生任何效果").toBe("");
    // 反向对照：新名生效（否则上面那条只是"这个字段永远是空"）
    expect(loadConfig({ ...base, MIWO_PROXY: "http://new.invalid:2" }).proxyUrl).toBe("http://new.invalid:2");
    // 进程级单例（`config`）也必须是同一口径（它由 vitest 环境变量加载，测试环境没设 MIWO_PROXY）
    expect(config.proxyUrl).toBe("");
  });
});

/**
 * 在**临时目录**里铺一份最小 `src/` 树来跑门禁的判别力自证。
 *
 * ⚠ 为什么不直接改仓库文件再还原：那会让用例"不可重入"（并发跑同一文件会互相踩），
 *   而且这个仓库的硬约束明确要求"篡改/回退实验的还原源必须是 VCS"——
 *   在单测里做文件改动本身就违反那条纪律。这里改成**给门禁一个不同的根**。
 * ⚠ 门禁原本不支持 `--root` / `--min-files`：本用例新增了它们
 *   （缺省 = 仓库根 + 120 个文件下界，行为完全不变）。
 * ⚠ `--min-files=2` 是必须的：临时树只有 2 个文件，不放开下界就会**正确地** exit 3
 *   （"观测不到 ⇒ 不是通过"）—— 那反而会让人误以为判据是"文件数"。
 */
function runGate(root: string): { status: number | null; out: string } {
  const r = spawnSync(process.execPath, [GATE, `--root=${root}`, "--min-files=2"], { encoding: "utf8" });
  return { status: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-cfg-single-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 铺一份"干净"的最小树：281 个真文件的缩减版（门禁的下界由 `--min-files` 参数放开）。 */
function seedCleanTree(root: string): void {
  const src = path.join(root, "apps", "api", "src");
  fs.mkdirSync(path.join(src, "utils"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "config.ts"),
    [
      'export const config = { env: "dev" };',
      "// 唯一入口可以读任何 MIWO_*",
      'const a = process.env.MIWO_ENV;',
      'const b = process.env.MIWO_PORT;',
      "process.env.NODE_ENV = 'development';",
      "export default { a, b };",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(src, "utils", "oss.ts"), 'import { config } from "@/config";\nexport const x = config.env;\n');
}

describe("cfgs 4. 门禁 check-config-single-source 的判别力（红/绿两端都用真门禁跑）", () => {
  it("★★ 真门禁：干净树 ⇒ EXIT 0；加一处 `process.env.SOMETHING_LEGACY` ⇒ EXIT 1 且**打印出文件:行 变量名**；还原 ⇒ EXIT 0", () => {
    const root = path.join(TMP, "clean");
    seedCleanTree(root);
    const clean = runGate(root);
    expect(clean.status, `干净树必须 EXIT 0，实际 ${clean.status}\n${clean.out}`).toBe(0);

    // ---- 红端：加一处违规 ----
    const oss = path.join(root, "apps", "api", "src", "utils", "oss.ts");
    const original = fs.readFileSync(oss, "utf8");
    fs.writeFileSync(oss, `${original}\nvoid process.env.SOMETHING_LEGACY;\n`);
    const dirty = runGate(root);
    expect(dirty.status, `有违规必须 EXIT 1\n${dirty.out}`).toBe(1);
    expect(dirty.out, "必须打印 `文件:行  变量名`（否则人没法定位）").toMatch(/utils\/oss\.ts:\d+\s+SOMETHING_LEGACY/);

    // ---- 还原 ⇒ 绿 ----
    fs.writeFileSync(oss, original);
    expect(runGate(root).status, "还原后必须回到 EXIT 0（否则红端可能是别的噪声）").toBe(0);
  });

  it("★ 门禁的另一个方向：**非 config.ts** 的文件直读 `MIWO_*` 也必须红（brief 初稿的'前缀即契约'太松）", () => {
    const root = path.join(TMP, "prefix-bypass");
    seedCleanTree(root);
    expect(runGate(root).status, "前置：干净树绿").toBe(0);
    // 实测发现的那一处：迁移文件直读 MIWO_DATA_DIR（真值在 config 之外）
    const dbDir = path.join(root, "apps", "api", "src", "db", "migrations");
    fs.mkdirSync(dbDir, { recursive: true });
    const mig = path.join(dbDir, "003_x.ts");
    fs.writeFileSync(mig, "export const dir = process.env.MIWO_SOMETHING;\n");
    const r = runGate(root);
    expect(r.status, "非 config.ts 的文件直读 MIWO_* 必须红").toBe(1);
    expect(r.out).toMatch(/003_x\.ts:\d+\s+MIWO_SOMETHING/);
  });

  it("★ 真仓库跑一次门禁 ⇒ EXIT 0（本任务交付状态的机械判据）", () => {
    const r = spawnSync(process.execPath, [GATE], { encoding: "utf8" });
    expect(r.status, `真仓库门禁必须 EXIT 0：${r.stdout || ""}${r.stderr || ""}`).toBe(0);
    expect(r.stdout, "必须打印观测计数（观测不到就不能算通过）").toMatch(/扫描 \d+ 个 \.ts/);
  });

  it("★ 门禁扫到的东西必须包含改动前的那些违规点（否则'0 违规'可能只是没扫到）", () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) files.push(p);
      }
    };
    walk(API_SRC);
    expect(files.length, "必须真的递归看到 200+ 个 .ts（看不到 = 这条断言空转）").toBeGreaterThan(200);

    // ⚠ 必须**剥注释**：收口后这些旧名字仍会出现在"解释为什么废弃"的注释里（那是留档，不是读取）。
    //   与门禁同口径：只处理整行 `*` 续行与行内 `//`；本仓库没有"代码里嵌 /* */ 用到 process.env"的形状。
    const offenders: string[] = [];
    for (const f of files) {
      const rel = path.relative(API_SRC, f).split(path.sep).join("/");
      for (const [i, raw] of fs.readFileSync(f, "utf8").split(/\r?\n/).entries()) {
        const s = raw.trimStart().startsWith("*") ? "" : raw;
        const cut = s.indexOf("//");
        const code = cut >= 0 ? s.slice(0, cut) : s;
        for (const legacy of ["ossURL", "FFMPEG_PATH", "FFPROBE_PATH", "FFMPEG_TIMEOUT", "REDRAW_PREP", "TOONFLOW_PROXY"]) {
          if (new RegExp(`process\\.env\\.${legacy}\\b`).test(code)) offenders.push(`${rel}:${i + 1} process.env.${legacy}`);
        }
      }
    }
    expect(offenders, `收口后 src 里不得再有这 6 个旧名的读取：\n${offenders.join("\n")}`).toEqual([]);
  });
});
