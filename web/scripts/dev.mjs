// Runs the API server (tsx watch) and the Vite dev server side by side.
// Ctrl+C stops both. Kept dependency-free on purpose.
import { spawn } from "node:child_process";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const procs = [
  spawn(npm, ["run", "dev", "-w", "server"], { stdio: "inherit" }),
  spawn(npm, ["run", "dev", "-w", "client"], { stdio: "inherit" }),
];

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const p of procs) p.kill("SIGTERM");
  process.exitCode = code;
}
for (const p of procs) p.on("exit", (code) => stop(code ?? 0));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
