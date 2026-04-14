import { NextResponse } from "next/server";
import { readPersistedGatewayTokenIfPresent } from "@beebridge/shared/gateway-token-file";

/**
 * Returns the current gateway token (server-side only; same precedence as providers.tsx).
 * Called by GatewayProvider when the cached client token fails /health → 401.
 */
export function GET() {
  const nextPublic =
    typeof process.env.NEXT_PUBLIC_GATEWAY_TOKEN === "string" ? process.env.NEXT_PUBLIC_GATEWAY_TOKEN.trim() : "";
  const gateEnv = typeof process.env.GATEWAY_TOKEN === "string" ? process.env.GATEWAY_TOKEN.trim() : "";
  const persisted = readPersistedGatewayTokenIfPresent() ?? "";
  const token = nextPublic || gateEnv || persisted;
  return NextResponse.json({ token });
}
