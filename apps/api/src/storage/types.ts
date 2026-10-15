/**
 * 媒体存储接口（spec §6.5 第 4 项；Phase 1e Task 01）。
 *
 * ── 本文件的口径为什么与计划正文不同（R1：审计优先，已满足的不得重做）──
 * 计划写于 Phase 1b/1c/1d **之前**，它设想的签名是"`MediaRef` 的 `root` 也参与规范串、
 * TTL 2 小时、sig 是 64 位 hex"。**Phase 1c 已经交付了另一套**（`src/utils/mediaSign.ts`）：
 *   · 规范串 = **只有归一化后的路径**（`${relPath}|${exp}`），`root` 不参与；
 *   · TTL = **24h**（`MEDIA_TTL_SEC`），sig = **base64url 截断 43 字符**；
 *   · `oss.getFileUrl()` 自己就把 `?exp=&sig=` 拼好了，`mediaAuthGuard` 按同一口径验签。
 * ⇒ 本接口**只做 Phase 2 `S3Storage` 的替换接缝**，不改 1c 的签名口径：
 *   把 `root` 纳入签名会**让所有已发出的链接立即失效**，并直接弄红 `verify:phase1c-media`（34/34）。
 *   这是"接口先行、口径沿用现状"，不是"少做了一步"。
 * ⚠ Phase 2 加 `S3Storage` 时**不得改本接口的形状**（spec §6.5 第 4 项）。
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
  getAbsPath(p: string): Promise<string>;
  getFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer | string): Promise<void>;
  writeStream(p: string, source: Readable): Promise<number>;
  deleteFile(p: string): Promise<void>;
  deleteDirectory(p: string): Promise<void>;
  fileExists(p: string): Promise<boolean>;
  getImageBase64(p: string): Promise<string>;
  getSmallImageUrl(p: string): Promise<string>;
  /** 产出一条**已签名**的媒体 URL（`?exp=&sig=`）。 */
  signRef(ref: MediaRef): Promise<string>;
  /** 校验一条媒体引用的签名参数（与 `mediaAuthGuard` 同一套判据）。 */
  verifyRef(ref: MediaRef, params: { exp?: string; sig?: string }): Promise<boolean>;
}
