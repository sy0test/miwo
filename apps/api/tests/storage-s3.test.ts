import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createS3MediaStorage } from "@/storage/s3";
import type { S3StorageConfig } from "@/storage/config";

const root = path.join(process.cwd(), ".test-tmp", `storage-s3-${process.pid}`);
const cfg: S3StorageConfig = {
  bucket: "media-bucket",
  region: "us-east-1",
  endpoint: "https://s3.example.test",
  accessKeyId: "AKIDEXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
  sessionToken: "session-token-secret",
  forcePathStyle: true,
  cacheDir: root,
};

afterEach(async () => fs.rm(root, { recursive: true, force: true }));

function response(body = "", status = 200, headers?: HeadersInit): Response {
  return new Response(status === 204 ? null : body, { status, headers });
}

describe("S3 MediaStorage", () => {
  it("signs PUT with SigV4 and streams a known-length temp-spooled body with session token", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => response());
    const storage = createS3MediaStorage(cfg, fetchMock as typeof fetch);

    expect(await storage.writeStream("tenant-a/source video.mp4", Readable.from(["视频"]))).toBe(6);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    const headers = new Headers(init.headers);
    expect(url.toString()).toContain("/media-bucket/tenant-a/source%20video.mp4");
    expect(init.method).toBe("PUT");
    expect(headers.get("content-length")).toBe("6");
    expect(headers.get("x-amz-security-token")).toBe("session-token-secret");
    expect(headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\//);
    expect(headers.get("authorization")).not.toContain(cfg.secretAccessKey);
  });

  it("hydrates a remote object into its deterministic safe cache path", async () => {
    const transport = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("?list-type=2") ? response("<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>") : response("remote-data"),
    );
    const storage = createS3MediaStorage({ ...cfg, sessionToken: undefined }, transport as typeof fetch);
    const cached = await storage.getAbsPath("tenant-a/media.bin");

    expect(cached).toBe(path.join(root, "oss", "tenant-a", "media.bin"));
    expect(await fs.readFile(cached, "utf8")).toBe("remote-data");
    expect(transport.mock.calls.map(([url]) => String(url))).toEqual(expect.arrayContaining([
      expect.stringContaining("tenant-a/media.bin"),
    ]));
  });

  it("isolates same-named objects and caches by media root", async () => {
    const requests: string[] = [];
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(url)}`);
      return response();
    });
    const storage = createS3MediaStorage({ ...cfg, sessionToken: undefined }, transport as typeof fetch);

    await storage.writeFile("same.bin", Buffer.from("oss-data"), "oss");
    await storage.writeFile("same.bin", Buffer.from("asset-data"), "assets");

    expect(requests).toEqual([
      expect.stringContaining("/media-bucket/same.bin"),
      expect.stringContaining("/media-bucket/assets/same.bin"),
    ]);
    expect(await fs.readFile(path.join(root, "oss", "same.bin"), "utf8")).toBe("oss-data");
    expect(await fs.readFile(path.join(root, "assets", "same.bin"), "utf8")).toBe("asset-data");
  });

  it("removes stale cache when an object disappears between HEAD and GET", async () => {
    const key = "tenant-a/disappeared.bin";
    const cached = path.join(root, "oss", key);
    await fs.mkdir(path.dirname(cached), { recursive: true });
    await fs.writeFile(cached, "stale-data");
    const methods: string[] = [];
    const transport = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      methods.push(method);
      return method === "HEAD" ? response() : response("", 404);
    });
    const storage = createS3MediaStorage({ ...cfg, sessionToken: undefined }, transport as typeof fetch);

    await expect(storage.getAbsPath(key)).resolves.toBe(cached);
    await expect(fs.readFile(cached, "utf8")).rejects.toThrow();
    expect(methods).toEqual(["HEAD", "GET"]);
  });

  it("redacts response bodies and credentials from S3 errors", async () => {
    const storage = createS3MediaStorage(cfg, (async () =>
      response("Authorization: secret; X-Amz-Signature=private", 403)) as typeof fetch);
    const error = await storage.getFile("tenant-a/private.bin").then(() => null, (e: unknown) => e as Error);

    expect(error?.message).toBe("S3 GET failed (403)");
    expect(error?.message).not.toMatch(/secret|private|Signature/);
  });

  it("rejects traversal before making any request", async () => {
    const transport = vi.fn();
    const storage = createS3MediaStorage(cfg, transport as typeof fetch);
    await expect(storage.getFile("../secret")).rejects.toThrow(/path|key|traversal/i);
    expect(transport).not.toHaveBeenCalled();
  });

  it("deletes every page of a directory prefix without exposing signed query details", async () => {
    const requests: string[] = [];
    const transport = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      requests.push(`${init?.method ?? "GET"} ${String(url)}`);
      if (init?.method === "DELETE") return response("", 204);
      if (String(url).includes("continuation-token=next%2Ftoken")) {
        return response("<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>tenant%2Fdir%2Fb.mp4</Key></Contents></ListBucketResult>");
      }
      return response("<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>next/token</NextContinuationToken><Contents><Key>tenant%2Fdir%2Fa.mp4</Key></Contents></ListBucketResult>");
    });
    const storage = createS3MediaStorage({ ...cfg, sessionToken: undefined }, transport as typeof fetch);
    await storage.deleteDirectory("tenant/dir");

    expect(requests.filter((request) => request.startsWith("DELETE "))).toHaveLength(2);
    expect(requests.some((request) => request.includes("continuation-token=next%2Ftoken"))).toBe(true);
  });
});
