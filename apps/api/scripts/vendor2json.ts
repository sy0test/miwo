import fs from "fs";
import path from "path";

// 注意：进包用的是 src/lib/vendor.json（fixDB 顶部 import 它，esbuild 会内联进 data/serve/app.js），
// 不是 data/vendor/vendor.json —— 写到后者等于没生效（老版本这里写错过，故留注释）。
const vendorDir = path.join("data", "vendor");
const outFile = path.join("src", "lib", "vendor.json");
const files = fs.readdirSync(vendorDir).filter((f) => f.endsWith(".ts"));
const result: Record<string, string> = {};
for (const file of files) {
  result[file] = fs.readFileSync(path.join(vendorDir, file), "utf-8");
}
fs.writeFileSync(outFile, JSON.stringify(result, null, 2), "utf-8");
console.log(`Done, saved ${outFile}（${files.length} 个 vendor）`);
