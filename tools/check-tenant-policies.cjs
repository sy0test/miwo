#!/usr/bin/env node
/**
 * 租户策略门禁（Phase 1b Task 8）：**三方一致** + 唯一真相复用。
 *
 *  ① `apps/api/src/db/policies.ts` 的 `TABLE_POLICIES` / `TENANT_TABLES` / `DROPPED_TABLES` / `INFRA_TABLES`
 *     —— 经 `tools/tenant-policy-facts.ts`（**真 tsx 进程**）导入，**不再正则解析、不再手写第二份清单**；
 *  ② **全部迁移文件**的 `createTable` / `dropTableIfExists`（源码级，唯一无法导入的部分）——
 *     解析器是 `tools/migration-tables.cjs`（**单一来源**，`tests/tenant-policies.test.ts` 用的是同一份）。
 *     ⚠ **【Phase 1c Task 1】** 1b 时期这里**硬编码只解析 `001_schema.ts`** ⇒ 新增迁移建的表对门禁
 *     **完全不可见**（一给它们登记策略就报"策略表里的表不在建表清单里"）。现在改为扫描
 *     `src/db/migrations/*.ts` 全部迁移，"最终落地的表"= 建表名 − 被 `renameTable` 改掉的暂存表
 *     （`*_new` / `*_old`，见 `005_accounts.ts`）。
 *  ③ `apps/api/src/db/tenant-exceptions.json` 的 `joins[].tables`（被 join 的表必须已声明、且未退役）；
 *  ④ `apps/api/src/db/legacy/backfill-userid.ts` 导出的
 *     `BACKFILL_TARGET_TABLES`(19) / `SELF_CHECK_TABLES`(20) / `BACKFILL_EXEMPT_TABLES`(2)
 *     —— **三方一致的不变量**（Phase 1c Task 1 改写）：
 *       `TENANT_TABLES == BACKFILL_TARGET_TABLES ∪ {o_project} ∪ BACKFILL_EXEMPT_TABLES`
 *     （豁免表 = "迁移之后才新建的租户空表"，没有历史行可回填；**豁免清单只有这一份来源**，
 *      禁止在门禁里再手写一遍 —— 1b 反复出事的形状）。
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
const INV = path.join(API, "src/db/tenant-exceptions.json");
const FACTS = path.join(__dirname, "tenant-policy-facts.ts");
// ⚠ 建表清单的解析器是**单一来源**（`tools/migration-tables.cjs`），单测用的是同一份 —— 见其文件头。
const { collectMigrationTables } = require(path.join(__dirname, "migration-tables.cjs"));

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
  !Array.isArray(facts.backfillExemptTables) ||
  !Array.isArray(facts.selfCheckTables)
) {
  console.error("check-tenant-policies 无法完成：探针自证不足（observed/字段缺失）。" + JSON.stringify(facts).slice(0, 400));
  process.exit(3);
}

// ---------- ② 建表清单（源码级，全部迁移；解析器是 tools/migration-tables.cjs 单一来源）----------
const tables = collectMigrationTables();
const created = tables.deployedTables;
const droppedInSchema = tables.retiredTables;
const staging = tables.stagingTables;
if (created.length < 27 || droppedInSchema.length === 0 || tables.files.length < 5) {
  console.error(
    `check-tenant-policies 无法完成：从 ${tables.files.length} 个迁移文件解析到的表数不合理` +
      `（最终落地 ${created.length}、dropTableIfExists ${droppedInSchema.length}）—— 观测不到就 exit 3，不放行。`,
  );
  process.exit(3);
}
// ⚠ 暂存表（`*_new` / `*_old`）**不得**出现在策略表里：迁移结束时它们并不存在，
//   "给暂存表登记策略"= 给一张不存在的表声明策略（真实症状是启动期/查询期 500）。
for (const t of staging) {
  if (t in facts.tablePolicies) failures.push(`暂存表 ${t}（被 renameTable 改掉的中间表）不得登记策略 —— 迁移结束时它并不存在`);
}
// ⚠ `dropTableIfExists` 只用来表达**退役表**（spec §5.4），不用来做"重建中转"：
//   中转删除一律用 `dropTable`（不带 IfExists），所以这里不会出现"某张表既被建出来又被 IfExists 删掉"
//   的正常情形。真的出现就说明有人把重建写成了 `dropTableIfExists` —— 那会让它被误判成退役表。
for (const t of droppedInSchema) {
  if (created.includes(t)) {
    failures.push(
      `表 ${t} 同时出现在"建表清单"与"dropTableIfExists 退役清单"里 —— 这是重建中转删除的形状。` +
        ` 退役表只能出现在 DROPPED_TABLES（spec §5.4）；迁移内的重建请用 \`dropTable\`（不带 IfExists）。`,
    );
  }
}

// ---------- 一致性判据 ----------
const policies = facts.tablePolicies;
const infra = new Set(facts.infraTables);
const dropped = new Set(facts.droppedTables);
const tenant = facts.tenantTables.slice().sort();

const declaredBusiness = Object.keys(policies).filter((t) => !infra.has(t)).sort();
if (JSON.stringify(declaredBusiness) !== JSON.stringify(created)) {
  failures.push(
    `策略表 ↔ 迁移建表清单不一致（全部迁移，不含被 renameTable 改掉的暂存表）：\n      只有策略 ${declaredBusiness.filter((t) => !created.includes(t)).join(", ") || "（无）"}\n      只有建表 ${created.filter((t) => !declaredBusiness.includes(t)).join(", ") || "（无）"}`,
  );
}
if (JSON.stringify(facts.droppedTables.slice().sort()) !== JSON.stringify(droppedInSchema)) {
  failures.push(
    `DROPPED_TABLES ↔ 迁移的 dropTableIfExists 不一致：策略 ${facts.droppedTables.join(", ")}；迁移 ${droppedInSchema.join(", ")}`,
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
// ⚠ 28 张租户表：既有 22 张（含 `o_account` / `o_modelGrant`）+ Phase 2 的 6 张账务、准入与成员表；
//   定价 `o_price` 和组配置表是 platform，不计入租户数。数字变化需核对，不能放宽逐表清单校验。
if (tenant.length !== 28) {
  failures.push(
    `tenant 表应为 28 张（既有 22 张 + Phase 2 的 6 张账务/准入/成员表），` +
      `实际 ${tenant.length}：${tenant.join(", ")}`,
  );
}
if (facts.userColumn !== "userId") failures.push(`策略层的 USER_COLUMN 必须是 "userId"（守卫与回填都按它注入），实际 ${String(facts.userColumn)}`);

// ④ 回填/自检/豁免常量**复用**（禁止第三份手写清单）：
//   不变量（Phase 1c Task 1）：TENANT == BACKFILL_TARGETS ∪ {o_project} ∪ EXEMPT
const exempt = facts.backfillExemptTables.slice().sort();
const selfCheck = facts.selfCheckTables.slice().sort();
const backfill = facts.backfillTargetTables.slice().sort();
if (exempt.length !== 8) failures.push(`BACKFILL_EXEMPT_TABLES 应包含 8 张迁移后新建的租户空表，实际 ${exempt.length}（检查 backfill-userid.ts 的导出）`);
for (const t of exempt) {
  if (!tenant.includes(t)) failures.push(`BACKFILL_EXEMPT_TABLES 里的 ${t} 不是租户表（不在 TENANT_TABLES 里）—— 豁免只对租户表有意义`);
}
// ① SELF_CHECK == TENANT − EXEMPT（自检表 = 真的会被回填的那批；豁免表没有历史行，不进自检）
const expectedSelf = tenant.filter((t) => !exempt.includes(t)).sort();
if (JSON.stringify(selfCheck) !== JSON.stringify(expectedSelf)) {
  failures.push(
    `SELF_CHECK_TABLES ↔ TENANT_TABLES − BACKFILL_EXEMPT_TABLES 不一致：\n      只有 SELF_CHECK ${selfCheck.filter((t) => !expectedSelf.includes(t)).join(", ") || "（无）"}\n      只有 TENANT−EXEMPT ${expectedSelf.filter((t) => !selfCheck.includes(t)).join(", ") || "（无）"}`,
  );
}
// ② BACKFILL_TARGET == TENANT − EXEMPT − {o_project}（链源头单独处理）
const expectedBackfill = expectedSelf.filter((t) => t !== "o_project").sort();
if (JSON.stringify(backfill) !== JSON.stringify(expectedBackfill)) {
  failures.push(
    `BACKFILL_TARGET_TABLES ↔ TENANT_TABLES − BACKFILL_EXEMPT_TABLES − {o_project} 不一致：\n      只有回填目标 ${backfill.filter((t) => !expectedBackfill.includes(t)).join(", ") || "（无）"}\n      只有租户表 ${expectedBackfill.filter((t) => !backfill.includes(t)).join(", ") || "（无）"}`,
  );
}
// ③ 三组并集**恰好**覆盖全部租户表（"多一张租户表但没归类"必红 —— 这是本门禁的核心判据）
const union = [...new Set(["o_project", ...backfill, ...exempt])].sort();
if (JSON.stringify(union) !== JSON.stringify(tenant)) {
  failures.push(
    `三方并集 {o_project} ∪ BACKFILL_TARGET_TABLES ∪ BACKFILL_EXEMPT_TABLES ↔ TENANT_TABLES 不一致：\n      只有并集 ${union.filter((t) => !tenant.includes(t)).join(", ") || "（无）"}\n      只有 TENANT ${tenant.filter((t) => !union.includes(t)).join(", ") || "（无）"}`,
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
    `与 ${tables.files.length} 个迁移文件的 ${created.length} 张建表逐项一致（暂存表 ${staging.length} 张已排除：${staging.join(", ") || "（无）"}）；` +
    `回填目标 ${facts.backfillTargetTables.length} + 自检 ${facts.selfCheckTables.length} + 豁免 ${exempt.length}` +
    `（三者并集 == TENANT_TABLES，全部复用 backfill-userid.ts 的导出常量）`,
);
