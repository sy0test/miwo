import { ConfigError } from "@/config";
import { LocalMediaStorage } from "./local";
import { createS3MediaStorage } from "./s3";
import type { S3StorageConfig } from "./config";
import type { MediaStorage } from "./types";

const MIN_SECRET_BYTES = 32;

export function createStorage(c: { storageDriver: "local" | "s3"; jwtSecret: string; s3Storage?: S3StorageConfig }): MediaStorage {
  if (typeof c.jwtSecret !== "string" || Buffer.byteLength(c.jwtSecret, "utf8") < MIN_SECRET_BYTES) {
    throw new ConfigError(`媒体签名密钥至少 ${MIN_SECRET_BYTES} 字节（与 MIWO_JWT_SECRET 同口径）：实际 ${Buffer.byteLength(String(c.jwtSecret ?? ""), "utf8")} 字节`);
  }
  if (c.storageDriver === "s3") {
    if (!c.s3Storage) throw new ConfigError("MIWO_STORAGE_DRIVER=s3 缺少有效 S3 配置");
    return createS3MediaStorage(c.s3Storage);
  }
  return new LocalMediaStorage();
}
