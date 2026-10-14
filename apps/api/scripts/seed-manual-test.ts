/**
 * **手动点击测试的夹具种子**（`pnpm run verify:manual-test` 的第二步）。
 *
 *   cd apps/api
 *   MIWO_DATA_DIR=<一次性目录> node --import=tsx scripts/seed-manual-test.ts --admin=admin --invite=<码>
 *
 * ── 为什么需要它（不是"给测试塞数据的脚手架"）──
 *   手动测试的口径是「**打开页面 → 注册/登录 → 建项目 → 看到媒体**」四步都要能点通。
 *   一条全新迁移出来的库**四步全都点不通**，逐条都有机械理由：
 *     · 注册：默认 `registrationMode='invite'`（spec §15 O1）⇒ 没有邀请码就注册不了，
 *       而**邀请码管理接口不在 1c 范围**（brief Step 2 的 C 组同款处置）；
 *     · 登录：`005_accounts` 把旧明文行一律迁成 `status='disabled'`（口令不迁移，裁定 1c-25）
 *       ⇒ 库里一个能登录的账号都没有，必须先跑 `db:bootstrap-admin`；
 *     · 建项目 / 看到媒体：一个空库没有任何项目行、也没有 `oss/` 下的文件。
 *   所以本脚本只做**那三件机械缺口**，不做任何业务伪造：邀请码是真插入 `o_invite` 一行
 *   （走的是 `registerWithInvite` 的同一张表、同一套列），项目行是真的 `o_project` 一行，
 *   媒体文件真的落在 `<MIWO_DATA_DIR>/oss/manual-test/demo.png`。
 *
 * ── 两条硬约束 ──
 *   ① **目标护栏**：与 `db:migrate` / `db:bootstrap-admin` 同一套判定
 *      （`scripts/db-target-guard.cjs`，Ruling 131/139），在 `createKnex()` **之前**判定。
 *      ⚠ 本脚本**不 import `@/utils/db`**：那个模块有模块级副作用（建空库文件 + 跑迁移）。
 *      这里只走 `@/db/connect` 的 `createKnex()` + 显式 `runWithTenant`（写租户表 `o_project`
 *      必须带 ctx，守卫是 fail-closed 的 —— 这正好也证明了"租户守卫真的在拦"）。
 *   ② **幂等**：邀请码按 `code` 冲突即跳过、项目按固定 id 冲突即跳过 ⇒ 重复跑不炸、结果一致。
 *
 * ── ⚠ 这是**刻意绕过 HTTP** 的一步（如实登记）──
 *   邀请码管理接口（`/api/invite/*`）不在 Phase 1c 范围内，项目行也可以由管理员在浏览器里点出来
 *   （这里种一行只是为了让"看到媒体"这一步有东西可看）。所以本脚本**不是**应用的测试通道，
 *   只是手动测试环境的**夹具准备**。它由 `scripts/manual-test.ps1` 调用，参数全部由脚本给出。
 */
import path from "node:path";
import fs from "node:fs";
import { createKnex, describeTarget } from "@/db/connect";
import { makeTenantAware } from "@/db/tenant-guard";
import { currentTenant, runWithTenant } from "@/db/tenant-context";
import { signMediaQuery } from "@/utils/mediaSign";
import { config } from "@/config";
import guard from "./db-target-guard.cjs";

const WHAT = "manual-test:seed";
const KNOWN_FLAGS = ["--help", "-h", "--allow-repo-dev-db"];
const KNOWN_PREFIXES = ["--admin=", "--invite=", "--no-demo-project"];
const DEMO_PROJECT_ID = 900001;
const DEMO_MEDIA_REL = "manual-test/demo.png";

/** 未知旗标一律 exit 1（同 `backfill-userid` / `bootstrap-admin` 的纪律）。 */
function validateArgs(args: string[]): void {
  const unknown = args.filter((a) => a.startsWith("-") && !KNOWN_FLAGS.includes(a) && !KNOWN_PREFIXES.some((p) => a.startsWith(p)));
  if (unknown.length) {
    console.error(`[seed-manual-test] 拒绝执行 —— 未知旗标：${unknown.join(", ")}`);
    console.error("用法：node --import=tsx scripts/seed-manual-test.ts [--admin=<名字>] [--invite=<码>] [--no-demo-project]");
    process.exit(1);
  }
}

/** 16x16 的确定性 PNG（深色底 + 一条亮斜线）：不需要任何图像库，字节写死。 */
const DEMO_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAXklEQVR42mNkYPhfz0AEYBxVSF+F" +
  "/6EKGUcV0lch46hC+ipkHFVIX4WMowrpq5BxVCF9FTKOKqSvQsZRhfRVyDiqkL4KGUcV0lch" +
  "46hC+ipkHFVIX4WMowrpqxAA0t0Y/8k0m+EAAAAASUVORK5CYII=";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  validateArgs(args);
  const valueOf = (p: string): string | undefined => args.find((a) => a.startsWith(p))?.slice(p.length);
  const admin = (valueOf("--admin=") ?? "admin").trim();
  const invite = (valueOf("--invite=") ?? "").trim();
  const demoProject = !args.includes("--no-demo-project");

  guard.requireRepoDevDbAllowed({ argv: args, what: WHAT });
  if (args.includes("--allow-repo-dev-db")) console.log("[seed-manual-test] 已显式放行：--allow-repo-dev-db");

  // ---- 媒体夹具（纯文件系统，先做：不需要库，失败了也不该留下半个种子）----
  const ossRoot = path.join(config.dataDir, "oss");
  const absMedia = path.join(ossRoot, "manual-test", "demo.png");
  fs.mkdirSync(path.dirname(absMedia), { recursive: true });
  fs.writeFileSync(absMedia, Buffer.from(DEMO_PNG_BASE64, "base64"));
  const bytes = fs.statSync(absMedia).size;
  console.log(`[seed-manual-test] 媒体夹具：${absMedia}（${bytes} 字节）`);

  const db = createKnex();
  try {
    console.log(`[seed-manual-test] 目标库：${describeTarget()}`);

    // ---- ① 管理员：由 `db:bootstrap-admin` 负责；这里只**核对**它在不在（不在就响亮失败）----
    const adminRow = (await db("o_user").where("username", admin).first()) as
      | { id: number | string; role: string | null; status: string | null; mustChangePassword: number | null }
      | undefined;
    if (!adminRow || adminRow.status !== "active" || adminRow.role !== "admin") {
      console.error(
        `[seed-manual-test] 前置不满足：o_user 里没有可用的管理员 "${admin}"` +
          `（实际 ${adminRow ? JSON.stringify({ role: adminRow.role, status: adminRow.status }) : "不存在"}）。` +
          `先跑 pnpm.cmd run db:bootstrap-admin -- --username=${admin} --apply`,
      );
      process.exit(1);
    }
    console.log(`[seed-manual-test] 管理员已就位：${admin}（id=${adminRow.id}, role=admin, mustChangePassword=${adminRow.mustChangePassword}）`);

    // ---- ② 邀请码（`o_invite` 一行；默认注册方式是 invite ⇒ 没有它注册不了）----
    if (invite) {
      const existingInvite = await db("o_invite").where("code", invite).first();
      if (existingInvite) {
        console.log(`[seed-manual-test] 邀请码已存在（幂等跳过）：${invite}`);
      } else {
        await db("o_invite").insert({
          code: invite,
          createdBy: Number(adminRow.id),
          maxUses: 5,
          usedCount: 0,
          expiresAt: Date.now() + 7 * 24 * 3600 * 1000,
          disabled: 0,
          createdAt: Date.now(),
        });
        console.log(`[seed-manual-test] 邀请码已建：${invite}（maxUses=5，7 天有效）`);
      }
    } else {
      console.log("[seed-manual-test] 未给 --invite：跳过邀请码（注册那一步需要它）");
    }

    // ---- ③ 示例项目（租户表 o_project ⇒ 必须带 ctx 写，走的是与应用同一条守卫）----
    if (demoProject) {
      const uid = Number(adminRow.id);
      const existing = await db("o_project").where("id", DEMO_PROJECT_ID).first();
      if (existing) {
        console.log(`[seed-manual-test] 示例项目已存在（幂等跳过）：id=${DEMO_PROJECT_ID}`);
      } else {
        await runWithTenant({ userId: uid, role: "admin", requestId: "manual-test-seed", source: "system" }, async () => {
          // ⚠ 用**应用同一条守卫链**（`makeTenantAware`，`u.db` 用的就是它；这里只是不 import
          //   `@/utils` —— 那个模块有模块级副作用：建空库文件 + 自己再跑一次迁移）写入，
          //   于是"租户守卫真的在注入 userId"这件事在夹具准备阶段也被走到一次：
          //   写漏 userId 时守卫会**当场抛错**，而不是留下一行谁都看不见的孤儿。
          const guarded = makeTenantAware(db, { getCtx: currentTenant });
          await (guarded as any)("o_project").insert({
            id: DEMO_PROJECT_ID,
            projectType: "manual-test",
            name: "手动测试示例项目",
            intro: "verify:manual-test 种下的夹具项目，用来验证「建项目 → 看到媒体」这两步",
            type: "manual-test",
            artStyle: "",
            videoRatio: "16:9",
            imageModel: "",
            videoModel: "",
            imageQuality: "",
            mode: "",
            createTime: Date.now(),
            targetCountry: null,
          });
        });
        console.log(`[seed-manual-test] 示例项目已建：id=${DEMO_PROJECT_ID}（归 userId=${uid}）`);
      }
      const check = (await db("o_project").where("id", DEMO_PROJECT_ID).first()) as { userId: number | null } | undefined;
      if (!check || Number(check.userId) !== uid) {
        console.error(`[seed-manual-test] 自证失败：示例项目 id=${DEMO_PROJECT_ID} 的 userId 不是 ${uid}（实际 ${check && check.userId}）`);
        process.exit(1);
      }
    } else {
      console.log("[seed-manual-test] --no-demo-project：跳过示例项目");
    }
  } finally {
    await db.destroy();
  }

  // ---- ④ 媒体签名 URL（打印给操作者，直接点开就能验证"媒体在鉴权之后仍有合法通路"）----
  const signQuery = signMediaQuery(DEMO_MEDIA_REL);
  const mediaUrl = `${config.publicBaseUrl}/oss/${DEMO_MEDIA_REL}?${signQuery}`;
  console.log(`[seed-manual-test] 媒体直链（签名 24h 有效）：${mediaUrl}`);
  console.log(`[seed-manual-test] 对照：同一路径**不带签名**应 403 → ${config.publicBaseUrl}/oss/${DEMO_MEDIA_REL}`);
}

if (process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
  console.log(
    [
      "用法（从 apps/api 下跑）：",
      "  MIWO_DATA_DIR=<一次性目录> node --import=tsx scripts/seed-manual-test.ts [--admin=<名字>] [--invite=<码>] [--no-demo-project]",
      "",
      "它做的三件事：① 核对管理员存在（由 db:bootstrap-admin 建）；② 插一行 o_invite 邀请码；",
      "③ 写 oss/manual-test/demo.png + 建一行示例项目（带租户 ctx）。幂等。",
    ].join("\n"),
  );
} else {
  main().catch((err) => {
    console.error("[seed-manual-test] 失败：", err);
    process.exit(1);
  });
}
