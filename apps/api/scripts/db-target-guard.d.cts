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
  /** 【Ruling 139】仓库外备份目录的默认位置：`<仓库根>/../../.db-backups`。 */
  defaultBackupDir(): string;
  describeTarget(opts?: { env?: NodeJS.ProcessEnv }): string;
  driverOf(opts?: { env?: NodeJS.ProcessEnv }): string;
  /**
   * 【Ruling 139】建立/复用"可恢复点"（备份）。只读目标库。
   * 返回 `{ ok: true, sha256, reused|created, ... }` 或 `{ ok: false, error }`。
   */
  ensureRecoverablePoint(opts?: {
    target?: string;
    backupDir?: string;
    log?: (s: string) => void;
    now?: () => number;
  }):
    | { ok: true; target: string; sha256: string | null; reused: string | null; created: string | null; note?: string }
    | { ok: false; error: string };
  repoDevDbFile(): string;
  repoDevDbVerdict(opts?: {
    env?: NodeJS.ProcessEnv;
    argv?: string[];
    what?: string;
    log?: (s: string) => void;
    /** 【裁定 A】调用方已解析的驱动（`MiwoConfig.db.driver`）；给了就以它为准，不看 env。 */
    driver?: string;
    /** 【裁定 A】调用方已解析的目标文件（`MiwoConfig.db.file`）；给了就以它为准，不看 `MIWO_DATA_DIR`。 */
    file?: string;
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
    /** 只在"目标就是仓库内 dev 库 + 带了放行开关"时出现（**语法层**放行，可恢复点由硬版本建立）。 */
    optIn?: { flag: string; recoverablePoint: string };
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
    /** 【裁定 A】调用方已解析的驱动（`MiwoConfig.db.driver`）；给了就以它为准，不看 env。 */
    driver?: string;
    /** 【裁定 A】调用方已解析的目标文件（`MiwoConfig.db.file`）；给了就以它为准，不看 `MIWO_DATA_DIR`。 */
    file?: string;
    /** 测试/自证用：覆盖备份目录（默认 `defaultBackupDir()`）。 */
    backupDir?: string;
  }): {
    checked: boolean;
    blocked: boolean;
    target: string;
    reason: string;
    optIn?: { flag: string; recoverablePoint: string };
  };
  samePath(a: string, b: string): boolean;
};

export = guard;
