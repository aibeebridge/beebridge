import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";

/** Same directory as global `config.json`; persisted gateway bearer + CDP relay secret when `GATEWAY_TOKEN` is unset. */
export const BEEGATEWAY_TOKEN_FILE = path.join(os.homedir(), ".beebridge", "gateway-token");

function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

/**
 * Read token from disk if present (non-empty). Does not create a file.
 */
export function readPersistedGatewayTokenIfPresent(): string | undefined {
  try {
    if (fs.existsSync(BEEGATEWAY_TOKEN_FILE)) {
      const t = fs.readFileSync(BEEGATEWAY_TOKEN_FILE, "utf-8").trim();
      if (t.length > 0) return t;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

/**
 * OpenClaw-style: 24-byte random hex, persisted for stable restarts when env token is absent.
 */
export function loadOrCreatePersistedGatewayToken(): { token: string; created: boolean } {
  const existing = readPersistedGatewayTokenIfPresent();
  if (existing) {
    return { token: existing, created: false };
  }

  const token = randomBytes(24).toString("hex");
  const dir = path.dirname(BEEGATEWAY_TOKEN_FILE);
  ensureDir(dir);
  const tmp = `${BEEGATEWAY_TOKEN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  fs.renameSync(tmp, BEEGATEWAY_TOKEN_FILE);
  try {
    fs.chmodSync(BEEGATEWAY_TOKEN_FILE, 0o600);
  } catch {
    /* Windows may not support chmod */
  }
  return { token, created: true };
}

/**
 * When the gateway uses `GATEWAY_TOKEN` from the environment, the on-disk file can still hold an
 * older auto-generated token. CLI and Next.js read the file — keep them aligned with the live secret.
 */
export function persistGatewayTokenFileIfChanged(token: string): boolean {
  const t = token.trim();
  if (!t) return false;
  const cur = readPersistedGatewayTokenIfPresent();
  if (cur === t) return false;

  const dir = path.dirname(BEEGATEWAY_TOKEN_FILE);
  ensureDir(dir);
  const tmp = `${BEEGATEWAY_TOKEN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${t}\n`, { mode: 0o600 });
  fs.renameSync(tmp, BEEGATEWAY_TOKEN_FILE);
  try {
    fs.chmodSync(BEEGATEWAY_TOKEN_FILE, 0o600);
  } catch {
    /* Windows may not support chmod */
  }
  return true;
}
