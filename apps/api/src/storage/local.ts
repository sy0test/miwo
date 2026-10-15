/**
 * 本地盘实现（spec §15 O4；Phase 1e Task 01）。
 *
 * ⚠ **URL 产出点不搬家**：全部转发给 `utils/oss.ts` 的单例（全仓 44 个业务文件依赖 `u.oss` 的形状，
 *   spec §5.1 的"保留形状"原则同样适用于这里）。本类只做两件事：
 *   1. 把 `MediaStorage` 接口暴露出去，让 Phase 2 的 `S3Storage` 有可替换的接缝；
 *   2. 提供 `signRef` / `verifyRef` 这两个签名适配点。
 *
 * ⚠⚠ **签名不是本类新加的**（R1）：Phase 1c 起 `oss.getFileUrl()` 返回的 URL **已经**带
 *   `?exp=&sig=`（`utils/oss.ts:93` 调的 `signMediaQuery`）。所以 `signRef` 的第一件事是
 *   **判断是否已签名**——再无条件拼一次会产出 `?exp=..&sig=..&exp=..&sig=..` 的**双签名** URL
 *   （URL 变长、语义歧义，而且 `getSmallImageUrl` 的 `?size=20` 拼接点会跟着错）。
 */
import type { MediaRef, MediaStorage } from "./types";
import oss from "@/utils/oss";
import { MEDIA_TTL_SEC, signMediaQuery, verifyMediaSig } from "@/utils/mediaSign";

/** `?exp=<毫秒>&sig=<base64url>`（1c 的签名形状）是否已经在 URL 里。 */
const HAS_SIGNED_QUERY = /[?&]exp=\d{1,15}(&|$)/;

export class LocalMediaStorage implements MediaStorage {
  readonly rootDir: string;

  /** `rootDir` 缺省取 `oss` 单例的根（可注入，供测试用一次性目录）。 */
  constructor(rootDir: string = oss.rootDir) {
    this.rootDir = rootDir;
  }

  getFileUrl(p: string, prefix?: string): Promise<string> {
    return oss.getFileUrl(p, prefix);
  }
  getAbsPath(p: string): Promise<string> {
    return oss.getAbsPath(p);
  }
  getFile(p: string): Promise<Buffer> {
    return oss.getFile(p);
  }
  writeFile(p: string, data: Buffer | string): Promise<void> {
    return oss.writeFile(p, data);
  }
  writeStream(p: string, source: Parameters<MediaStorage["writeStream"]>[1]): Promise<number> {
    return oss.writeStream(p, source);
  }
  deleteFile(p: string): Promise<void> {
    return oss.deleteFile(p);
  }
  deleteDirectory(p: string): Promise<void> {
    return oss.deleteDirectory(p);
  }
  fileExists(p: string): Promise<boolean> {
    return oss.fileExists(p);
  }
  getImageBase64(p: string): Promise<string> {
    return oss.getImageBase64(p);
  }
  getSmallImageUrl(p: string): Promise<string> {
    return oss.getSmallImageUrl(p);
  }

  /**
   * 签名 URL。
   *  · 1c 的 `getFileUrl` **已经**签过（`?exp=&sig=`）⇒ 原样返回（**不重复拼**）；
   *  · 若将来换成别的 driver / 关掉内联签名，则按 `MEDIA_TTL_SEC` 补一次。
   */
  async signRef(ref: MediaRef): Promise<string> {
    const url = await oss.getFileUrl(ref.path, ref.root);
    if (HAS_SIGNED_QUERY.test(url)) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${signMediaQuery(ref.path, MEDIA_TTL_SEC)}`;
  }

  async verifyRef(ref: MediaRef, params: { exp?: string; sig?: string }): Promise<boolean> {
    // 与 `mediaAuthGuard` 同一套判据（路径域签名；`root` 不参与，见 types.ts 的头注）。
    return verifyMediaSig(ref.path, params.exp, params.sig);
  }
}
