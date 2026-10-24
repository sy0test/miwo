import path from "node:path";
import { ConfigError } from "@/config";

export interface S3StorageConfig {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
  cacheDir?: string;
}

export function parseS3StorageConfig(env: NodeJS.ProcessEnv, cacheDir: string): S3StorageConfig {
  const required = (key: string) => {
    const value = env[key]?.trim();
    if (!value) throw new ConfigError(`使用 S3 时必须设置 ${key}`);
    return value;
  };
  const endpoint = required("MIWO_S3_ENDPOINT");
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ConfigError("MIWO_S3_ENDPOINT 必须是有效的 http(s) URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ConfigError("MIWO_S3_ENDPOINT 必须使用 http 或 https");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new ConfigError("MIWO_S3_ENDPOINT 不允许包含凭据、查询或片段");
  }
  const bucket = required("MIWO_S3_BUCKET");
  const region = required("MIWO_S3_REGION");
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes("..")) {
    throw new ConfigError("MIWO_S3_BUCKET 格式非法");
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(region)) throw new ConfigError("MIWO_S3_REGION 格式非法");
  const rawPathStyle = env.MIWO_S3_FORCE_PATH_STYLE?.trim();
  if (rawPathStyle !== undefined && rawPathStyle !== "" && rawPathStyle !== "true" && rawPathStyle !== "false") {
    throw new ConfigError("MIWO_S3_FORCE_PATH_STYLE 只能是 true 或 false");
  }
  return {
    bucket,
    region,
    endpoint: parsed.toString().replace(/\/$/, ""),
    accessKeyId: required("MIWO_S3_ACCESS_KEY_ID"),
    secretAccessKey: required("MIWO_S3_SECRET_ACCESS_KEY"),
    sessionToken: env.MIWO_S3_SESSION_TOKEN?.trim() || undefined,
    forcePathStyle: rawPathStyle === "true",
    cacheDir: path.resolve(cacheDir),
  };
}
