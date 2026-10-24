import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import isPathInside from "is-path-inside";
import path from "node:path";
import oss from "@/utils/oss";
import getPath from "@/utils/getPath";
import { MEDIA_TTL_SEC, signMediaQuery, verifyMediaSig } from "@/utils/mediaSign";
import type { MediaRef, MediaRoot, MediaStorage } from "./types";

const HAS_SIGNED_QUERY = /[?&]exp=\d{1,15}(&|$)/;
const MIME_TYPES: Record<string, string> = {
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

export class LocalMediaStorage implements MediaStorage {
  readonly rootDir: string;

  constructor(rootDir: string = oss.rootDir) {
    this.rootDir = path.resolve(rootDir);
  }

  private resolvePath(userRelPath: string, root: MediaRoot = "oss"): string {
    const normalized = userRelPath.replace(/^[/\\]+/, "").split("/").join(path.sep);
    const rootDir = root === "assets" ? getPath("assets") : this.rootDir;
    const absPath = path.resolve(rootDir, normalized);
    if (!isPathInside(absPath, rootDir)) throw new Error(`${userRelPath} 不在 ${root} 根目录内`);
    return absPath;
  }

  async getFileUrl(p: string, prefix?: string): Promise<string> {
    return oss.getFileUrl(p, prefix);
  }

  async getAbsPath(p: string, root: MediaRoot = "oss"): Promise<string> {
    return this.resolvePath(p, root);
  }

  async getFile(p: string, root: MediaRoot = "oss"): Promise<Buffer> {
    return fs.readFile(this.resolvePath(p, root));
  }

  async writeFile(p: string, data: Buffer | string, root: MediaRoot = "oss"): Promise<void> {
    const absPath = this.resolvePath(p, root);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    const buffer = typeof data === "string" ? Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64") : data;
    await fs.writeFile(absPath, buffer);
  }

  async writeStream(p: string, source: Readable, root: MediaRoot = "oss"): Promise<number> {
    const absPath = this.resolvePath(p, root);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await pipeline(source, createWriteStream(absPath));
    return (await fs.stat(absPath)).size;
  }

  async deleteFile(p: string, root: MediaRoot = "oss"): Promise<void> {
    await fs.unlink(this.resolvePath(p, root));
  }

  async deleteDirectory(p: string, root: MediaRoot = "oss"): Promise<void> {
    const absPath = this.resolvePath(p, root);
    const stat = await fs.stat(absPath);
    if (!stat.isDirectory()) throw new Error(`${p} 不是文件夹`);
    await fs.rm(absPath, { recursive: true, force: true });
  }

  async fileExists(p: string, root: MediaRoot = "oss"): Promise<boolean> {
    try {
      return (await fs.stat(this.resolvePath(p, root))).isFile();
    } catch {
      return false;
    }
  }

  async getImageBase64(p: string, root: MediaRoot = "oss"): Promise<string> {
    const absPath = this.resolvePath(p, root);
    const stat = await fs.stat(absPath);
    if (!stat.isFile()) throw new Error(`${p} 不是文件`);
    const ext = path.extname(p).toLowerCase();
    const mimeType = MIME_TYPES[ext];
    if (!mimeType) throw new Error(`不支持的图片格式: ${ext}。支持的格式: ${Object.keys(MIME_TYPES).join(", ")}`);
    return `data:${mimeType};base64,${(await fs.readFile(absPath)).toString("base64")}`;
  }

  async getSmallImageUrl(p: string, root: MediaRoot = "oss"): Promise<string> {
    const base = await this.getFileUrl(p, root);
    return base.includes("?") ? `${base}&size=20` : `${base}?size=20`;
  }

  async signRef(ref: MediaRef): Promise<string> {
    const url = await oss.getFileUrl(ref.path, ref.root);
    if (HAS_SIGNED_QUERY.test(url)) return url;
    const sep = url.includes("?") ? "&" : "?";
    return `${url}${sep}${signMediaQuery(ref.path, MEDIA_TTL_SEC, ref.root)}`;
  }

  async verifyRef(ref: MediaRef, params: { exp?: string; sig?: string }): Promise<boolean> {
    return verifyMediaSig(ref.path, params.exp, params.sig, Date.now(), ref.root);
  }
}
