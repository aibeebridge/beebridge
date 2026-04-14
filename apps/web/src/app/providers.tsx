import type { ReactNode } from "react";
import { readPersistedGatewayTokenIfPresent } from "@beebridge/shared/gateway-token-file";
import { ProvidersClient } from "./providers-client";

/**
 * Server: same precedence as the gateway — NEXT_PUBLIC_* (build), then GATEWAY_TOKEN (dev shell),
 * then ~/.beebridge/gateway-token. Gateway also syncs env token to that file on startup.
 */
export function Providers({ children }: { children: ReactNode }) {
  const nextPublic =
    typeof process.env.NEXT_PUBLIC_GATEWAY_TOKEN === "string" ? process.env.NEXT_PUBLIC_GATEWAY_TOKEN.trim() : "";
  const gateEnv = typeof process.env.GATEWAY_TOKEN === "string" ? process.env.GATEWAY_TOKEN.trim() : "";
  const persisted = readPersistedGatewayTokenIfPresent() ?? "";
  const initialGatewayToken = nextPublic || gateEnv || persisted || undefined;
  return <ProvidersClient initialGatewayToken={initialGatewayToken}>{children}</ProvidersClient>;
}
