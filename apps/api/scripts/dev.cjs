const { spawn } = require("node:child_process");
const path = require("node:path");

const nodemon = path.resolve(__dirname, "../node_modules/nodemon/bin/nodemon.js");
const processes = [
  {
    name: "api",
    args: ["--exec", "node --env-file-if-exists=.env --import=tsx --inspect=9229", "src/app.ts"],
  },
  {
    name: "worker",
    args: ["--exec", "node --env-file-if-exists=.env --import=tsx --inspect=9230", "src/worker.ts"],
  },
];

let stopping = false;
let exitCode = 0;
const children = [];

function stop(signal) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.exitCode === null && !child.killed) child.kill(signal);
  }
}

for (const processSpec of processes) {
  const child = spawn(process.execPath, [nodemon, ...processSpec.args], {
    cwd: path.resolve(__dirname, ".."),
    stdio: "inherit",
  });
  children.push(child);
  child.on("error", (error) => {
    console.error(`[dev] ${processSpec.name} failed to start:`, error);
    exitCode = 1;
    stop("SIGTERM");
  });
  child.on("exit", (code) => {
    if (!stopping) {
      exitCode = code ?? 1;
      stop("SIGTERM");
    }
  });
}

process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

process.on("exit", () => {
  process.exitCode = exitCode;
});
