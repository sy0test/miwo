#!/usr/bin/env node
/**
 * 断言受版本控制的文本文件工作区为 LF、且无 BOM。
 * 用 git 列出受控文件，跳过二进制（.png/.jpg/.mp4/.onnx/.sqlite/.ico 等）。
 * 用法：node tools/check-eol.cjs
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const BINARY = /\.(png|jpe?g|gif|webp|mp4|mov|onnx|sqlite|ico|woff2?|ttf|eot|pdf|zip)$/i;

const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean)
  .filter((f) => !BINARY.test(f));

const crlf = [];
const bom = [];
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const buf = fs.readFileSync(abs);
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom.push(rel);
  if (buf.includes(0x0d)) crlf.push(rel);
}

if (crlf.length) {
  console.error(`check-eol 失败：${crlf.length} 个受控文件工作区含 CR 字节（应全为 LF）：`);
  for (const f of crlf.slice(0, 20)) console.error("  - " + f);
  process.exit(1);
}
if (bom.length) {
  console.error(`check-eol 失败：${bom.length} 个受控文件带 BOM：`);
  for (const f of bom) console.error("  - " + f);
  process.exit(1);
}
console.log(`check-eol 通过（${files.length} 个受控文本文件：全 LF、无 BOM）`);
