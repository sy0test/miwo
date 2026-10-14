import { describe, expect, it } from "vitest";
import { ARGON2_OPTIONS, hashPassword, needsRehash, verifyPassword } from "@/auth/password";

describe("口令哈希（spec §7.2 argon2id）", () => {
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
