/**
 * 构建期生成 src/router.ts（spec §4.3）。
 * 原实现在 src/core.ts，由 app.ts 在 NODE_ENV==dev 时运行期调用；
 * 运行期生成会让"生产跑的是提交在仓库里的 router.ts"变成隐式契约，改为显式构建步骤。
 * 用法：node scripts/generate-router.ts   （需 NODE_OPTIONS=--import=tsx）
 */
import fg from "fast-glob";
import path from "path";
import { readFile, writeFile } from "fs/promises";
import crypto from "crypto";

/**
 * 路径基准一律取脚本自身位置（`apps/api`），**不依赖 cwd**。
 * 旧实现用裸相对路径（glob 的 `src/routes` 前缀与 `readFile("src/router.ts")`）按 cwd 解析：
 * 一旦不是从 apps/api 启动，glob 会静默匹配 0 个文件、router.ts 读写会 ENOENT，报错不指向真因。
 */
const API_ROOT = path.resolve(__dirname, "..");
const p = (...segs: string[]): string => path.resolve(API_ROOT, ...segs);

function fileNameToRoutePath(fileName: string): string {
  let routePath = fileName.replace(/\.(ts)$/, "");
  routePath = routePath.split(path.sep).join("/");
  routePath = routePath.replace(/\[([^\]]+)\]/g, (_, p1: string) => (p1.startsWith("...") ? "*" : `:${p1}`));
  if (routePath === "index") return "/";
  routePath = routePath.replace(/\/index$/, "");
  return "/" + routePath.replace(/\/+/g, "/").replace(/\/$/, "");
}

type RouteModulePair = { routePath: string; varName: string; entry: string };

async function main(): Promise<void> {
  const srcDir = p("src");
  const routesDir = p("src", "routes");
  const routerFile = p("src", "router.ts");
  const entries = (await fg(["**/*.ts"], { cwd: routesDir })).sort((a, b) => a.localeCompare(b));

  /**
   * 空清单护栏（Task 10 Step 0a）：
   * 没有这道闸，`entries` 为空时算出的 hash = md5("[]") 与现有头不同 →
   * **覆盖写并打印"已生成（0 条路由）"** → 静默清空 router.ts 里全部 176 条挂载，
   * 而退出码仍是 0（CI/构建全绿）。触发条件（src/routes 改名、glob 失效、目录被清空）概率低但后果严重。
   */
  if (entries.length === 0) throw new Error(`未在 ${routesDir} 下匹配到任何 .ts，拒绝覆盖 ${routerFile}`);

  const importLines: string[] = [];
  const routeModulePairs: RouteModulePair[] = [];

  entries.forEach((entry: string, i: number) => {
    const varName = `route${i + 1}`;
    let importPath = path.relative(srcDir, path.join(routesDir, entry)).replace(/\\/g, "/");
    if (!importPath.startsWith(".")) importPath = "./" + importPath;
    importPath = importPath.replace(/\.ts$/, "");
    importLines.push(`import ${varName} from "${importPath}";`);
    const routeKey = entry.replace(/\\/g, "/");
    routeModulePairs.push({ routePath: fileNameToRoutePath(routeKey), varName, entry });
  });

  const routerData = JSON.stringify(routeModulePairs.map(({ routePath, varName }) => ({ routePath, varName })));
  const hash = crypto.createHash("md5").update(routerData).digest("hex");

  let content = `// @routes-hash ${hash}\nimport { Express } from "express";\n\n`;
  content += `${importLines.join("\n")}\n\n`;
  content += `export default async (app: Express) => {\n`;
  for (const { routePath, varName } of routeModulePairs) content += `  app.use("/api${routePath}", ${varName});\n`;
  content += `}\n`;

  let needWrite = true;
  try {
    const current = await readFile(routerFile, "utf8");
    const match = current.match(/^\/\/\s*@routes-hash\s*([a-z0-9]+)\n/);
    if (match && match[1] === hash) needWrite = false;
  } catch {
    needWrite = true;
  }
  if (needWrite) {
    await writeFile(routerFile, content, "utf8");
    console.log(`router.ts 已生成（${routeModulePairs.length} 条路由，hash ${hash}）`);
  } else {
    console.log(`router.ts 已是最新（${routeModulePairs.length} 条路由，hash ${hash}）`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
