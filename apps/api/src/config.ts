/**
 * 谜沃唯一配置入口（spec §4.3）。
 *
 * 设计要点：
 *  - 唯一真相是 MIWO_* 环境变量；启动时校验，缺项或非法直接抛 ConfigError（fail-fast）
 *  - 同步派生 process.env.NODE_ENV，兼容 Express / knex 等生态代码
 *  - 不再从 process.cwd() 推断数据根（替掉 getPath.ts:11 的行为）
 */
import path from "node:path";

export type MiwoEnv = "dev" | "prod";

export class ConfigError extends Error {
  constructor(message: string) {
    super(`[配置错误] ${message}`);
    this.name = "ConfigError";
  }
}

export interface MiwoDbConfigSqlite {
  driver: "sqlite";
  file: string;
}

export interface MiwoDbConfigMysql {
  driver: "mysql";
  host: string;
  port: number;
  user: string;
  password: string;
  name: string;
  poolMin: number;
  poolMax: number;
}

export interface MiwoConfig {
  env: MiwoEnv;
  port: number;
  host: string;
  dataDir: string;
  mediaDir: string;
  storageDriver: "local" | "s3";
  publicBaseUrl: string;
  trustProxy: number;
  jwtSecret: string;
  db: MiwoDbConfigSqlite | MiwoDbConfigMysql;
}

const MIN_SECRET_BYTES = 32;

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (v === undefined || v === "") throw new ConfigError(`缺少必需环境变量 ${key}`);
  return v;
}

function toPort(raw: string, key: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new ConfigError(`${key} 必须是 1..65535 的整数，实际 "${raw}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MiwoConfig {
  const rawEnv = required(env, "MIWO_ENV");
  if (rawEnv !== "dev" && rawEnv !== "prod") throw new ConfigError(`MIWO_ENV 只能是 dev 或 prod，实际 "${rawEnv}"`);

  const port = toPort(required(env, "MIWO_PORT"), "MIWO_PORT");
  const host = required(env, "MIWO_HOST");
  if (rawEnv === "prod" && host !== "127.0.0.1") {
    throw new ConfigError(`prod 环境 MIWO_HOST 必须是 127.0.0.1（由 Nginx 反代），实际 "${host}"`);
  }

  const dataDir = path.resolve(required(env, "MIWO_DATA_DIR"));

  const jwtSecret = required(env, "MIWO_JWT_SECRET");
  if (Buffer.byteLength(jwtSecret, "utf8") < MIN_SECRET_BYTES) {
    throw new ConfigError(`MIWO_JWT_SECRET 至少 ${MIN_SECRET_BYTES} 字节（当前 ${Buffer.byteLength(jwtSecret, "utf8")}）`);
  }

  const publicBaseUrl = env.MIWO_PUBLIC_BASE_URL || (rawEnv === "dev" ? `http://${host}:${port}` : "");
  if (rawEnv === "prod" && !publicBaseUrl) throw new ConfigError("prod 环境必须设置 MIWO_PUBLIC_BASE_URL");

  const storageDriver = env.MIWO_STORAGE_DRIVER || "local";
  if (storageDriver !== "local" && storageDriver !== "s3") {
    throw new ConfigError(`MIWO_STORAGE_DRIVER 只能是 local 或 s3，实际 "${storageDriver}"`);
  }

  const trustProxy = env.MIWO_TRUST_PROXY === undefined ? (rawEnv === "prod" ? 1 : 0) : Number(env.MIWO_TRUST_PROXY);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) throw new ConfigError(`MIWO_TRUST_PROXY 必须是非负整数，实际 "${env.MIWO_TRUST_PROXY}"`);

  const dbDriver = env.MIWO_DB_DRIVER || "sqlite";
  let db: MiwoConfig["db"];
  if (dbDriver === "sqlite") {
    db = { driver: "sqlite", file: path.join(dataDir, "db2.sqlite") };
  } else if (dbDriver === "mysql") {
    db = {
      driver: "mysql",
      host: required(env, "MIWO_DB_HOST"),
      port: toPort(required(env, "MIWO_DB_PORT"), "MIWO_DB_PORT"),
      user: required(env, "MIWO_DB_USER"),
      password: env.MIWO_DB_PASSWORD ?? "",
      name: required(env, "MIWO_DB_NAME"),
      poolMin: Number(env.MIWO_DB_POOL_MIN ?? 2),
      poolMax: Number(env.MIWO_DB_POOL_MAX ?? 20),
    };
  } else {
    throw new ConfigError(`MIWO_DB_DRIVER 只能是 sqlite 或 mysql，实际 "${dbDriver}"`);
  }

  // 兼容生态代码（Express/knex/vite 等仍读 NODE_ENV）
  env.NODE_ENV = rawEnv === "dev" ? "development" : "production";

  return {
    env: rawEnv,
    port,
    host,
    dataDir,
    mediaDir: env.MIWO_MEDIA_DIR ? path.resolve(env.MIWO_MEDIA_DIR) : path.join(dataDir, "oss"),
    storageDriver,
    publicBaseUrl,
    trustProxy,
    jwtSecret,
    db,
  };
}

export const config: MiwoConfig = loadConfig();
