import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// ⚠ 用 `@/config`（而不是 `../src/config`）：这样至少有一个已提交的测试**真的走过 `resolve.alias`**，
//    否则别名被误删后测试仍会全绿（Task 7 审查发现的覆盖漏洞 M4）。
import { ConfigError, loadConfig } from "@/config";

const apiScripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;

describe("API development command", () => {
  it("loads the API .env file before starting the app", () => {
    expect(apiScripts.dev).toContain("--env-file-if-exists=.env");
  });
});

const base = {
  MIWO_ENV: "dev",
  MIWO_PORT: "10599",
  MIWO_HOST: "127.0.0.1",
  MIWO_DATA_DIR: "D:\\tmp\\miwo-data",
  MIWO_JWT_SECRET: "x".repeat(48),
} as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("缺 MIWO_ENV 时抛 ConfigError", () => {
    const env = { ...base };
    delete env.MIWO_ENV;
    expect(() => loadConfig(env)).toThrow(ConfigError);
  });

  it("MIWO_ENV 只接受 dev/prod", () => {
    expect(() => loadConfig({ ...base, MIWO_ENV: "staging" })).toThrow(/MIWO_ENV/);
  });

  it("prod 且 host 不是 127.0.0.1 时抛错", () => {
    expect(() => loadConfig({ ...base, MIWO_ENV: "prod", MIWO_HOST: "0.0.0.0" })).toThrow(/127\.0\.0\.1/);
  });

  it("JWT 密钥短于 32 字节时抛错", () => {
    expect(() => loadConfig({ ...base, MIWO_JWT_SECRET: "短" })).toThrow(/MIWO_JWT_SECRET/);
  });

  it("端口非法时抛错", () => {
    expect(() => loadConfig({ ...base, MIWO_PORT: "70000" })).toThrow(/MIWO_PORT/);
  });

  it("dev 下把 NODE_ENV 设为 development，prod 下为 production", () => {
    const dev = { ...base };
    loadConfig(dev);
    expect(dev.NODE_ENV).toBe("development");
    // 显式标注 NodeJS.ProcessEnv：对象字面量展开会丢索引签名，导致 prod.NODE_ENV 在 tsc 下报 TS2339。
    const prod: NodeJS.ProcessEnv = {
      ...base, MIWO_ENV: "prod", MIWO_HOST: "127.0.0.1", MIWO_PUBLIC_BASE_URL: "https://example.test",
    };
    loadConfig(prod);
    expect(prod.NODE_ENV).toBe("production");
  });

  it("Phase 0 默认 sqlite，文件在 dataDir 下", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.db.driver).toBe("sqlite");
    if (cfg.db.driver === "sqlite") expect(cfg.db.file.replace(/\\/g, "/")).toBe("D:/tmp/miwo-data/db2.sqlite");
  });

  it("mediaDir 默认是 dataDir/oss", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.mediaDir.replace(/\\/g, "/")).toBe("D:/tmp/miwo-data/oss");
  });

  it("MIWO_DB_DRIVER=mysql 时要求连接参数齐全", () => {
    expect(() => loadConfig({ ...base, MIWO_DB_DRIVER: "mysql" })).toThrow(/MIWO_DB_HOST/);
    const cfg = loadConfig({
      ...base, MIWO_DB_DRIVER: "mysql", MIWO_DB_HOST: "127.0.0.1", MIWO_DB_PORT: "3306",
      MIWO_DB_USER: "miwo", MIWO_DB_PASSWORD: "p", MIWO_DB_NAME: "miwo",
    });
    expect(cfg.db.driver).toBe("mysql");
  });

  // ---- 以下为 Task 7 审查补出的覆盖缺口（I1/I2/M1/M3）：每个可执行分支都要有用例 ----

  it("mysql 的 4 个 required 分支逐个生效（参数化）", () => {
    const mysqlBase = {
      ...base, MIWO_DB_DRIVER: "mysql", MIWO_DB_HOST: "127.0.0.1", MIWO_DB_PORT: "3306",
      MIWO_DB_USER: "miwo", MIWO_DB_NAME: "miwo",
    } as NodeJS.ProcessEnv;
    for (const key of ["MIWO_DB_HOST", "MIWO_DB_PORT", "MIWO_DB_USER", "MIWO_DB_NAME"]) {
      const env = { ...mysqlBase };
      delete env[key];
      expect(() => loadConfig(env), `缺 ${key} 应抛错`).toThrow(new RegExp(key));
    }
  });

  it("mysql 的 password 允许为空（显式为可选）", () => {
    const cfg = loadConfig({
      ...base, MIWO_DB_DRIVER: "mysql", MIWO_DB_HOST: "127.0.0.1", MIWO_DB_PORT: "3306",
      MIWO_DB_USER: "miwo", MIWO_DB_NAME: "miwo",
    });
    expect(cfg.db.driver).toBe("mysql");
    if (cfg.db.driver === "mysql") expect(cfg.db.password).toBe("");
  });

  it("连接池参数非法时抛错、缺省时取默认（不允许 NaN 静默流出）", () => {
    expect(() => loadConfig({ ...base, MIWO_DB_DRIVER: "mysql", MIWO_DB_HOST: "h", MIWO_DB_PORT: "3306", MIWO_DB_USER: "u", MIWO_DB_NAME: "n", MIWO_DB_POOL_MIN: "abc" })).toThrow(/MIWO_DB_POOL_MIN/);
    expect(() => loadConfig({ ...base, MIWO_DB_DRIVER: "mysql", MIWO_DB_HOST: "h", MIWO_DB_PORT: "3306", MIWO_DB_USER: "u", MIWO_DB_NAME: "n", MIWO_DB_POOL_MAX: "0" })).toThrow(/MIWO_DB_POOL_MAX/);
    expect(() => loadConfig({ ...base, MIWO_DB_DRIVER: "mysql", MIWO_DB_HOST: "h", MIWO_DB_PORT: "3306", MIWO_DB_USER: "u", MIWO_DB_NAME: "n", MIWO_DB_POOL_MIN: "10", MIWO_DB_POOL_MAX: "5" })).toThrow(/不能小于/);
    const cfg = loadConfig({ ...base, MIWO_DB_DRIVER: "mysql", MIWO_DB_HOST: "h", MIWO_DB_PORT: "3306", MIWO_DB_USER: "u", MIWO_DB_NAME: "n" });
    // ⚠ 前置断言：不先锁住"确实进了 mysql 分支"，后面的 poolMin/poolMax 在 sqlite 分支下会因
    //    `cfg.db.driver === "mysql"` 为假而**整块静默跳过**，看着通过其实什么都没测。
    expect(cfg.db.driver).toBe("mysql");
    if (cfg.db.driver === "mysql") {
      expect(cfg.db.poolMin).toBe(2);
      expect(cfg.db.poolMax).toBe(20);
    }
  });

  it("非法 MIWO_STORAGE_DRIVER 抛错", () => {
    expect(() => loadConfig({ ...base, MIWO_STORAGE_DRIVER: "ftp" })).toThrow(/MIWO_STORAGE_DRIVER/);
  });

  it("非法 MIWO_TRUST_PROXY 抛错", () => {
    expect(() => loadConfig({ ...base, MIWO_TRUST_PROXY: "-1" })).toThrow(/MIWO_TRUST_PROXY/);
    expect(() => loadConfig({ ...base, MIWO_TRUST_PROXY: "abc" })).toThrow(/MIWO_TRUST_PROXY/);
  });

  it("空串 MIWO_TRUST_PROXY 视为未设置（prod 下取默认 1，而不是 Number(\"\")→0）", () => {
    // ⚠ 必须用 prod 才**有判别力**：dev 下"空串按未设置 → 默认 0"与"Number("") → 0"结果相同，
    //    旧断言（dev + 空串 → 0）改前改后都通过，等于没锁住 Task 7 审查的 M1 修复。
    expect(
      loadConfig({
        ...base, MIWO_ENV: "prod", MIWO_HOST: "127.0.0.1",
        MIWO_PUBLIC_BASE_URL: "https://example.test", MIWO_TRUST_PROXY: "",
      }).trustProxy,
    ).toBe(1);
    // 配对的另一侧：dev 下空串同样按未设置 → 默认 0（含纯空白，走 optional() 的 trim 判定）
    expect(loadConfig({ ...base, MIWO_TRUST_PROXY: "" }).trustProxy).toBe(0);
    expect(loadConfig({ ...base, MIWO_TRUST_PROXY: "   " }).trustProxy).toBe(0);
  });

  it("非法 MIWO_DB_DRIVER 抛错", () => {
    expect(() => loadConfig({ ...base, MIWO_DB_DRIVER: "oracle" })).toThrow(/MIWO_DB_DRIVER/);
  });

  it("prod 缺 MIWO_PUBLIC_BASE_URL 抛错", () => {
    expect(() => loadConfig({ ...base, MIWO_ENV: "prod", MIWO_HOST: "127.0.0.1" })).toThrow(/MIWO_PUBLIC_BASE_URL/);
  });

  it("MIWO_MEDIA_DIR 覆盖默认媒体目录", () => {
    const cfg = loadConfig({ ...base, MIWO_MEDIA_DIR: "D:\\tmp\\custom-media" });
    expect(cfg.mediaDir.replace(/\\/g, "/")).toBe("D:/tmp/custom-media");
    // 纯空白同样按"未设置"处理（与 MIWO_TRUST_PROXY 的 M1 修复口径一致，锁住 Task 8 Step 0 第 3 项）
    expect(loadConfig({ ...base, MIWO_MEDIA_DIR: "   " }).mediaDir.replace(/\\/g, "/")).toBe("D:/tmp/miwo-data/oss");
  });

  it("S3 driver requires valid bucket, region, endpoint and credentials", () => {
    const s3 = { ...base, MIWO_STORAGE_DRIVER: "s3" };
    expect(() => loadConfig(s3)).toThrow(/MIWO_S3_ENDPOINT/);
    const cfg = loadConfig({
      ...s3,
      MIWO_S3_BUCKET: "miwo-media",
      MIWO_S3_REGION: "us-east-1",
      MIWO_S3_ENDPOINT: "https://s3.example.test",
      MIWO_S3_ACCESS_KEY_ID: "access",
      MIWO_S3_SECRET_ACCESS_KEY: "secret",
      MIWO_S3_SESSION_TOKEN: "token",
      MIWO_S3_FORCE_PATH_STYLE: "true",
    });
    expect(cfg.s3Storage).toMatchObject({ bucket: "miwo-media", region: "us-east-1", accessKeyId: "access", sessionToken: "token", forcePathStyle: true });
  });
});
