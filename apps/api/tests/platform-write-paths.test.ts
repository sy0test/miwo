/**
 * 「**platform 表写只有两条合法路径**」的确定性用例（Phase 1c Task 4；控制器裁定 §2.1）。
 *
 * ── 要钉的那件事 ──
 * 守卫对 `platform` 表的写放行条件是 `isPlatformWriteCtx(ctx)`：
 *   ① `ctx.role === "admin"`（真管理员请求；HTTP/socket 的 role 一律来自 DB）；
 *   ② `source === "system"` **且** `role === "admin"` **且** `userId === 0`（= `runAsAuth()` 的系统身份）。
 * 旧实现只看 `ctx.role === "admin"` —— 于是"**用 http 来源造一个系统形状的 admin ctx**"
 * （`{role:"admin", source:"system", userId:1}`）会**被放行**：那不是管理员，却拿到了平台写权限。
 *
 * ── 判断力（红绿两端）──
 *   · 红端：把 `isPlatformWriteCtx` 的 `source === "system"` 分支删掉（退回旧实现）⇒ 下面
 *     `伪造的系统身份必须被拒` 那条**必红**（实测见 task-4-report.md）。
 *   · 绿端：两条合法路径（真 admin ctx / runAsAuth 的系统身份）都必须**真的写进去**（直读确认）。
 *
 * ⚠ 用真 sqlite（`vitest.config.ts` 的 MIWO_DATA_DIR，仓库外的一次性数据目录）+ 真守卫
 *   （`makeTenantAware`），不是 mock：被放行/被拒的判据必须落在**真 SQL**上。
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { dbReady, systemDb } from "@/utils/db";
import { makeTenantAware, isPlatformWriteCtx, PlatformWriteDeniedError } from "@/db/tenant-guard";
import { runWithTenant, type TenantCtx } from "@/db/tenant-context";
import { authSystemCtx, runAsAuth, AUTH_SYSTEM_USER_ID } from "@/db/noContext";

const TAG = `pw${crypto.randomBytes(4).toString("hex")}`;
const TABLE = "o_setting";
const KEY = `${TAG}_probe`;

/** 造一个"看着像系统身份"的 ctx（`source:"system"` + admin，但 userId ≠ 0）。 */
function forgedSystemCtx(userId: number): TenantCtx {
  return { userId, role: "admin", requestId: "forged-system", source: "system" };
}

/** 在给定 ctx 里写一行 platform 表；返回 `"ok"` 或错误 name（**不吞掉**，让断言看得出区分）。 */
async function tryPlatformWrite(ctx: TenantCtx | undefined, value: string): Promise<string> {
  const guarded = makeTenantAware(systemDb, { getCtx: () => ctx });
  const doWrite = async (): Promise<string> => {
    try {
      await (guarded as any)(TABLE).insert({ key: KEY, value });
      return "ok";
    } catch (err: any) {
      return String(err?.name ?? err);
    }
  };
  return ctx ? runWithTenant(ctx, doWrite) : doWrite();
}

describe("platform 写路径（两条合法路径 + 伪造系统身份必须被拒）", () => {
  it("① 纯判定式：7 条 ctx 形状的判定结果（判别力表）", () => {
    const cases: Array<[string, TenantCtx | undefined, boolean]> = [
      ["runAsAuth 的系统身份", authSystemCtx(), true],
      ["HttpCtx：真 admin", { userId: 1, role: "admin", requestId: "h", source: "http" }, true],
      ["SocketCtx：真 admin", { userId: 1, role: "admin", requestId: "s", source: "socket" }, true],
      ["HttpCtx：普通用户", { userId: 7, role: "user", requestId: "h", source: "http" }, false],
      ["伪造：source=system 但 userId≠0", forgedSystemCtx(1), false],
      ["伪造：source=system + role=user", { userId: 0, role: "user", requestId: "f", source: "system" }, false],
      ["无 ctx", undefined, false],
    ];
    const got = cases.map(([label, ctx]) => `${label} => ${isPlatformWriteCtx(ctx)}`);
    const want = cases.map(([label, , expected]) => `${label} => ${expected}`);
    expect(got, "判定表漂移 ⇒ 「platform 写只有两条合法路径」这条不变式被破坏").toEqual(want);
  });

  it("② 真 SQL：runAsAuth 的系统身份能写 platform 表（正向）", async () => {
    await dbReady;
    const verdict = await runAsAuth(async () => tryPlatformWrite(authSystemCtx(), "via-runAsAuth"));
    expect(verdict, "系统身份（runAsAuth）必须能写 platform 表").toBe("ok");
    const row: any = await systemDb(TABLE).where("key", KEY).first();
    expect(String(row?.value), "直读确认真的落库了").toBe("via-runAsAuth");
    await systemDb(TABLE).where("key", KEY).del();
  }, 60000);

  it("③ 真 SQL：真 admin ctx 能写；普通用户 ctx 被拒（PlatformWriteDeniedError）", async () => {
    await dbReady;
    const adminCtx: TenantCtx = { userId: 1, role: "admin", requestId: "t-admin", source: "http" };
    expect(await tryPlatformWrite(adminCtx, "via-admin"), "真 admin ctx 必须能写").toBe("ok");
    await systemDb(TABLE).where("key", KEY).del();

    const userCtx: TenantCtx = { userId: 7, role: "user", requestId: "t-user", source: "http" };
    expect(await tryPlatformWrite(userCtx, "via-user"), "普通用户 ctx 必须被拒").toBe(new PlatformWriteDeniedError("").name);
    expect(await systemDb(TABLE).where("key", KEY).first(), "被拒的写必须零副作用").toBeUndefined();
  }, 60000);

  it("④ ★ 真 SQL：**伪造的系统身份**（source=system + role=admin + userId≠0）必须被拒（红端形状）", async () => {
    await dbReady;
    const forged = forgedSystemCtx(1);
    expect(isPlatformWriteCtx(forged), "判定式必须拒绝伪造的系统身份").toBe(false);
    const verdict = await tryPlatformWrite(forged, "via-forged");
    expect(
      verdict,
      "伪造的系统身份**必须**被 PlatformWriteDeniedError 拦住 —— 旧实现（只看 role==='admin'）会放行它并真的写进库",
    ).toBe(new PlatformWriteDeniedError("").name);
    expect(await systemDb(TABLE).where("key", KEY).first(), "被拒的写必须零副作用").toBeUndefined();
  }, 60000);

  it("⑤ 自证：系统身份的 userId 常量仍是 0（fail-closed 的根基）", () => {
    expect(AUTH_SYSTEM_USER_ID, "系统身份的 userId 必须是 0（不属于任何用户）").toBe(0);
    expect(Number(authSystemCtx().userId)).toBe(0);
  });
});
