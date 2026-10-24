#!/usr/bin/env node
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const API_ROOT = path.resolve(__dirname, "..");
const TEMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "miwo-phase2-"));
const VITEST = path.join(API_ROOT, "node_modules", "vitest", "vitest.mjs");

function main() {
  if (!fs.existsSync(VITEST)) throw new Error(`Vitest entry point not found: ${VITEST}`);
  const result = spawnSync(process.execPath, [
    VITEST,
    "run",
    "tests/phase2-acceptance.test.ts",
    "--maxWorkers=1",
    "--minWorkers=1",
  ], {
    cwd: API_ROOT,
    env: { ...process.env, MIWO_DATA_DIR: TEMP_ROOT },
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exitCode = result.status || 1;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
} finally {
  try {
    fs.rmSync(TEMP_ROOT, { recursive: true, force: true });
    if (fs.existsSync(TEMP_ROOT)) throw new Error(`Temporary data directory was not removed: ${TEMP_ROOT}`);
  } catch (error) {
    process.stderr.write(`Phase 2 verifier cleanup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
