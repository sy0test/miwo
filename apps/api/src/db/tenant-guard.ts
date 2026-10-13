/**
 * 租户守卫：把 `u.db` 变成 fail-closed 的唯一入口（spec §6.2 / §6.4）。
 *
 * 为什么用 Proxy 而不是"逐个改调用点"：
 *  - 调用点口径（**可复现**，别再引用不可复现的"462 处"；Ruling 205）：在仓库根跑
 *    `$f = Get-ChildItem apps/api/src -Recurse -Filter *.ts -File`，再跑
 *    `(Select-String -Path $f.FullName -Pattern 'u[.]db').Count` → Task 4 实测 **463 行**。
 *    调用点里任何一处漏改都是一次越权；把隔离放在**唯一入口**上，
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
 *     只影响本租户的 1 行，跨租户 update 影响 0 行）；`update` 的 payload 显式把
 *     `userId` 改成别人的 → 抛（修复轮 1 / M2）。`truncate` 无法限定 → 禁。
 *  5. 能绕过注入的方法（`orWhere*`/`whereRaw`/`joinRaw`/`crossJoin`/`union*`/`with*`/
 *     `having*`/`whereExists`/`whereNotExists`）在租户查询上禁；`joinRaw` 另加"SQL 文本
 *     提及租户表即禁"；`onConflict()`（upsert）在租户表上禁 —— 冲突分支无法被租户条件
 *     限定（sqlite 会把注入的 where 当成 `DO UPDATE` 的过滤，MySQL 的
 *     `ON DUPLICATE KEY UPDATE` 根本没有 WHERE ⇒ 跨方言行为不一致，只能 fail-closed）。
 *     ⚠ 全仓实测这些方法**经守卫的调用 0 处**：`db/legacy/import.ts:373` 的 `havingRaw`、
 *     `db/migrations/002_platform_seed.ts:133` 的 `whereRaw` 各 1 处，但两者都走裸 knex
 *     （legacy 导入 / 迁移器），**不经过本守卫**（见 task-2-report.md「修复轮 1」L8）。
 *  6. 执行前再做一次 SQL 复核：`then` / `catch` / `finally` **三条入口都做**（修复轮 1 / M1），
 *     先把 SQL 里的**字符串字面量剥掉**，再扫**整条** SQL（不再只看第一个 `where` 之前，
 *     修复轮 1 / M5）。SQL 里提到的每张租户表（**大小写不敏感**，修复轮 1 / M4）都必须在
 *     SQL 里有 `userId = ?` 且绑定值就是 `ctx.userId`；`insert` 例外 —— 它的隔离由构建期的
 *     `fill()` 保证（SQL 里不会有 `userId = ?`），这里只要求"SQL 里的租户表就是守卫登记的那张"
 *     （防 `.from()`/`.into()` 换表）。实测它能抓住"租户子查询塞进平台查询的投影/WHERE/
 *     HAVING"、"注入被人为拆掉"、"平台 builder 换表后写租户表"三种情形，且对现有查询零误报。
 *  7. 平台表：读放行（含无 ctx，登录前取 tokenKey 需要）；写要求 `ctx.role === "admin"`，
 *     否则 `PlatformWriteDeniedError`。
 *  8. 未声明策略的表 → `PolicyNotFoundError`；退役表 → 同一个错误但文案点明"已退役"。
 *  9. 事务：`transaction(container, config)` 把 container 包成 `guardTrx` —— `trx("表")` 走守卫、
 *     `trx.raw` 与顶层 `raw` **共用同一个租户表拦截器**（修复轮 1 / M3），但各自**绑定自己的连接**
 *     （修复轮 2 / Task 3 接线时实测：`trx.raw` 复用顶层实现 = 走根连接 = **在事务外**执行；
 *     sqlite 池 max=1 时与持有连接的事务互等 ⇒ 超时挂死）、`config` 原样透传 knex（修复轮 1 / L6）。
 *     `db.trx` 只是 `transaction` 的别名（修复轮 1 / L5）。
 * 10. 成员面与 Phase 1a 的显式白名单**逐项对齐**：函数成员 `bind(knex)`、对象成员原样挂
 *     （`fn/ref/schema/client/destroy/migrate/seed`）；`transaction`/`raw`/`trx` 是守卫自己的
 *     实现，不被覆盖。⚠ **接线时实测发现原实现只挂函数 ⇒ 对象成员全丢**（Task 3 修复，
 *     见下方 `MEMBER_SHAPES` 的注释）。
 *
 * ⚠ 已知**有意不支持**的形态（都是 fail-closed，不是静默降级）：
 *  - `join({别名: "表"})` 对象形式 → `parseTableSpec` 抛（全仓 0 处使用）
 *  - `joinRaw` / `crossJoin` / `with` / `union` / `whereRaw` 在租户查询上一律抛
 *  - 租户表上的 `onConflict()`（含 `.merge()` / `.ignore()`）：冲突分支限定不了 → 一律抛；
 *    真有实例级 upsert 就走 `systemDb`
 *  - 写入语句的隔离由"主表条件 + 执行前复核"共同兜底；函数形式的 `update` payload
 *    （`.update(fn)`）无法在构建期静态检查，只有第 6 条 SQL 复核兜底
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
 * 构建期 catch-all 里若复核同步抛出（knex 结构变化时才会发生，见 `wrapBuilder` 的注释），
 * 守卫据此把错误换成"注定失败对象"而不是当场断链。对调用方而言它仍是
 * `TenantIsolationError`（403）—— **不给它另立 `code`**（Task 4 的错误分支只认
 * `TENANT_ISOLATION`）。
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
     * "注定失败"的统一应答（`rejectWith`）。
     *
     * ⚠ 形状是本机实测出来的（红绿证据在 task-2-report.md「修复轮 1」）：
     *  ① **绝不能在 `then` 里 `return Promise.reject(...)`**：knex 的 QueryBuilder 是
     *     thenable，而 ECMAScript 的 `PromiseResolveThenableJob` **忽略 `then` 的返回值**
     *     ⇒ `await`/`Promise.resolve()` 永不 settle，错误另走 `unhandledRejection`
     *     （**这是语言语义，不是 Node 24/vitest 特有**）。所以有 `onRejected` 时**直接调用它**。
     *  ② 没有 `onRejected` 的入口（构建期 catch-all、被拒的 `insert`）返回一个**真拒绝
     *     Promise**，并把 builder 方法（含 `onConflict`/`merge`/`ignore` 这类链上方法，
     *     修复轮 1 / L1）装饰成"调用即返回它自己"，这样调用方还能继续链式写下去。
     *
     * `deferred` 已按 Ruling 189 删除：当前 knex 方言下 `.select(<raw 子查询>)` **不会**
     * 同步调 `toSQL()`（实测 `instanceof Promise === false`），所以"构建期就发现复核违规"
     * 这条路当前**不可达**；catch-all 里的 `SqlScopeError` 分支保留为**结构变化护栏**
     * （knex 哪天改成构建期执行，它保证失败方向仍然是"拒绝"而不是断链）。
     */
    let doomed: any = null;
    /**
     * 每个 wrapBuilder 一个"注定失败对象"的惰性缓存（`doomed`）：
     *  - 有 `onRejected`（thenable 协议入口）→ **直接调用它**，而不是返回拒绝 promise（见上面 ①）。
     *  - 没有（构建期 catch-all / 被拒的 insert）→ 造一个"真拒绝 Promise + 可继续链式调用"的对象：
     *    `instanceof Promise === true`（vitest `.rejects` 的硬要求，且比 thenable 更直接），
     *    builder 方法装饰成"调用即返回它自己"。
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
        // `onConflict/merge/ignore` 不在 QueryBuilder 原型上（`onConflict()` 返回的是一个
        // OnConflictBuilder，`merge()/ignore()` 在它身上）⇒ 被拒的 insert 若只装饰 QueryBuilder
        // 的方法，`.insert({别人}).onConflict("id").merge()` 仍会在 `merge` 处断成 TypeError，
        // 而原始拒绝没人消费 → unhandledRejection（Node 默认终止进程）。修复轮 1 / L1。
        for (const key of ["onConflict", "merge", "ignore"]) names.add(key);
        for (const key of names) {
          if (key === "then" || key === "catch" || key === "finally" || key === "constructor") continue;
          if (key.startsWith("_")) continue; // knex 内部状态：装饰它只会制造误用
          try {
            if (key !== "onConflict" && key !== "merge" && key !== "ignore" && typeof Reflect.get(qb, key) !== "function") continue;
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

        // clone 出来的 builder 仍然要在守卫里（否则 clone 之后的 join 不会被注入）；
        // ⚠ `joins` 必须**拷贝**（修复轮 1 / L7）：共享同一个数组会让同源 clone 互相误伤
        //    ——本体 join 过租户表之后，没 join 的克隆体会被误禁 `orWhere`。
        if (prop === "clone") return (...args: any[]) => wrapBuilder(value.apply(target, args), { ...self, joins: [...self.joins] });

        if (prop === "insert") {
          return (...args: any[]) => {
            if (self.policy === "tenant") {
              try {
                const ctx = needCtx();
                const fill = (row: any) => {
                  if (row === null || typeof row !== "object" || Array.isArray(row)) return row;
                  assertOwnUserId(row, "insert", ctx);
                  return { ...row, [USER_COLUMN]: ctx.userId };
                };
                args = args.map((a) => (Array.isArray(a) ? a.map(fill) : fill(a)));
              } catch (err) {
                // ⚠ 非法 insert 必须是**拒绝的 Promise**而不是同步抛：契约是
                //    `await expect(db("t").insert({userId: 别人})).rejects.toThrow(...)`。
                //    但**不能**用裸 `Promise.reject`（修复轮 1 / L1）：`.insert(...)` 之后常见的
                //    `.onConflict("id").merge()` 会在裸 Promise 上断成 TypeError，而原始拒绝
                //    没人消费 → unhandledRejection。统一走 `rejectWith` 的"注定失败对象"。
                return rejectWith(err);
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
                  return rejectWith(err); // 同上：保链 + 不留 unhandledRejection
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

        if (prop === "onConflict") {
          return (...args: any[]) => {
            // 修复轮 1 / M6（本轮新增发现，超出审查清单）：`onConflict()` 返回的是另一个对象
            // （OnConflictBuilder），它 `.merge()` 之后**直接返回裸 QueryBuilder** ⇒ 不但绕过
            // 第 6 条的 SQL 复核，而且冲突分支根本限定不了：实测 sqlite 只把注入的 where 当
            // `DO UPDATE` 的过滤（跨租户的冲突行侥幸没被改），而 MySQL 的
            // `ON DUPLICATE KEY UPDATE` **没有 WHERE** ⇒ 同一句代码在两种方言下隔离性不同。
            // 按"限定不了就禁"（与 `truncate` 同族）处理；实例级 upsert 走 `systemDb`。
            if (self.policy === "tenant") {
              throw new TenantIsolationError(
                "租户表禁用 onConflict()（upsert）：冲突分支无法被租户条件限定（fail-closed）；实例级运维请走 systemDb",
              );
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
          try {
            return keep(value.apply(target, args));
          } catch (err) {
            // 结构变化护栏（当前不可达，见 `rejectWith` 上方注释）：如果哪天 knex 改成
            // "构建期方法内部同步执行 SQL"，复核会在 `value.apply` 里抛出，这里把同步抛
            // 换成"注定失败对象"，失败方向仍然是拒绝、不是断链。
            if (err instanceof SqlScopeError) return rejectWith(err, args);
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
   * 租户表 `raw` 的**唯一拦截器**：顶层 `raw` 与 `trx.raw` 共用它（检查相同），
   * 但**执行各自绑定自己的连接**（修复轮 2 / Task 3 实测的缺陷，见 `guardTrx`）。
   */
  const assertRawSafe = (sql: unknown): void => {
    if (mentionsTenantTable(sql)) {
      throw new TenantIsolationError("raw() 的 SQL 提及租户表，无法注入隔离条件（fail-closed）；实例级运维请走 systemDb");
    }
  };

  /**
   * 事务对象也要守卫：`persistShots.ts:54` 那条链路全部走 `trx("表")`。
   *
   * ⚠ `trx.raw` 的历史（两轮修复，别只做一半）：
   *  - 修复轮 1 / M3：原来 `trx.raw` 是 `value.bind(trx)` **直接透传** ⇒ 事务里
   *    `trx.raw` 直通时，`update o_tasks … where id=2` 真的改了别人的行。改成**先过 `assertRawSafe`**。
   *  - 修复轮 2 / Task 3：M3 当时写成"复用顶层 `guarded.raw` 的同一个实现"，而顶层实现内部走的是
   *    `knex.raw`（**根连接**）⇒ 事务里的合法 `trx.raw` 跑到了**事务外**；
   *    sqlite 池 max=1 时它与持有唯一连接的事务**互等**，实测直接把用例挂到 5s 超时
   *    （真机上会一直挂到 `acquireTimeoutMillis`）。**检查共用、执行必须委派给 `trx`**。
   */
  function guardTrx(trx: any): any {
    const guardedTrx: any = (tableSpec: string) => guardBuilder(trx(tableSpec), tableSpec);
    guardedTrx.raw = (sql: string, bindings?: readonly unknown[]) => {
      assertRawSafe(sql);
      return trx.raw(sql, bindings as any);
    };
    for (const key of ["commit", "rollback", "fn", "ref", "schema", "client"]) {
      const value = trx[key];
      if (typeof value === "function") guardedTrx[key] = value.bind(trx);
    }
    return guardedTrx;
  }

  const guarded: any = (tableSpec: string) => guardBuilder(knex(tableSpec), tableSpec);
  guarded.raw = (sql: string, bindings?: readonly unknown[]) => {
    assertRawSafe(sql);
    return knex.raw(sql, bindings as any);
  };
  /**
   * 成员镜像：**按 Phase 1a 的显式白名单逐项核对形状**，不是黑名单。
   *
   * ⚠ 修复（Task 3 接线时实测发现）：这里原先只挂 `typeof === "function"` 的成员，于是
   *   knex 3.x 下**对象成员全丢**。实测 `knex.fn` / `knex.schema` / `knex.client` /
   *   `knex.migrate` / `knex.seed` 的 `typeof` 全是 `"object"` ⇒ 接线后 `u.db.fn` / `u.db.schema`
   *   / `u.db.client` / `u.db.migrate` / `u.db.seed` 通通变 `undefined`：
   *     ① `tests/db-driver.test.ts` 的"白名单契约"断言（`schema.createTable` / `migrate.latest`
   *        / `seed.run` / `fn.now` 可用）**必红**；
   *     ② 真实代码里 `u.db.schema` / `u.db.migrate` 这类用法会 `TypeError`。
   *   `TenantAwareDb` 接口一直声明它们存在 —— 声明与运行时不一致，与修复轮 1 / L5 同族。
   *
   * 判据（与 `utils/db.ts` 的 `DB_MEMBERS` 一字对应）：函数成员要 `bind(knex)`（`ref` 必须，
   * 否则 `this` 丢失）；**对象成员原样挂**（`bind` 只会把它们弄坏）。
   * `transaction` / `raw` / `trx` 不走这里：它们是**守卫自己的实现**（上面已挂），不能被覆盖。
   *
   * ⚠ 白名单的意义：只读这些名字，`caller` / `arguments` 在**结构上不可能**被读到
   *   （严格模式下读它们直接抛，见 `utils/db.ts` 的历史真机 bug）。
   */
  const MEMBER_SHAPES = {
    ref: "function",
    destroy: "function",
    fn: "object",
    schema: "object",
    client: "object",
    migrate: "object",
    seed: "object",
  } as const;
  for (const [key, shape] of Object.entries(MEMBER_SHAPES)) {
    let value: any;
    try {
      value = (knex as any)[key];
    } catch {
      continue; // getter 会抛就跳过，别让模块初始化挂掉
    }
    if (typeof value !== shape) continue; // 形状与白名单不符 → 不挂（宁缺勿错，也不抛）
    guarded[key] = shape === "function" ? value.bind(knex) : value;
  }
  /**
   * `transaction(container, config)`：knex 的签名是 `(container, config)`，**两个参数都要透传**
   * （修复轮 1 / L6：原实现丢掉 `arg2`，调用方设的 `doNotRejectOnRollback`/`isolationLevel`
   * 之类会被静默忽略）。
   */
  guarded.transaction = (arg1: any, arg2?: any) => {
    if (typeof arg1 === "function") return (knex as any).transaction((trx: any) => arg1(guardTrx(trx)), arg2);
    return (knex as any).transaction(arg1, (trx: any) => (typeof arg2 === "function" ? arg2(guardTrx(trx)) : undefined));
  };
  // 修复轮 1 / L5：接口声明了 `trx`，但 knex 实例上**没有** `trx` 方法 ⇒ 之前运行时是
  // `undefined`（声明在撒谎，Task 3 若照接口写 `u.db.trx(...)` 会 TypeError）。
  // knex 的语义里 `trx` 是 `transaction(container)` 里那个"事务对象"，这里显式指成
  // `transaction` 的别名，让声明与运行时一致。
  guarded.trx = guarded.transaction;
  return guarded as TenantAwareDb;
}
