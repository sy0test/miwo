/**
 * 类型声明：`db-target-guard.cjs` 是纯 CJS（见该文件头），这里只暴露它的公开形状，
 * 让 `apps/api/scripts/*.ts`（`module: CommonJS` + `esModuleInterop`）能用
 * `import guard from "./db-target-guard.cjs"` 拿到**有类型**的护栏，而不是 `any`。
 *
 * ⚠ 用 `export =`（CJS 形状）而不是 `export default`：本仓库 tsconfig 是
 *   `module: CommonJS` + `esModuleInterop: true`，`export =` 是与之匹配的声明形式；
 *   `export default` 会让 `.cjs` 的真实形状（`module.exports = {...}`）对不上。
 */
declare const guard: {
  API_ROOT: string;
  HOWTO: string;
  OPT_IN_FLAGS: string[];
  describeTarget(opts?: { env?: NodeJS.ProcessEnv }): string;
  driverOf(opts?: { env?: NodeJS.ProcessEnv }): string;
  repoDevDbFile(): string;
  repoDevDbVerdict(opts?: {
    env?: NodeJS.ProcessEnv;
    argv?: string[];
    what?: string;
    log?: (s: string) => void;
  }): {
    checked: boolean;
    blocked: boolean;
    target: string;
    reason: string;
    driver?: string;
    devFile?: string;
    resolved?: string;
    canonicalDevFile?: string;
    repoRoot?: string;
  };
  repoRoot(): string;
  resolvedSqliteFile(opts?: { env?: NodeJS.ProcessEnv }): string;
  requireDriver(
    want: string,
    what: string,
    opts?: { env?: NodeJS.ProcessEnv; exitCode?: number; log?: (s: string) => void },
  ): void;
  requireRepoDevDbAllowed(opts?: {
    env?: NodeJS.ProcessEnv;
    argv?: string[];
    what?: string;
    log?: (s: string) => void;
    exitCode?: number;
  }): { checked: boolean; blocked: boolean; target: string; reason: string };
  samePath(a: string, b: string): boolean;
};

export = guard;
