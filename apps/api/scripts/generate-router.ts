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
  const entries = (await fg(["src/routes/**/*.ts"])).sort((a, b) => a.localeCompare(b));

  const importLines: string[] = [];
  const routeModulePairs: RouteModulePair[] = [];

  entries.forEach((entry: string, i: number) => {
    const varName = `route${i + 1}`;
    let importPath = path.relative("src", entry).replace(/\\/g, "/");
    if (!importPath.startsWith(".")) importPath = "./" + importPath;
    importPath = importPath.replace(/\.ts$/, "");
    importLines.push(`import ${varName} from "${importPath}";`);
    const routeKey = path.relative("src/routes", entry).replace(/\\/g, "/");
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
    const current = await readFile("src/router.ts", "utf8");
    const match = current.match(/^\/\/\s*@routes-hash\s*([a-z0-9]+)\n/);
    if (match && match[1] === hash) needWrite = false;
  } catch {
    needWrite = true;
  }
  if (needWrite) {
    await writeFile("src/router.ts", content, "utf8");
    console.log(`router.ts 已生成（${routeModulePairs.length} 条路由，hash ${hash}）`);
  } else {
    console.log(`router.ts 已是最新（${routeModulePairs.length} 条路由，hash ${hash}）`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
