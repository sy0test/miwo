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

/** 可选值：把 `undefined` 与空串**统一**视为"未设置"，避免 `""` 被 `Number("")` 静默吃成 0 或漏过校验。 */
function optional(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = env[key];
  return v === undefined || v.trim() === "" ? undefined : v;
}

/** 可选整数：未设置取默认值；设置了就必须是 >= min 的整数，否则抛错（不允许 NaN 静默流出）。 */
function toInt(env: NodeJS.ProcessEnv, key: string, dflt: number, min: number): number {
  const raw = optional(env, key);
  if (raw === undefined) return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) throw new ConfigError(`${key} 必须是 >=${min} 的整数，实际 "${raw}"`);
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

  const publicBaseUrl = optional(env, "MIWO_PUBLIC_BASE_URL") ?? (rawEnv === "dev" ? `http://${host}:${port}` : "");
  if (rawEnv === "prod" && !publicBaseUrl) throw new ConfigError("prod 环境必须设置 MIWO_PUBLIC_BASE_URL");

  const storageDriver = optional(env, "MIWO_STORAGE_DRIVER") ?? "local";
  if (storageDriver !== "local" && storageDriver !== "s3") {
    throw new ConfigError(`MIWO_STORAGE_DRIVER 只能是 local 或 s3，实际 "${storageDriver}"`);
  }

  const trustProxyRaw = optional(env, "MIWO_TRUST_PROXY");
  const trustProxy = trustProxyRaw === undefined ? (rawEnv === "prod" ? 1 : 0) : Number(trustProxyRaw);
  if (!Number.isInteger(trustProxy) || trustProxy < 0) throw new ConfigError(`MIWO_TRUST_PROXY 必须是非负整数，实际 "${trustProxyRaw}"`);

  // ⚠ 与 M1 同口径：用 optional()（把 undefined 与纯空白统一视为"未设置"），
  //    不用 `env.MIWO_MEDIA_DIR ? ...` —— 后者会把 "   " 当成有效值，resolve 成 cwd 本身。
  const mediaDirRaw = optional(env, "MIWO_MEDIA_DIR");

  const dbDriver = optional(env, "MIWO_DB_DRIVER") ?? "sqlite";
  let db: MiwoConfig["db"];
  if (dbDriver === "sqlite") {
    db = { driver: "sqlite", file: path.join(dataDir, "db2.sqlite") };
  } else if (dbDriver === "mysql") {
    db = {
      driver: "mysql",
      host: required(env, "MIWO_DB_HOST"),
      port: toPort(required(env, "MIWO_DB_PORT"), "MIWO_DB_PORT"),
      user: required(env, "MIWO_DB_USER"),
      // password 允许为空（本地 MySQL 常见），但**必须显式**：这里不用 `required`，并在 .env.example 里写明
      password: optional(env, "MIWO_DB_PASSWORD") ?? "",
      name: required(env, "MIWO_DB_NAME"),
      poolMin: toInt(env, "MIWO_DB_POOL_MIN", 2, 1),
      poolMax: toInt(env, "MIWO_DB_POOL_MAX", 20, 1),
    };
    if ((db as MiwoDbConfigMysql).poolMax < (db as MiwoDbConfigMysql).poolMin) {
      throw new ConfigError(`MIWO_DB_POOL_MAX (${(db as MiwoDbConfigMysql).poolMax}) 不能小于 MIWO_DB_POOL_MIN (${(db as MiwoDbConfigMysql).poolMin})`);
    }
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
    mediaDir: mediaDirRaw ? path.resolve(mediaDirRaw) : path.join(dataDir, "oss"),
    storageDriver,
    publicBaseUrl,
    trustProxy,
    jwtSecret,
    db,
  };
}

export const config: MiwoConfig = loadConfig();
