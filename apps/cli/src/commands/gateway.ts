import { spawn } from "node:child_process";
import process from "node:process";
import { spawnNpmDaemon } from "../daemon-spawn.js";
import { stopProcessOnPort } from "../port-utils.js";
import { resolveBeebridgeRepoRoot } from "../repo-root.js";

const DEFAULT_GATEWAY_PORT = 4321;

export async function startGatewayUi(options: { port?: string; daemon?: boolean }): Promise<void> {
  const port = Number(options.port ?? process.env.PORT ?? String(DEFAULT_GATEWAY_PORT));

  if (options.daemon) {
    const { pid, logPath, pidPath } = spawnNpmDaemon({
      npmScript: "dev:gateway",
      port,
      label: "gateway",
    });
    process.stdout.write(
      `Gateway daemon started (PID ${pid}).\nLog: ${logPath}\nPID file: ${pidPath}\n`,
    );
    return;
  }

  const repoRoot = resolveBeebridgeRepoRoot();
  const env = { ...process.env, PORT: String(port) };

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", "dev:gateway"], {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });

    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || code === null) {
        resolve();
        return;
      }
      reject(new Error(`Gateway exited (code=${code}).`));
    });
  });
}

export async function restartGatewayUi(options: { port?: string; daemon?: boolean }): Promise<void> {
  const port = Number(options.port ?? process.env.PORT ?? String(DEFAULT_GATEWAY_PORT));
  stopProcessOnPort(port);
  await startGatewayUi(options);
}
