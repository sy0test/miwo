import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { config } from "@/config";
import { AuthError, ACCESS_TTL_SEC, REFRESH_TTL_SEC, signToken, verifyToken } from "@/auth/tokens";

describe("双令牌（spec §7.2）", () => {
  it("access 15 分钟 / refresh 7 天（exp - iat 精确断言）", () => {
    const a: any = jwt.decode(signToken({ uid: 1, role: "user", tv: 0, typ: "access" }));
    expect(a.exp - a.iat).toBe(ACCESS_TTL_SEC);
    const r: any = jwt.decode(signToken({ uid: 1, role: "user", tv: 0, typ: "refresh" }));
    expect(r.exp - r.iat).toBe(REFRESH_TTL_SEC);
  });

  it("每个 token 带唯一 jti（为 Phase 2 的重用检测留位置）", () => {
    const a: any = jwt.decode(signToken({ uid: 1, role: "user", tv: 0, typ: "access" }));
    const b: any = jwt.decode(signToken({ uid: 1, role: "user", tv: 0, typ: "access" }));
    expect(typeof a.jti).toBe("string");
    expect(a.jti).not.toBe(b.jti);
  });

  it("类型混淆必拒：access 当 refresh 用 → AuthError(type)", () => {
    const t = signToken({ uid: 1, role: "user", tv: 0, typ: "access" });
    expect(() => verifyToken(t, "refresh")).toThrow(AuthError);
    try {
      verifyToken(t, "refresh");
    } catch (e: any) {
      expect(e.code).toBe("type");
    }
  });

  it("篡改签名必拒（改一个字节）", () => {
    const t = signToken({ uid: 1, role: "user", tv: 0, typ: "access" });
    const [h, p, s] = t.split(".");
    const tampered = `${h}.${p}.${s.slice(0, -1)}${s.endsWith("A") ? "B" : "A"}`;
    expect(() => verifyToken(tampered, "access")).toThrow(AuthError);
  });

  it("过期必拒（用 -1s 手工签一个）", () => {
    const expired = jwt.sign({ uid: 1, role: "user", tv: 0, typ: "access", jti: "x" }, config.jwtSecret, {
      expiresIn: -1,
      algorithm: "HS256",
    });
    try {
      verifyToken(expired, "access");
      throw new Error("不该通过");
    } catch (e: any) {
      expect(e.code).toBe("expired");
    }
  });

  it("其他算法签的 token 必拒（alg 白名单）", () => {
    const t512 = jwt.sign({ uid: 1, role: "user", tv: 0, typ: "access", jti: "x" }, config.jwtSecret, { algorithm: "HS512" });
    expect(() => verifyToken(t512, "access")).toThrow(AuthError);
  });

  it("载荷不完整必拒（缺 tv / 缺 uid / role 非法）", () => {
    for (const payload of [
      { uid: 1, role: "user", typ: "access", jti: "x" },
      { role: "user", tv: 0, typ: "access", jti: "x" },
      { uid: 1, role: "root", tv: 0, typ: "access", jti: "x" },
    ]) {
      const t = jwt.sign(payload, config.jwtSecret, { expiresIn: 60, algorithm: "HS256" });
      expect(() => verifyToken(t, "access")).toThrow(AuthError);
    }
  });

  it("传入别的密钥时验不过（密钥不是装饰品）", () => {
    const other = "another-secret-at-least-32-bytes-long!!";
    const t = signToken({ uid: 1, role: "user", tv: 0, typ: "access" }, other);
    expect(() => verifyToken(t, "access")).toThrow(AuthError);
    expect(verifyToken(t, "access", other).uid).toBe(1);
  });
});

/**
 * Phase 1c Task 11：**旧形状 token 的兼容已整体退役**。
 *
 * 原来这里有两条 `verifyLegacyToken` 的用例（"旧形状能被认出来" / "无 id、坏签名 → null"）。
 * 现在那个函数**已经删除**，所以这里改钉"**旧形状在新链路上不成立**"：
 *   · `verifyToken` 对旧形状载荷（没有 `typ`/`uid`/`tv`）一律抛 `AuthError`；
 *   · 真 HTTP / socket 层面的"旧令牌必须 401 / 拒连"由
 *     `tests/auth-legacy-retired.test.ts`（真应用 + 真 HTTP）与 `tests/socket-tenant.test.ts` 覆盖。
 * 判据的意义：**删掉原语之后，"再加回一条兼容分支"必须从零写起**，而这里钉住的是"新链路不认它"。
 */
describe("★ 旧形状 token（{id,name}，无 typ/tv）在新链路上必须不成立（Phase 1c Task 11）", () => {
  it("旧形状载荷 → `verifyToken` 抛 AuthError（不是被认出来、也不是静默放行）", () => {
    const legacy = jwt.sign({ id: 7, name: "u7" }, config.jwtSecret, { expiresIn: "1h" });
    expect(() => verifyToken(legacy, "access")).toThrow(AuthError);
  });

  it("缺 uid / 无 id / id 非正 的旧形状一律拒", () => {
    for (const payload of [{ name: "x" }, { id: 0, name: "x" }, { id: -1, name: "x" }, { id: 7 }]) {
      const t = jwt.sign(payload, config.jwtSecret, { expiresIn: "1h" });
      expect(() => verifyToken(t, "access"), JSON.stringify(payload)).toThrow(AuthError);
    }
  });

  it("判别力对照：同一密钥签的**新形状**必须照常通过（否则上面两条只是「整个验签坏了」）", () => {
    const modern = signToken({ uid: 7, role: "user", tv: 0, typ: "access" });
    expect(verifyToken(modern, "access").uid).toBe(7);
  });
});
