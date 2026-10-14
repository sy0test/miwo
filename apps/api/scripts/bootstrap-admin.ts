/**
 * **一次性引导管理员**（spec §7.1 / Phase 1c 裁定 1c-25「引导管理员 + 用户重新注册」）。
 *
 *   cd apps/api
 *   node --env-file-if-exists=.env --import=tsx scripts/bootstrap-admin.ts --username=admin            # DRY-RUN（默认）
 *   node --env-file-if-exists=.env --import=tsx scripts/bootstrap-admin.ts --username=admin --apply
 *   node --env-file-if-exists=.env --import=tsx scripts/bootstrap-admin.ts --username=admin --reset-legacy --apply
 *
 * ⚠ 本仓库是 CJS，tsx 下**不能有顶层 await**（Phase 1a 账本 Ruling 21）⇒ 一切包在 `main()`。
 *
 * ── 为什么这条命令必须存在（不是"顺手加的便利脚本"）──
 *   1c-25 已拍板：既有 7 个账号走「引导管理员 + 用户重新注册」，**明文口令绝不迁移**
 *   （`005_accounts` 把老行一律迁成 `status='disabled'` + `passwordHash=''`，空哈希过不了任何 argon2 校验）。
 *   也就是说升级之后**库里一个能登录的账号都没有** —— 没有这条命令，升级完就是一座空城，
 *   "创建管理员 → 发邀请码 → 用户重新注册"这条唯一通路的第一步都迈不出去。
 *
 * ── 两条硬护栏（顺序刻意：都在 `createKnex()` 之前）──
 *   ① `validateArgs()` —— 未知旗标一律 exit 1（Ruling 25 的同款纪律）。本命令**会写权限数据**，
 *      `--aply` 这种拼错如果 fall-through 到 dry-run，操作者会以为"管理员建好了"而实际一个都没建
 *      —— 对一条改账号权限的命令，"看着对但没生效"比报错糟得多。
 *   ② `guard.requireRepoDevDbAllowed()` —— 与 `db:migrate` / `backfill-userid` **同一套判定**
 *      （`scripts/db-target-guard.cjs`，Ruling 131/139）。目标解析成 `apps/api/data/db2.sqlite`
 *      且没有显式放行时**拒绝跑**；显式放行时还要求先有"可恢复点"。
 *      ⚠ 放在 `createKnex()` **之前**是硬要求：sqlite 分支下 `createKnex()` 之前就会打开/建出库文件。
 *
 * ── 为什么 `--dry-run` 真的是 dry-run（不靠自觉）──
 *   本脚本**不 import `@/utils/db`**。那个模块有模块级副作用（sqlite 分支会 `mkdirSync`/`writeFileSync`
 *   建空库文件，并立刻 `connect()` → `migrate.latest()` 写 `knex_migrations` 记账行）——
 *   一个"默认 dry-run"的命令带上那种副作用就不再是 dry-run 了。
 *   这里只走 `@/db/connect` 的 `createKnex()`（纯建实例，不连库；knex 是惰性连接），
 *   审计行也用**同一个 knex 句柄**显式插入，绕开 `@/utils/audit`（它经 `u.db`，会拉进上面那串副作用）。
 *   证据：`verify-phase1c.cjs` 的 C 组对库文件做 sha256 前后比对（`--dry-run` 后必须逐字节不变）。
 *
 * ── 口令从哪来 ──
 *   · `MIWO_BOOTSTRAP_PASSWORD`（推荐：一次性环境变量，不落 shell history、不进 argv）
 *   · `--password-env=<变量名>`：从**指定**的变量读（部署脚本里换名字用）
 *   · 都没有时**交互式**提示（`readline`，输入回显关闭）。
 *   ⚠ `MIWO_BOOTSTRAP_*` 这两个名字**只被本脚本读**，`config.ts` 不读它们 ——
 *     一次性引导不该进应用配置面（`check-config-single-source.cjs` 只扫 `apps/api/src`，扫不到 scripts/）。
 *
 * ── 退出码 ──
 *   0 = 完成（dry-run 打印计划；`--apply` 已建号；或"已存在同名用户"由 `--apply` 判定为幂等无操作）
 *   1 = 参数错误 / 护栏拒绝 / 执行失败
 *   3 = 同名用户已存在，本命令**拒绝覆盖**（不覆盖、不改口令；重置请走 HTTP 的管理员接口）
 */
import readline from "node:readline";
import { createKnex, describeTarget } from "@/db/connect";
import { hashPassword } from "@/auth/password";
import guard from "./db-target-guard.cjs";

const WHAT = "db:bootstrap-admin";
const KNOWN_FLAGS = ["--apply", "--reset-legacy", "--allow-repo-dev-db", "--help", "-h"];
const KNOWN_PREFIXES = ["--username=", "--password-env="];
const DEFAULT_USERNAME = "admin";
/** 口令下限与 `src/auth/password.ts` 的策略不冲突（那边还有用户名不得出现在口令里的限制）。 */
const MIN_PASSWORD_LEN = 8;

const USAGE = [
  "用法（从 apps/api 下跑）：",
  "  node --env-file-if-exists=.env --import=tsx scripts/bootstrap-admin.ts [--username=<名字>] [--apply] [--reset-legacy]",
  "",
  "  --username=<名字>      管理员用户名（默认 admin；3..64 字符）",
  "  --apply                真的写库。**不加就是 DRY-RUN**（只报告会做什么、一行不写）",
  "  --reset-legacy         若库里已有同名、且 status='disabled' 的旧行（005 从明文口令迁来的）",
  "                         → 显式把它改成 role=admin / status=active / mustChangePassword=1 + 新口令哈希",
  "  --password-env=<变量名>  从该环境变量读口令（默认读 MIWO_BOOTSTRAP_PASSWORD）",
  "  --allow-repo-dev-db    显式确认「目标就是仓库内真实 dev 库」（不建议；优先 MIWO_DATA_DIR 指到别处）",
  "",
  "口令来源（按优先级）：--password-env 指定的变量 → MIWO_BOOTSTRAP_PASSWORD → 交互式输入。",
  "⚠ 不要用 `--password=`：argv 会进 shell history 与进程列表。",
].join("\n");

/** 未知旗标一律 exit 1（会改账号权限的命令不许"看着对但没生效"）。 */
function validateArgs(args: string[]): void {
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.includes(a) && !KNOWN_PREFIXES.some((p) => a.startsWith(p)));
  if (unknown.length) {
    console.error(`[bootstrap-admin] 拒绝执行 —— 未知旗标：${unknown.join(", ")}`);
    console.error("  ⚠ 本命令会**写账号权限**；拼错的旗标静默降级成 dry-run 会让人以为管理员建好了（实际没建）。");
    console.error(USAGE);
    process.exit(1);
  }
}

function valueOf(args: string[], prefix: string): string | undefined {
  return args.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

/** 交互式读口令（回显关闭）。没有 TTY 时直接失败，绝不留空口令。 */
function promptPassword(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    console.error("[bootstrap-admin] 需要口令但当前不是交互式终端：请设 MIWO_BOOTSTRAP_PASSWORD 或 --password-env=<变量名>。");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const anyRl = rl as unknown as { _writeToOutput?: (s: string) => void };
  const original = anyRl._writeToOutput?.bind(rl);
  anyRl._writeToOutput = (s: string) => {
    if (original && s.includes(question)) original(question);
  };
  return new Promise<string>((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      anyRl._writeToOutput = original;
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

/** 口令获取：显式 `--password-env` → `MIWO_BOOTSTRAP_PASSWORD` → 交互式。 */
async function resolvePassword(args: string[]): Promise<{ plain: string; source: string }> {
  const envName = valueOf(args, "--password-env=") ?? "MIWO_BOOTSTRAP_PASSWORD";
  const fromEnv = process.env[envName];
  if (fromEnv !== undefined && String(fromEnv).length > 0) return { plain: String(fromEnv), source: `环境变量 ${envName}` };
  const typed = await promptPassword("新管理员口令（输入不回显）：");
  return { plain: typed, source: "交互式输入" };
}

interface UserRow {
  id: number | string;
  username: string | null;
  role: string | null;
  status: string | null;
  passwordHash: string | null;
  mustChangePassword: number | null;
}

/** 审计行（**不**经 `@/utils/audit`：那个模块经 `u.db`，会把模块级迁移副作用拉进来）。 */
async function writeAudit(
  db: ReturnType<typeof createKnex>,
  action: string,
  target: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db("o_auditLog").insert({
    userId: null,
    role: "admin",
    action,
    target,
    detail: JSON.stringify(detail),
    requestId: null,
    ip: "cli",
    createdAt: Date.now(),
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  validateArgs(args);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(USAGE);
    return;
  }

  const apply = args.includes("--apply");
  const resetLegacy = args.includes("--reset-legacy");
  const username = (valueOf(args, "--username=") ?? DEFAULT_USERNAME).trim();
  if (username.length < 3 || username.length > 64) {
    console.error(`[bootstrap-admin] --username 必须是 3..64 字符，实际 "${username}"（长度 ${username.length}）`);
    process.exit(1);
  }

  // ⚠ 护栏必须在 createKnex() 之前（sqlite 分支下 createKnex 之前就会打开/建出库文件）。
  guard.requireRepoDevDbAllowed({ argv: args, what: WHAT });
  if (args.includes("--allow-repo-dev-db")) {
    console.log(`[bootstrap-admin] 已显式放行：--allow-repo-dev-db（目标可能是仓库内真实 dev 库）`);
  }

  const db = createKnex();
  try {
    console.log(`[bootstrap-admin] 目标库：${describeTarget()}`);
    console.log(`[bootstrap-admin] 模式：${apply ? "APPLY（会写库）" : "DRY-RUN（不写库）"}`);

    // 表存在性前置：库还没迁移时给出可操作的报错，而不是一个 `no such table` 堆栈。
    const hasUserTable = await db.schema.hasTable("o_user");
    if (!hasUserTable) {
      console.error("[bootstrap-admin] 目标库里没有 o_user 表：先跑迁移（README-auth.md 的「升级顺序」第 2 步）。");
      process.exit(1);
    }

    const existing = (await db("o_user").where("username", username).first()) as UserRow | undefined;

    if (existing && !(resetLegacy && existing.status === "disabled")) {
      // 同名存在 → **拒绝**（不覆盖、不改口令），如实说明该走哪条路。
      console.error(`[bootstrap-admin] 拒绝执行 —— 已存在用户 "${username}"（id=${existing.id}, role=${existing.role}, status=${existing.status}）。`);
      console.error("  本命令**绝不覆盖**已有账号、也**不改**它的口令（那会把一次运维操作变成静默提权）。");
      console.error("  · 忘了口令 → 用管理员接口重置；");
      if (existing.status === "disabled") console.error("  · 这是 005 从旧明文行迁来的 disabled 账号 → 加 --reset-legacy 显式重开通（会同时设 mustChangePassword=1）。");
      process.exit(3);
    }

    const mode = existing ? "reset-legacy" : "create";
    const { plain, source } = await resolvePassword(args);
    if (String(plain).length < MIN_PASSWORD_LEN) {
      console.error(`[bootstrap-admin] 口令太短：至少 ${MIN_PASSWORD_LEN} 字符（来源：${source}）。`);
      process.exit(1);
    }
    if (username.length >= 3 && String(plain).toLowerCase().includes(username.toLowerCase())) {
      console.error(`[bootstrap-admin] 口令不得包含用户名 "${username}"（与 src/auth 的口令策略一致）。`);
      process.exit(1);
    }

    if (!apply) {
      console.log(`[bootstrap-admin] DRY-RUN：将会 ${mode === "create" ? "新建" : "重开通"} 管理员 "${username}"`);
      console.log(`  · role=admin、status=active、mustChangePassword=1（首次登录强制改密）`);
      console.log(`  · passwordHash = argon2id（来源：${source}；口令**不回显、不落日志**）`);
      console.log(`  · 审计：向 o_auditLog 写一条 action=${mode === "create" ? "admin.bootstrap" : "admin.bootstrap.resetLegacy"}`);
      console.log(`  · ${mode === "create" ? "将插入 1 行 o_user" : `将更新 o_user id=${existing!.id}（当前 status=${existing!.status}）`}`);
      console.log("");
      console.log("[bootstrap-admin] 未写库（dry-run）。确认无误后加 `--apply`。");
      return;
    }

    const passwordHash = await hashPassword(String(plain));
    if (!passwordHash.startsWith("$argon2id$")) {
      // 自证：写库**之前**确认哈希形态（`@node-rs/argon2` 换默认算法会在这里红，而不是静默降级）。
      console.error(`[bootstrap-admin] 哈希形态异常（应以 $argon2id$ 开头）：${passwordHash.slice(0, 24)}…`);
      process.exit(1);
    }
    const now = Date.now();
    let userId: number;

    if (mode === "create") {
      const inserted = await db("o_user").insert({
        username,
        email: null,
        passwordHash,
        role: "admin",
        status: "active",
        tokenVersion: 0,
        mustChangePassword: 1,
        createdAt: now,
        lastLoginAt: null,
      });
      userId = Number(Array.isArray(inserted) ? inserted[0] : inserted);
      await writeAudit(db, "admin.bootstrap", `o_user:${userId}`, { username, mode, role: "admin", passwordHash: "argon2id" });
      console.log(`[bootstrap-admin] 已新建管理员 "${username}"（id=${userId}，role=admin，mustChangePassword=1，argon2id）`);
    } else {
      userId = Number(existing!.id);
      const updated = await db("o_user").where("id", userId).update({
        passwordHash,
        role: "admin",
        status: "active",
        tokenVersion: 0,
        mustChangePassword: 1,
      });
      if (Number(updated) !== 1) {
        console.error(`[bootstrap-admin] 重开通失败：期望更新 1 行，实际 ${updated} 行。`);
        process.exit(1);
      }
      await writeAudit(db, "admin.bootstrap.resetLegacy", `o_user:${userId}`, {
        username,
        mode,
        from: { status: existing!.status, passwordHashWasEmpty: !existing!.passwordHash },
        to: { status: "active", role: "admin", mustChangePassword: 1 },
      });
      console.log(`[bootstrap-admin] 已重开通旧账号 "${username}"（id=${userId}）：status=active、role=admin、mustChangePassword=1、新 argon2id 口令`);
    }

    // 自证（写完后直读一遍）：这条断言让"看起来成功"与"真的成功"分开。
    const check = (await db("o_user").where("id", userId).first()) as UserRow | undefined;
    const ok =
      !!check &&
      check.status === "active" &&
      check.role === "admin" &&
      Number(check.mustChangePassword) === 1 &&
      String(check.passwordHash ?? "").startsWith("$argon2id$");
    if (!ok) {
      console.error(`[bootstrap-admin] 自证失败：写完之后直读 o_user 与预期不符：${JSON.stringify({ ...check, passwordHash: "<省略>" })}`);
      process.exit(1);
    }
    console.log(`[bootstrap-admin] 自证：直读 o_user id=${userId} → status=active / role=admin / mustChangePassword=1 / passwordHash 以 $argon2id$ 开头`);
    console.log("[bootstrap-admin] 下一步：发邀请码 → 用户重新注册（README-auth.md「升级顺序」）。");
  } finally {
    await db.destroy();
  }
}

// ⚠ `--help` 走 main() 但不需要库；为让 --help 在缺 env 时也能用，这里先做一次纯参数短路。
if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  validateArgs(process.argv.slice(2));
  console.log(USAGE);
} else {
  main().catch((err) => {
    console.error("[bootstrap-admin] 失败：", err);
    process.exit(1);
  });
}
