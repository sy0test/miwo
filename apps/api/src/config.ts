/**
 * 谜沃唯一配置入口（spec §4.3）。
 *
 * 设计要点：
 *  - 唯一真相是 MIWO_* 环境变量；启动时校验，缺项或非法直接抛 ConfigError（fail-fast）
 *  - 同步派生 process.env.NODE_ENV，兼容 Express / knex 等生态代码
 *  - 不再从 process.cwd() 推断数据根（替掉 getPath.ts:11 的行为）
 */
import path from "node:path";
import { parseS3StorageConfig, type S3StorageConfig } from "@/storage/config";

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

/**
 * 转绘预处理里的**本地 ASR**（M1 原生化：faster-whisper）。见 spec §5.3 / §5.5。
 *
 * `原外部预处理脚本变量`（外部 redraw-prep.cjs）**已删除**：预处理改由 `redraw/pent/prep.ts` 在进程内编排，
 * 切点用原生 ffmpeg、转写用本地 faster-whisper，不再依赖 hypit 仓库与 WhisperX 服务。
 */
export interface MiwoAsrConfig {
  /** local = 本地 faster-whisper；relay = 中继 ASR（暂未启用，留档）；off = 关闭（转写阶段必然失败） */
  driver: "local" | "relay" | "off";
  /** 模型档位：small / medium / large-v3（缺省 medium int8，见 spec §15 的拍板） */
  model: string;
  /** 模型目录（`scripts/fetch-asr-model.cjs` 的下载目标）；缺省 `<dataDir>/asr-models` */
  modelDir: string;
  /** faster-whisper 的 compute_type（CPU 缺省 int8） */
  compute: string;
  /** python 解释器（venv）；空 = 平台约定（win: python / 其它: python3） */
  pythonPath: string;
  /** transcribe.py 绝对路径；空 = 按 dev/打包两种布局自动找 */
  scriptPath: string;
  /** 单集转写超时（毫秒），缺省 20 分钟 */
  timeoutMs: number;
}

export interface MiwoConfig {
  env: MiwoEnv;
  port: number;
  host: string;
  dataDir: string;
  mediaDir: string;
  storageDriver: "local" | "s3";
  s3Storage?: S3StorageConfig;
  publicBaseUrl: string;
  trustProxy: number;
  jwtSecret: string;
  /**
   * 媒体 URL 前缀覆盖（原 `process.env.ossURL`）。空串 = 用相对/公开基地址。
   * ⚠ dev 与 Electron 的基地址另有规则（见 `utils/oss.ts` 的 `getFileUrl`）：本字段只在非空时**覆盖前缀**。
   */
  ossUrl: string;
  /** 外部二进制与超时（原 `FFMPEG_PATH` / `FFPROBE_PATH` / `FFMPEG_TIMEOUT`，Phase 1c Task 10 收口）。 */
  ffmpeg: { path: string; probePath: string; timeoutMs: number };
  /** 出海转绘的本地 ASR（M1 原生化；原 `原外部预处理脚本变量` 已删除）。 */
  asr: MiwoAsrConfig;
  /**
   * 拼贴图标签用的字体（drawtext 的 fontfile）。缺省 = 部署镜像里的 DejaVuSans（G10：只画数字/时间码，
   * **不需要 CJK 字体**，所以不往仓库里塞字体二进制）。文件不存在时拼贴图只是没有编号，不失败。
   */
  gridFont: string;
  /** 出网代理（原 `TOONFLOW_PROXY`，Phase 1c Task 10 **重命名**为 `MIWO_PROXY`）；空 = 直连/读标准代理变量。 */
  proxyUrl: string;
  /**
   * 数据库目标（spec §5.1 的联合类型：sqlite 分支 dev/回归，mysql 分支部署）。
   *
   * ⚠ Phase 1a / Task 4 起这个联合类型被**真正消费**：`src/db/connect.ts` 的 `createKnex()`
   *   按 `db.driver` 选 client，`connectionConfig()` 按分支给连接参数，启动路径
   *   （`utils/db.ts` 的 `dbReady` → `connect()`）据此连库并跑迁移。
   *   在此之前它只是配置层的一个形状，没有任何"选分支"的消费者。
   *   ⚠ 本 Task **不新增**任何 `MIWO_*` 变量（裁定 5）：这里只补注释。
   * ⚠ Phase 1c / Task 10 追加 `ossUrl` / `ffmpeg` / `proxyUrl` 三个字段（`redrawPrepScript` 已于转绘
 *    M1 删除，改成 `asr`）：
   *   它们把此前**散落在消费点**的 6 个 `process.env` 读取收进唯一入口，
   *   由 `node tools/check-config-single-source.cjs`（`pnpm run verify:config`）机械守住
   *   （`apps/api/src/**` 里不许再绕过 config.ts 直读 env；四个标准代理变量是唯一豁免）。
   */
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
  const mediaDir = mediaDirRaw ? path.resolve(mediaDirRaw) : path.join(dataDir, "oss");
  const s3Storage = storageDriver === "s3" ? parseS3StorageConfig(env, path.join(mediaDir, ".s3-cache")) : undefined;

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

  // ---- Phase 1c Task 10：把散落在消费点的 env 读取收进唯一入口 ----
  // ⚠ 默认值与改动前的现状**逐字一致**（否则"没配就换个行为"是一次静默的行为变更）：
  //   · `utils/oss.ts:82` 的 `process.env.ossURL`（空 = 不覆盖前缀）；
  //   · `utils/ffmpeg.ts:15/16/19` 的 `FFMPEG_PATH || "ffmpeg"` / `FFPROBE_PATH || "ffprobe"` /
  //     `Number(FFMPEG_TIMEOUT || 10*60*1000)`；
  //   · `proxy.ts:98` 的 `TOONFLOW_PROXY`（**重命名**为 `MIWO_PROXY`，Phase 0 ledger 已裁定）。
  // ⚠ `toInt` 而不是 `Number(...)`：改动前的 `Number(FFMPEG_TIMEOUT || …)` 会把 "abc" 静默吃成 NaN
  //   ⇒ 超时变成"永不超时"。`toInt` 在非法值上 fail-fast（这正是 config.ts 存在的理由）。
  const ossUrl = optional(env, "MIWO_OSS_URL") ?? "";
  const ffmpegTimeoutMs = toInt(env, "MIWO_FFMPEG_TIMEOUT_MS", 10 * 60 * 1000, 1000);
  const ffmpegPath = optional(env, "MIWO_FFMPEG_PATH") ?? "ffmpeg";
  const ffprobePath = optional(env, "MIWO_FFPROBE_PATH") ?? "ffprobe";
  /**
   * 转绘预处理的本地 ASR（M1）。**(`原外部预处理脚本变量` 与外部脚本已删除)**：
   * 解析前的前置步骤（拼贴图 / 切点 / 转写）现在全在进程内完成（`redraw/prep/prep.ts`）。
   *
   * driver 是**显式三态**而不是布尔：off 让"这台机器没装 Python 依赖"变成一个可声明的状态
   * （部署机没装时启动日志会说清楚，而不是等用户点「开始分析」才 500）。
   */
  const asrDriver = optional(env, "MIWO_ASR_DRIVER") ?? "local";
  if (asrDriver !== "local" && asrDriver !== "relay" && asrDriver !== "off") {
    throw new ConfigError(`MIWO_ASR_DRIVER 只能是 local / relay / off，实际 "${asrDriver}"`);
  }
  const asrModelDirRaw = optional(env, "MIWO_ASR_MODEL_DIR");
  const asr = {
    driver: asrDriver,
    model: optional(env, "MIWO_ASR_MODEL") ?? "medium",
    modelDir: asrModelDirRaw ? path.resolve(asrModelDirRaw) : path.join(dataDir, "asr-models"),
    compute: optional(env, "MIWO_ASR_COMPUTE") ?? "int8",
    pythonPath: optional(env, "MIWO_ASR_PYTHON") ?? "",
    scriptPath: optional(env, "MIWO_ASR_SCRIPT") ?? "",
    timeoutMs: toInt(env, "MIWO_ASR_TIMEOUT_MS", 20 * 60 * 1000, 1000),
  } satisfies MiwoAsrConfig;
  const proxyUrl = optional(env, "MIWO_PROXY") ?? "";
  // G10：拼贴图标签只用 ASCII（编号/秒数），DejaVu 就够；可用 MIWO_GRID_FONT 指向别的字体
  const gridFont = optional(env, "MIWO_GRID_FONT") ?? "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";

  return {
    env: rawEnv,
    port,
    host,
    dataDir,
    mediaDir,
    storageDriver,
    s3Storage,
    publicBaseUrl,
    trustProxy,
    jwtSecret,
    ossUrl,
    ffmpeg: { path: ffmpegPath, probePath: ffprobePath, timeoutMs: ffmpegTimeoutMs },
    asr,
    proxyUrl,
    gridFont,
    db,
  };
}

export const config: MiwoConfig = loadConfig();