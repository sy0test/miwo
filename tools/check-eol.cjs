#!/usr/bin/env node
/**
 * 断言受版本控制的文本文件工作区为 LF、且无 BOM。
 * 用 git 列出受控文件；二进制靠**内容嗅探**识别（前 8 KB 含 NUL 字节），扩展名白名单只作快速通道。
 * 用法：node tools/check-eol.cjs
 */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
// 快速通道：这些扩展名必为二进制，直接跳过读盘。
// ⚠ 它**不是**判定依据 —— 旧实现只认扩展名，日后新增 mp3/webm/psd/xlsx 等会被当文本扫 CR 而假失败；
//    真正的判定是下面的 NUL 嗅探，扩展名只用来省一次 readFileSync。
const BINARY_EXT = /\.(png|jpe?g|gif|webp|mp4|mov|onnx|sqlite|ico|woff2?|ttf|eot|pdf|zip)$/i;
// 嗅探窗口：文本文件里不该出现 NUL 字节。
const SNIFF_BYTES = 8192;

const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const crlf = [];
const bom = [];
const missing = [];
let textCount = 0;
for (const rel of files) {
  const abs = path.join(ROOT, rel);
  // ⚠ "索引有、工作区缺" 不能静默跳过：批量误删受控文件时这里必须响亮红灯。
  if (!fs.existsSync(abs)) {
    missing.push(rel);
    continue;
  }
  if (BINARY_EXT.test(rel)) continue;
  const buf = fs.readFileSync(abs);
  // 内容嗅探：前 8 KB 含 NUL 字节 = 二进制，跳过（不参与 CR/BOM 判定，也不计入文本文件数）。
  if (buf.subarray(0, SNIFF_BYTES).includes(0x00)) continue;
  textCount += 1;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) bom.push(rel);
  if (buf.includes(0x0d)) crlf.push(rel);
}

if (missing.length) {
  console.error(`check-eol 失败：${missing.length} 个受控文件在索引中但工作区缺失（疑似被误删）：`);
  for (const f of missing) console.error("  - " + f);
  process.exit(1);
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
console.log(`check-eol 通过（${textCount} 个受控文本文件：全 LF、无 BOM）`);
