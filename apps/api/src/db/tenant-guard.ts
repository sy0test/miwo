/**
 * 租户守卫：把 `u.db` 变成 fail-closed 的唯一入口（spec §6.2 / §6.4）。
 *
 * 为什么用 Proxy 而不是"改 462 处调用点"：
 *  - 462 处调用点里，任何一处漏改都是一次越权；把隔离放在**唯一入口**上，
 *    "漏改"就从"越权"变成"当场报错/查不到"（spec §6.2 的原话）。
 *
 * 注入规则（每条都有实跑证据，见计划正文"本计划的实测证据"）：
 *  1. 主表是 tenant → 拿表名时就 `andWhere("<alias>.userId", ctx.userId)`。
 *  2. `.join/.leftJoin/…` 目标是 tenant → 往 **JoinClause 的 ON 子句**追加
 *     `andOnVal("<joinAlias>.userId", "=", ctx.userId)`。实测：`onVal/andOnVal` 只在
 *     JoinClause 上（不在 QueryBuilder 上），而 `_statements` 里最后一条 `grouping==="join"`
 *     就是它。拿不到 JoinClause / 没有 `andOnVal` → **直接抛错**（fail-closed，绝不静默放行）。
 *  3. `insert` → 给每一行补 `userId`；显式写了别人的 `userId` → 抛错。
 *  4. `update/delete/del` → 靠规则 1 已注入的主表条件限定（实测：不带 where 的 update
 *     只影响本租户的 1 行，跨租户 update 影响 0 行）。`truncate` 无法限定 → 禁。
 *  5. 能绕过注入的方法（`orWhere*`/`whereRaw`/`joinRaw`/`crossJoin`/`union*`/`with*`/
 *     `having*`/`whereExists`/`whereNotExists`）在租户查询上禁；`joinRaw` 另加"SQL 文本
 *     提及租户表即禁"。⚠ 全仓实测这些方法当前 **0 处调用**，所以这是零回归的封堵。
 *  6. 执行前再做一次 SQL 复核：SELECT 的投影/FROM 段里提到的每张租户表，都必须在
 *     WHERE 里有 `<别名>.userId = ?` 且绑定值就是 `ctx.userId`。实测它能抓住
 *     "把租户子查询塞进平台查询的投影"和"注入被人为拆掉"两种情形，且对现有查询零误报。
 *  7. 平台表：读放行（含无 ctx，登录前取 tokenKey 需要）；写要求 `ctx.role === "admin"`，
 *     否则 `PlatformWriteDeniedError`。
 *  8. 未声明策略的表 → `PolicyNotFoundError`；退役表 → 同一个错误但文案点明"已退役"。
 *
 * ⚠ 已知**有意不支持**的形态（都是 fail-closed，不是静默降级）：
 *  - `join({别名: "表"})` 对象形式 → `parseTableSpec` 抛（全仓 0 处使用）
 *  - `joinRaw` / `crossJoin` / `with` / `union` / `whereRaw` 在租户查询上一律抛
 *  - `select` 之外的语句不做执行前复核（update/delete 由主表条件保证；insert 单独补列）
 */
import type { Knex } from "knex";
import { PolicyNotFoundError, TABLE_POLICIES, TENANT_TABLES, USER_COLUMN, policyOfIn, type TablePolicy } from "@/db/policies";
import { TenantContextError, type TenantCtx } from "@/db/tenant-context";

type AnyFn = (...args: any[]) => any;

export interface TenantGuardOptions {
  /** 取当前 ctx；返回 undefined 表示"没有租户上下文"。 */
  getCtx: () => TenantCtx | undefined;
  /** 覆盖策略表（默认 `TABLE_POLICIES`）。只为单测 `global` 这类"表映射里暂未用到"的语义。 */
  policies?: Readonly<Record<string, TablePolicy>>;
}

export interface TenantAwareDb {
  (table: string): any;
  raw: AnyFn;
  transaction: AnyFn;
  trx: AnyFn;
  fn: any;
  ref: any;
  schema: any;
  client: any;
  destroy: AnyFn;
  migrate: any;
  seed: any;
}

export class TenantIsolationError extends Error {
  readonly httpStatus = 403;
  readonly code = "TENANT_ISOLATION";
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

export class PlatformWriteDeniedError extends Error {
  readonly httpStatus = 403;
  readonly code = "PLATFORM_WRITE_DENIED";
  constructor(message: string) {
    super(message);
    this.name = "PlatformWriteDeniedError";
  }
}

/** join 族里"参数形式可解析"的方法（不含 `joinRaw`，它单独处置）。 */
export const JOIN_METHODS: ReadonlySet<string> = new Set([
  "join", "innerJoin", "leftJoin", "leftOuterJoin", "rightJoin", "rightOuterJoin", "outerJoin", "fullOuterJoin",
]);

/** 能绕过注入的方法：租户查询上一律禁（`orWhere*` 前缀另判）。 */
export const WIDENING_METHODS: ReadonlySet<string> = new Set([
  "with", "withRecursive", "union", "unionAll", "having", "havingRaw", "whereRaw",
  "joinRaw", "crossJoin", "truncate", "whereExists", "whereNotExists",
]);

const WRITE_METHODS: ReadonlySet<string> = new Set(["insert", "update", "delete", "del", "truncate"]);

/**
 * "执行前复核"（规则 6）专用错误：**不是**新分类，而是给守卫内部一个可判别的标记。
 * 构建期同步触发复核时（`.select()` 会同步 `toSQL()`），守卫据此把错误"延到 await"，
 * 见 `wrapBuilder` 里 `deferred` 的注释。对调用方而言它仍是 `TenantIsolationError`（403）。
 */
class SqlScopeError extends TenantIsolationError {
  constructor(message: string) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

/** "o_assets" / "o_assets as a" / "`o_assets`" → {table, alias}；解析不出来就抛（fail-closed）。 */
export function parseTableSpec(spec: unknown): { table: string; alias: string } {
  if (typeof spec !== "string") {
    throw new PolicyNotFoundError(`无法解析表名（非字符串）：${JSON.stringify(spec)} —— 守卫不能确认隔离条件，fail-closed`);
  }
  const cleaned = spec.replace(/[`"']/g, " ").trim();
  const withAlias = /^([A-Za-z_][\w$]*)\s+(?:as\s+)?([A-Za-z_][\w$]*)$/i.exec(cleaned);
  if (withAlias) return { table: withAlias[1], alias: withAlias[2] };
  const bare = /^([A-Za-z_][\w$]*)$/.exec(cleaned);
  if (bare) return { table: bare[1], alias: bare[1] };
  throw new PolicyNotFoundError(`无法解析表名/别名（fail-closed）："${spec}"`);
}

/** 一个租户表名在 SQL 文本里的"词边界"匹配器（`i`：修复轮 1 / M4，表名匹配不分大小写）。 */
function tenantTablePattern(table: string): RegExp {
  return new RegExp(`(^|[^\\w$])${table}([^\\w$]|$)`, "i");
}

/** SQL 文本里出现的**所有**租户表名（去重、按 `TENANT_TABLES` 顺序）。 */
function tenantTablesIn(text: string): string[] {
  return TENANT_TABLES.filter((t) => tenantTablePattern(t).test(text));
}

/** SQL 文本里是否出现任何租户表名（词边界匹配，避免 `json_extract(x,'$.o_assetss')` 这类误报）。 */
function mentionsTenantTable(sql: unknown): string | null {
  return tenantTablesIn(String(sql))[0] ?? null;
}

/**
 * 把 SQL 里的**单引号字符串字面量**替换成空串（修复轮 1 / M5）。
 *
 * 为什么必须先剥：`where("describe", "like", "%o_segment%")` 这类**参数**会出现在
 * `where ... = '...'` 的位置，`select 'o_tasks'` 也是合法 SQL。不剥就会把字面量误判成
 * "提到了租户表"（假红）；剥了之后复核才敢扫**整条** SQL（而不是只看第一个 `where` 之前）。
 * SQL 的单引号转义是 `''`，这里一并处理。
 */
function stripSqlLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

export function makeTenantAware(knex: Knex, options: TenantGuardOptions): TenantAwareDb {
  const { getCtx } = options;
  const policyTable = options.policies ?? TABLE_POLICIES;
  const resolvePolicy = (table: string): TablePolicy => policyOfIn(table, policyTable);

  const needCtx = (): TenantCtx => {
    const ctx = getCtx();
    if (!ctx) throw new TenantContextError();
    return ctx;
  };

  /**
   * 把"守卫在**构建期**就发现的违规"变成**拒绝的 Promise**，而不是同步抛。
   *
   * 为什么必须有这条路径（本机实跑，brief Step 1 的用例钉住了它）：
   *  - `await expect(db("o_tasks").insert({userId: 别人})).rejects.toThrow(...)`：knex 的
   *    `.insert()` 本身是同步的；若守卫同步抛，`await expect(...)` 拿不到 promise（用例失败）。
   *    守卫必须像 knex 一样"把错误延到 await 时才响"。
   *  - `db("o_setting").select(<租户子查询>)`：knex 的 `.select()` 会**同步**调 `toSQL()`
   *    （SQLite 方言要展开子查询），于是执行前复核在构建期就被触发，同样必须变成拒绝。
   *  - 失败方向不变：这个 promise **只 reject、永不 resolve**（fail-closed，绝不静默放行）。
   */
  const asRejection = (err: unknown): Promise<never> => Promise.reject(err);

  /** 构建期"某一行显式写了别人的 userId"的统一检查（`insert` 与 `update` payload 共用，修复轮 1 / M2）。 */
  const assertOwnUserId = (row: any, what: string, ctx: TenantCtx): void => {
    if (row === null || typeof row !== "object" || Array.isArray(row)) return;
    const current = row[USER_COLUMN];
    if (current !== undefined && current !== null && Number(current) !== Number(ctx.userId)) {
      throw new TenantIsolationError(`${what} 显式写了别人的 ${USER_COLUMN}=${current}（ctx=${ctx.userId}）—— 已阻断`);
    }
  };

  /**
   * 执行前复核（规则 6）。
   *
   * 修复轮 1 的三处收紧：
   *  - **M5**：扫整条 SQL（字符串字面量先剥掉），不再只看第一个 `where` 之前 ——
   *    平台查询的 WHERE/HAVING 里塞租户子查询、平台 builder `.from(租户表)` 后写，
   *    都要被拦；
   *  - **M4**：表名匹配不分大小写；
   *  - `insert`：隔离由构建期的 `fill()` 保证（SQL 里没有 `userId = ?`），所以它的
   *    判据是"SQL 里提到的租户表就是守卫登记的那张"，防 `.from()`/`.into()` 换表。
   */
  function assertSqlScoped(target: any, self: { policy: string | null; alias: string | null; table: string | null }): void {
    const { sql, bindings } = target.toSQL();
    const text = stripSqlLiterals(String(sql));
    const names = tenantTablesIn(text);
    if (!names.length) return; // 没提及任何租户表（含字面量里的表名）→ 无需复核
    const ctx = getCtx();
    const boundSelf = ctx ? (bindings ?? []).filter((b: unknown) => Number(b) === Number(ctx.userId)).length : 0;

    if (/^\s*insert\b/i.test(sql)) {
      const declared = self.table ? self.table.toLowerCase() : "";
      const swapped = names.filter((t) => t.toLowerCase() !== declared);
      if (!declared || swapped.length) {
        throw new SqlScopeError(
          `执行期复核失败：insert 的目标表与守卫登记的表不一致（登记 "${self.table ?? "—"}"，SQL 提及 ${names.join(", ")}）` +
            `—— 已阻断（fail-closed）`,
        );
      }
      return;
    }

    const conditions = (text.match(/[.`"']?\buserId\b[.`"']?\s*=\s*\?/gi) ?? []).length;
    if (conditions < names.length || boundSelf < names.length) {
      throw new SqlScopeError(
        `执行期复核失败：SQL 提及 ${names.length} 张租户表（${names.join(", ")}），` +
          `但只有 ${conditions} 处 userId 条件 / ${boundSelf} 个 ctx.userId 绑定 —— 已阻断（fail-closed）`,
      );
    }
  }

  function wrapBuilder(qb: any, self: { policy: string | null; alias: string | null; table: string | null; joins: string[] }): any {
    /**
     * 构建期发现的"执行前复核"违规（`deferred`）：**留到 await 时才响**。
     *
     * 为什么不能当场同步抛：`db("t").select(<租户子查询>).where(...)` 会立刻断链
     * （`.where()` 拿到的是抛出的异常而不是 builder），且 `await expect(...).rejects` 也不认同步抛。
     *
     * ⚠ 形状是本机实测出来的（四种写法都试过，红绿证据在 task-2-report.md）：
     *  ① `then()` 里返回拒绝 promise（真 Promise / Proxy 包真 Promise 都试过）：
     *     Node 24 + V8 + vitest 3.2.7 下 `await` **永不 settle**（8s 超时，错误另走
     *     unhandledRejection）。⇒ 必须**直接调用 then 的 onRejected**（`rejectWith`）。
     *  ② 构建期 catch-all 那条路没有 onRejected，只能返回"注定失败对象"；而 vitest 的
     *     `.rejects` 只认**真 Promise 实例**，同时调用方还要能继续 `.where()`。⇒ 一个
     *     已拒绝的真 Promise + 把 builder 方法装饰成"调用即返回它自己"（见 `rejectWith`）。
     */
    let deferred: unknown = null;
    let doomed: any = null;
    /**
     * "注定失败"的统一应答（本机实测唯一可行形状）：
     *  - 有 `onRejected`（thenable 协议入口）→ **直接调用它**，而不是返回拒绝 promise（见上面 ①）。
     *  - 没有（构建期 catch-all）→ 造一个"真拒绝 Promise + 可继续链式调用"的对象：
     *    `instanceof Promise === true`（vitest `.rejects` 的硬要求），builder 方法装饰成
     *    "调用即返回它自己"（`.select(...)` 之后还能 `.where(...)` 的硬要求）。
     *  - 失败方向不变：只拒绝、永不 resolve，且**不会真的执行 SQL**（knex builder 从未被 await）。
     */
    const rejectWith = (err: unknown, thenArgs?: any[]): any => {
      const onRejected = thenArgs && typeof thenArgs[1] === "function" ? thenArgs[1] : null;
      if (onRejected) return onRejected(err);
      if (!doomed) {
        const p: any = Promise.reject(err);
        const names = new Set<string>();
        for (let o: any = qb; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
          for (const key of Object.getOwnPropertyNames(o)) names.add(key);
        }
        for (const key of names) {
          if (key === "then" || key === "catch" || key === "finally" || key === "constructor") continue;
          if (key.startsWith("_")) continue; // knex 内部状态：装饰它只会制造误用
          try {
            if (typeof Reflect.get(qb, key) !== "function") continue;
            Object.defineProperty(p, key, { value: () => p, enumerable: false, configurable: true, writable: true });
          } catch {
            /* 只读属性跳过：只求"可继续链"，不要因为装饰失败改变失败方向 */
          }
        }
        doomed = p;
      }
      return doomed;
    };
    /** 查询真正被执行的地方（`then`）：先做执行前复核，再交给 knex。 */
    const run = (target: any, thenFn: AnyFn, args: any[]): any => {
      if (deferred) return rejectWith(deferred, args);
      try {
        assertSqlScoped(target, self);
      } catch (err) {
        return rejectWith(err, args);
      }
      return Promise.resolve(thenFn.apply(target, args)).then(args[0], args[1]);
    };
    const proxy: any = new Proxy(qb, {
      get(target: any, prop: string | symbol) {
        const value = Reflect.get(target, prop);
        if (typeof value !== "function") return value;
        const keep = (out: unknown) => (out === target ? proxy : out);

        if (prop === "then") return (...args: any[]) => run(target, value, args);
        // ⚠ `.catch()` / `.finally()` 也必须先过执行前复核（修复轮 1 / M1）：只给 `then` 加
        //    复核等于给"用 catch 收尾的调用方"留一条静默越权路（实测：`.catch(h)` 会把两租户
        //    全部行 resolve 出来，而同一句 `await` 却被拦）。
        if (prop === "catch") {
          return (...args: any[]) => {
            try {
              assertSqlScoped(target, self);
            } catch (err) {
              return Promise.reject(err).catch(args[0]);
            }
            return Promise.resolve(value.apply(target, args)).catch(args[0]);
          };
        }
        if (prop === "finally") {
          return (...args: any[]) => {
            try {
              assertSqlScoped(target, self);
            } catch (err) {
              return Promise.reject(err).finally(args[0]);
            }
            return Promise.resolve(value.apply(target, args)).finally(args[0]);
          };
        }

        // clone 出来的 builder 仍然要在守卫里（否则 clone 之后的 join 不会被注入）
        if (prop === "clone") return (...args: any[]) => wrapBuilder(value.apply(target, args), self);

        if (prop === "insert") {
          return (...args: any[]) => {
            if (self.policy === "tenant") {
              try {
                const ctx = needCtx();
                const fill = (row: any) => {
                  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
                  const current = row[USER_COLUMN];
                  if (current !== undefined && current !== null && Number(current) !== Number(ctx.userId)) {
                    throw new TenantIsolationError(`insert 显式写了别人的 ${USER_COLUMN}=${current}（ctx=${ctx.userId}）—— 已阻断`);
                  }
                  return { ...row, [USER_COLUMN]: ctx.userId };
                };
                args = args.map((a) => (Array.isArray(a) ? a.map(fill) : fill(a)));
              } catch (err) {
                // ⚠ 非法 insert 必须是**拒绝的 Promise**而不是同步抛：契约是
                //    `await expect(db("t").insert({userId: 别人})).rejects.toThrow(...)`。
                //    这里能直接用 `Promise.reject`（真 Promise）是因为 `insert` 是**普通构建期方法**、
                //    不在 thenable 协议路径上；`run()`/catch-all 那两条才必须走 `rejectWith` 的
                //    "有 onRejected 就调它"（原因见 `rejectWith` 注释）。失败方向一致：只拒绝、不执行 SQL。
                return Promise.reject(err);
              }
            } else {
              assertPlatformWriteAllowed(self);
            }
            return keep(value.apply(target, args));
          };
        }

        if (WRITE_METHODS.has(String(prop))) {
          return (...args: any[]) => {
            if (self.policy === "tenant") {
              if (prop === "truncate") throw new TenantIsolationError("租户表禁用 truncate()：它无法被租户条件限定");
              if (prop === "update") {
                // 修复轮 1 / M2：`update({userId: 别人})` 能把**自己的行**改成别人的
                // （实测：`db("o_tasks").update({userId: 8})` 影响 1 行），必须在构建期拦。
                try {
                  const ctx = needCtx();
                  args.forEach((a: any, i: number) => {
                    if (Array.isArray(a)) {
                      for (const row of a) assertOwnUserId(row, "update 的 payload", ctx);
                    } else if (typeof a === "string" && a === USER_COLUMN) {
                      assertOwnUserId({ [USER_COLUMN]: args[i + 1] }, "update 的 payload", ctx); // .update("userId", 8)
                    } else {
                      assertOwnUserId(a, "update 的 payload", ctx);
                    }
                  });
                } catch (err) {
                  return rejectWith(err); // 保链 + 不留 unhandledRejection
                }
              }
            } else {
              assertPlatformWriteAllowed(self);
            }
            return keep(value.apply(target, args));
          };
        }

        if (JOIN_METHODS.has(String(prop))) {
          return (...args: any[]) => {
            const info = parseTableSpec(args[0]);
            const joinPolicy = resolvePolicy(info.table);
            const out = value.apply(target, args);
            if (joinPolicy === "tenant") {
              const ctx = needCtx();
              const statements = target._statements;
              const joinClause = Array.isArray(statements)
                ? [...statements].reverse().find((s: any) => s.grouping === "join")
                : undefined;
              if (!joinClause || typeof joinClause.andOnVal !== "function") {
                throw new TenantIsolationError(
                  `knex 内部结构变化：无法在 join(${info.table}) 的 ON 子句注入租户条件（fail-closed）。` +
                    `请核对 knex 版本并把 tests/tenant-guard.test.ts 的"join 族方法名"用例一起更新`,
                );
              }
              joinClause.andOnVal(`${info.alias}.${USER_COLUMN}`, "=", ctx.userId);
              self.joins.push(info.alias);
            }
            return keep(out);
          };
        }

        if (prop === "joinRaw") {
          return (...args: any[]) => {
            if (self.policy === "tenant" || mentionsTenantTable(args[0])) {
              throw new TenantIsolationError("joinRaw 无法注入租户条件（fail-closed）；实例级运维请走 src/utils/db.ts 的 systemDb");
            }
            return keep(value.apply(target, args));
          };
        }

        if (/^orWhere/.test(String(prop)) || WIDENING_METHODS.has(String(prop))) {
          return (...args: any[]) => {
            if (self.policy === "tenant" || self.joins.length) {
              throw new TenantIsolationError(`${String(prop)}() 会绕过注入的租户条件，租户查询上禁用`);
            }
            return keep(value.apply(target, args));
          };
        }

        if (prop === "transaction" || prop === "trx") {
          return (...args: any[]) => {
            const index = args.findIndex((a) => typeof a === "function");
            if (index >= 0) {
              const fn = args[index];
              args[index] = (trx: any) => fn(guardTrx(trx));
            }
            return value.apply(target, args);
          };
        }

        return (...args: any[]) => {
          if (deferred) return rejectWith(deferred, args); // 已注定失败：只保链，不再动 builder
          try {
            return keep(value.apply(target, args));
          } catch (err) {
            // 构建期方法（如 `.select()`、`.orderBy()`）内部会同步调 `toSQL()`，
            // 复核因此在这里抛出。用 `rejectWith` 应答（见它的注释）。
            if (err instanceof SqlScopeError) {
              deferred = err;
              return rejectWith(err, args);
            }
            throw err;
          }
        };
      },
    });
    return proxy;
  }

  /**
   * 平台/全局表的写权限：
   *  - `platform` → 仅 admin（spec §6.2 的"写：仅 ctx.role === 'admin' 放行"）
   *  - `global`   → **任何角色都抛**（spec §6.2 的"全平台只读"）
   */
  function assertPlatformWriteAllowed(self: { policy: string | null; alias: string | null }): void {
    if (self.policy !== "platform" && self.policy !== "global") return;
    if (self.policy === "global") {
      throw new TenantIsolationError(`全局只读表 ${self.alias} 不接受任何写操作（global 策略）`);
    }
    const ctx = needCtx();
    if (ctx.role !== "admin") {
      throw new PlatformWriteDeniedError(`平台表 ${self.alias} 只允许管理员写（ctx.role=${ctx.role}, ctx.userId=${ctx.userId}）`);
    }
  }

  function guardBuilder(qb: any, tableSpec: string | undefined): any {
    let policy: string | null = null;
    let alias: string | null = null;
    let table: string | null = null;
    if (tableSpec) {
      const info = parseTableSpec(tableSpec);
      alias = info.alias;
      table = info.table;
      policy = resolvePolicy(info.table);
      if (policy === "tenant") qb.andWhere(`${alias}.${USER_COLUMN}`, needCtx().userId);
    }
    return wrapBuilder(qb, { policy, alias, table, joins: [] });
  }

  /**
   * 事务对象也要守卫：`persistShots.ts:54` 那条链路全部走 `trx("表")`。
   *
   * ⚠ `trx.raw` 必须复用**顶层 `guarded.raw` 的同一个实现**（修复轮 1 / M3）：之前是
   * `value.bind(trx)` 直接透传，实测 `await db.transaction(trx => trx.raw("update o_tasks
   * set state='hacked' where id=2"))` **真的改了别人的行**。
   */
  function guardTrx(trx: any): any {
    const guardedTrx: any = (tableSpec: string) => guardBuilder(trx(tableSpec), tableSpec);
    guardedTrx.raw = guarded.raw; // 同一个函数：提及租户表 → 抛
    for (const key of ["commit", "rollback", "fn", "ref", "schema", "client"]) {
      const value = trx[key];
      if (typeof value === "function") guardedTrx[key] = value.bind(trx);
    }
    return guardedTrx;
  }

  const guarded: any = (tableSpec: string) => guardBuilder(knex(tableSpec), tableSpec);
  guarded.raw = (sql: string, bindings?: readonly unknown[]) => {
    if (mentionsTenantTable(sql)) {
      throw new TenantIsolationError("raw() 的 SQL 提及租户表，无法注入隔离条件（fail-closed）；实例级运维请走 systemDb");
    }
    return knex.raw(sql, bindings as any);
  };
  for (const key of ["fn", "ref", "schema", "client", "destroy", "migrate", "seed", "trx"]) {
    const value: any = (knex as any)[key];
    if (typeof value === "function") guarded[key] = value.bind(knex);
  }
  guarded.transaction = (arg1: any, arg2?: any) => {
    if (typeof arg1 === "function") return (knex as any).transaction((trx: any) => arg1(guardTrx(trx)));
    return (knex as any).transaction(arg1, (trx: any) => (typeof arg2 === "function" ? arg2(guardTrx(trx)) : undefined));
  };
  return guarded as TenantAwareDb;
}
