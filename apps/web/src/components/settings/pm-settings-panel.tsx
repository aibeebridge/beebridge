"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useGateway, gatewayFetchUrl, fetchWithGatewayTimeout } from "../../context/gateway";

/** Gateway admin restart can take longer than normal API calls. */
const GATEWAY_RESTART_FETCH_TIMEOUT_MS = 90_000;

type ProviderAuthMode = "api_key" | "oauth";

type ProviderCatalogItem = {
  id: string;
  label: string;
  authModes: ProviderAuthMode[];
  models: string[];
};

type PmAuthProfile = {
  id: string;
  providerId: string;
  mode: ProviderAuthMode;
  secret: string;
  label?: string;
  active: boolean;
  createdAt: string;
};

type PmModelPolicy = {
  defaultProviderId: string;
  defaultModel: string;
  allowedModels: string[];
  fallbackModel?: string;
};

type SettingsPayload = {
  providers: ProviderCatalogItem[];
  authProfiles: PmAuthProfile[];
  modelPolicy: PmModelPolicy;
  activeProfile: string | null;
};

type WorkspaceInfo = {
  workspacePath: string;
  dataRoot: string;
  workspaceRoot: string;
  files: string[];
};

type SettingsTab = "connection" | "auth" | "model" | "workspace" | "status";

function isSettingsTab(value: string): value is SettingsTab {
  return value === "connection" || value === "auth" || value === "model" || value === "workspace" || value === "status";
}

/** UI label for stored mode `oauth` — OpenAI uses Codex terminology in the product. */
function labelForAuthMode(providerId: string, m: ProviderAuthMode): string {
  if (m === "api_key") return "API key";
  if (providerId === "openai") return "Codex";
  return "OAuth";
}

function formatProfileMode(providerId: string, mode: ProviderAuthMode): string {
  return labelForAuthMode(providerId, mode);
}

function authHeader(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

function verificationUriHost(uri: string): string {
  try {
    return new URL(uri).hostname;
  } catch {
    return "";
  }
}

function autoPollWaitingLabel(providerId: string, verificationUri: string): string {
  const host = verificationUriHost(verificationUri);
  if (providerId === "github-copilot") {
    return "Waiting for GitHub authorization";
  }
  if (providerId === "openai") {
    return host ? `Waiting for sign-in at ${host}` : "Waiting for OpenAI sign-in";
  }
  return host ? `Waiting for authorization at ${host}` : "Waiting for provider authorization";
}

export function PmSettingsPanel() {
  const {
    url: appGatewayUrl,
    token: appGatewayToken,
    setUrl: setAppGatewayUrl,
    setToken: setAppGatewayToken,
  } = useGateway();
  const gatewayUrl = appGatewayUrl || "http://localhost:4321";
  const gatewayToken = appGatewayToken;
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [providerId, setProviderId] = useState("openai");
  const [mode, setMode] = useState<ProviderAuthMode>("api_key");
  const [secret, setSecret] = useState("");
  const [profileLabel, setProfileLabel] = useState("");

  const [defaultProviderId, setDefaultProviderId] = useState("openai");
  const [defaultModel, setDefaultModel] = useState("");
  const [fallbackModel, setFallbackModel] = useState("");
  const [allowedModelsText, setAllowedModelsText] = useState("");
  const [activeTab, setActiveTab] = useState<SettingsTab>("connection");

  const [wsInfo, setWsInfo] = useState<WorkspaceInfo | null>(null);
  const [newWsPath, setNewWsPath] = useState("");
  const [wsLoading, setWsLoading] = useState(false);
  const [restartLoading, setRestartLoading] = useState(false);

  const [deviceFlow, setDeviceFlow] = useState<{
    sessionId: string;
    userCode: string;
    verificationUri: string;
    authCode: string;
    autoPolling: boolean;
    polling: boolean;
    pollStatus: string | null;
  } | null>(null);
  const deviceFlowCardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (deviceFlow && deviceFlowCardRef.current) {
      deviceFlowCardRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [deviceFlow]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab && isSettingsTab(tab)) {
      setActiveTab(tab);
    }
  }, []);

  const onSelectTab = useCallback((tab: SettingsTab) => {
    setActiveTab(tab);
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("tab", tab);
    window.history.replaceState({}, "", nextUrl.toString());
  }, []);

  const selectedProvider = useMemo(
    () => settings?.providers.find((item) => item.id === providerId) ?? null,
    [settings?.providers, providerId],
  );

  const modelCandidates = useMemo(
    () => settings?.providers.find((item) => item.id === defaultProviderId)?.models ?? [],
    [settings?.providers, defaultProviderId],
  );

  const loadSettings = useCallback(async () => {
    setError(null);
    const response = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/pm`, {
      method: "GET",
      headers: authHeader(gatewayToken),
    });

    if (!response.ok) {
      throw new Error(`Failed to load settings (${response.status}).`);
    }

    const data = (await response.json()) as SettingsPayload;
    setSettings(data);
    const policy = data.modelPolicy ?? {} as PmModelPolicy;
    setProviderId(policy.defaultProviderId ?? "");
    setDefaultProviderId(policy.defaultProviderId ?? "");
    setDefaultModel(policy.defaultModel ?? "");
    setFallbackModel(policy.fallbackModel ?? "");
    setAllowedModelsText((policy.allowedModels ?? []).join(", "));
  }, [gatewayToken, gatewayUrl]);

  const onConnect = useCallback(async () => {
    try {
      await loadSettings();
      setAppGatewayUrl(gatewayUrl);
      setAppGatewayToken(gatewayToken.trim());
      setNotice("Settings loaded.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load settings.");
    }
  }, [gatewayToken, gatewayUrl, loadSettings, setAppGatewayToken, setAppGatewayUrl]);

  const onCreateProfile = useCallback(async () => {
    if (!secret.trim()) {
      setError(
        providerId === "openai"
          ? "Please enter an API key or Codex token."
          : "Please enter an API key or OAuth token.",
      );
      return;
    }
    setError(null);
    const response = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/auth/profiles`, {
      method: "POST",
      headers: authHeader(gatewayToken),
      body: JSON.stringify({
        providerId,
        mode,
        secret,
        label: profileLabel || undefined,
      }),
    });
    if (!response.ok) {
      setError(`Failed to save profile (${response.status}).`);
      return;
    }
    setSecret("");
    setProfileLabel("");
    await loadSettings();
    setNotice("Profile saved.");
  }, [gatewayToken, gatewayUrl, loadSettings, mode, profileLabel, providerId, secret]);

  const onStartOAuthLogin = useCallback(async () => {
    setError(null);
    // Open a tab immediately in the click handler to avoid popup blockers.
    const authWindow = window.open("", "_blank");
    const startResponse = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/auth/device/start`, {
      method: "POST",
      headers: authHeader(gatewayToken),
      body: JSON.stringify({
        providerId,
        label: profileLabel || undefined,
      }),
    });
    if (!startResponse.ok) {
      const errData = await startResponse.json().catch(() => null);
      authWindow?.close();
      setError(
        errData?.message ??
          `Failed to start ${providerId === "openai" ? "Codex" : "OAuth"} login (${startResponse.status}).`,
      );
      return;
    }
    const startData = (await startResponse.json()) as {
      sessionId: string;
      verificationUri: string;
      userCode: string;
      autoPolling?: boolean;
    };

    if (authWindow) {
      authWindow.location.href = startData.verificationUri;
    } else {
      window.open(startData.verificationUri, "_blank");
      setNotice(
        providerId === "github-copilot"
          ? "Popup was blocked. Use the fallback link below to open GitHub."
          : `Popup was blocked. Use the link below to open the sign-in page (${verificationUriHost(startData.verificationUri) || "provider"}).`,
      );
    }
    setDeviceFlow({
      sessionId: startData.sessionId,
      userCode: startData.userCode,
      verificationUri: startData.verificationUri,
      authCode: "",
      autoPolling: startData.autoPolling ?? false,
      polling: false,
      pollStatus: null,
    });
  }, [gatewayToken, gatewayUrl, profileLabel, providerId]);

  const pollForAuthorization = useCallback(async (sessionId: string) => {
    setDeviceFlow((prev) => prev ? { ...prev, polling: true, pollStatus: "Checking authorization..." } : prev);

    const poll = async (): Promise<boolean> => {
      const res = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/auth/device/complete`, {
        method: "POST",
        headers: authHeader(gatewayToken),
        body: JSON.stringify({ sessionId }),
      });

      if (res.status === 202) {
        return false;
      }
      if (res.status === 201) {
        return true;
      }
      const errData = await res.json().catch(() => null);
      throw new Error(errData?.message ?? `Authorization failed (${res.status})`);
    };

    try {
      for (let i = 0; i < 36; i++) {
        const done = await poll();
        if (done) {
          setDeviceFlow(null);
          await loadSettings();
          setNotice(providerId === "openai" ? "Codex profile saved." : "OAuth profile saved.");
          return;
        }
        setDeviceFlow((prev) =>
          prev
            ? {
                ...prev,
                pollStatus: `${autoPollWaitingLabel(providerId, prev.verificationUri)}… (${i + 1})`,
              }
            : prev,
        );
        await new Promise((r) => setTimeout(r, 5000));
      }
      setError("Authorization timed out. Please try again.");
      setDeviceFlow(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Authorization check failed.");
      setDeviceFlow((prev) => prev ? { ...prev, polling: false, pollStatus: null } : prev);
    }
  }, [gatewayToken, gatewayUrl, loadSettings, providerId]);

  const onCompleteOAuthLogin = useCallback(async () => {
    if (!deviceFlow) return;

    if (deviceFlow.autoPolling) {
      await pollForAuthorization(deviceFlow.sessionId);
      return;
    }

    if (!deviceFlow.authCode?.trim()) {
      setError(
        providerId === "openai"
          ? "Please paste the redirect URL from after login."
          : "Please enter the callback code or token.",
      );
      return;
    }
    setError(null);
    const bodyPayload: Record<string, string> = {
      sessionId: deviceFlow.sessionId,
    };
    if (providerId === "openai") {
      bodyPayload.redirectUrl = deviceFlow.authCode.trim();
    } else {
      bodyPayload.authCode = deviceFlow.authCode.trim();
    }
    const completeResponse = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/auth/device/complete`, {
      method: "POST",
      headers: authHeader(gatewayToken),
      body: JSON.stringify(bodyPayload),
    });
    if (!completeResponse.ok) {
      const errData = await completeResponse.json().catch(() => null);
      setError(
        errData?.message ??
          `Failed to complete ${providerId === "openai" ? "Codex" : "OAuth"} login (${completeResponse.status}).`,
      );
      return;
    }
    setDeviceFlow(null);
    await loadSettings();
    setNotice(providerId === "openai" ? "Codex profile saved." : "OAuth profile saved.");
  }, [deviceFlow, gatewayToken, gatewayUrl, loadSettings, pollForAuthorization, providerId]);

  const onCancelOAuthLogin = useCallback(() => {
    setDeviceFlow(null);
    setNotice(providerId === "openai" ? "Codex setup cancelled." : "OAuth login cancelled.");
  }, [providerId]);

  const onSelectProfile = useCallback(
    async (profile: PmAuthProfile) => {
      setError(null);

      const activateRes = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/auth/profiles/${profile.id}/activate`, {
        method: "PATCH",
        headers: authHeader(gatewayToken),
      });
      if (!activateRes.ok) {
        setError(`Failed to activate profile (${activateRes.status}).`);
        return;
      }

      const provider = settings?.providers.find((p) => p.id === profile.providerId);
      if (provider && provider.models.length > 0) {
        const policyRes = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/model-policy`, {
          method: "PUT",
          headers: authHeader(gatewayToken),
          body: JSON.stringify({
            defaultProviderId: provider.id,
            defaultModel: provider.models[0],
            allowedModels: provider.models,
          }),
        });
        if (!policyRes.ok) {
          setError(`Profile activated, but failed to update model policy (${policyRes.status}).`);
          await loadSettings();
          return;
        }
      }

      await loadSettings();
      const providerLabel = provider?.label ?? profile.providerId;
      setNotice(`Switched to ${providerLabel} — ${provider?.models[0] ?? "default model"}.`);
    },
    [gatewayToken, gatewayUrl, loadSettings, settings?.providers],
  );

  const onDeleteProfile = useCallback(
    async (profileId: string) => {
      setError(null);
      const response = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/auth/profiles/${profileId}`, {
        method: "DELETE",
        headers: authHeader(gatewayToken),
      });
      if (!response.ok) {
        setError(`Failed to delete profile (${response.status}).`);
        return;
      }
      await loadSettings();
      setNotice("Auth profile deleted.");
    },
    [gatewayToken, gatewayUrl, loadSettings],
  );

  const onResetAuthSettings = useCallback(async () => {
    const confirmed = window.confirm(
      "Reset all sign-in profiles? This deletes every saved profile and clears in-progress Codex/OAuth sessions.",
    );
    if (!confirmed) return;

    setError(null);
    const response = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/auth/profiles`, {
      method: "DELETE",
      headers: authHeader(gatewayToken),
    });
    if (!response.ok) {
      setError(`Failed to reset auth settings (${response.status}).`);
      return;
    }

    setDeviceFlow(null);
    setSecret("");
    setProfileLabel("");
    await loadSettings();
    setNotice("Auth settings reset.");
  }, [gatewayToken, gatewayUrl, loadSettings]);

  const onSaveModelPolicy = useCallback(async () => {
    setError(null);
    const allowedModels = allowedModelsText
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const response = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/model-policy`, {
      method: "PUT",
      headers: authHeader(gatewayToken),
      body: JSON.stringify({
        defaultProviderId,
        defaultModel,
        fallbackModel: fallbackModel || undefined,
        allowedModels,
      }),
    });
    if (!response.ok) {
      setError(`Failed to save model policy (${response.status}).`);
      return;
    }
    await loadSettings();
    setNotice("Model policy saved.");
  }, [
    allowedModelsText,
    defaultModel,
    defaultProviderId,
    fallbackModel,
    gatewayToken,
    gatewayUrl,
    loadSettings,
  ]);

  const loadWorkspaceInfo = useCallback(async () => {
    try {
      const res = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/workspace`, {
        headers: authHeader(gatewayToken),
      });
      if (res.ok) {
        const data = (await res.json()) as WorkspaceInfo;
        setWsInfo(data);
        setNewWsPath(data.workspacePath);
      }
    } catch {
      // silent
    }
  }, [gatewayUrl, gatewayToken]);

  useEffect(() => {
    if (activeTab === "workspace") {
      loadWorkspaceInfo();
    }
  }, [activeTab, loadWorkspaceInfo]);

  const onRestartGateway = useCallback(async () => {
    if (
      !window.confirm(
        "This will shut down the gateway process. You may need to start it again (e.g. beebridge gateway start or npm run start:gateway). Continue?",
      )
    ) {
      return;
    }
    setRestartLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetchWithGatewayTimeout(gatewayFetchUrl(gatewayUrl, "/api/admin/restart"), {
        method: "POST",
        headers: authHeader(gatewayToken),
      }, GATEWAY_RESTART_FETCH_TIMEOUT_MS);
      const data = (await res.json().catch(() => null)) as { message?: string; error?: string } | null;
      if (!res.ok) {
        setError(data?.error ?? `Restart request failed (${res.status}).`);
        return;
      }
      setNotice(data?.message ?? "Gateway has been shut down. Restart the gateway from the terminal if needed.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Restart request failed.");
    } finally {
      setRestartLoading(false);
    }
  }, [gatewayToken, gatewayUrl]);

  const onChangeWorkspace = useCallback(async () => {
    if (!newWsPath.trim()) return;
    setWsLoading(true);
    setError(null);
    try {
      const res = await fetchWithGatewayTimeout(`${gatewayUrl}/api/settings/workspace`, {
        method: "PUT",
        headers: authHeader(gatewayToken),
        body: JSON.stringify({ workspacePath: newWsPath }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? `Failed to change workspace (${res.status}).`);
        return;
      }
      const data = (await res.json()) as WorkspaceInfo;
      setWsInfo(data);
      setNotice("Workspace path updated.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to change workspace.");
    } finally {
      setWsLoading(false);
    }
  }, [gatewayUrl, gatewayToken, newWsPath]);

  return (
    <section className="panel settings-panel">
      <header className="settings-header">
        <h2>PM Profiles &amp; Model</h2>
        <p>Register API keys or Codex/OpenAI profiles and choose the default model.</p>
      </header>

      {error && <p className="settings-error">{error}</p>}
      {notice && <p className="settings-notice">{notice}</p>}

      <div className="settings-shell">
        <aside className="settings-sidebar">
          <button
            type="button"
            className={`settings-tab ${activeTab === "connection" ? "active" : ""}`}
            onClick={() => onSelectTab("connection")}
          >
            Connection
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === "auth" ? "active" : ""}`}
            onClick={() => onSelectTab("auth")}
          >
            Profiles
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === "model" ? "active" : ""}`}
            onClick={() => onSelectTab("model")}
          >
            Model Policy
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === "workspace" ? "active" : ""}`}
            onClick={() => onSelectTab("workspace")}
          >
            Workspace
          </button>
          <button
            type="button"
            className={`settings-tab ${activeTab === "status" ? "active" : ""}`}
            onClick={() => onSelectTab("status")}
          >
            Diagnostics
          </button>
        </aside>

        <div className="settings-content">
          {activeTab === "connection" && (
            <section className="settings-card">
              <h3>Gateway Connection</h3>
              <div className="field-grid">
                <label>
                  Gateway URL
                  <input value={gatewayUrl} onChange={(event) => setAppGatewayUrl(event.target.value)} />
                </label>
                <label>
                  Gateway Token
                  <input value={gatewayToken} onChange={(event) => setAppGatewayToken(event.target.value)} />
                </label>
              </div>
              <button type="button" onClick={onConnect}>
                Connect
              </button>
            </section>
          )}

          {activeTab === "auth" && (
            <section className="settings-card">
              <h3>Manager profiles</h3>
              <div className="field-grid">
                <label>
                  Provider
                  <select value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                    {(settings?.providers ?? []).map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Sign-in mode
                  <select value={mode} onChange={(event) => setMode(event.target.value as ProviderAuthMode)}>
                    {(selectedProvider?.authModes ?? ["api_key"]).map((authMode) => (
                      <option key={authMode} value={authMode}>
                        {labelForAuthMode(providerId, authMode)}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Profile label
                  <input
                    value={profileLabel}
                    placeholder="e.g. PM Main Account"
                    onChange={(event) => setProfileLabel(event.target.value)}
                  />
                </label>
                <label>
                  {providerId === "openai" ? "Secret (API key or Codex token)" : "Secret (API key / OAuth token)"}
                  <input
                    value={secret}
                    type="password"
                    placeholder={providerId === "openai" ? "sk-… or token" : "Enter token"}
                    onChange={(event) => setSecret(event.target.value)}
                  />
                </label>
              </div>
              <button type="button" onClick={onCreateProfile}>
                Save profile
              </button>
              <button type="button" className="btn-secondary" onClick={onResetAuthSettings}>
                Reset profiles
              </button>
              {mode === "oauth" && !deviceFlow && (
                <button type="button" onClick={onStartOAuthLogin}>
                  {providerId === "openai" ? "Start Codex setup" : "Start OAuth login"}
                </button>
              )}
              {deviceFlow && (
                <div className="device-flow-card" ref={deviceFlowCardRef}>
                  <h4>{providerId === "openai" ? "OpenAI Codex Login" : "Complete OAuth login"}</h4>
                  <p>
                    {deviceFlow.autoPolling
                      ? providerId === "github-copilot"
                        ? "A new tab has been opened. Enter the code below on GitHub and authorize access."
                        : "A new tab has been opened to the provider. Complete authorization there, then return here."
                      : providerId === "openai"
                        ? "Complete the OpenAI login in the new tab. After login, the browser will redirect to a localhost URL (the page may not load). Copy the full URL from the address bar and paste it below."
                        : providerId === "anthropic" || providerId === "google"
                          ? "A new tab has the provider key/console page. Copy your API key and paste it below, then click Complete login. (Or use Sign-in mode: API key and Save profile.)"
                          : "A new tab has been opened. If the provider shows a device or callback code, enter it below; otherwise paste the API key or token Beebridge should use."}
                  </p>
                  {deviceFlow.autoPolling ? (
                    <div className="device-code-display">
                      <span className="device-code-label">Your device code</span>
                      <code className="device-code-value">{deviceFlow.userCode}</code>
                    </div>
                  ) : providerId === "openai" ? (
                    <div className="device-code-display device-oauth-redirect" style={{ textAlign: "left" }}>
                      <span className="device-code-label">Example redirect URL format:</span>
                      <code className="device-code-value device-code-value--break" style={{ color: "var(--muted)", fontSize: "11px" }}>
                        {"http://localhost:1455/auth/callback?code=abc123&state=xyz"}
                      </code>
                    </div>
                  ) : (
                    <p className="device-flow-poll-status" style={{ marginBottom: "8px" }}>
                      Session id: <code>{deviceFlow.userCode}</code>
                      {" — paste API key or token below if the provider has no device screen."}
                    </p>
                  )}
                  <p className="device-flow-link">
                    If the tab didn&apos;t open,{" "}
                    <a href={deviceFlow.verificationUri} target="_blank" rel="noopener noreferrer">
                      {providerId === "openai"
                        ? "Open OpenAI login page"
                        : providerId === "github-copilot"
                          ? "open the GitHub device page"
                          : "open the provider page"}
                    </a>
                    .
                  </p>
                  {!deviceFlow.autoPolling && (
                    <label>
                      {providerId === "openai"
                        ? "Paste the redirect URL"
                        : providerId === "anthropic" || providerId === "google"
                          ? "API key (paste here)"
                          : "Callback code / token"}
                      <input
                        value={deviceFlow.authCode}
                        onChange={(e) => setDeviceFlow({ ...deviceFlow, authCode: e.target.value })}
                        placeholder={
                          providerId === "openai"
                            ? "http://localhost:1455/auth/callback?code=...&state=..."
                            : "Paste API key or callback code"
                        }
                        autoFocus
                      />
                    </label>
                  )}
                  {deviceFlow.pollStatus && (
                    <p className="device-flow-poll-status">{deviceFlow.pollStatus}</p>
                  )}
                  <div className="device-flow-actions">
                    <button
                      type="button"
                      onClick={onCompleteOAuthLogin}
                      disabled={deviceFlow.polling}
                    >
                      {deviceFlow.polling
                        ? "Checking..."
                        : deviceFlow.autoPolling
                          ? providerId === "github-copilot"
                            ? "I\u2019ve authorized on GitHub"
                            : "I\u2019ve authorized"
                          : providerId === "openai"
                            ? "Complete authentication"
                            : "Complete login"}
                    </button>
                    <button
                      type="button"
                      className="btn-secondary"
                      onClick={onCancelOAuthLogin}
                      disabled={deviceFlow.polling}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {(settings?.authProfiles ?? []).length > 0 && (
                <div className="profile-card-list">
                  <h4>Saved Profiles</h4>
                  {(settings?.authProfiles ?? []).map((profile) => {
                    const provider = settings?.providers.find((p) => p.id === profile.providerId);
                    const isActive = settings?.activeProfile === profile.id;
                    return (
                      <div
                        key={profile.id}
                        className={`profile-card ${isActive ? "profile-card--active" : ""}`}
                        onClick={() => !isActive && onSelectProfile(profile)}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !isActive) onSelectProfile(profile);
                        }}
                      >
                        <div className="profile-card__indicator">
                          {isActive ? "✓" : ""}
                        </div>
                        <div className="profile-card__body">
                          <div className="profile-card__name">
                            {profile.label || provider?.label || profile.providerId}
                          </div>
                          <div className="profile-card__meta">
                            {provider?.label ?? profile.providerId} ·{" "}
                            {formatProfileMode(profile.providerId, profile.mode as ProviderAuthMode)}
                            {isActive && " · Active"}
                          </div>
                          {isActive && provider && (
                            <div className="profile-card__models">
                              {provider.models.slice(0, 4).join(", ")}
                              {provider.models.length > 4 && ` +${provider.models.length - 4} more`}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="profile-card__delete"
                          title="Delete profile"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDeleteProfile(profile.id);
                          }}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          )}

          {activeTab === "model" && (
            <section className="settings-card">
              <h3>PM Model Policy</h3>
              <div className="field-grid">
                <label>
                  Default provider
                  <select value={defaultProviderId} onChange={(event) => setDefaultProviderId(event.target.value)}>
                    {(settings?.providers ?? []).map((provider) => (
                      <option key={provider.id} value={provider.id}>
                        {provider.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Default model
                  <select value={defaultModel} onChange={(event) => setDefaultModel(event.target.value)}>
                    {modelCandidates.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Allowed models (comma-separated)
                  <input
                    value={allowedModelsText}
                    placeholder="gpt-4o, gpt-4.1"
                    onChange={(event) => setAllowedModelsText(event.target.value)}
                  />
                </label>
                <label>
                  Fallback model
                  <input
                    value={fallbackModel}
                    placeholder="Optional"
                    onChange={(event) => setFallbackModel(event.target.value)}
                  />
                </label>
              </div>
              <button type="button" onClick={onSaveModelPolicy}>
                Save model policy
              </button>
            </section>
          )}

          {activeTab === "workspace" && (
            <section className="settings-card">
              <h3>Workspace Configuration</h3>
              <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted)" }}>
                All settings, history, and data are stored under this workspace path. If the folder does not exist, it
                is created. Under it, <code style={{ fontSize: 12 }}>.beebridge/workspace</code> holds districts, jobs,
                and related files.
              </p>
              <div className="field-grid">
                <label>
                  Workspace Path
                  <input
                    value={newWsPath}
                    onChange={(e) => setNewWsPath(e.target.value)}
                    placeholder="/Users/.../my-project"
                  />
                </label>
              </div>
              <button type="button" onClick={onChangeWorkspace} disabled={wsLoading}>
                {wsLoading ? "Applying..." : "Change Workspace"}
              </button>

              {wsInfo && (
                <div style={{ marginTop: 16 }}>
                  <div className="settings-status-grid">
                    <article>
                      <p>Current Path</p>
                      <strong style={{ fontSize: 12, wordBreak: "break-all" }}>{wsInfo.workspacePath}</strong>
                    </article>
                    <article>
                      <p>Data Root</p>
                      <strong style={{ fontSize: 12, wordBreak: "break-all" }}>{wsInfo.dataRoot}</strong>
                    </article>
                    <article>
                      <p>Files</p>
                      <strong>{wsInfo.files.length}</strong>
                    </article>
                  </div>
                  {wsInfo.files.length > 0 && (
                    <details style={{ marginTop: 10, fontSize: 12 }}>
                      <summary style={{ cursor: "pointer", color: "var(--muted)", fontWeight: 500 }}>
                        Workspace Files ({wsInfo.files.length})
                      </summary>
                      <ul style={{ margin: "6px 0 0", paddingLeft: 18, color: "var(--muted)", lineHeight: 1.8 }}>
                        {wsInfo.files.map((f) => <li key={f}>{f}</li>)}
                      </ul>
                    </details>
                  )}
                </div>
              )}
            </section>
          )}

          {activeTab === "status" && (
            <section className="settings-card">
              <h3>Status Diagnostics</h3>
              <div className="settings-status-grid">
                <article>
                  <p>Active profile</p>
                  <strong>{settings?.activeProfile ?? "None"}</strong>
                </article>
                <article>
                  <p>Default provider</p>
                  <strong>{settings?.modelPolicy.defaultProviderId ?? "-"}</strong>
                </article>
                <article>
                  <p>Default model</p>
                  <strong>{settings?.modelPolicy.defaultModel ?? "-"}</strong>
                </article>
                <article>
                  <p>Allowed models</p>
                  <strong>{settings?.modelPolicy.allowedModels.length ?? 0}</strong>
                </article>
              </div>
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid var(--line, #e5e5e5)" }}>
                <h4 style={{ margin: "0 0 8px", fontSize: 15 }}>Gateway restart</h4>
                <p style={{ margin: "0 0 12px", fontSize: 13, color: "var(--muted)" }}>
                  This stops the server process. The workspace is saved before shutdown. If nothing auto-restarts (e.g.{" "}
                  <code style={{ fontSize: 12 }}>beebridge gateway start</code> or{" "}
                  <code style={{ fontSize: 12 }}>npm run start:gateway</code>), start the gateway again from the terminal.
                </p>
                <button type="button" className="btn-secondary" onClick={onRestartGateway} disabled={restartLoading}>
                  {restartLoading ? "Requesting…" : "Restart gateway"}
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </section>
  );
}
