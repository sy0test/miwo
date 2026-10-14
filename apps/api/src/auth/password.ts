/**
 * 口令哈希（spec §7.2：argon2id）。Phase 1c Task 2。
 *
 * 参数取 OWASP Password Storage Cheat Sheet 的**第二档**（m=19456 KiB / t=2 / p=1）：
 * 本机实测（Node v24.21.0 / win32-x64 / @node-rs/argon2 2.2.2）hash 约 22 ms、verify 约 37 ms，
 * 对登录接口可接受，且比库默认档更省内存。
 * ⚠ 参数写死在这里（不是运维旋钮）：换参数属于"安全策略变更"，要走代码评审；
 *   `needsRehash()` 负责在用户下次登录成功时把旧参数哈希升级掉。
 *
 * 为什么用 `@node-rs/argon2` 而不是 `argon2`（npm 原生）：
 *   · 本仓库是 **CJS**（tsconfig `module: CommonJS`，不能顶层 await），而 pnpm 10 默认**跳过依赖的
 *     构建脚本**：npm 原生 `argon2` 带 `install: node-gyp-build`，会被跳过 ⇒ 装完不可用；
 *     要放行就得改根 `package.json` 的 `pnpm.onlyBuiltDependencies`，连带牵动 `tools/check-natives.cjs`
 *     的清单断言（该清单是"双向核对"的，改一处要三处同步），收益为负。
 *   · `@node-rs/argon2` 是预编译 NAPI 包（可选平台依赖 `@node-rs/argon2-win32-x64-msvc`），
 *     `scripts` 里**没有** install/postinstall（实测 `tools/check-natives.cjs` 仍是 4 项 EXIT 0）。
 *
 * ⚠ 默认参数就是 argon2id（m=19456,t=2,p=1），这里仍**显式**写死 `algorithm: 2`
 *   （= `Algorithm.Argon2id`）：不写就等于把口令安全押在"库哪天不改默认值"上。
 *   刻意 `import` 常量而不是 `Algorithm` 成员：该包把枚举声明成 `const enum`，
 *   跨文件导入 `const enum` 在 esbuild/tsx 这类"单文件转译"链路上不可靠，写数字字面量最稳。
 */
import { hash, verify, type Options } from "@node-rs/argon2";

/** `algorithm: 2` === `Algorithm.Argon2id`（`@node-rs/argon2` 的枚举值，见上面注释）。 */
export const ARGON2_OPTIONS: Options = { algorithm: 2 as Options["algorithm"], memoryCost: 19456, timeCost: 2, parallelism: 1 };

export async function hashPassword(plain: string): Promise<string> {
  if (typeof plain !== "string" || plain.length === 0) throw new Error("口令不得为空");
  return hash(plain, ARGON2_OPTIONS);
}

/**
 * ⚠ 空哈希（`005_accounts` 迁过来的旧行是 `passwordHash=''`）必须**直接判 false**，
 *   不能让 argon2 去解析空串；非法哈希也一律 false —— **不把异常泄露成 500**
 *   （否则一个坏哈希就能把"登录失败"变成"服务器错误"，既是可用性问题也是信息泄露）。
 */
export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  if (!storedHash || storedHash.length < 16) return false;
  if (typeof plain !== "string" || plain.length === 0) return false;
  try {
    return await verify(storedHash, plain);
  } catch {
    return false;
  }
}

/** 参数是否与当前策略一致；不一致就该在下次登录成功后重算（`$argon2id$v=19$m=…,t=…,p=…$`）。 */
export function needsRehash(storedHash: string): boolean {
  if (!storedHash) return false;
  const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash);
  if (!m) return true;
  return (
    Number(m[1]) !== ARGON2_OPTIONS.memoryCost ||
    Number(m[2]) !== ARGON2_OPTIONS.timeCost ||
    Number(m[3]) !== ARGON2_OPTIONS.parallelism
  );
}
