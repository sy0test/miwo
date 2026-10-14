import isPathInside from "is-path-inside";
import getPath, { isEletron } from "@/utils/getPath";
import { config } from "@/config";
import { signMediaQuery } from "@/utils/mediaSign";
import fs from "node:fs/promises";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import sharp from "sharp";

// 规范化路径：去除前导斜杠，并将路径分隔符统一转换为系统分隔符
function normalizeUserPath(userPath: string): string {
  // 去除前导的 / 或 \
  const trimmedPath = userPath.replace(/^[/\\]+/, "");
  // 将所有 / 替换为系统路径分隔符（path.sep）
  // 这样在 Windows 上会转为 \，在 Unix 上保持 /
  return trimmedPath.split("/").join(path.sep);
}

// 校验路径
function resolveSafeLocalPath(userPath: string, rootDir: string): string {
  const safePath = normalizeUserPath(userPath);
  const absPath = path.join(rootDir, safePath);
  if (!isPathInside(absPath, rootDir)) {
    throw new Error(`${userPath} 不在 OSS 根目录内`);
  }
  return absPath;
}

/**
 * 按扩展名判断一个 OSS 文件是图片、视频还是音频。
 *
 * 用途是给参考素材定 `ReferenceList` 的类型：类型标错不会报错，
 * 只会被供应商当另一种素材静默忽略 —— 参考视频被标成 image 就是这么没的。
 * 判不出来一律当图片（分镜图、资产图是最常见的，也是唯一有安全默认值的）。
 */
export function mediaKindOf(filePath: string | undefined): "image" | "video" | "audio" {
  const ext = (filePath ?? "").split(".").pop()?.toLowerCase() ?? "";
  if (["mp4", "webm", "mov", "avi", "mkv"].includes(ext)) return "video";
  if (["mp3", "wav", "ogg", "aac", "flac", "m4a"].includes(ext)) return "audio";
  return "image";
}

class OSS {
  private rootDir: string;
  private initPromise: Promise<void>;

  constructor() {
    this.rootDir = getPath("oss");
    // 初始化时自动创建根目录
    this.initPromise = fs.mkdir(this.rootDir, { recursive: true }).then(() => {});
  }

  /**
   * 等待根目录初始化完成。用于保证所有文件操作在目录已创建后执行。
   * @private
   */
  private async ensureInit() {
    await this.initPromise;
  }

  /**
   * 获取指定相对路径文件的访问 URL（**带短时签名**，spec §6.5）。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @param prefix 静态挂载点：`oss`（默认）或 `assets`
   * @returns 文件的 http 链接（本地服务地址）+ `?exp=<ms>&sig=<hmac>`
   *
   * ⚠ Phase 1c Task 7 起 `?exp=&sig=` 是**必须**的：`/oss` 与 `/assets` 已经移到 `authenticate` 之后，
   *   浏览器自己发的 `<img>/<video>` 请求不带 `Authorization`，只能靠 query 里的签名放行。
   *   签名的被签内容 = 该挂载点下的**相对路径**（`?` 之前的那一段），与 `app.ts` 里
   *   `mediaAuthGuard` 用 `req.path` 取到的形态一致（两侧都做归一，见 `mediaSign.ts`）。
   * ⚠ 这个返回值**只允许出现在响应体里**：不要把它写进 DB（签名 TTL 到期后那些行就是死链）。
   *   `apps/api/tests/media-sign.test.ts` 有一条静态断言把这条钉住。
   */
  async getFileUrl(userRelPath: string, prefix?: string): Promise<string> {
    if (!prefix) prefix = "oss";
    await this.ensureInit();
    const safePath = normalizeUserPath(userRelPath);
    // URL 始终使用 /，所以这里需要将系统分隔符转回 /
    let url = `/${prefix}/`;
    if (process.env.ossURL && process.env.ossURL !== "") url = process.env.ossURL + `/${prefix}/`;
    // dev（纯 Node，可能被局域网浏览器访问）用对外基地址 —— 唯一真相是 config.publicBaseUrl
    // （= MIWO_PUBLIC_BASE_URL，dev 缺省 http://<MIWO_HOST>:<MIWO_PORT>），不再自己探测局域网 IP：
    // 探测出来的网卡可能与浏览器实际走的那张不同（本机就有 192.168.1.12 与虚拟网卡两个非回环地址）。
    if (config.env === "dev") url = `${config.publicBaseUrl}/${prefix}/`;
    // Electron（打包版）页面是 file:///自定义协议，必须绝对地址；属 Phase 1c，端口不再读环境变量 `PORT`。
    if (isEletron()) url = `http://localhost:${config.port}/${prefix}/`;
    const rel = safePath.split(path.sep).join("/");
    // 短时签名（spec §6.5）：/assets 下的片尾素材与 /oss 下的媒体都要走同一个守卫。
    return `${url}${rel}?${signMediaQuery(rel)}`;
  }

  /**
   * 把 OSS 相对路径解析成本机绝对路径。
   *
   * 给需要把文件交给外部进程读写的地方用（目前只有 ffmpeg 切片）——
   * 走外部进程就没法用 writeFile 那样拿 Buffer 中转，只能给它一个真实路径。
   * 越界校验与其它方法共用同一套，别在这里另写一遍。
   *
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 本机绝对路径
   * @throws 路径不在 OSS 根目录内
   */
  async getAbsPath(userRelPath: string): Promise<string> {
    await this.ensureInit();
    return resolveSafeLocalPath(userRelPath, this.rootDir);
  }

  /**
   * 读取指定路径的文件内容为 Buffer。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件内容的 Buffer
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  async getFile(userRelPath: string): Promise<Buffer> {
    await this.ensureInit();
    return fs.readFile(resolveSafeLocalPath(userRelPath, this.rootDir));
  }

  /**
   * 读取图片文件并转换为 base64 编码的 Data URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns base64 编码的 Data URL (例如: data:image/png;base64,iVBORw0KGgo...)
   * @throws 路径不在 OSS 根目录内、文件不存在、不是图片文件等错误
   */
  async getImageBase64(userRelPath: string): Promise<string> {
    await this.ensureInit();
    const absPath = resolveSafeLocalPath(userRelPath, this.rootDir);

    // 检查文件是否存在且为文件
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) {
      throw new Error(`${userRelPath} 不是文件`);
    }

    // 获取文件扩展名并确定 MIME 类型
    const ext = path.extname(userRelPath).toLowerCase();
    const mimeTypes: Record<string, string> = {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".gif": "image/gif",
      ".webp": "image/webp",
      ".bmp": "image/bmp",
      ".svg": "image/svg+xml",
      ".ico": "image/x-icon",
      ".tiff": "image/tiff",
      ".tif": "image/tiff",
      ".mp4": "video/mp4",
      ".mp3": "audio/mpeg",
    };

    const mimeType = mimeTypes[ext];
    if (!mimeType) {
      throw new Error(`不支持的图片格式: ${ext}。支持的格式: ${Object.keys(mimeTypes).join(", ")}`);
    }

    // 读取文件并转换为 base64
    const data = await fs.readFile(absPath);
    const base64 = data.toString("base64");
    // 返回完整的 Data URL
    return `data:${mimeType};base64,${base64}`;
  }
  /**
   * 删除指定路径的文件。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件不存在等错误
   */
  async deleteFile(userRelPath: string): Promise<void> {
    await this.ensureInit();
    await fs.unlink(resolveSafeLocalPath(userRelPath, this.rootDir));
  }

  /**
   * 删除指定路径的文件夹及其所有内容。
   * @param userRelPath 用户传入的相对文件夹路径（使用 / 作为分隔符）
   * @throws 路径不在 OSS 根目录内、文件夹不存在、目标是文件而非文件夹等错误
   */
  async deleteDirectory(userRelPath: string): Promise<void> {
    await this.ensureInit();
    const absPath = resolveSafeLocalPath(userRelPath, this.rootDir);
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) {
      throw new Error(`${userRelPath} 不是文件夹`);
    }
    await fs.rm(absPath, { recursive: true, force: true });
  }

  /**
   * 将数据写入指定路径的新文件或覆盖已有文件。
   * 写入前自动创建所需的父文件夹。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @param data 要写入的数据，可以为 Buffer 或字符串
   * @throws 路径不在 OSS 根目录内等错误
   */
  async writeFile(userRelPath: string, data: Buffer | string): Promise<void> {
    await this.ensureInit();
    const absPath = resolveSafeLocalPath(userRelPath, this.rootDir);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    // 如果 data 是 string，则视为 base64 编码，先解码再写入
    // 自动去除可能存在的 Data URL 前缀（如 "data:image/png;base64,"）
    const buffer = typeof data === "string" ? Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64") : data;
    await fs.writeFile(absPath, buffer);
  }

  /**
   * 把一个流原样写进指定路径（覆盖已有文件）。写入前自动创建所需的父文件夹。
   *
   * 给**大文件上传**用：源视频动辄几百 MB，走 `writeFile(rel, base64)` 要先在内存里
   * 攒成字符串再解回来，而 app.ts 的 body 上限是 100mb —— 撞上就是 413。
   * 流式写不经过 body parser，也不把内容整块读进内存。
   *
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @param source 要写入的数据流（路由里直接传 `req`）
   * @returns 实际写入的字节数
   * @throws 路径不在 OSS 根目录内、流中途断开（此时落盘文件是半截，调用方负责删）
   */
  async writeStream(userRelPath: string, source: Readable): Promise<number> {
    await this.ensureInit();
    const absPath = resolveSafeLocalPath(userRelPath, this.rootDir);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    // 用 pipeline 而不是手动 pipe：上游（HTTP 请求）中途出错时要能**销毁**目的流，
    // 否则文件句柄不关、错误也浮不上来。
    await pipeline(source, createWriteStream(absPath));
    return (await fs.stat(absPath)).size;
  }

  /**
   * 检查指定路径文件是否存在。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 文件存在返回 true，否则 false
   */
  async fileExists(userRelPath: string): Promise<boolean> {
    await this.ensureInit();
    try {
      const stat = await fs.stat(resolveSafeLocalPath(userRelPath, this.rootDir));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  /**
   * 获取图片的缩略图 URL（最长边不超过 512px，等比缩放）。
   * 缩略图保存在原路径同目录下的 smallImage 子文件夹中。
   * 若缩略图已存在则直接返回其 URL；若不存在则同步生成并保存后返回缩略图 URL，
   * 生成失败时返回原图 URL。
   * @param userRelPath 用户传入的相对文件路径（使用 / 作为分隔符）
   * @returns 缩略图 URL（已存在或生成成功）或原图 URL（生成失败时）
   */
  async getSmallImageUrl(userRelPath: string): Promise<string> {
    // 构造缩略图相对路径：在原路径的目录层级前插入 smallImage 目录
    // 例如：123/abc.jpg => smallImage/123/abc.jpg
    // const smallImageRelPath = `smallImage/${userRelPath.replace(/^[/\\]+/, "")}`;

    // if (await this.fileExists(smallImageRelPath)) {
    //   return this.getFileUrl(smallImageRelPath);
    // }

    // // 缩略图不存在：同步生成，生成失败则返回原图 URL
    // const originalUrl = await this.getFileUrl(userRelPath);

    // try {
    //   await this.ensureInit();
    //   const srcAbsPath = resolveSafeLocalPath(userRelPath, this.rootDir);
    //   const dstAbsPath = resolveSafeLocalPath(smallImageRelPath, this.rootDir);
    //   await fs.mkdir(path.dirname(dstAbsPath), { recursive: true });
    //   await sharp(srcAbsPath)
    //     .resize(512, 512, { fit: "inside", withoutEnlargement: true })
    //     .toFile(dstAbsPath);
    //   console.info(`[${dstAbsPath}]小图写入成功`);
    // ⚠ `?size=20` 是给 `app.ts` 的 `/oss` 缩略图分支看的参数，**必须用 `&` 追加**：
    //   `getFileUrl` 现在返回 `…?exp=…&sig=…`，再拼一个 `?size=20` 会得到 `…?sig=…?size=20` ——
    //   签名值里混进 `?size=20` ⇒ 守卫 403、页面上**一张图都没有**（"接口全正常、图全裂"那个症状）。
    //   `tests/media-sign.test.ts` 断言"`sig=` 与 `size=20` 同时存在，且 URL 里只有一个 `?`"。
    const base = await this.getFileUrl(userRelPath);
    return base.includes("?") ? `${base}&size=20` : `${base}?size=20`;
    // } catch (e) {
    //   // 生成失败返回原图
    //   console.warn("[OSS] 生成缩略图失败:", e);
    //   return originalUrl;
    // }
  }
}

export default new OSS();
