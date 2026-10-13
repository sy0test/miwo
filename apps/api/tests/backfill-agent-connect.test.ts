/**
 * ★★P1 端到端（Phase 1b Task 6）：`o_script.userId` 未回填 ⇒ `productionAgent` **连不上**；
 * 跑**真 CLI** 回填后 ⇒ **连得上**（Ruling 228 的阻塞项在这里被真正解锁）。
 *
 * 取证方式（本任务书的 ★判别力 ①）：
 *   1. `%TEMP%` 一次性数据目录 + 真 `db:migrate`（001–004）；
 *   2. 用 `createKnex` 种 fixture：`o_project`(userId=7) + `o_script`(**userId=NULL**) + `o_setting.tokenKey`；
 *   3. spawn `scripts/probe-agent-connect.ts`（**真** productionAgent 连接逻辑 + 假 socket）
 *      → 必须 `disconnected=true` 且 `scriptCheckRejected=true`（**红端**）；
 *   4. spawn **真 CLI** `scripts/backfill-userid.ts --apply` → exit 0，报告里带自检表；
 *   5. 再 spawn probe → 必须 `disconnected=false`（**绿端**）。
 *
 * ⚠ 不复用 vitest 自己的库：**全程 `%TEMP%` 一次性目录**（`MIWO_DATA_DIR` 指向它），
 *   不碰 `apps/api/data/db2.sqlite`，也不会污染共享的 vitest 库。
 * ⚠ 判别力覆盖到 **handler 层**（连接逻辑），**不含 engine.io transport**（仓库无 `socket.io-client`）。
 */
import fs from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import type { MiwoConfig } from "@/config";
import { createKnex } from "@/db/connect";

const API_ROOT = path.resolve(__dirname, "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-task6-e2e-"));
afterAll(() => fs.rmSync(TMP, { recursive: true, force: true }));

/** 文件 sha256（用于"拒绝必须是碰库之前发生的"这类逐字节断言）。 */
const sha256 = (file: string): string => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const TOKEN_KEY = "task6-e2e-token-key-32-bytes!!!!!";
const CONFIG_SECRET = "task6-e2e-config-secret-32-bytes!!!";
const PROJECT_ID = 98001;
const SCRIPT_ID = 98101;
const USER_ID = 7;

function envOf(dataDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    MIWO_ENV: "dev",
    MIWO_HOST: "127.0.0.1",
    MIWO_DATA_DIR: dataDir,
    MIWO_DB_DRIVER: "sqlite",
    MIWO_JWT_SECRET: CONFIG_SECRET,
    NODE_OPTIONS: "--import=tsx",
  };
}

function cfgOf(file: string): MiwoConfig {
  return {
    env: "dev", port: 10599, host: "127.0.0.1", dataDir: path.dirname(file), mediaDir: path.join(path.dirname(file), "oss"),
    storageDriver: "local", publicBaseUrl: "http://127.0.0.1:10599", trustProxy: 0,
    jwtSecret: CONFIG_SECRET, db: { driver: "sqlite", file },
  };
}

interface ProbeRun {
  status: number | null;
  raw: string;
  result: any;
}

function runProbe(dataDir: string): ProbeRun {
  const r = spawnSync(
    process.execPath,
    ["--env-file-if-exists=.env", "--import=tsx", path.join("scripts", "probe-agent-connect.ts"), `--project=${PROJECT_ID}`, `--script=${SCRIPT_ID}`, `--user=${USER_ID}`],
    { cwd: API_ROOT, env: envOf(dataDir), encoding: "utf8", timeout: 180000, windowsHide: true },
  );
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const line = String(r.stdout ?? "").split(/\r?\n/).find((l) => l.startsWith("PROBE_RESULT="));
  return { status: r.status, raw: out, result: line ? JSON.parse(line.slice("PROBE_RESULT=".length)) : null };
}

describe("★P1：o_script.userId 回填是 agent 可用性的开关（真 route + 真 CLI，%TEMP% 一次性库）", () => {
  it("跳过回填 → 连接被拒；跑真 CLI 回填 → 连接成功（两端原文）", async () => {
    const dataDir = path.join(TMP, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, "db2.sqlite");

    // 1) 建库：真跑 db:migrate（001–004；此时库里没有业务行，004 是空跑）
    const mig = spawnSync(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("scripts", "db-migrate.ts")], {
      cwd: API_ROOT, env: envOf(dataDir), encoding: "utf8", timeout: 180000, windowsHide: true,
    });
    expect(mig.status, `db:migrate 失败：stdout=${mig.stdout}\nstderr=${mig.stderr}`).toBe(0);

    // 2) 种 fixture（直连该文件；不走应用）
    const knex = createKnex(cfgOf(dbFile));
    try {
      await knex("o_project").insert({ id: PROJECT_ID, userId: USER_ID, name: "T6", createTime: 1 }).onConflict("id").merge();
      await knex("o_script").insert({ id: SCRIPT_ID, projectId: PROJECT_ID, name: "ep1", userId: null }).onConflict("id").merge();
      await knex("o_setting").insert({ key: "tokenKey", value: TOKEN_KEY }).onConflict("key").merge();
      // 前置：脚本行**存在**，但 userId 是 NULL —— 这正是"未回填"的形态
      const row: any = await knex("o_script").where("id", SCRIPT_ID).first();
      expect(row?.userId, "前置：fixture 的 o_script.userId 必须是 NULL").toBeNull();
      expect(Number(row?.projectId)).toBe(PROJECT_ID);
    } finally {
      await knex.destroy();
    }

    // 3) 红端：真 route 试连 → 必须被集号归属校验拒
    const red = runProbe(dataDir);
    expect(red.result, `probe 没有输出 PROBE_RESULT：${red.raw.slice(-800)}`).toBeTruthy();
    console.log("[task6-e2e] 红端（o_script.userId=NULL）probe=" + JSON.stringify(red.result));
    expect(red.result.disconnected, `跳过回填时必须被拒。probe=${JSON.stringify(red.result)}`).toBe(true);
    expect(red.result.scriptCheckRejected, `拒连的原因必须是集号归属校验。probe=${JSON.stringify(red.result)}`).toBe(true);

    // 4) 跑真 CLI 回填
    const cli = spawnSync(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("scripts", "backfill-userid.ts"), "--apply"], {
      cwd: API_ROOT, env: envOf(dataDir), encoding: "utf8", timeout: 180000, windowsHide: true,
    });
    expect(cli.status, `真 CLI 失败：stdout=${cli.stdout}\nstderr=${cli.stderr}`).toBe(0);
    expect(String(cli.stdout)).toMatch(/自检/);
    const cliTail = String(cli.stdout)
      .split(/\r?\n/)
      .filter((l) => /自检|o_script:|o_project:|memories:/.test(l))
      .join(" | ");
    console.log("[task6-e2e] 真 CLI 自检行：" + cliTail);

    const knex2 = createKnex(cfgOf(dbFile));
    try {
      const row: any = await knex2("o_script").where("id", SCRIPT_ID).first();
      expect(row?.userId, "回填后 o_script.userId 必须等于项目归属").toBe(USER_ID);
    } finally {
      await knex2.destroy();
    }

    // 5) 绿端：同一连接逻辑再试一次 → 必须连上（handlers 里能看到被包住的事件入口）
    const green = runProbe(dataDir);
    expect(green.result, `probe 没有输出 PROBE_RESULT：${green.raw.slice(-800)}`).toBeTruthy();
    console.log("[task6-e2e] 绿端（回填后）probe=" + JSON.stringify(green.result));
    expect(green.result.disconnected, `回填后必须连上。probe=${JSON.stringify(green.result)}`).toBe(false);
    expect(green.result.scriptCheckRejected).toBe(false);
    expect(green.result.handlers).toContain("updateContext");
  }, 300000);

  it("★ P2-1 加固：probe 对**仓库内 dev 库**直接拒绝（且该文件逐字节未变）", () => {
    const repoDb = path.join(API_ROOT, "data", "db2.sqlite");
    const before = sha256(repoDb);
    const env = envOf(path.join(API_ROOT, "data"));
    delete env.MIWO_ALLOW_REPO_DEV_DB; // 不许放行
    const r = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "--import=tsx", path.join("scripts", "probe-agent-connect.ts"), "--project=1", "--script=1", "--user=1"],
      { cwd: API_ROOT, env, encoding: "utf8", timeout: 180000, windowsHide: true },
    );
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    console.log("[task6-e2e] probe 对仓库 dev 库：exit=" + r.status + " 输出尾部=" + out.trim().split(/\r?\n/).slice(-2).join(" | "));
    expect(r.status, `probe 必须拒绝仓库内 dev 库（exit ${r.status}）：\n${out}`).not.toBe(0);
    expect(out).toMatch(/拒绝执行/);
    expect(sha256(repoDb), "拒绝必须是**在碰库之前**发生的：仓库 dev 库逐字节未变").toBe(before);
  }, 200000);

  it("★ P3-1：`--report=` 写**完整 JSON**（孤儿名单不截断），控制台仍只点前 5 条", async () => {
    const dataDir = path.join(TMP, "json-report");
    fs.mkdirSync(dataDir, { recursive: true });
    const dbFile = path.join(dataDir, "db2.sqlite");
    const mig = spawnSync(process.execPath, ["--env-file-if-exists=.env", "--import=tsx", path.join("scripts", "db-migrate.ts")], {
      cwd: API_ROOT, env: envOf(dataDir), encoding: "utf8", timeout: 180000, windowsHide: true,
    });
    expect(mig.status, `db:migrate 失败：${mig.stdout}\n${mig.stderr}`).toBe(0);

    const knex = createKnex(cfgOf(dbFile));
    try {
      // 归属得上的项目（证明不是"全表都没归属"），以及一个 userId=NULL 的孤儿项目 + 7 条属于它的 o_tasks
      await knex("o_project").insert([
        { id: 5001, userId: 7, name: "ok", createTime: 1 },
        { id: 5002, userId: null, name: "orphan", createTime: 1 },
      ]);
      const rows = [];
      for (let i = 0; i < 7; i += 1) rows.push({ id: 6000 + i, projectId: 5002, userId: null, taskClass: "t", state: "进行中" });
      rows.push({ id: 6100, projectId: 5001, userId: null, taskClass: "t", state: "进行中" });
      await knex("o_tasks").insert(rows);
    } finally {
      await knex.destroy();
    }

    const reportPath = path.join(dataDir, "report.json");
    const cli = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "--import=tsx", path.join("scripts", "backfill-userid.ts"), "--apply", `--report=${reportPath}`],
      { cwd: API_ROOT, env: envOf(dataDir), encoding: "utf8", timeout: 180000, windowsHide: true },
    );
    expect(cli.status, `CLI 失败：${cli.stdout}\n${cli.stderr}`).toBe(0);
    // 控制台：只点前 5 条孤儿（可读性取舍）
    const consoleOrphans = (String(cli.stdout).match(/孤儿 \{/g) ?? []).length;
    expect(consoleOrphans, "控制台应只点前 5 条").toBe(5);
    // JSON：7 条孤儿**全在**（预裁定 1 要求"留 NULL + 报告"，名单截断等于没报告）
    const parsed = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    const tasks = parsed.tables.find((t: any) => t.table === "o_tasks");
    expect(tasks.orphans).toHaveLength(7);
    expect(tasks.updated).toBe(1);
    expect(parsed.selfCheck.find((s: any) => s.table === "o_tasks")).toMatchObject({ userIdNull: 7, expectedNull: 7, updated: 1, orphans: 7 });
    // 可疑全孤儿信号**不该**在这里触发（有 1 行归属上了）
    expect(parsed.warnings).toEqual([]);
    // 幂等 + 第二次 JSON 里孤儿仍是 7（名单稳定）
    const cli2 = spawnSync(
      process.execPath,
      ["--env-file-if-exists=.env", "--import=tsx", path.join("scripts", "backfill-userid.ts"), "--apply", `--report=${reportPath}`],
      { cwd: API_ROOT, env: envOf(dataDir), encoding: "utf8", timeout: 180000, windowsHide: true },
    );
    expect(cli2.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(reportPath, "utf8")).tables.find((t: any) => t.table === "o_tasks").orphans).toHaveLength(7);
  }, 300000);
});
