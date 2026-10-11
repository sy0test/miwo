import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config";

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
    const prod: NodeJS.ProcessEnv = {
      ...base, MIWO_ENV: "prod", MIWO_HOST: "127.0.0.1",
      // ⚠ brief 原文此处缺 MIWO_PUBLIC_BASE_URL，但 brief 自己的 config.ts（prod 必须设公网基址，
      //   fail-fast 契约）会因此抛错 —— 两处自相矛盾。此处按"prod 契约"补齐 fixture 才自洽。
      MIWO_PUBLIC_BASE_URL: "https://miwo.example.com",
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
});
