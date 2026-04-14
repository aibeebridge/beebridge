import process from "node:process";
import { stopProcessOnPort } from "../port-utils.js";

const DEFAULT_GATEWAY_PORT = 4321;
const DEFAULT_WEB_PORT = 3000;

function parsePort(label: string, raw: string | undefined, fallback: number): number {
  const s = raw !== undefined && raw !== "" ? raw : String(fallback);
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0 || n > 65535) {
    throw new Error(`Invalid ${label}: ${raw ?? ""}`.trim());
  }
  return Math.trunc(n);
}

/**
 * Best-effort SIGTERM to processes listening on the gateway and web ports (same behavior as `restart` before start).
 */
export function stopBeebridgeServers(options: { gatewayPort?: string; webPort?: string } = {}): void {
  const gatewayPort = parsePort("--gateway-port", options.gatewayPort, DEFAULT_GATEWAY_PORT);
  const webPort = parsePort("--web-port", options.webPort, DEFAULT_WEB_PORT);

  process.stdout.write(`Stopping gateway (port ${gatewayPort})...\n`);
  stopProcessOnPort(gatewayPort);

  process.stdout.write(`Stopping web UI (port ${webPort})...\n`);
  stopProcessOnPort(webPort);

  process.stdout.write("Stop complete.\n");
}
