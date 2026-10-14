import { describe, expect, it } from "vitest";
import { ARGON2_OPTIONS, hashPassword, needsRehash, verifyPassword } from "@/auth/password";

describe("口令哈希（spec §7.2 argon2id）", () => {
  /**
   * ★ Phase 1c Task 4 / L1 修复：**显式下限**断言。
   *
   * 旧用例（下面那条）拿 `ARGON2_OPTIONS` 常量**自己**当期望值，并用它去 `toContain` 自己算出来的
   * 哈希串 —— 那是**同义反复**：把 `memoryCost` 改成 1024，断言照样绿（哈希串与常量一起变）。
   * 这里改用**外部真值**（OWASP Password Storage Cheat Sheet 的 Argon2id 第二档）：
   *   https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
   *   「Use Argon2id with a minimum configuration of 19 MiB of memory, an iteration count of 2,
   *     and 1 degree of parallelism.」 ⇒ m ≥ 19456 KiB、t ≥ 2、p ≥ 1，且算法必须是 argon2id。
   * 判别力（红端）：把 `src/auth/password.ts` 的 `memoryCost` 调到 **1024** ⇒ 本用例**必红**
   *   （而下面那条同义反复的用例仍然绿 —— 这正是它当年没抓住问题的原因）。
   */
  it("★ 参数必须满足 OWASP 的显式下限（memoryCost ≥ 19456 / timeCost ≥ 2 / parallelism ≥ 1，且算法 = argon2id）", async () => {
    // 外部真值，不引用 ARGON2_OPTIONS 自己
    const OWASP_MIN_MEMORY_KIB = 19456; // 19 MiB
    const OWASP_MIN_TIME = 2;
    const OWASP_MIN_PARALLELISM = 1;
    expect(ARGON2_OPTIONS.memoryCost, "memoryCost 低于 OWASP 下限（19 MiB）").toBeGreaterThanOrEqual(OWASP_MIN_MEMORY_KIB);
    expect(ARGON2_OPTIONS.timeCost, "timeCost 低于 OWASP 下限（2）").toBeGreaterThanOrEqual(OWASP_MIN_TIME);
    expect(ARGON2_OPTIONS.parallelism, "parallelism 低于 OWASP 下限（1）").toBeGreaterThanOrEqual(OWASP_MIN_PARALLELISM);
    expect(ARGON2_OPTIONS.algorithm, "算法必须显式写死 argon2id（枚举值 2）").toBe(2);
    // 生成的哈希串里的参数也必须满足同样的下限（防"常量与实现脱钩"）
    const h = await hashPassword("pw-123456");
    const m = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(h);
    expect(m, `哈希串形状不对：${h.slice(0, 40)}`).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(OWASP_MIN_MEMORY_KIB);
    expect(Number(m![2])).toBeGreaterThanOrEqual(OWASP_MIN_TIME);
    expect(Number(m![3])).toBeGreaterThanOrEqual(OWASP_MIN_PARALLELISM);
  });

  it("产出 argon2id 且参数是写死的那一档", async () => {
    const h = await hashPassword("pw-123456");
    expect(h.startsWith("$argon2id$v=19$")).toBe(true);
    expect(h).toContain(`m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}`);
  });

  it("同一口令两次哈希不同（加盐），但都能验证通过", async () => {
    const a = await hashPassword("pw-123456");
    const b = await hashPassword("pw-123456");
    expect(a).not.toBe(b);
    await expect(verifyPassword(a, "pw-123456")).resolves.toBe(true);
    await expect(verifyPassword(b, "pw-123456")).resolves.toBe(true);
  });

  it("错口令 false；空哈希/非法哈希/空口令一律 false（不抛错）", async () => {
    const h = await hashPassword("pw-123456");
    await expect(verifyPassword(h, "WRONG")).resolves.toBe(false);
    await expect(verifyPassword("", "pw-123456")).resolves.toBe(false);
    await expect(verifyPassword("not-a-hash", "pw-123456")).resolves.toBe(false);
    await expect(verifyPassword(h, "")).resolves.toBe(false);
    // 005 迁过来的旧行是 passwordHash=''（明文口令未迁）⇒ 永远登不进去，而不是抛异常
    await expect(verifyPassword("", "")).resolves.toBe(false);
  });

  it("needsRehash：参数不符要 true，相符要 false（判别力：改 memoryCost 必红）", async () => {
    const h = await hashPassword("pw-123456");
    expect(needsRehash(h)).toBe(false);
    expect(needsRehash("$argon2id$v=19$m=65536,t=3,p=1$abc$def")).toBe(true);
    expect(needsRehash("")).toBe(false);
    // argon2i / argon2d 的旧哈希也必须判"要重算"
    expect(needsRehash("$argon2i$v=19$m=19456,t=2,p=1$abc$def")).toBe(true);
  });

  it("hashPassword 拒绝空口令（不让空串进库）", async () => {
    await expect(hashPassword("")).rejects.toThrow();
  });
});
