import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(() => {
  process.env.MIWO_ENV = "dev";
  process.env.MIWO_PORT = "10599";
  process.env.MIWO_HOST = "127.0.0.1";
  process.env.MIWO_DATA_DIR = path.resolve("D:/tmp/miwo-getpath");
  process.env.MIWO_JWT_SECRET = "y".repeat(48);
});

describe("getPath", () => {
  it("无参返回数据根", async () => {
    const { default: getPath } = await import("../src/utils/getPath");
    expect(getPath().replace(/\\/g, "/")).toBe("D:/tmp/miwo-getpath");
  });

  it("拼接子路径", async () => {
    const { default: getPath } = await import("../src/utils/getPath");
    expect(getPath("oss").replace(/\\/g, "/")).toBe("D:/tmp/miwo-getpath/oss");
  });

  it("数组形式拼接", async () => {
    const { default: getPath } = await import("../src/utils/getPath");
    expect(getPath(["oss", "smallImage"]).replace(/\\/g, "/")).toBe("D:/tmp/miwo-getpath/oss/smallImage");
  });

  it("路径逃逸必须抛错", async () => {
    const { default: getPath } = await import("../src/utils/getPath");
    expect(() => getPath("../../etc/passwd")).toThrow(/路径逃逸/);
  });

  it("数组形式的路径逃逸同样抛错", async () => {
    const { default: getPath } = await import("../src/utils/getPath");
    expect(() => getPath(["..", "..", "etc", "passwd"])).toThrow(/路径逃逸/);
  });

  it("isEletron 在纯 Node 下为 false", async () => {
    const { isEletron } = await import("../src/utils/getPath");
    expect(isEletron()).toBe(false);
  });
});
