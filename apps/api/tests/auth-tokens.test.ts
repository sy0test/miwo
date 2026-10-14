import { describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { config } from "@/config";
import { AuthError, ACCESS_TTL_SEC, REFRESH_TTL_SEC, signToken, verifyLegacyToken, verifyToken } from "@/auth/tokens";

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

describe("旧形状 token 的过渡兼容（{id,name}，无 typ/tv）", () => {
  it("旧形状能被认出来（Phase 1b 的 verify-phase1b / ops-endpoints-auth 依赖它）", () => {
    const legacy = jwt.sign({ id: 7, name: "u7" }, config.jwtSecret, { expiresIn: "1h" });
    const got = verifyLegacyToken(legacy);
    expect(got?.userId).toBe(7);
    // 判别力：**新形状绝不能被 legacy 分支接走**，否则类型混淆会被绕过
    const modern = signToken({ uid: 7, role: "user", tv: 0, typ: "access" });
    expect(verifyLegacyToken(modern)).toBeNull();
    const refresh = signToken({ uid: 7, role: "user", tv: 0, typ: "refresh" });
    expect(verifyLegacyToken(refresh)).toBeNull();
  });

  it("无 id / id 非正 / 坏签名 / 别的密钥 → null（不抛）", () => {
    expect(verifyLegacyToken(jwt.sign({ name: "x" }, config.jwtSecret))).toBeNull();
    expect(verifyLegacyToken(jwt.sign({ id: 0, name: "x" }, config.jwtSecret))).toBeNull();
    expect(verifyLegacyToken(jwt.sign({ id: -1, name: "x" }, config.jwtSecret))).toBeNull();
    expect(verifyLegacyToken("garbage")).toBeNull();
    expect(verifyLegacyToken(jwt.sign({ id: 7 }, "another-secret-at-least-32-bytes-long!!"))).toBeNull();
  });
});
