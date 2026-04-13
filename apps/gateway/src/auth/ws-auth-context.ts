import type { IncomingMessage } from "http";
import { authorizeSecret, type GatewayAuthConfig } from "./modes.js";

export interface WsAuthContext {
  clientId: string;
  authenticated: boolean;
  reason?: string;
}

export function resolveWsAuthContext(req: IncomingMessage, config: GatewayAuthConfig): WsAuthContext {
  const ip = req.socket.remoteAddress ?? "unknown";
  const clientId = `${ip}:${Date.now()}`;

  const authHeader = req.headers.authorization;
  const headerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;
  const queryToken = new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? undefined;
  const supplied = headerToken ?? queryToken;

  const authenticated = authorizeSecret(config, supplied);

  if (!authenticated) {
    return { clientId, authenticated: false, reason: "invalid_credentials" };
  }

  return { clientId, authenticated: true };
}
