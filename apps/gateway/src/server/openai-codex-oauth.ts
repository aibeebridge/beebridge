/**
 * OpenAI Codex / ChatGPT OAuth via auth.openai.com (PKCE), aligned with Codex CLI client_id.
 * @see https://auth.openai.com — authorization_code + refresh_token flows
 */

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

export const OPENAI_CODEX_AUTH = "https://auth.openai.com/oauth/authorize";
export const OPENAI_CODEX_TOKEN = "https://auth.openai.com/oauth/token";

export const OPENAI_CODEX_CLIENT_ID =
  process.env.OPENAI_CODEX_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";

/** Must match what OpenAI registered for this public client (same as Codex CLI). */
export const OPENAI_CODEX_REDIRECT_URI =
  process.env.OPENAI_CODEX_REDIRECT_URI ?? "http://localhost:1455/auth/callback";

const CODEX_SCOPES = "openid profile email offline_access";

export type CodexTokenBundle = {
  v: 1;
  kind: "openai_codex_oauth";
  access_token: string;
  refresh_token: string;
  expires_at_ms: number;
};

function base64Url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(32));
  const challenge = base64Url(createHash("sha256").update(verifier, "utf8").digest());
  return { verifier, challenge };
}

export function generateOauthState(): string {
  return randomBytes(16).toString("hex");
}

export function buildCodexAuthorizeUrl(params: {
  codeChallenge: string;
  state: string;
}): string {
  const q = new URLSearchParams({
    client_id: OPENAI_CODEX_CLIENT_ID,
    redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    scope: CODEX_SCOPES,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    response_type: "code",
    state: params.state,
    codex_cli_simplified_flow: "true",
    originator: "beebridge",
  });
  return `${OPENAI_CODEX_AUTH}?${q.toString()}`;
}

export type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type?: string;
};

export async function exchangeCodexAuthorizationCode(
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OPENAI_CODEX_CLIENT_ID,
    code,
    redirect_uri: OPENAI_CODEX_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  const res = await fetch(OPENAI_CODEX_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const data = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new Error(
      data.error_description || data.error || `token exchange failed: HTTP ${res.status}`,
    );
  }
  if (!data.access_token) {
    throw new Error("token exchange: no access_token");
  }
  return data;
}

export async function refreshCodexAccessToken(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: OPENAI_CODEX_CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(OPENAI_CODEX_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: body.toString(),
  });
  const data = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new Error(
      data.error_description || data.error || `token refresh failed: HTTP ${res.status}`,
    );
  }
  if (!data.access_token) {
    throw new Error("refresh: no access_token");
  }
  return data;
}

export function serializeCodexBundle(t: TokenResponse): string {
  const expiresIn = t.expires_in ?? 3600;
  const bundle: CodexTokenBundle = {
    v: 1,
    kind: "openai_codex_oauth",
    access_token: t.access_token,
    refresh_token: t.refresh_token ?? "",
    expires_at_ms: Date.now() + expiresIn * 1000,
  };
  return JSON.stringify(bundle);
}

export function parseCodexBundle(secret: string): CodexTokenBundle | null {
  try {
    const o = JSON.parse(secret) as CodexTokenBundle;
    if (o?.v !== 1 || o?.kind !== "openai_codex_oauth" || !o.access_token) return null;
    return o;
  } catch {
    return null;
  }
}

/** Merge refreshed tokens into stored bundle (keeps refresh_token if server omits new one). */
export function mergeRefreshedBundle(prevJson: string, t: TokenResponse): string {
  const prev = parseCodexBundle(prevJson);
  const expiresIn = t.expires_in ?? 3600;
  const bundle: CodexTokenBundle = {
    v: 1,
    kind: "openai_codex_oauth",
    access_token: t.access_token,
    refresh_token: t.refresh_token || prev?.refresh_token || "",
    expires_at_ms: Date.now() + expiresIn * 1000,
  };
  return JSON.stringify(bundle);
}

export type CallbackServerResult = {
  authUrl: string;
  codeVerifier: string;
  state: string;
  /** Resolves when /auth/callback receives a valid code (or rejects on error/timeout). */
  authorizationCode: Promise<string>;
  close: () => void;
};

/**
 * Binds localhost to the port in OPENAI_CODEX_REDIRECT_URI and waits for GET /auth/callback.
 * Rejects with EADDRINUSE if the port is taken (another Codex client or stale process).
 */
export async function createCodexCallbackSession(timeoutMs: number): Promise<CallbackServerResult> {
  const { verifier, challenge } = generatePkce();
  const state = generateOauthState();
  const authUrl = buildCodexAuthorizeUrl({ codeChallenge: challenge, state });

  const redirect = new URL(OPENAI_CODEX_REDIRECT_URI);
  const port = Number(redirect.port || (redirect.protocol === "https:" ? 443 : 80));
  const pathname = redirect.pathname || "/auth/callback";

  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const authorizationCode = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const server = http.createServer((req, res) => {
    try {
      if (!req.url) {
        res.writeHead(400);
        res.end();
        return;
      }
      const u = new URL(req.url, `http://localhost:${port}`);
      if (u.pathname !== pathname) {
        res.writeHead(404);
        res.end();
        return;
      }
      const q = u.searchParams;
      if (q.get("state") !== state) {
        res.writeHead(400);
        res.end("Invalid state");
        if (timeoutId) clearTimeout(timeoutId);
        try {
          server.close();
        } catch {
          /* ignore */
        }
        rejectCode(new Error("OAuth state mismatch"));
        return;
      }
      const oauthErr = q.get("error");
      if (oauthErr) {
        const desc = q.get("error_description") || oauthErr;
        res.writeHead(400);
        res.end(String(desc));
        if (timeoutId) clearTimeout(timeoutId);
        try {
          server.close();
        } catch {
          /* ignore */
        }
        rejectCode(new Error(`OAuth error: ${desc}`));
        return;
      }
      const code = q.get("code");
      if (!code) {
        res.writeHead(400);
        res.end("No code");
        if (timeoutId) clearTimeout(timeoutId);
        try {
          server.close();
        } catch {
          /* ignore */
        }
        rejectCode(new Error("No authorization code"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(
        "<!DOCTYPE html><html><body><p>Beebridge: 로그인되었습니다. 이 창을 닫아도 됩니다.</p></body></html>",
      );
      if (timeoutId) clearTimeout(timeoutId);
      try {
        server.close();
      } catch {
        /* ignore */
      }
      resolveCode(code);
    } catch (e) {
      rejectCode(e instanceof Error ? e : new Error(String(e)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(err);
    });
    server.listen(port, "0.0.0.0", () => resolve());
  });

  timeoutId = setTimeout(() => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
    rejectCode(new Error("Codex login timed out (15 minutes)"));
  }, timeoutMs);

  const close = (): void => {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };

  return { authUrl, codeVerifier: verifier, state, authorizationCode, close };
}
