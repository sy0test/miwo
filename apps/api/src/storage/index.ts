/**
 * 存储装配点（Phase 1e Task 01）。
 *
 * **`s3` 在 Phase 2 之前一律拒绝启动**：1e 之前 `MIWO_STORAGE_DRIVER=s3` 会被静默地按本地盘跑
 * （`config.ts` 只校验取值合法，装配处直接 new 了 local）—— 部署者会以为自己已经切了对象存储。
 * 这里把它变成**响亮的失败**（与 `config.ts` 的双保险：配置层 + 装配层各一条）。
 */
import { ConfigError } from "@/config";
import { LocalMediaStorage } from "./local";
import type { MediaStorage } from "./types";

/** JWT 密钥的强度下限（与 `config.ts` 的 `MIN_SECRET_BYTES` 同口径：媒体签名密钥不得更弱）。 */
const MIN_SECRET_BYTES = 32;

export function createStorage(c: { storageDriver: "local" | "s3"; jwtSecret: string }): MediaStorage {
  if (c.storageDriver === "s3") {
    throw new ConfigError(
      "MIWO_STORAGE_DRIVER=s3 尚未实现（Phase 2 落地 S3Storage）。当前请设为 local —— " +
        "它在 Phase 1e 之前是**静默按本地盘运行**的，那会让部署者以为自己已经切了对象存储。",
    );
  }
  // ⚠ 真实签名密钥由 `utils/mediaSign.ts` 的 `mediaSignKey()` 从 `config.jwtSecret` 派生（域分离）；
  //   这里只做**强度自检** —— 否则"密钥太短"这件事要等到第一次签名才暴露。
  if (typeof c.jwtSecret !== "string" || Buffer.byteLength(c.jwtSecret, "utf8") < MIN_SECRET_BYTES) {
    throw new ConfigError(
      `媒体签名密钥至少 ${MIN_SECRET_BYTES} 字节（与 MIWO_JWT_SECRET 同口径）：实际 ${Buffer.byteLength(String(c.jwtSecret ?? ""), "utf8")} 字节`,
    );
  }
  return new LocalMediaStorage();
}
