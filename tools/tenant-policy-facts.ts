/**
 * 给 `tools/check-tenant-policies.cjs` 用的**事实探针**（Phase 1b Task 8）。
 *
 * 为什么要有它（而不是让 CJS 门禁用正则去"读"这些常量）：
 *   · **唯一真相复用**：策略表/回填目标/自检表都是 TS 里**导出**的常量，正则解析会造出**第二份手写清单**
 *     （"手工清单必漂"在本阶段已出过多次事：漏选外键列、`--aply` 静默降级、`check-copy` 阈值口径）；
 *   · **真进程**：照 Ruling 243 —— "断言某模块/闭包"必须在**真进程**里做；这里更进一步：探针必须
 *     **自证观测到了**（`observed:true` + 各项非空），观测不到时门禁 `exit 3`（"检查没跑起来"≠"干净"）。
 *
 * 运行方式（**必须** `cwd=apps/api`：`@/*` 别名由该目录的 tsconfig 提供；实测从仓库根跑会 ERR_MODULE_NOT_FOUND）：
 *   cd apps/api && node --import=tsx ../../tools/tenant-policy-facts.ts
 * 输出：单行 `POLICY_FACTS=<JSON>`。
 */
import { BACKFILL_EXEMPT_TABLES, BACKFILL_TARGET_TABLES, SELF_CHECK_TABLES } from "@/db/legacy/backfill-userid";
import { DROPPED_TABLES, INFRA_TABLES, TABLE_POLICIES, TENANT_TABLES, USER_COLUMN } from "@/db/policies";

const facts = {
  observed: true,
  userColumn: USER_COLUMN,
  tablePolicies: TABLE_POLICIES,
  droppedTables: [...DROPPED_TABLES].sort(),
  infraTables: [...INFRA_TABLES].sort(),
  tenantTables: [...TENANT_TABLES].sort(),
  backfillTargetTables: [...BACKFILL_TARGET_TABLES].sort(),
  // ⚠【Phase 1c Task 1】豁免表也是**导出常量**（`backfill-userid.ts`），不是门禁里的第二份清单：
  //   三方一致的不变量 = `TENANT == BACKFILL_TARGETS ∪ {o_project} ∪ EXEMPT`。
  backfillExemptTables: [...BACKFILL_EXEMPT_TABLES].sort(),
  selfCheckTables: [...SELF_CHECK_TABLES].sort(),
};

// 自证：这几组必须都非空，否则就是"探针没真正读到模块"（调用方据此 exit 3）。
// ⚠ `backfillExemptTables` **允许为空**（豁免集合法地可以是空的）：只要求"字段存在且是数组"，
//   由调用方那侧的判据断言它非空（当前实现里它必然有 2 项）。
if (
  Object.keys(facts.tablePolicies).length === 0 ||
  facts.tenantTables.length === 0 ||
  facts.backfillTargetTables.length === 0 ||
  facts.selfCheckTables.length === 0 ||
  !Array.isArray(facts.backfillExemptTables)
) {
  console.error("POLICY_FACTS_INCOMPLETE=" + JSON.stringify({ ...facts, tablePolicies: Object.keys(facts.tablePolicies).length }));
  process.exit(3);
}

console.log("POLICY_FACTS=" + JSON.stringify(facts));
// ⚠ 显式退出：`@/db/policies` 不拉启动链，但保持一致（导入链里若将来有 keep-alive 句柄，别让门禁挂死）。
process.exit(0);
