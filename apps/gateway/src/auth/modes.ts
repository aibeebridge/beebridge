export type GatewayAuthMode = "none" | "token" | "password";

export interface GatewayAuthConfig {
  mode: GatewayAuthMode;
  token?: string;
  password?: string;
}

export function safeEqualSecret(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i += 1) {
    out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return out === 0;
}

export function authorizeSecret(config: GatewayAuthConfig, provided?: string): boolean {
  if (config.mode === "none") return true;
  if (!provided) return false;

  if (config.mode === "token" && config.token) {
    return safeEqualSecret(config.token, provided);
  }

  if (config.mode === "password" && config.password) {
    return safeEqualSecret(config.password, provided);
  }

  return false;
}
