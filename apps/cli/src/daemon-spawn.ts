import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { resolveBeebridgeRepoRoot } from "./repo-root.js";
import { envForNextWebDev } from "./web-dev-env.js";

export type DaemonLabel = "gateway" | "web";

/**
 * Spawn `npm run <script>` detached; stdout/stderr append to `.beebridge-daemon/<label>-<port>.log`.
 * Writes PID to `.beebridge-daemon/<label>-<port>.pid`.
 */
export function spawnNpmDaemon(options: {
  npmScript: "dev:gateway" | "dev:web";
  port: number;
  label: DaemonLabel;
}): { pid: number; logPath: string; pidPath: string } {
  const repoRoot = resolveBeebridgeRepoRoot();
  const dir = path.join(repoRoot, ".beebridge-daemon");
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, `${options.label}-${options.port}.log`);
  const pidPath = path.join(dir, `${options.label}-${options.port}.pid`);

  const stamp = `\n--- ${new Date().toISOString()} beebridge ${options.label} daemon ---\n`;
  fs.appendFileSync(logPath, stamp);

  const logFd = fs.openSync(logPath, "a");
  const env =
    options.npmScript === "dev:web"
      ? envForNextWebDev(options.port)
      : { ...process.env, PORT: String(options.port) };

  const child = spawn("npm", ["run", options.npmScript], {
    cwd: repoRoot,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    shell: process.platform === "win32",
  });

  fs.closeSync(logFd);

  if (child.pid === undefined) {
    throw new Error("Failed to spawn daemon process.");
  }

  fs.writeFileSync(pidPath, `${child.pid}\n`, "utf8");
  child.unref();

  return { pid: child.pid, logPath, pidPath };
}
