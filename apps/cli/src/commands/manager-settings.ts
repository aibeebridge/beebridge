import { execFileSync, spawn } from "node:child_process";
import readline from "node:readline";

function gatewayBaseUrl(): string {
  return process.env.beebridge_GATEWAY_URL ?? "http://localhost:4321";
}

function gatewayToken(): string {
  return process.env.beebridge_GATEWAY_TOKEN ?? "dev-token";
}
const GITHUB_DEVICE_CODE_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";

type GithubDeviceCodeResponse = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
};

type GithubDeviceTokenResponse =
  | {
      access_token: string;
      token_type: string;
      scope?: string;
    }
  | {
      error: string;
      error_description?: string;
      error_uri?: string;
    };

function isTlsIssuerError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UNABLE_TO_GET_ISSUER_CERT_LOCALLY") ||
    message.includes("unable to get local issuer certificate")
  );
}

function curlPostFormJson(url: string, form: URLSearchParams): unknown {
  try {
    const stdout = execFileSync(
      "curl",
      [
        "-sS",
        "-k",
        "-X",
        "POST",
        "-H",
        "Accept: application/json",
        "-H",
        "Content-Type: application/x-www-form-urlencoded",
        "--data",
        form.toString(),
        url,
      ],
      { encoding: "utf8" },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`curl OAuth fallback failed: ${message}`);
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${gatewayToken()}`,
    ...extra,
  };
}

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

async function promptInput(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const value = await new Promise<string>((resolve) => rl.question(message, resolve));
  rl.close();
  return value.trim();
}

async function requestGithubDeviceCode(): Promise<GithubDeviceCodeResponse> {
  const body = new URLSearchParams({
    client_id: GITHUB_COPILOT_CLIENT_ID,
    scope: "read:user",
  });

  let json: Partial<GithubDeviceCodeResponse>;
  try {
    const response = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) {
      throw new Error(`GitHub device code request failed: HTTP ${response.status}`);
    }
    json = (await response.json()) as Partial<GithubDeviceCodeResponse>;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.log(`fetch failed (${reason}). Switching to curl fallback...`);
    json = curlPostFormJson(GITHUB_DEVICE_CODE_URL, body) as Partial<GithubDeviceCodeResponse>;
  }

  if (!json.device_code || !json.user_code || !json.verification_uri || !json.expires_in || !json.interval) {
    throw new Error("GitHub device code response is missing required fields.");
  }
  return json as GithubDeviceCodeResponse;
}

async function pollGithubAccessToken(params: {
  deviceCode: string;
  intervalSeconds: number;
  expiresAtMs: number;
}): Promise<string> {
  const body = new URLSearchParams({
    client_id: GITHUB_COPILOT_CLIENT_ID,
    device_code: params.deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });

  let intervalMs = Math.max(1000, params.intervalSeconds * 1000);
  let forceCurlFallback = false;
  while (Date.now() < params.expiresAtMs) {
    let json: GithubDeviceTokenResponse;
    if (!forceCurlFallback) {
      try {
        const response = await fetch(GITHUB_ACCESS_TOKEN_URL, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body,
        });

        if (!response.ok) {
          throw new Error(`GitHub token polling failed: HTTP ${response.status}`);
        }
        json = (await response.json()) as GithubDeviceTokenResponse;
      } catch (error) {
        forceCurlFallback = true;
        const reason = error instanceof Error ? error.message : String(error);
        console.log(`Polling fetch failed (${reason}). Switching to curl fallback...`);
        json = curlPostFormJson(GITHUB_ACCESS_TOKEN_URL, body) as GithubDeviceTokenResponse;
      }
    } else {
      json = curlPostFormJson(GITHUB_ACCESS_TOKEN_URL, body) as GithubDeviceTokenResponse;
    }

    if ("access_token" in json && typeof json.access_token === "string" && json.access_token.trim()) {
      return json.access_token;
    }

    const errorCode = "error" in json ? json.error : "unknown";
    if (errorCode === "authorization_pending") {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    if (errorCode === "slow_down") {
      intervalMs += 2000;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      continue;
    }
    if (errorCode === "access_denied") {
      throw new Error("GitHub authorization was denied.");
    }
    if (errorCode === "expired_token") {
      throw new Error("GitHub device code expired. Please run login again.");
    }
    throw new Error(`GitHub device flow error: ${errorCode}`);
  }

  throw new Error("GitHub device code timed out. Please run login again.");
}

async function saveOauthProfile(params: {
  provider: string;
  tokenValue: string;
  label?: string;
}): Promise<void> {
  const storeResponse = await fetch(`${gatewayBaseUrl()}/api/settings/auth/profiles`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      providerId: params.provider,
      mode: "oauth",
      secret: params.tokenValue,
      label: params.label || params.provider,
    }),
  });

  if (!storeResponse.ok) {
    throw new Error(`Failed to save OAuth profile: ${storeResponse.status}`);
  }
  const profileData = await storeResponse.json();
  console.log(JSON.stringify(profileData, null, 2));
}

export async function managerSettingsShow(): Promise<void> {
  const response = await fetch(`${gatewayBaseUrl()}/api/settings/pm`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to load settings: ${response.status}`);
  }
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

export async function managerAuthAdd(options: {
  provider: string;
  mode: "api_key" | "oauth";
  secret: string;
  label?: string;
}): Promise<void> {
  const response = await fetch(`${gatewayBaseUrl()}/api/settings/auth/profiles`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      providerId: options.provider,
      mode: options.mode,
      secret: options.secret,
      label: options.label,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to add profile: ${response.status}`);
  }
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

export async function managerAuthLogin(options: {
  provider: string;
  label?: string;
  open?: boolean;
}): Promise<void> {
  if (options.provider === "github-copilot") {
    if (!process.stdin.isTTY) {
      throw new Error("GitHub Copilot login requires an interactive TTY.");
    }

    try {
      const device = await requestGithubDeviceCode();
      console.log(`\nGitHub Copilot device login started`);
      console.log(`Open this URL: ${device.verification_uri}`);
      console.log(`Enter this code: ${device.user_code}\n`);

      if (options.open !== false) {
        openInBrowser(device.verification_uri);
      }

      console.log("Waiting for GitHub authorization...");
      const githubToken = await pollGithubAccessToken({
        deviceCode: device.device_code,
        intervalSeconds: device.interval,
        expiresAtMs: Date.now() + device.expires_in * 1000,
      });

      await saveOauthProfile({
        provider: "github-copilot",
        tokenValue: githubToken,
        label: options.label || "github-copilot",
      });
      console.log("GitHub Copilot login completed.\n");
      return;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.log(`\nAutomatic device login failed: ${reason}`);
      console.log("Final fallback: paste a GitHub token manually.\n");
      const manualToken = await promptInput("GitHub token: ");
      if (!manualToken) {
        throw new Error("GitHub Copilot login cancelled: no token provided.");
      }
      await saveOauthProfile({
        provider: "github-copilot",
        tokenValue: manualToken,
        label: options.label || "github-copilot",
      });
      console.log("GitHub Copilot profile saved using manual token fallback.\n");
      return;
    }
  }

  const startResponse = await fetch(`${gatewayBaseUrl()}/api/settings/auth/device/start`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ providerId: options.provider, label: options.label }),
  });
  if (!startResponse.ok) {
    throw new Error(
      options.provider === "openai"
        ? `Failed to start Codex setup: ${startResponse.status}`
        : `Failed to start OAuth login: ${startResponse.status}`,
    );
  }
  const startData = (await startResponse.json()) as {
    sessionId: string;
    providerId: string;
    verificationUri: string;
    userCode: string;
  };

  const codex = options.provider === "openai";
  console.log(`\n${codex ? "Codex" : "OAuth"} login started for ${startData.providerId}`);
  console.log(`Open this URL: ${startData.verificationUri}`);
  console.log(
    codex
      ? `Session ref: ${startData.userCode} (paste your OpenAI API key below, not this code)\n`
      : `Enter this code: ${startData.userCode}\n`,
  );

  if (options.open !== false) {
    openInBrowser(startData.verificationUri);
  }

  const authCode = await promptInput(
    codex ? "Paste OpenAI API key (sk-...) and press Enter: " : "Paste callback code/token and press Enter: ",
  );
  if (!authCode) {
    throw new Error(codex ? "Codex setup cancelled: no API key provided." : "OAuth login cancelled: no code or token provided.");
  }

  const completeResponse = await fetch(`${gatewayBaseUrl()}/api/settings/auth/device/complete`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ sessionId: startData.sessionId, authCode }),
  });
  if (!completeResponse.ok) {
    throw new Error(
      codex ? `Failed to complete Codex setup: ${completeResponse.status}` : `Failed to complete OAuth login: ${completeResponse.status}`,
    );
  }
  const profileData = await completeResponse.json();
  console.log(JSON.stringify(profileData, null, 2));
}

export async function managerAuthActivate(profileId: string): Promise<void> {
  const response = await fetch(`${gatewayBaseUrl()}/api/settings/auth/profiles/${profileId}/activate`, {
    method: "PATCH",
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to activate profile: ${response.status}`);
  }
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

export async function managerAuthRemove(profileId: string): Promise<void> {
  const response = await fetch(`${gatewayBaseUrl()}/api/settings/auth/profiles/${profileId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to remove profile: ${response.status}`);
  }
  console.log(`[beebridge] profile removed: ${profileId}`);
}

export async function managerModelSet(options: {
  provider: string;
  model: string;
  allow?: string;
  fallback?: string;
}): Promise<void> {
  const allowedModels = (options.allow ?? options.model)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const response = await fetch(`${gatewayBaseUrl()}/api/settings/model-policy`, {
    method: "PUT",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      defaultProviderId: options.provider,
      defaultModel: options.model,
      allowedModels,
      fallbackModel: options.fallback,
    }),
  });
  if (!response.ok) {
    throw new Error(`Failed to save model policy: ${response.status}`);
  }
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}

export async function managerProvidersList(): Promise<void> {
  const response = await fetch(`${gatewayBaseUrl()}/api/settings/providers`, {
    method: "GET",
    headers: authHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Failed to load providers: ${response.status}`);
  }
  const data = await response.json();
  console.log(JSON.stringify(data, null, 2));
}
