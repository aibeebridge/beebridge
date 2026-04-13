import {
  mergeRefreshedBundle,
  parseCodexBundle,
  refreshCodexAccessToken,
} from "../server/openai-codex-oauth.js";

const SKEW_MS = 120_000;

export type ResolvedOpenAiSecret = {
  apiKey: string;
  /** True when the secret was a Codex OAuth bundle (use chatgpt.com/backend-api). */
  codexOAuth: boolean;
};

/**
 * If `secret` is a Codex OAuth JSON bundle, returns a valid access token (refreshing if needed)
 * and persists the updated bundle via `persist` when refreshed.
 * Otherwise returns `secret` as-is (API key `sk-...`).
 */
export async function resolveOpenAiSecretToApiKey(
  secret: string,
  persist: (newSecretJson: string) => void,
): Promise<ResolvedOpenAiSecret> {
  const trimmed = secret.trim();
  if (!trimmed.startsWith("{")) {
    return { apiKey: secret, codexOAuth: false };
  }
  const bundle = parseCodexBundle(trimmed);
  if (!bundle) {
    return { apiKey: secret, codexOAuth: false };
  }
  if (bundle.expires_at_ms > Date.now() + SKEW_MS) {
    return { apiKey: bundle.access_token, codexOAuth: true };
  }
  if (!bundle.refresh_token) {
    throw new Error(
      "OpenAI Codex token expired and no refresh_token is stored. Sign in again from Settings.",
    );
  }
  const t = await refreshCodexAccessToken(bundle.refresh_token);
  const next = mergeRefreshedBundle(trimmed, t);
  persist(next);
  return { apiKey: t.access_token, codexOAuth: true };
}
