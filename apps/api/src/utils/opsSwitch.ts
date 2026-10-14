/**
 * 运维开关 + 注册方式（Phase 1c Task 4；spec §7.3 的「默认关闭」落点）。
 *
 * ── 为什么用 `o_setting` 的平台键而不是环境变量 ──
 * 环境变量要同时改 `deploy/.env.example` + `apps/api/.env.example` + `tools/check-deploy-config.cjs`
 * 的白名单**三处**（Global Constraints 的"不新增 `MIWO_*`"），而这两个开关**天然是运行时可变**
 * 的运维决定。风险与代价（照 brief 原话，不粉饰）：
 *   · 风险：能改它的人必须先是管理员（`o_setting` 策略 = platform，写操作只有 admin 放行）；
 *   · 代价：**灾备场景下"库都坏了"时没法规避** —— 所以 `allowDbAdminOps` 只控制
 *     "清表/清库/导入/导出"这几个接口，**不允许它控制任何启动路径行为**（启动期读不到就是关闭）。
 *
 * ── 为什么读值要按"最严"解析 ──
 * 读不到 / 值不是 `"1"` / 抛错 ⇒ 一律 `false`（fail-closed）。开关是**收敛型**的：
 * 任何异常都只能让能力更少，不能更多。
 */
import u from "@/utils";

export type OpsSwitchKey = "allowDbAdminOps";

/** 注册方式（spec §15 O1）：`invite`（默认）/ `open` / `closed`；非法/缺失一律按最严的 `invite`。 */
export type RegistrationMode = "invite" | "open" | "closed";

/**
 * 运维开关是否开启。**默认关闭**：`o_setting` 里没有该行、值为空、值不是 `"1"` —— 全部 `false`。
 *
 * ⚠ 读的是 platform 表的**读**路径（放行，含无 ctx），所以本函数在请求期/启动期都可调用；
 *   写它是 admin 的事（`o_setting` 的写策略见 `src/db/policies.ts`）。
 */
export async function opsEnabled(key: OpsSwitchKey): Promise<boolean> {
  try {
    const row: { value?: string | null } | undefined = await (u.db as any)("o_setting").where("key", key).select("value").first();
    return String(row?.value ?? "0") === "1";
  } catch (err: any) {
    console.error(`[opsSwitch] 读开关 ${key} 失败 ⇒ 按关闭处理（fail-closed）：${err?.message ?? err}`);
    return false;
  }
}

/** 注册方式。**单一实现**：`src/auth/service.ts` 的 `registrationMode()` 直接转调这里。 */
export async function registrationMode(): Promise<RegistrationMode> {
  const row: { value?: string | null } | undefined = await (u.db as any)("o_setting").where("key", "registrationMode").select("value").first();
  const v = String(row?.value ?? "invite");
  if (v === "open" || v === "closed") return v;
  return "invite";
}

/** 运维接口被关闭时的统一文案（接口与用例共用一份，别各写一遍）。 */
export function opsDisabledMessage(): string {
  return "运维接口默认关闭：请由管理员在 设置 → 数据库 里开启 allowDbAdminOps 后再试（离线清库/恢复请走停机窗口的脚本）";
}
