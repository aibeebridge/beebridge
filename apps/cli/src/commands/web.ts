import { spawn } from "node:child_process";
import process from "node:process";
import { assertWebNextBuildExists } from "../build-preflight.js";
import { spawnNpmDaemon } from "../daemon-spawn.js";
import { stopProcessOnPort } from "../port-utils.js";
import { resolveBeebridgeRepoRoot } from "../repo-root.js";
import { envForNextWebDev, envForNextWebProd } from "../web-dev-env.js";

/** Must match `SettingsTab` in web `pm-settings-panel.tsx` (URL `?tab=`). */
type SettingsTab = "connection" | "auth" | "model" | "workspace" | "status";

function openInBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true });
    return;
  }

  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
    return;
  }

  spawn("xdg-open", [url], { stdio: "ignore", detached: true });
}

export async function startWebUi(options: {
  open?: boolean;
  port?: string;
  daemon?: boolean;
  dev?: boolean;
}): Promise<void> {
  await startWebUiWithPath({ ...options, openPath: "/dashboard" });
}

async function startWebUiWithPath(options: {
  open?: boolean;
  port?: string;
  openPath: string;
  daemon?: boolean;
  dev?: boolean;
}): Promise<void> {
  const port = Number(options.port ?? process.env.PORT ?? "3000");
  const dev = options.dev === true;

  if (!dev) {
    assertWebNextBuildExists(resolveBeebridgeRepoRoot());
  }

  const npmScript = dev ? "dev:web" : "start:web";

  if (options.daemon) {
    const { pid, logPath, pidPath } = spawnNpmDaemon({
      npmScript,
      port,
      label: "web",
    });
    process.stdout.write(
      `Web daemon started (PID ${pid}).\nLog: ${logPath}\nPID file: ${pidPath}\n`,
    );
    if (options.open) {
      setTimeout(() => openInBrowser(`http://localhost:${port}${options.openPath}`), 1200);
    }
    return;
  }

  const repoRoot = resolveBeebridgeRepoRoot();
  const env = dev ? envForNextWebDev(port) : envForNextWebProd(port);

  if (options.open) {
    setTimeout(() => openInBrowser(`http://localhost:${port}${options.openPath}`), 1200);
  }

  await new Promise<void>((resolve, reject) => {
    const child = spawn("npm", ["run", npmScript], {
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
      reject(new Error(`Web server exited (code=${code}).`));
    });
  });
}

export async function restartWebUi(options: {
  open?: boolean;
  port?: string;
  daemon?: boolean;
  dev?: boolean;
}): Promise<void> {
  const port = Number(options.port ?? process.env.PORT ?? "3000");
  stopProcessOnPort(port);
  await startWebUi(options);
}

export async function openSettingsUi(options: {
  port?: string;
  open?: boolean;
  tab?: SettingsTab;
  dev?: boolean;
}): Promise<void> {
  const tab = options.tab ?? "connection";
  await startWebUiWithPath({
    port: options.port,
    open: options.open ?? true,
    openPath: `/settings?tab=${encodeURIComponent(tab)}`,
    dev: options.dev,
  });
}
