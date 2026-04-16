import { spawn } from "node:child_process";
import process from "node:process";
import { assertGatewayDistExists, assertWebNextBuildExists } from "../build-preflight.js";
import { spawnNpmDaemon } from "../daemon-spawn.js";
import { resolveBeebridgeRepoRoot } from "../repo-root.js";
import { stopBeebridgeServers } from "./stop.js";

const DEFAULT_GATEWAY_PORT = 4321;
const DEFAULT_WEB_PORT = 3000;

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

function parsePorts(options: { gatewayPort?: string; webPort?: string }) {
  const gatewayPort = Number(
    options.gatewayPort ?? process.env.PORT ?? String(DEFAULT_GATEWAY_PORT),
  );
  const webPort = Number(options.webPort ?? String(DEFAULT_WEB_PORT));
  return { gatewayPort, webPort };
}

function requireDaemonForBoth(): void {
  process.stderr.write(
    "This command requires --daemon to run gateway and web together in one terminal.\n" +
      "For foreground logs, use two terminals:\n" +
      "  beebridge gateway start\n" +
      "  beebridge web start\n",
  );
  process.exit(1);
}

function spawnBothDaemons(options: {
  gatewayPort: number;
  webPort: number;
  dev: boolean;
  open?: boolean;
}): void {
  const gatewayScript = options.dev ? "dev:gateway" : "start:gateway";
  const webScript = options.dev ? "dev:web" : "start:web";

  const gw = spawnNpmDaemon({
    npmScript: gatewayScript,
    port: options.gatewayPort,
    label: "gateway",
  });
  process.stdout.write(
    `Gateway daemon started (PID ${gw.pid}).\nLog: ${gw.logPath}\nPID file: ${gw.pidPath}\n`,
  );

  const w = spawnNpmDaemon({
    npmScript: webScript,
    port: options.webPort,
    label: "web",
  });
  process.stdout.write(
    `Web daemon started (PID ${w.pid}).\nLog: ${w.logPath}\nPID file: ${w.pidPath}\n`,
  );

  if (options.open) {
    setTimeout(
      () => openInBrowser(`http://localhost:${options.webPort}/dashboard`),
      1200,
    );
  }
}

/**
 * Start gateway + web as daemons (no stop). Foreground is not supported for both at once.
 */
export async function startServers(options: {
  gatewayPort?: string;
  webPort?: string;
  daemon?: boolean;
  dev?: boolean;
  open?: boolean;
}): Promise<void> {
  if (options.daemon !== true) {
    requireDaemonForBoth();
  }

  const dev = options.dev === true;
  const repoRoot = resolveBeebridgeRepoRoot();
  if (!dev) {
    assertGatewayDistExists(repoRoot);
    assertWebNextBuildExists(repoRoot);
  }

  const { gatewayPort, webPort } = parsePorts(options);
  spawnBothDaemons({ gatewayPort, webPort, dev, open: options.open });
}

/**
 * Stop ports, then start gateway + web as daemons.
 */
export async function restartServers(options: {
  gatewayPort?: string;
  webPort?: string;
  daemon?: boolean;
  dev?: boolean;
  open?: boolean;
}): Promise<void> {
  if (options.daemon !== true) {
    process.stderr.write(
      "beebridge servers restart requires --daemon to run gateway and web together in one terminal.\n" +
        "For foreground logs, use two terminals:\n" +
        "  beebridge gateway restart\n" +
        "  beebridge web restart\n",
    );
    process.exit(1);
  }

  const dev = options.dev === true;
  const repoRoot = resolveBeebridgeRepoRoot();

  if (!dev) {
    assertGatewayDistExists(repoRoot);
    assertWebNextBuildExists(repoRoot);
  }

  const { gatewayPort, webPort } = parsePorts(options);

  stopBeebridgeServers({
    gatewayPort: String(gatewayPort),
    webPort: String(webPort),
  });

  spawnBothDaemons({ gatewayPort, webPort, dev, open: options.open });
}
