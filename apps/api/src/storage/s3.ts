import { createHash, createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import isPathInside from "is-path-inside";
import { config } from "@/config";
import { MEDIA_TTL_SEC, signMediaQuery, verifyMediaSig } from "@/utils/mediaSign";
import type { MediaRef, MediaRoot, MediaStorage } from "./types";
import type { S3StorageConfig } from "./config";

const MIME_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".tiff": "image/tiff", ".tif": "image/tiff", ".mp4": "video/mp4", ".mp3": "audio/mpeg",
};
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const hmac = (key: Buffer | string, value: string, encoding?: "hex"): Buffer | string => {
  const digest = createHmac("sha256", key).update(value);
  return encoding === "hex" ? digest.digest("hex") : digest.digest();
};
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
const xmlDecode = (value: string) => value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");

function safeKey(value: string): string {
  if (typeof value !== "string" || value.includes("\0")) throw new Error("Invalid storage key");
  const parts = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("Invalid storage key traversal");
  return parts.join("/");
}

function redact(error: unknown, method: string): Error {
  const status = error instanceof S3HttpError ? ` failed (${error.status})` : " failed";
  return new Error(`S3 ${method}${status}`);
}
class S3HttpError extends Error { constructor(readonly status: number) { super(); } }

export function createS3MediaStorage(c: S3StorageConfig, transport: typeof fetch = fetch): MediaStorage {
  const endpoint = new URL(c.endpoint);
  if (!c.bucket || !c.region || !c.accessKeyId || !c.secretAccessKey || !endpoint.hostname || !["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("Invalid S3 storage configuration");
  }
  const rootDir = path.resolve(c.cacheDir ?? path.join(config.mediaDir, ".s3-cache"));
  const base = endpoint.toString().replace(/\/$/, "");

  function objectKey(p: string, root: MediaRoot = "oss"): string {
    const key = safeKey(p);
    if (root === "oss") return key;
    return key ? `assets/${key}` : "assets";
  }

  function cachePath(p: string, root: MediaRoot = "oss"): string {
    const key = safeKey(p);
    const cacheRoot = path.join(rootDir, root);
    const abs = path.resolve(cacheRoot, ...key.split("/"));
    if (abs !== cacheRoot && !isPathInside(abs, cacheRoot)) throw new Error("Invalid storage key traversal");
    return abs;
  }

  function target(key: string, query: Record<string, string> = {}): { url: URL; canonicalUri: string; canonicalQuery: string } {
    const normalized = safeKey(key);
    const encodedKey = normalized.split("/").map(encode).join("/");
    const url = new URL(base);
    const pathPrefix = url.pathname.replace(/\/$/, "");
    const objectPath = c.forcePathStyle ? `/${encode(c.bucket)}${encodedKey ? `/${encodedKey}` : ""}` : `${encodedKey ? `/${encodedKey}` : ""}`;
    if (!c.forcePathStyle) url.hostname = `${c.bucket}.${url.hostname}`;
    const uri = `${pathPrefix}${objectPath}` || "/";
    url.pathname = uri;
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const canonicalUri = url.pathname.split("/").map((part) => part ? encode(decodeURIComponent(part)) : "").join("/");
    const canonicalQuery = [...url.searchParams.entries()].map(([k, v]) => [encode(k), encode(v)] as const)
      .sort(([ak, av], [bk, bv]) => ak.localeCompare(bk) || av.localeCompare(bv))
      .map(([k, v]) => `${k}=${v}`).join("&");
    return { url, canonicalUri, canonicalQuery };
  }

  async function request(method: string, key: string, body?: Buffer | Readable, contentLength?: number, query: Record<string, string> = {}, streamedPayloadHash?: string, allowNotFound = false) {
    const { url, canonicalUri, canonicalQuery } = target(key, query);
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const dateStamp = date.slice(0, 8);
    const payloadHash = Buffer.isBuffer(body) ? sha256(body) : body ? (streamedPayloadHash ?? "UNSIGNED-PAYLOAD") : sha256("");
    const headers: Record<string, string> = {
      host: url.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": date,
    };
    if (contentLength !== undefined) headers["content-length"] = String(contentLength);
    if (c.sessionToken) headers["x-amz-security-token"] = c.sessionToken;
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers).sort().map((name) => `${name}:${headers[name].trim()}\n`).join("");
    const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${dateStamp}/${c.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha256(canonicalRequest)}`;
    const kDate = hmac(`AWS4${c.secretAccessKey}`, dateStamp) as Buffer;
    const kRegion = hmac(kDate, c.region) as Buffer;
    const kService = hmac(kRegion, "s3") as Buffer;
    const kSigning = hmac(kService, "aws4_request") as Buffer;
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${c.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${hmac(kSigning, stringToSign, "hex")}`;
    try {
      const init: RequestInit & { duplex?: "half" } = { method, headers, body: body as BodyInit | null, duplex: body && !Buffer.isBuffer(body) ? "half" : undefined };
      const response = await transport(url, init);
      if (!response.ok && !(response.status === 404 && (method === "HEAD" || allowNotFound))) throw new S3HttpError(response.status);
      return response;
    } catch (error) {
      throw redact(error, method);
    }
  }

  async function download(key: string, targetPath: string): Promise<boolean> {
    const response = await request("GET", key, undefined, undefined, {}, undefined, true);
    if (response.status === 404) {
      await fs.rm(targetPath, { force: true });
      return false;
    }
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const temp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(temp));
      await fs.rename(temp, targetPath);
      return true;
    } catch (error) {
      await fs.rm(temp, { force: true });
      throw error;
    }
  }

  async function list(prefix: string, continuation?: string): Promise<{ keys: string[]; next?: string }> {
    const query: Record<string, string> = { "list-type": "2", "encoding-type": "url", prefix: prefix ? `${prefix.replace(/\/$/, "")}/` : "" };
    if (continuation) query["continuation-token"] = continuation;
    const response = await request("GET", "", undefined, undefined, query);
    const xml = await response.text();
    const keys = [...xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)].map((match) => {
      const key = xmlDecode(match[1]);
      try { return decodeURIComponent(key); } catch { return key; }
    });
    const truncated = /<IsTruncated>true<\/IsTruncated>/i.test(xml);
    const token = xml.match(/<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/)?.[1];
    return { keys, next: truncated && token ? xmlDecode(token) : undefined };
  }

  async function hydratePrefix(prefix: string, root: MediaRoot) {
    const objectPrefix = objectKey(prefix, root);
    let token: string | undefined;
    do {
      const page = await list(objectPrefix, token);
      for (const key of page.keys) {
        const relative = root === "assets" ? safeKey(key).slice("assets/".length) : safeKey(key);
        await download(key, cachePath(relative, root));
      }
      token = page.next;
    } while (token);
  }

  const storage: MediaStorage = {
    rootDir,
    async getFileUrl(p, prefix = "oss") {
      const rel = safeKey(p).replace(/\\/g, "/");
      const root: MediaRoot = prefix === "assets" ? "assets" : "oss";
      let url = `/${prefix}/${rel}`;
      if (config.ossUrl) url = `${config.ossUrl.replace(/\/$/, "")}/${prefix}/${rel}`;
      if (config.env === "dev") url = `${config.publicBaseUrl}/${prefix}/${rel}`;
      if (typeof process.versions.electron !== "undefined") url = `http://localhost:${config.port}/${prefix}/${rel}`;
      if (url.startsWith("/") && config.env !== "dev") url = `/${prefix}/${rel}`;
      return `${url}?${signMediaQuery(rel, MEDIA_TTL_SEC, root)}`;
    },
    async getAbsPath(p, root = "oss") {
      const key = safeKey(p);
      const abs = cachePath(key, root);
      const cacheRoot = path.join(rootDir, root);
      if (!key) {
        await fs.mkdir(cacheRoot, { recursive: true });
        return cacheRoot;
      }
      const remoteKey = objectKey(key, root);
      if (p.endsWith("/") || !path.extname(key)) {
        await fs.mkdir(abs, { recursive: true });
        await hydratePrefix(key, root);
        return abs;
      }
      await fs.mkdir(path.dirname(abs), { recursive: true });
      const head = await request("HEAD", remoteKey);
      if (head.status !== 404) await download(remoteKey, abs);
      else await fs.rm(abs, { force: true });
      return abs;
    },
    async getFile(p, root = "oss") {
      const response = await request("GET", objectKey(p, root));
      return Buffer.from(await response.arrayBuffer());
    },
    async writeFile(p, data, root = "oss") {
      const key = safeKey(p);
      const remoteKey = objectKey(key, root);
      const body = typeof data === "string" ? Buffer.from(data.replace(/^data:[^;]+;base64,/, ""), "base64") : data;
      await request("PUT", remoteKey, body, body.length);
      const abs = cachePath(key, root);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, body);
    },
    async writeStream(p, source, root = "oss") {
      const key = safeKey(p);
      const remoteKey = objectKey(key, root);
      const spoolDir = await fs.mkdtemp(path.join(os.tmpdir(), "miwo-s3-"));
      const spool = path.join(spoolDir, "body");
      const hash = createHash("sha256");
      let bytes = 0;
      const hasher = new Transform({ transform(chunk: Buffer, _encoding, callback) { bytes += chunk.length; hash.update(chunk); callback(null, chunk); } });
      try {
        await pipeline(source, hasher, (await fs.open(spool, "w")).createWriteStream());
        const body = createReadStream(spool);
        // Request signer accepts a caller-provided hash for streamed bodies through this scoped value.
        await request("PUT", remoteKey, body, bytes, {}, hash.digest("hex"));
        const abs = cachePath(key, root);
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.copyFile(spool, abs);
        return bytes;
      } finally {
        await fs.rm(spoolDir, { recursive: true, force: true });
      }
    },
    async deleteFile(p, root = "oss") {
      const key = safeKey(p);
      await request("DELETE", objectKey(key, root));
      await fs.rm(cachePath(key, root), { force: true });
    },
    async deleteDirectory(p, root = "oss") {
      const prefix = safeKey(p);
      const remotePrefix = objectKey(prefix, root);
      let token: string | undefined;
      do {
        const page = await list(remotePrefix, token);
        for (const key of page.keys) await request("DELETE", key);
        token = page.next;
      } while (token);
      await fs.rm(cachePath(prefix, root), { recursive: true, force: true });
    },
    async fileExists(p, root = "oss") {
      const response = await request("HEAD", objectKey(p, root));
      return response.status !== 404;
    },
    async getImageBase64(p, root = "oss") {
      const data = await this.getFile(p, root);
      const mime = MIME_TYPES[path.extname(p).toLowerCase()];
      if (!mime) throw new Error(`Unsupported image format: ${path.extname(p)}`);
      return `data:${mime};base64,${data.toString("base64")}`;
    },
    async getSmallImageUrl(p, root = "oss") {
      const url = await this.getFileUrl(p, root);
      return `${url}&size=20`;
    },
    async signRef(ref: MediaRef) {
      const url = await this.getFileUrl(ref.path, ref.root);
      return /[?&]exp=\d{1,15}(&|$)/.test(url) ? url : `${url}${url.includes("?") ? "&" : "?"}${signMediaQuery(ref.path, MEDIA_TTL_SEC, ref.root)}`;
    },
    async verifyRef(ref: MediaRef, params) { return verifyMediaSig(ref.path, params.exp, params.sig, Date.now(), ref.root); },
  };
  return storage;
}
