import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const API_ROOT = path.resolve(__dirname, "..");
const ROUTER = path.join(API_ROOT, "src", "router.ts");

function generate() {
  execFileSync(process.execPath, [path.join(API_ROOT, "scripts", "generate-router.ts")], {
    cwd: API_ROOT,
    env: { ...process.env, NODE_OPTIONS: "--import=tsx" },
    stdio: "pipe",
  });
}

describe("generate-router", () => {
  it("能重新生成 router.ts 且内容稳定（幂等）", () => {
    expect(fs.existsSync(ROUTER)).toBe(true);
    const first = fs.readFileSync(ROUTER, "utf8");
    generate();
    const second = fs.readFileSync(ROUTER, "utf8");
    expect(second).toBe(first);
  });

  it("生成的路由条数与路由文件数一致", () => {
    const text = fs.readFileSync(ROUTER, "utf8");
    const mounts = text.match(/app\.use\("\/api/g) ?? [];

    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (p.endsWith(".ts")) out.push(p);
      }
      return out;
    };
    const routeFiles = walk(path.join(API_ROOT, "src", "routes"));

    expect(mounts.length).toBe(177);
    expect(routeFiles.length).toBe(177);
  });

  it("router.ts 的 hash 头格式正确，且与路由清单重算结果一致", () => {
    const text = fs.readFileSync(ROUTER, "utf8");
    const m = text.match(/^\/\/ @routes-hash ([a-f0-9]{32})/);
    expect(m).not.toBeNull();

    // 按 generate-router.ts 的规则重算 hash：路由清单 = [{routePath, varName}]
    // routePath 形如 "/login/login"（带前导斜杠），mount 为 app.use("/api" + routePath, varN)
    const pairRe = /app\.use\("\/api(\/[^"]*)", (route\d+)\)/g;
    const pairs: Array<{ routePath: string; varName: string }> = [];
    for (const mm of text.matchAll(pairRe)) pairs.push({ routePath: mm[1], varName: mm[2] });
    expect(pairs.length).toBe(177);
    const hash = crypto.createHash("md5").update(JSON.stringify(pairs)).digest("hex");
    expect(m![1]).toBe(hash);
  });
});
