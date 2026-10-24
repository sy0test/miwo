#!/usr/bin/env node
/**
 * 把 apps/web 的构建产物接进 `MIWO_DATA_DIR/web`（**唯一被服务的 SPA 真相**）。
 *
 * 用法：
 *   node apps/api/scripts/sync-web-build.cjs --src apps/web/dist --out <MIWO_DATA_DIR>/web
 *   node apps/api/scripts/sync-web-build.cjs --self-test      # 用临时目录自证判别力（CI 用）
 *
 * 设计约束（Phase 0/1a 的教训）：
 *  1. **不做任何体积阈值断言**。旧的 verify-deploy.cjs 把"前端产物 > 20 MB"写死成断言，
 *     spec §12.1 明确判为"丢弃重写"；Phase 3 首屏要降到 1–2 MB，阈值只会变成新的假红源。
 *  2. **不猜构建状态**：`dist/index.html` 不存在 → 直接失败并提示先跑 build-only。
 *  3. **只允许构建产物**：目标目录里出现白名单外的扩展名就红（防止有人把 db2.sqlite
 *     或 vendor/*.ts 放进 data/web，那个目录是**匿名可读**的）。
 *  4. 幂等：同一份 dist 重复同步，结果一致（`MIWO-WEB.json` 的 syncedAt 会变，内容哈希不变）。
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** Build outputs allowed in data/web; the root manifest is handled separately. */
const ALLOWED_EXT = new Set([".js", ".css", ".html", ".ico", ".png", ".svg", ".woff2"]);
/** 明确拒绝的"绝对不是构建产物"的文件名。 */
const FORBIDDEN_NAME = /^(db2\.sqlite|.*\.sqlite|.*\.ts|.*\.env|.*\.pem|.*\.key)$/i;
const MANIFEST = "MIWO-WEB.json";

function die(msg) {
  console.error("sync-web-build 失败：" + msg);
  process.exit(1);
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else out.push({ rel: path.relative(base, p).split(path.sep).join("/"), size: fs.statSync(p).size });
  }
  return out;
}

function resolveWithExistingSymlinks(target) {
  const resolved = path.resolve(target);
  let existing = resolved;
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) return resolved;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...missing);
}

function pathsOverlap(a, b) {
  const relative = path.relative(a, b);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateSource(src) {
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) die(`源目录不存在：${src}`);
  const html = path.join(src, "index.html");
  if (!fs.existsSync(html)) {
    die(`源目录里没有 index.html（${src}）。先跑：pnpm.cmd --filter @miwo/web run build-only`);
  }
  const htmlSize = fs.statSync(html).size;
  if (htmlSize < 1024) die(`index.html 只有 ${htmlSize} 字节，看起来不是构建产物（viteSingleFile 下单文件应远大于此）`);
  const files = walk(src);
  for (const f of files) {
    if (f.rel === MANIFEST) continue;
    const ext = path.extname(f.rel).toLowerCase();
    if (!ALLOWED_EXT.has(ext)) die(`源目录里有不在白名单内的文件：${f.rel}（扩展名 ${ext}）`);
  }
  return { html, files };
}

function sync(src, out) {
  const { files } = validateSource(src);
  const resolvedSrc = resolveWithExistingSymlinks(src);
  const resolvedOut = resolveWithExistingSymlinks(out);
  if (pathsOverlap(resolvedSrc, resolvedOut) || pathsOverlap(resolvedOut, resolvedSrc)) {
    die(`源目录与目标目录不能重叠：${resolvedSrc} / ${resolvedOut}`);
  }
  // Validate an existing destination before creating or writing anything.
  if (fs.existsSync(out)) {
    if (!fs.statSync(out).isDirectory()) die(`目标路径不是目录：${out}`);
    for (const f of walk(out)) {
      if (f.rel === MANIFEST) continue;
      const ext = path.extname(f.rel).toLowerCase();
      if (!ALLOWED_EXT.has(ext)) die(`目标目录里有非构建产物：${f.rel}`);
      if (FORBIDDEN_NAME.test(path.basename(f.rel))) die(`目标目录里有禁止文件：${f.rel}`);
    }
  }
  fs.mkdirSync(out, { recursive: true });
  let bytes = 0;
  for (const f of files) {
    const from = path.join(src, f.rel);
    const to = path.join(out, f.rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
    bytes += f.size;
  }
  const indexSha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(src, "index.html"))).digest("hex");
  const manifest = {
    syncedAt: new Date().toISOString(),
    src: path.resolve(src).split(path.sep).join("/"),
    fileCount: files.length,
    bytes,
    indexSha256,
    files: files.map((f) => f.rel).sort(),
  };
  fs.writeFileSync(path.join(out, MANIFEST), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

// ---------- --self-test：在工作树内的临时目录里自证判别力 ----------
function selfTest() {
  const testRoot = path.join(__dirname, "..", ".test-tmp");
  fs.mkdirSync(testRoot, { recursive: true });
  const base = fs.mkdtempSync(path.join(testRoot, "sync-web-selftest-"));
  const src = path.join(base, "dist");
  const out = path.join(base, "web");
  const good = path.join(base, "not-dist");
  fs.mkdirSync(src, { recursive: true });
  // 故意造一个"单文件 + 一个 worker chunk"的 dist（与实测产物同形）
  fs.writeFileSync(path.join(src, "index.html"), "<html>" + "x".repeat(4096) + "</html>", "utf8");
  fs.writeFileSync(path.join(src, "ts.worker-abc.js"), "console.log(1)", "utf8");
  for (const name of ["app.css", "favicon.ico", "icon.png", "logo.svg", "font.woff2"]) {
    fs.writeFileSync(path.join(src, name), "asset", "utf8");
  }
  fs.writeFileSync(path.join(src, MANIFEST), "{}\n", "utf8");
  // 反例 1：没有 index.html
  fs.mkdirSync(good, { recursive: true });
  fs.writeFileSync(path.join(good, "index.html.bak"), "x", "utf8");

  const failures = [];
  const ok = (cond, msg) => {
    if (!cond) failures.push(msg);
  };
  const snapshot = (dir) => JSON.stringify(walk(dir).map((f) => [f.rel, fs.readFileSync(path.join(dir, f.rel)).toString("base64")]));
  const cli = (source, output) => spawnSync(process.execPath, [__filename, "--src", source, "--out", output], { encoding: "utf8" });
  const checkOverlap = (label, source, output, absentOutput = false) => {
    const sourceBefore = snapshot(source);
    const outputBefore = absentOutput ? null : snapshot(output);
    const result = cli(source, output);
    ok(result.status === 1, `${label}: overlap must exit 1, got ${result.status}`);
    ok(snapshot(source) === sourceBefore, `${label}: source must remain byte-identical`);
    if (absentOutput) ok(!fs.existsSync(output), `${label}: absent destination must remain absent`);
    else ok(snapshot(output) === outputBefore, `${label}: destination must remain byte-identical`);
  };
  const m = sync(src, out);
  ok(fs.existsSync(path.join(out, "index.html")), "应复制 index.html");
  ok(fs.existsSync(path.join(out, "ts.worker-abc.js")), "应复制 worker chunk");
  ok(fs.existsSync(path.join(out, MANIFEST)), "应写清单");
  ok(m.fileCount === 8, `fileCount 应为 8（允许的构建扩展 + 根清单），实际 ${m.fileCount}`);
  for (const name of ["app.css", "favicon.ico", "icon.png", "logo.svg", "font.woff2", MANIFEST]) {
    ok(fs.existsSync(path.join(out, name)), `应接受允许的根文件 ${name}`);
  }
  const again = sync(src, out);
  ok(again.indexSha256 === m.indexSha256, "幂等：内容哈希应一致");
  // 反例 2：目标目录已混入禁止文件 → 必须失败（用子进程断言退出码，因为 sync 会 process.exit）
  const { spawnSync } = require("child_process");
  const run = () => spawnSync(process.execPath, [__filename, "--src", src, "--out", out], { encoding: "utf8" });
  fs.writeFileSync(path.join(out, "db2.sqlite"), "not a build artifact", "utf8");
  const r1 = run();
  ok(r1.status === 1 && /非构建产物|禁止文件/.test(r1.stderr), `目标目录含 db2.sqlite 时必须 EXIT 1，实际 ${r1.status} / ${r1.stderr.slice(0, 120)}`);
  fs.rmSync(path.join(out, "db2.sqlite"));
  // 反例 3：源目录不是构建产物 → 必须失败
  const r2 = spawnSync(process.execPath, [__filename, "--src", good, "--out", out], { encoding: "utf8" });
  ok(r2.status === 1 && /index\.html/.test(r2.stderr), `源目录缺 index.html 时必须 EXIT 1，实际 ${r2.status}`);
  // 反例 4：源目录里混入 .ts → 必须失败
  fs.writeFileSync(path.join(src, "leak.ts"), "export default 1", "utf8");
  const r3 = run();
  ok(r3.status === 1 && /白名单/.test(r3.stderr), `源目录含 .ts 时必须 EXIT 1，实际 ${r3.status} / ${r3.stderr.slice(0, 120)}`);
  fs.rmSync(path.join(src, "leak.ts"));
  const r4 = run();
  ok(r4.status === 0, `还原后必须 EXIT 0，实际 ${r4.status} / ${r4.stderr.slice(0, 120)}`);

  fs.writeFileSync(path.join(src, "image.jpg"), "unapproved", "utf8");
  const r5 = cli(src, out);
  ok(r5.status === 1 && /白名单/.test(r5.stderr), `源目录含 .jpg 时必须 EXIT 1，实际 ${r5.status}`);
  fs.rmSync(path.join(src, "image.jpg"));

  fs.mkdirSync(path.join(src, "nested"), { recursive: true });
  fs.writeFileSync(path.join(src, "nested", MANIFEST), "{}", "utf8");
  const r6 = cli(src, out);
  ok(r6.status === 1, `源目录的嵌套清单必须 EXIT 1，实际 ${r6.status}`);
  fs.rmSync(path.join(src, "nested"), { recursive: true, force: true });

  fs.mkdirSync(path.join(out, "nested"), { recursive: true });
  fs.writeFileSync(path.join(out, "nested", MANIFEST), "{}", "utf8");
  const r7 = cli(src, out);
  ok(r7.status === 1, `目标目录的嵌套清单必须 EXIT 1，实际 ${r7.status}`);
  fs.rmSync(path.join(out, "nested"), { recursive: true, force: true });

  fs.writeFileSync(path.join(out, "unapproved.txt"), "not a build asset", "utf8");
  const r8 = cli(src, out);
  ok(r8.status === 1, `目标目录含 .txt 时必须 EXIT 1，实际 ${r8.status}`);
  fs.rmSync(path.join(out, "unapproved.txt"));

  checkOverlap("same path", src, src);
  const nestedOut = path.join(src, "new-output");
  checkOverlap("output nested under source", src, nestedOut, true);
  const outer = path.join(base, "outer");
  const nestedSrc = path.join(outer, "dist");
  fs.mkdirSync(outer, { recursive: true });
  fs.cpSync(src, nestedSrc, { recursive: true });
  checkOverlap("source nested under output", nestedSrc, outer);

  const alias = path.join(base, "source-junction");
  fs.symlinkSync(src, alias, "junction");
  checkOverlap("junction alias", src, alias);

  fs.rmSync(base, { recursive: true, force: true });
  if (failures.length) {
    console.error("sync-web-build --self-test 失败：");
    for (const f of failures) console.error("  - " + f);
    process.exit(1);
  }
  console.log("sync-web-build --self-test 通过（复制 + 清单 + 幂等 + allowlist + overlap）");
}

function main() {
  const argv = process.argv.slice(2);
  const val = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (argv.includes("--self-test")) return selfTest();
  const known = new Set(["--src", "--out"]);
  // ⚠ 每个已知旗标都**带一个取值**，所以必须跳着走：写成"逐个 argv 都要在 known 里"会把
  //   `--src <路径>` 的**路径**判成未知参数（计划里的代码块就是这个形态，实测 self-test 全红）。
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i])) die(`未知参数 ${argv[i]}（只接受 --src/--out/--self-test）`);
  }
  if (argv.length % 2 !== 0) die(`旗标 ${argv[argv.length - 1]} 缺少取值`);
  const src = val("--src");
  const out = val("--out");
  if (!src || !out) die("必须同时给 --src 与 --out");
  const m = sync(path.resolve(src), path.resolve(out));
  console.log(`sync-web-build 通过：复制 ${m.fileCount} 个文件 / ${Math.round(m.bytes / 1024)} KB → ${path.resolve(out)}`);
  console.log(`  index.html sha256 = ${m.indexSha256}`);
}

main();
