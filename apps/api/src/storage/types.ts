/**
 * 媒体存储接口（spec §6.5 第 4 项；Phase 1e Task 01）。
 *
 * ── Signed URL contract ──
 * URLs retain the existing 24h TTL and 43-character base64url HMAC shape, while the `MediaRef.root`
 * (`oss` or `assets`) is now part of the signed payload. This prevents a signature for one mounted
 * storage namespace from authorizing a same-named file in the other namespace. Path-only URLs issued
 * before this contract change are rejected; their maximum remaining lifetime is 24 hours.
 * ⚠ Phase 2 `S3Storage` keeps this interface shape (spec §6.5 item 4).
 */
import type { Readable } from "node:stream";

/** 媒体资源根：与 `app.ts` 里挂载的两个受控通道一一对应。 */
export type MediaRoot = "oss" | "assets";

/** URL 上的签名参数（`?exp=` 毫秒时间戳 + `?sig=` 签名）。 */
export type SignedParams = { exp: number; sig: string };

/**
 * 一次媒体访问的完整引用。
 *
 * ⚠ `qs` **刻意不参与签名**（路径域签名，沿用 1c 口径）：`utils/oss.ts` 的 `getSmallImageUrl`
 * 会自己返回 `…?size=20` 形状的 URL，若把 query 纳入签名，那个形状会立刻失效。
 * 代价与上界见 `utils/thumbnail-size.ts`（`?size=` 有显式上界）。
 */
export type MediaRef = { root: MediaRoot; path: string; qs?: Record<string, string> };

/**
 * Phase 1 的存储接口。
 *
 * `signRef` / `verifyRef` 是 1c 签名器的**适配**（见文件头）；
 * 其余方法逐字对齐 `utils/oss.ts` 的既有形状（不搬家 URL 产出点：全仓 44 个业务文件依赖 `u.oss`）。
 */
export interface MediaStorage {
  readonly rootDir: string;
  getFileUrl(p: string, prefix?: string): Promise<string>;
  getAbsPath(p: string, root?: MediaRoot): Promise<string>;
  getFile(p: string, root?: MediaRoot): Promise<Buffer>;
  writeFile(p: string, data: Buffer | string, root?: MediaRoot): Promise<void>;
  writeStream(p: string, source: Readable, root?: MediaRoot): Promise<number>;
  deleteFile(p: string, root?: MediaRoot): Promise<void>;
  deleteDirectory(p: string, root?: MediaRoot): Promise<void>;
  fileExists(p: string, root?: MediaRoot): Promise<boolean>;
  getImageBase64(p: string, root?: MediaRoot): Promise<string>;
  getSmallImageUrl(p: string, root?: MediaRoot): Promise<string>;
  /** 产出一条**已签名**的媒体 URL（`?exp=&sig=`）。 */
  signRef(ref: MediaRef): Promise<string>;
  /** 校验一条媒体引用的签名参数（与 `mediaAuthGuard` 同一套判据）。 */
  verifyRef(ref: MediaRef, params: { exp?: string; sig?: string }): Promise<boolean>;
}
