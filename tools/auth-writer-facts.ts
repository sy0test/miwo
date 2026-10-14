/**
 * `tools/check-authenticated-writers.cjs` 的事实探针（Phase 1c Task 4）。
 *
 * 为什么门禁要起一个**真 tsx 进程**来导入 TS 常量：
 *   "platform 写只有两条合法路径"这条判据住在 `src/db/tenant-guard.ts` 的实现里，
 *   它在 `.cjs` 门禁里无法被 require（TypeScript + `@/` 别名）。
 *   1b 的教训（`tools/tenant-policy-facts.ts`）是同一个：**别在门禁里用正则重写一遍真相**。
 *
 * 输出一行 `AUTH_WRITER_FACTS={...}`：`tester` = 真实提交给守卫的 ctx，`allowed` = 守卫的判定。
 * 观测不到 = 门禁 `exit 3`（"观测不到 ≠ 干净"）。
 */
import { runAsAuth, authSystemCtx } from "@/db/noContext";
import { isPlatformWriteCtx } from "@/db/tenant-guard";
import type { TenantCtx } from "@/db/tenant-context";

/**
 * 伪造的"系统身份"ctx：`source === "system"` + `role === "admin"`，但 **userId ≠ 0**
 * （系统身份的 userId 必须是 `AUTH_SYSTEM_USER_ID = 0`）。旧实现只看 `role === "admin"` ⇒ 放行它。
 */
const forgedSystem: TenantCtx = { userId: 1, role: "admin", requestId: "probe-forged-system", source: "system" };

/** 一个"长得像系统身份但从 http 来"的 ctx：`source` 只认字面值 ⇒ 走 admin 那条路（刻意如此）。 */
const httpAdminZero: TenantCtx = { userId: 0, role: "admin", requestId: "probe-http-admin-0", source: "http" };

const cases: Array<[string, TenantCtx | undefined]> = [
  ["system-ctx(runAsAuth)", authSystemCtx()],
  ["http-admin", { userId: 1, role: "admin", requestId: "probe-http-admin", source: "http" }],
  ["socket-admin", { userId: 1, role: "admin", requestId: "probe-socket", source: "socket" }],
  ["forged-system-admin-userId1", forgedSystem],
  ["http-admin-userId0", httpAdminZero],
  ["http-user", { userId: 7, role: "user", requestId: "probe-http-user", source: "http" }],
  ["no-ctx", undefined],
];

const observed: string[] = [];
const allowed: string[] = [];
for (const [label, ctx] of cases) observed.push(label);
for (const [label, ctx] of cases) {
  let ok = false;
  try {
    ok = isPlatformWriteCtx(ctx);
  } catch {
    ok = false;
  }
  allowed.push(`${label} => ${ok}`);
}

/** 自证"真的进过 runAsAuth 的闭包"（照"断言某模块被加载必须在真进程里自证"的纪律）。 */
let ranInside = false;
void (async () => {
  await runAsAuth(async () => {
    ranInside = true;
    await Promise.resolve();
  });
  const payload = {
    observed: observed.length > 0 && ranInside,
    allowed,
    ranInside,
    probed: cases.map(([label, c]) => ({ label, ctx: c ?? null, verdict: isPlatformWriteCtx(c) })),
  };
  console.log("AUTH_WRITER_FACTS=" + JSON.stringify(payload));
})().catch((err) => {
  console.error("探针失败：" + String(err && (err as Error).stack ? (err as Error).stack : err));
  console.log("AUTH_WRITER_FACTS=" + JSON.stringify({ observed: false, allowed, ranInside }));
  process.exitCode = 1;
});
