/**
 * systemDb 绕过口清单的代码侧判据，作为 tenant exception inventory 的第二道测试保障。
 *
 * `systemDb` 是受控的管理查询绕过口。清单中的每个文件必须显式导入它，全仓导入者集合
 * 必须与清单完全相等；新增或移除使用者时，此处和 `tools/check-tenant-exceptions.cjs`
 * 的显式 `systemDbUsers` inventory 都要求同步审查。
 *
 * ⚠ 判据是**逐行正则**（`m` 标志，行首 `import`）：只认真正的 import 语句，
 *   注释里提到 `systemDb`（例如 `lib/fixDB.ts:38`）不会被误判成使用者。
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = path.resolve(__dirname, "..");
const SRC = path.join(API_ROOT, "src");

/**
 * 唯一绕过口 `systemDb` 的**登记清单**（相对 `src/`）：实例级运维与管理端用户组成员存在性检查。
 *
 * ⚠ **Phase 1b Task 7 收窄：7 → 6。** `routes/other/deleteAllData.ts` 原本在列（它用 `systemDb`
 *   配合 `initDB(db, true)` 清整库）；Task 7 按 Lead 裁定把它改成**无条件 501 停用**（连 admin 也打不动），
 *   并删掉了它的 `initDB`/`systemDb` 依赖 ⇒ 它**不再持有任何 DB 访问面**，也就不是绕过口使用者了。
 *   本清单必须跟着**收窄**（这正是这条用例的设计意图：绕过面变大变小都要有人看见）；
 *   文件与路由挂载都**保留**，只是不再走 DB。
 *
 * ⚠ **Phase 1c Task 5 收窄：6 → 5。** `lib/fixDB.ts` 随死代码清理被**删除**
 *   （它只被 `check-copy.cjs` 的"必须存在"断言钉住，那条断言也一并删了）。
 *   `lib/initDB.ts` 从来不在本清单里（它拿的是**传入的** Knex 参数，不 import `systemDb`）。
 */
const SYSTEM_DB_USERS = [
  "routes/billing/admin/groups.ts",
  "routes/setting/dbConfig/clearData.ts",
  "routes/setting/dbConfig/clearTable.ts",
  "routes/setting/dbConfig/dbInfo.ts",
  "routes/setting/dbConfig/exportData.ts",
  "routes/setting/dbConfig/importData.ts",
];

/** 行首的 `import { … systemDb … } from "@/utils/db"`（别名写法 `systemDb as db` 同样命中）。 */
const SYSTEM_DB_IMPORT_RE = /^\s*import\s*\{[^}]*\bsystemDb\b[^}]*\}\s*from\s*["']@\/utils\/db["']/m;

/**
 * 是否还有"命名导入**裸** db"（`import { db } from "@/utils/db"` —— 被删掉的旧绕过口）。
 *
 * ⚠ 不能简单用 `\bdb\b` 判：`import { systemDb as db }` 里的**别名** `db` 也会命中它。
 *   判据必须是**导入名**（`as` 之前那一段）= `db`。
 */
function importsNamedRawDb(src: string): boolean {
  const re = /^\s*import\s*\{([^}]*)\}\s*from\s*["']@\/utils\/db["']/gm;
  for (const m of src.matchAll(re)) {
    const names = m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    if (names.includes("db")) return true;
  }
  return false;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name === "dist") continue;
      walk(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

const rel = (abs: string) => path.relative(API_ROOT, abs).split(path.sep).join("/");
const read = (apiRelPath: string) => fs.readFileSync(path.join(API_ROOT, apiRelPath), "utf8");

describe("唯一绕过口 systemDb 的登记清单", () => {
  it("6 个登记文件各自显式导入 systemDb", () => {
    for (const r of SYSTEM_DB_USERS) {
      const abs = path.join(API_ROOT, "src", r);
      expect(fs.existsSync(abs), `${r} 必须存在`).toBe(true);
      const src = fs.readFileSync(abs, "utf8");
      expect(SYSTEM_DB_IMPORT_RE.test(src), `${r} 必须显式命名导入 systemDb（\`import { systemDb } from "@/utils/db"\`，别名任意、惯用 \`as db\`）`).toBe(true);
      expect(importsNamedRawDb(src), `${r} 不该再有命名导入裸 db`).toBe(false);
    }
  });

  it("全仓 systemDb 使用者集合 == 登记清单（新增使用者即红）", () => {
    const importers = walk(SRC)
      .filter((p) => SYSTEM_DB_IMPORT_RE.test(fs.readFileSync(p, "utf8")))
      .map(rel)
      .sort();
    expect(importers).toEqual(SYSTEM_DB_USERS.map((r) => `src/${r}`).sort());
  });

  it("getEvent 改走守卫：命名导入裸 db 已删，raw 也经 `u.db`（守卫）", () => {
    const src = read("src/routes/novel/event/getEvent.ts");
    expect(importsNamedRawDb(src)).toBe(false);
    expect(/^\s*import u from "@\/utils";/m.test(src)).toBe(true);
    expect(src).toMatch(/u\.db\.raw\(/);
    // 不许再出现"裸 db.raw("（`u.db.raw(` 的前缀是 `.`，不会被这条误伤）
    expect(src).not.toMatch(/(^|[^.\w])db\.raw\(/);
  });
});
