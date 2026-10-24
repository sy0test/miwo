#!/usr/bin/env node
/**
 * Seed runtime skills and model prompts into MIWO_DATA_DIR.
 * The implementation lives here so the CLI and --self-test share one source of truth.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REQUIRED_DIRS = ["skills", "modelPrompt"];
const DEFAULT_MIN = { skills: 31, modelPrompt: 4 };

function listFiles(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) walk(target);
      else if (entry.isFile()) files.push(path.relative(dir, target).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return files;
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function planSeed({ src, out, min = DEFAULT_MIN }) {
  const source = path.resolve(src);
  const target = path.resolve(out);
  const problems = [];
  const steps = [];

  if (containsPath(source, target) || containsPath(target, source)) {
    return {
      ok: false,
      steps,
      problems: [`源与目标目录不能相同或互相包含：${source} / ${target}`],
    };
  }

  for (const name of REQUIRED_DIRS) {
    const from = path.join(source, name);
    const to = path.join(target, name);
    const sourceFiles = listFiles(from);
    if (sourceFiles === null) {
      problems.push(`源目录不存在：${from}`);
      continue;
    }

    const minimum = min[name] ?? 1;
    if (sourceFiles.length === 0 || sourceFiles.length < minimum) {
      problems.push(`源目录文件数不足（假绿风险）：${from} 只有 ${sourceFiles.length} 个，下限 ${minimum}`);
      continue;
    }

    const targetFiles = listFiles(to);
    if (targetFiles !== null && targetFiles.length > 0) {
      steps.push({ name, action: "skip", from, to, sourceCount: sourceFiles.length, targetCount: targetFiles.length });
    } else {
      steps.push({ name, action: "copy", from, to, sourceCount: sourceFiles.length, targetCount: targetFiles?.length ?? 0 });
    }
  }

  return { ok: problems.length === 0, steps, problems };
}

function applySeed(steps) {
  for (const step of steps) {
    if (step.action !== "copy") continue;
    fs.mkdirSync(path.dirname(step.to), { recursive: true });
    fs.cpSync(step.from, step.to, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const options = { min: { ...DEFAULT_MIN }, dryRun: false, selfTest: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--self-test") {
      options.selfTest = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--src" || arg === "--out" || arg === "--min") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) throw new Error(`${arg} 缺少参数值`);
      i += 1;
      if (arg === "--src") options.src = value;
      else if (arg === "--out") options.out = value;
      else {
        const match = /^([^=]+)=(\d+)$/.exec(value);
        if (!match || !REQUIRED_DIRS.includes(match[1])) {
          throw new Error(`--min 必须是 --min skills=31 或 --min modelPrompt=4`);
        }
        options.min[match[1]] = Number(match[2]);
      }
    } else {
      throw new Error(`未知参数 ${arg}（接受 --src/--out/--dry-run/--min/--self-test）`);
    }
  }
  return options;
}

function selfTest() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-seed-selftest-"));
  const src = path.join(base, "source");
  const out = path.join(base, "volume");
  const min = { skills: 2, modelPrompt: 1 };
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const write = (root, name, file) => {
    const target = path.join(root, name, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "x", "utf8");
  };

  try {
    write(src, "skills", "one.md");
    write(src, "skills", "nested/two.md");
    write(src, "modelPrompt", "prompt.md");

    const first = planSeed({ src, out, min });
    check(first.ok, "完整源 + 缺失目标应通过");
    check(first.steps.filter((step) => step.action === "copy").length === 2, "两个目录都应 copy");
    applySeed(first.steps);
    check(fs.existsSync(path.join(out, "skills", "nested", "two.md")), "复制后应有嵌套 skill 文件");

    const second = planSeed({ src, out, min });
    check(second.ok && second.steps.every((step) => step.action === "skip"), "重复运行应全部 skip");

    fs.rmSync(path.join(out, "skills"), { recursive: true, force: true });
    fs.mkdirSync(path.join(out, "skills"), { recursive: true });
    const emptyTarget = planSeed({ src, out, min });
    check(emptyTarget.steps.find((step) => step.name === "skills")?.action === "copy", "已存在的空目标必须 copy");

    const missingSource = planSeed({ src: path.join(base, "missing"), out: path.join(base, "missing-out"), min });
    check(!missingSource.ok && missingSource.problems.some((problem) => problem.includes("skills")), "缺少源目录必须失败");

    const emptySource = path.join(base, "empty-source");
    fs.mkdirSync(path.join(emptySource, "skills"), { recursive: true });
    write(emptySource, "modelPrompt", "prompt.md");
    const empty = planSeed({ src: emptySource, out: path.join(base, "empty-out"), min });
    check(!empty.ok && empty.problems.some((problem) => problem.includes("skills")), "源和目标都空的情况必须失败");

    const belowMinimum = planSeed({ src, out: path.join(base, "short-out"), min: { skills: 31, modelPrompt: 1 } });
    check(!belowMinimum.ok, "源文件数低于下限必须失败");

    const overlap = planSeed({ src, out: path.join(src, "volume"), min });
    check(!overlap.ok, "源与目标互相包含必须失败");
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error("seed-data-dir --self-test 失败：");
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log("seed-data-dir --self-test 通过（复制/幂等/空目标/缺源/空源/下限/路径重叠）");
}

function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }
  if (options.selfTest) return selfTest();

  const src = path.resolve(options.src || path.join(__dirname, "..", "data"));
  const outArg = options.out || process.env.MIWO_DATA_DIR;
  if (!outArg) {
    console.error("必须给 --out，或设置 MIWO_DATA_DIR");
    process.exitCode = 1;
    return;
  }
  const out = path.resolve(outArg);
  let result;
  try {
    result = planSeed({ src, out, min: options.min });
  } catch (error) {
    console.error(`seed-data-dir 失败：${error.message}`);
    process.exitCode = 1;
    return;
  }

  for (const step of result.steps) {
    console.log(`  ${step.action === "copy" ? "COPY" : "skip"}  ${step.name}: 源 ${step.sourceCount} 个 → ${step.to}`);
  }
  if (!result.ok) {
    console.error("seed-data-dir 失败：");
    for (const problem of result.problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  if (options.dryRun) {
    console.log(`seed-data-dir dry-run 通过（${src} → ${out}；未写入任何文件）`);
    return;
  }

  try {
    applySeed(result.steps);
  } catch (error) {
    console.error(`seed-data-dir 复制失败：${error.message}`);
    process.exitCode = 1;
    return;
  }
  const copied = result.steps.filter((step) => step.action === "copy").length;
  const skipped = result.steps.filter((step) => step.action === "skip").length;
  console.log(`seed-data-dir 通过（${src} → ${out}；copy ${copied} / skip ${skipped}）`);
}

if (require.main === module) main();

module.exports = { DEFAULT_MIN, REQUIRED_DIRS, listFiles, planSeed };
