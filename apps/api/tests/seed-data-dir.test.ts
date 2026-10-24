import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const API_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(API_ROOT, "scripts", "seed-data-dir.cjs");
const TEMP_DIRS: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-seed-test-"));
  TEMP_DIRS.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of TEMP_DIRS.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function writeAsset(root: string, name: string, file: string, content = "asset") {
  const target = path.join(root, name, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function runSeeder(...args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });
}

function minimalArgs(src: string, out: string, ...extra: string[]) {
  return ["--src", src, "--out", out, "--min", "skills=1", "--min", "modelPrompt=1", ...extra];
}

describe("runtime asset seeder", () => {
  it("copies required assets once and skips non-empty destinations on repeat", () => {
    const root = makeTempDir();
    const src = path.join(root, "source");
    const out = path.join(root, "volume");
    writeAsset(src, "skills", "nested/skill.md", "skill source");
    writeAsset(src, "modelPrompt", "video/prompt.md", "prompt source");

    const first = runSeeder(...minimalArgs(src, out));
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain("COPY  skills");
    expect(first.stdout).toContain("COPY  modelPrompt");
    expect(fs.readFileSync(path.join(out, "skills", "nested", "skill.md"), "utf8")).toBe("skill source");

    const second = runSeeder(...minimalArgs(src, out));
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("skip  skills");
    expect(second.stdout).toContain("skip  modelPrompt");
  });

  it("merges newly added source files into a non-empty destination without overwriting existing ones", () => {
    const root = makeTempDir();
    const src = path.join(root, "source");
    const out = path.join(root, "volume");
    writeAsset(src, "skills", "old/skill.md", "old source");
    writeAsset(src, "modelPrompt", "prompt.md");

    const first = runSeeder(...minimalArgs(src, out));
    expect(first.status, first.stderr).toBe(0);
    // 模拟运行期用户改过的旧文件
    fs.writeFileSync(path.join(out, "skills", "old", "skill.md"), "user edited", "utf8");

    writeAsset(src, "skills", "new-skill/SKILL.md", "new source");
    const second = runSeeder(...minimalArgs(src, out));
    expect(second.status, second.stderr).toBe(0);
    expect(second.stdout).toContain("MERGE  skills");
    expect(fs.readFileSync(path.join(out, "skills", "new-skill", "SKILL.md"), "utf8")).toBe("new source");
    expect(fs.readFileSync(path.join(out, "skills", "old", "skill.md"), "utf8")).toBe("user edited");
  });

  it("copies into an existing but empty destination directory", () => {
    const root = makeTempDir();
    const src = path.join(root, "source");
    const out = path.join(root, "volume");
    writeAsset(src, "skills", "skill.md");
    writeAsset(src, "modelPrompt", "prompt.md");
    fs.mkdirSync(path.join(out, "skills"), { recursive: true });

    const result = runSeeder(...minimalArgs(src, out));
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(out, "skills", "skill.md"))).toBe(true);
  });

  it("dry-run validates the copy plan without creating destination files", () => {
    const root = makeTempDir();
    const src = path.join(root, "source");
    const out = path.join(root, "volume");
    writeAsset(src, "skills", "skill.md");
    writeAsset(src, "modelPrompt", "prompt.md");

    const result = runSeeder(...minimalArgs(src, out, "--dry-run"));
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("dry-run 通过");
    expect(fs.existsSync(out)).toBe(false);
  });

  it("fails when a source directory is missing, empty, or below its minimum", () => {
    const root = makeTempDir();
    const out = path.join(root, "volume");
    const missing = runSeeder(...minimalArgs(path.join(root, "missing"), out));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("skills");

    const emptySrc = path.join(root, "empty-source");
    fs.mkdirSync(path.join(emptySrc, "skills"), { recursive: true });
    writeAsset(emptySrc, "modelPrompt", "prompt.md");
    const empty = runSeeder("--src", emptySrc, "--out", out, "--min", "skills=1", "--min", "modelPrompt=1");
    expect(empty.status).toBe(1);
    expect(empty.stderr).toContain("skills");

    const shortSrc = path.join(root, "short-source");
    writeAsset(shortSrc, "skills", "only.md");
    writeAsset(shortSrc, "modelPrompt", "prompt.md");
    const short = runSeeder("--src", shortSrc, "--out", out, "--min", "skills=2", "--min", "modelPrompt=1");
    expect(short.status).toBe(1);
    expect(short.stderr).toContain("下限 2");
  });

  it("runs its standalone self-test", () => {
    const result = runSeeder("--self-test");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("seed-data-dir --self-test 通过");
  });
});
