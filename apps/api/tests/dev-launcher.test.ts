import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const packageJson = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8"));

describe("API development entrypoint", () => {
  it("starts the API and queue worker together while preserving API-only mode", () => {
    expect(packageJson.scripts.dev).toBe("node --env-file-if-exists=.env scripts/dev.cjs");
    expect(packageJson.scripts["dev:api"]).toContain("src/app.ts");
    expect(packageJson.scripts["dev:worker"]).toContain("src/worker.ts");
  });
});
