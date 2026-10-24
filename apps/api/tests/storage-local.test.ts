/**
 * `storage` 装配与 `local` 实现的用例（Phase 1e Task 01 Step 3/6）。
 *
 * ── 与计划正文的两处不同（R1：审计优先）──
 *  1. **没有 `storage/media-signer.ts`**：1c 已交付 `src/utils/mediaSign.ts`（HMAC-SHA256 域分离、
 *     24h TTL、base64url 43 字符、路径域签名）。计划里的 2h/64-hex/root-参与签名的一套**作废**
 *     （把 root 纳入签名会让所有已发链接失效并弄红 `verify:phase1c-media`）。
 *  2. **sig 形状断言按 1c 口径**：`[A-Za-z0-9_-]{43}`（不是计划里的 64 位 hex）。
 *     并新增一条**双签名守卫**：`exp=`/`sig=` 在 URL 里各只许出现一次 ——
 *     因为 `oss.getFileUrl()` 自己已经签过，`signRef` 再拼一次就是 `?exp&sig&exp&sig`（本组实测的坑）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "@/config";
import { createStorage } from "@/storage";
import { LocalMediaStorage } from "@/storage/local";

const SECRET = "storage-local-test-secret-at-least-32-bytes";
const SIG_SHAPE = /[?&]sig=[A-Za-z0-9_-]{43}(&|$)/;

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("LocalMediaStorage rootDir", () => {
  it("writes and reads files under its injected root", async () => {
    const root = path.join(process.cwd(), ".test-tmp", `storage-local-${process.pid}-${Date.now()}`);
    const storage = new LocalMediaStorage(root);
    try {
      await storage.writeFile("nested/file.bin", Buffer.from("injected-root"));

      expect(await storage.getAbsPath("nested/file.bin")).toBe(path.join(root, "nested", "file.bin"));
      expect(await storage.getFile("nested/file.bin")).toEqual(Buffer.from("injected-root"));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe("storage 工厂", () => {
  it("local → LocalMediaStorage 且 rootDir 非空", () => {
    const s = createStorage({ storageDriver: "local", jwtSecret: SECRET });
    expect(typeof s.rootDir).toBe("string");
    expect(s.rootDir.length).toBeGreaterThan(0);
  });

  it("s3 → S3 adapter when its required config is provided", () => {
    const s = createStorage({
      storageDriver: "s3",
      jwtSecret: SECRET,
      s3Storage: {
        bucket: "miwo-media", region: "us-east-1", endpoint: "https://s3.example.test",
        accessKeyId: "access", secretAccessKey: "secret", cacheDir: path.join(process.cwd(), ".test-tmp", "s3-factory"),
      },
    });
    expect(s.rootDir).toContain("s3-factory");
  });

  it("s3 without config fails loudly", () => {
    expect(() => createStorage({ storageDriver: "s3", jwtSecret: SECRET })).toThrowError(ConfigError);
  });

  it("★★ 密钥太短 → 构造即拒绝（不得静默用弱密钥）", () => {
    expect(() => createStorage({ storageDriver: "local", jwtSecret: "short" })).toThrowError(/32/);
  });

  it("★ signRef 产出的 URL 带 exp 与 sig，且路径与资源根没被改动", async () => {
    const s = createStorage({ storageDriver: "local", jwtSecret: SECRET });
    const url = await s.signRef({ root: "oss", path: "/a/b.jpg" });
    expect(url).toContain("/oss/");
    expect(url).toContain("/a/b.jpg");
    expect(url).toMatch(/[?&]exp=\d{1,15}(&|$)/);
    expect(url).toMatch(SIG_SHAPE);
  });

  it("★★ 双签名守卫：`exp=` 与 `sig=` 各只出现一次（1c 已在 getFileUrl 里签过）", async () => {
    const s = createStorage({ storageDriver: "local", jwtSecret: SECRET });
    const url = await s.signRef({ root: "oss", path: "/a/b.jpg" });
    expect(countOccurrences(url, "exp="), `URL 里 exp= 出现多次（双签名）：${url}`).toBe(1);
    expect(countOccurrences(url, "sig="), `URL 里 sig= 出现多次（双签名）：${url}`).toBe(1);
  });

  it("★ 真实签发 + 真实校验闭环（同一路径 true、另一路径 false）", async () => {
    const s = createStorage({ storageDriver: "local", jwtSecret: SECRET });
    const url = await s.signRef({ root: "oss", path: "/a/b.jpg" });
    const qs = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    const exp = qs.get("exp")!;
    const sig = qs.get("sig")!;
    expect(await s.verifyRef({ root: "oss", path: "/a/b.jpg" }, { exp, sig })).toBe(true);
    expect(await s.verifyRef({ root: "oss", path: "/a/other.jpg" }, { exp, sig })).toBe(false);
    // 篡改签名 / 过期 / 空值都必须 false（不是抛错、不是 true）
    expect(await s.verifyRef({ root: "oss", path: "/a/b.jpg" }, { exp, sig: sig.slice(0, -1) + "x" })).toBe(false);
    expect(await s.verifyRef({ root: "oss", path: "/a/b.jpg" }, { exp: "1", sig })).toBe(false);
    expect(await s.verifyRef({ root: "oss", path: "/a/b.jpg" }, {})).toBe(false);
  });

  it("★ 接口方法齐全（Phase 2 的 S3Storage 要有同样的接缝）", () => {
    const s = createStorage({ storageDriver: "local", jwtSecret: SECRET });
    for (const m of [
      "getFileUrl",
      "getAbsPath",
      "getFile",
      "writeFile",
      "writeStream",
      "deleteFile",
      "deleteDirectory",
      "fileExists",
      "getImageBase64",
      "getSmallImageUrl",
      "signRef",
      "verifyRef",
    ] as const) {
      expect(typeof (s as unknown as Record<string, unknown>)[m], `缺方法 ${m}`).toBe("function");
    }
  });
});
