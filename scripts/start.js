import dotenv from "dotenv";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DASHBOARD_DIR = path.join(ROOT, "dashboard");
const DASHBOARD_ENTRY = path.join(DASHBOARD_DIR, "build", "index.js");

dotenv.config({ path: path.join(ROOT, ".env") });

function setting(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

const DASHBOARD_PORT = setting("DASHBOARD_PORT") || "3001";
const DASHBOARD_HOST = setting("DASHBOARD_HOST") || "127.0.0.1";
const DASHBOARD_ENABLED = setting("DASHBOARD_ENABLED") !== "false";

const isWindows = process.platform === "win32";
const binary = (name) => path.join(ROOT, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);

const children = [];
let shuttingDown = false;

function log(message) {
  console.log(`[boxy] ${message}`);
}

function buildDashboard() {
  log("dashboard not built yet, building it...");
  const result = spawnSync("pnpm", ["--filter", "dashboard", "build"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: isWindows
  });
  return result.status === 0 && existsSync(DASHBOARD_ENTRY);
}

function start(name, { command, args, critical, ...options }) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push(child);

  child.on("error", (err) => {
    console.error(`[boxy] could not start ${name}: ${err.message}`);
    if (critical) shutdown(1);
  });

  child.on("exit", (code, signal) => {
    if (shuttingDown) return;
    if (critical) {
      log(`${name} exited (${signal ?? code}), shutting down`);
      shutdown(code ?? 1);
    } else {
      console.error(`[boxy] ${name} exited (${signal ?? code}), continuing without it`);
    }
  });

  return child;
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  process.exitCode = code;
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(0));
}

if (!DASHBOARD_ENABLED) {
  log("dashboard disabled (DASHBOARD_ENABLED=false)");
} else if (existsSync(DASHBOARD_ENTRY) || buildDashboard()) {
  log(`dashboard on http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
  start("dashboard", {
    command: process.execPath,
    args: ["build"],
    critical: false,
    cwd: DASHBOARD_DIR,
    env: {
      ...process.env,
      PORT: DASHBOARD_PORT,
      HOST: DASHBOARD_HOST,
      BOXY_DATA_DIR: process.env.BOXY_DATA_DIR || ROOT
    }
  });
} else {
  console.error("[boxy] dashboard build failed, starting without it (try `pnpm dashboard:build`)");
}

start("bot", {
  command: binary("probot"),
  args: ["run", "./src/index.js"],
  critical: true,
  cwd: ROOT
});
