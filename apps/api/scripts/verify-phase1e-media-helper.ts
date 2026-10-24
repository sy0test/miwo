import fs from "node:fs/promises";
import path from "node:path";
import oss from "@/utils/oss";
import { signMediaQuery } from "@/utils/mediaSign";

async function main(): Promise<void> {
  const [dataDirArg, relArg] = process.argv.slice(2);
  if (!dataDirArg || !relArg) throw new Error("usage: <data-dir> <relative-media-path>");
  const rel = relArg.replace(/\\/g, "/").replace(/^\/+/, "");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jXioAAAAASUVORK5CYII=",
    "base64",
  );
  await oss.writeFile(rel, png);
  const assetsPath = path.join(path.resolve(dataDirArg), "assets", ...rel.split("/"));
  await fs.mkdir(path.dirname(assetsPath), { recursive: true });
  await fs.writeFile(assetsPath, png);

  if (path.resolve(process.env.MIWO_DATA_DIR ?? "") !== path.resolve(dataDirArg)) {
    throw new Error("MIWO_DATA_DIR must point at the requested data directory before startup");
  }
  const url = await oss.getFileUrl(rel);
  const assetsUrl = await oss.getFileUrl(rel, "assets");
  const baseUrl = process.env.MIWO_PUBLIC_BASE_URL || `http://${process.env.MIWO_HOST || "127.0.0.1"}:${process.env.MIWO_PORT || "10588"}`;
  const expiredUrl = `${baseUrl.replace(/\/$/, "")}/oss/${rel}?${signMediaQuery(rel, -1)}`;
  process.stdout.write(JSON.stringify({ url, assetsUrl, expiredUrl, rel }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
