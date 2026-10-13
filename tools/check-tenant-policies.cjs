#!/usr/bin/env node
/**
 * 租户策略门禁（Phase 1b Task 8）：**三方一致** + 唯一真相复用。
 *
 *  ① `apps/api/src/db/policies.ts` 的 `TABLE_POLICIES` / `TENANT_TABLES` / `DROPPED_TABLES` / `INFRA_TABLES`
 *     —— 经 `tools/tenant-policy-facts.ts`（**真 tsx 进程**）导入，**不再正则解析、不再手写第二份清单**；
 *  ② `apps/api/src/db/migrations/001_schema.ts` 的 `createTable` / `dropTableIfExists`（源码级，唯一无法导入的部分）；
 *  ③ `apps/api/src/db/tenant-exceptions.json` 的 `joins[].tables`（被 join 的表必须已声明、且未退役）；
 *  ④ `apps/api/src/db/legacy/backfill-userid.ts` 导出的 `BACKFILL_TARGET_TABLES`(19) / `SELF_CHECK_TABLES`(20)
 *     —— **与 ① 的租户表集合逐项相等**（Lead 的 Task 8 输入 ②：禁止第三份手写清单）。
 *
 * 为什么需要独立脚本：`check-tenant-exceptions.cjs` 只管"特例清单 ↔ 代码"，管不到"策略表 ↔ 建表"；
 * 这两者一旦漂移，症状是"新表第一次被访问就 500（PolicyNotFoundError）"或"退役表被当成正常表"。
 *
 * 退出码：0 = 三方一致；1 = 有一致性问题；**3 = 检查自身没跑起来**（探针观测不到 / schema 解析为 0 张表
 *         —— "观测不到 ≠ 干净"，照 Ruling 243 的精神必须与"发现漂移"区分开）。
 *
 * 用法：node tools/check-tenant-policies.cjs
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const API = path.join(ROOT, "apps", "api");
const POLICIES = path.join(API, "src/db/policies.ts");
const SCHEMA = path.join(API, "src/db/migrations/001_schema.ts");
const INV = path.join(API, "src/db/tenant-exceptions.json");
const FACTS = path.join(__dirname, "tenant-policy-facts.ts");

const failures = [];

// ---------- ① 事实探针：真 tsx 进程导入 TS 常量（cwd 必须是 apps/api，`@/*` 别名才解析得到）----------
const probe = spawnSync(process.execPath, ["--import=tsx", path.relative(API, FACTS)], {
  cwd: API,
  encoding: "utf8",
  timeout: 120000,
  windowsHide: true,
  env: { ...process.env, NODE_OPTIONS: "--import=tsx" },
});
const probeOut = `${probe.stdout || ""}${probe.stderr || ""}`;
const line = probeOut.split(/\r?\n/).find((l) => l.startsWith("POLICY_FACTS="));
if (!line) {
  console.error(`check-tenant-policies 无法完成：事实探针没有输出 POLICY_FACTS=（exit ${probe.status}）。`);
  console.error(`  —— "观测不到"不等于"干净"（Ruling 243）。探针输出尾部：\n${probeOut.slice(-800)}`);
  process.exit(3);
}
const facts = JSON.parse(line.slice("POLICY_FACTS=".length));
if (
  facts.observed !== true ||
  !facts.tablePolicies ||
  !Array.isArray(facts.tenantTables) ||
  !Array.isArray(facts.backfillTargetTables) ||
  !Array.isArray(facts.selfCheckTables)
) {
  console.error("check-tenant-policies 无法完成：探针自证不足（observed/字段缺失）。" + JSON.stringify(facts).slice(0, 400));
  process.exit(3);
}

// ---------- ② schema 侧（源码级）----------
const schemaSrc = fs.readFileSync(SCHEMA, "utf8");
const created = [...new Set([...schemaSrc.matchAll(/createTable\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]))].sort();
const droppedInSchema = [...new Set([...schemaSrc.matchAll(/dropTableIfExists\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]))].sort();
if (created.length < 20 || droppedInSchema.length === 0) {
  console.error(
    `check-tenant-policies 无法完成：从 001_schema.ts 解析到的表数不合理（createTable ${created.length}、dropTableIfExists ${droppedInSchema.length}）` +
      ` —— 观测不到就 exit 3，不放行。`,
  );
  process.exit(3);
}

// ---------- 一致性判据 ----------
const policies = facts.tablePolicies;
const infra = new Set(facts.infraTables);
const dropped = new Set(facts.droppedTables);
const tenant = facts.tenantTables.slice().sort();

const declaredBusiness = Object.keys(policies).filter((t) => !infra.has(t)).sort();
if (JSON.stringify(declaredBusiness) !== JSON.stringify(created)) {
  failures.push(
    `策略表 ↔ 001_schema 不一致：\n      只有策略 ${declaredBusiness.filter((t) => !created.includes(t)).join(", ") || "（无）"}\n      只有建表 ${created.filter((t) => !declaredBusiness.includes(t)).join(", ") || "（无）"}`,
  );
}
if (JSON.stringify(facts.droppedTables.slice().sort()) !== JSON.stringify(droppedInSchema)) {
  failures.push(
    `DROPPED_TABLES ↔ 001_schema 的 dropTableIfExists 不一致：策略 ${facts.droppedTables.join(", ")}；schema ${droppedInSchema.join(", ")}`,
  );
}
for (const t of ["knex_migrations", "knex_migrations_lock"]) {
  if (!(t in policies)) failures.push(`knex 基础设施表 ${t} 未在 TABLE_POLICIES 声明（fail-closed 会拒绝它）`);
}
const policyTenant = Object.entries(policies).filter(([, p]) => p === "tenant").map(([t]) => t).sort();
if (JSON.stringify(policyTenant) !== JSON.stringify(tenant)) {
  failures.push(
    `TENANT_TABLES ↔ TABLE_POLICIES(tenant) 不一致：\n      只有 TENANT_TABLES ${tenant.filter((t) => !policyTenant.includes(t)).join(", ") || "（无）"}\n      只有策略 ${policyTenant.filter((t) => !tenant.includes(t)).join(", ") || "（无）"}`,
  );
}
if (tenant.length !== 20) failures.push(`tenant 表应为 20 张（Phase 1a 账本 Ruling 32），实际 ${tenant.length}：${tenant.join(", ")}`);
if (facts.userColumn !== "userId") failures.push(`策略层的 USER_COLUMN 必须是 "userId"（守卫与回填都按它注入），实际 ${String(facts.userColumn)}`);

// ④ 回填/自检常量**复用**（禁止第三份手写清单）：与策略表的租户集合逐项相等。
if (JSON.stringify(facts.selfCheckTables.slice().sort()) !== JSON.stringify(tenant)) {
  failures.push(
    `SELF_CHECK_TABLES（backfill-userid.ts 导出）↔ TENANT_TABLES 不一致：\n      只有 SELF_CHECK ${facts.selfCheckTables.filter((t) => !tenant.includes(t)).join(", ") || "（无）"}\n      只有 TENANT ${tenant.filter((t) => !facts.selfCheckTables.includes(t)).join(", ") || "（无）"}`,
  );
}
const expectedBackfill = tenant.filter((t) => t !== "o_project").sort();
if (JSON.stringify(facts.backfillTargetTables.slice().sort()) !== JSON.stringify(expectedBackfill)) {
  failures.push(
    `BACKFILL_TARGET_TABLES ↔ TENANT_TABLES - {o_project} 不一致：\n      只有回填目标 ${facts.backfillTargetTables.filter((t) => !expectedBackfill.includes(t)).join(", ") || "（无）"}\n      只有租户表 ${expectedBackfill.filter((t) => !facts.backfillTargetTables.includes(t)).join(", ") || "（无）"}`,
  );
}
if (facts.selfCheckTables.length !== facts.backfillTargetTables.length + 1) {
  failures.push(`SELF_CHECK_TABLES 应为 BACKFILL_TARGET_TABLES + 1（链源头 o_project）：${facts.selfCheckTables.length} vs ${facts.backfillTargetTables.length} + 1`);
}

// ③ 特例清单里被 join 的表必须是已声明的表（挡住表名拼写错误 / 指向退役表）。
if (fs.existsSync(INV)) {
  const inv = JSON.parse(fs.readFileSync(INV, "utf8"));
  for (const [file, v] of Object.entries(inv.joins || {})) {
    for (const t of v.tables || []) {
      if (dropped.has(t)) failures.push(`joins:${file} 指向已退役表 ${t}`);
      else if (!(t in policies)) failures.push(`joins:${file} 指向未声明策略的表 ${t}（policies.ts 里没有它）`);
    }
  }
} else {
  failures.push(`缺少特例清单 ${path.relative(ROOT, INV)}`);
}

if (failures.length) {
  console.error("check-tenant-policies 失败：");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}

const platformN = Object.values(policies).filter((p) => p === "platform").length;
console.log(
  `check-tenant-policies 通过：策略表 ${Object.keys(policies).length} 条（tenant ${tenant.length} / platform ${platformN}）；退役 ${facts.droppedTables.length} 张；` +
    `与 001_schema 的 ${created.length} 张建表逐项一致；回填目标 ${facts.backfillTargetTables.length} + 自检 ${facts.selfCheckTables.length}（复用 backfill-userid.ts 的导出常量）`,
);
