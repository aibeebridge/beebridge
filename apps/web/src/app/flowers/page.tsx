"use client";

import { useEffect, useState, useCallback } from "react";
import { useGateway } from "../../context/gateway";

type FlowerConnectionType = "chrome_extension" | "api_endpoint" | "mcp_server" | "discord_bot";

interface FlowerConfig {
  id: string;
  name: string;
  type: FlowerConnectionType;
  enabled: boolean;
  description?: string;
  apiEndpoint?: string;
  apiKey?: string;
  mcpCommand?: string;
  mcpArgs?: string[];
  mcpEnv?: Record<string, string>;
  discordBotToken?: string;
  discordChannelAllowlist?: string[];
  /** Present in API responses when token is stored (value never returned). */
  discordBotTokenSet?: boolean;
  discordChatToolsEnabled?: boolean;
  discordUserAllowlist?: string[];
  discordCooldownMs?: number;
  /** API-only: last Discord client error */
  discordLastError?: string;
  capabilities: string[];
  connected?: boolean;
  lastSeenAt?: string;
  createdAt: string;
}

type RuntimeDiagnostics = {
  cdpRelay?: { connected?: boolean; attachedTabId?: number | null };
  jobs?: { activeCount?: number; pendingApprovals?: number };
  discord?: { summary?: string };
};

type TabId = "list" | "add";

const TYPE_LABELS: Record<FlowerConnectionType, string> = {
  chrome_extension: "Chrome Extension",
  api_endpoint: "API Endpoint",
  mcp_server: "MCP Server",
  discord_bot: "Discord bot",
};

const TYPE_ICONS: Record<FlowerConnectionType, string> = {
  chrome_extension: "🧩",
  api_endpoint: "🔌",
  mcp_server: "🔗",
  discord_bot: "🤖",
};

const TYPE_DESCRIPTIONS: Record<FlowerConnectionType, string> = {
  chrome_extension:
    "Control the browser via a Chrome extension. Access AI web apps such as ChatGPT and Claude.",
  api_endpoint:
    "Connect directly to an external API endpoint. Send requests to REST, GraphQL, or other services you choose.",
  mcp_server:
    "Connect to an MCP (Model Context Protocol) server. Access the file system, databases, external tools, and more.",
  discord_bot:
    "Run a Discord bot on the gateway. Messages in allowlisted channels are answered using the same chat pipeline as the Chat tab (active PM profile required).",
};

const ALL_CAPABILITIES = [
  "navigate", "click", "type", "read", "screenshot", "wait",
  "scroll", "ai_chat", "ai_read_response",
  "http_request", "file_read", "file_write",
  "db_query", "shell_exec", "search",
];

type FlowerFormState = Omit<FlowerConfig, "id" | "createdAt" | "discordCooldownMs" | "discordLastError"> & {
  discordCooldownMsField: string;
};

const defaultForm: FlowerFormState = {
  name: "",
  type: "chrome_extension",
  enabled: true,
  description: "",
  apiEndpoint: "",
  apiKey: "",
  mcpCommand: "",
  mcpArgs: [],
  mcpEnv: {},
  discordBotToken: "",
  discordChannelAllowlist: [""],
  discordChatToolsEnabled: true,
  discordUserAllowlist: [""],
  discordCooldownMsField: "",
  capabilities: [],
};

export default function FlowersPage() {
  const { apiFetch } = useGateway();
  const [flowers, setFlowers] = useState<FlowerConfig[]>([]);
  const [connectedCount, setConnectedCount] = useState(0);
  const [diagnostics, setDiagnostics] = useState<RuntimeDiagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabId>("list");
  const [form, setForm] = useState<FlowerFormState>(defaultForm);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [mcpArgsText, setMcpArgsText] = useState("");
  const [mcpEnvText, setMcpEnvText] = useState("");

  const loadFlowers = useCallback(async () => {
    try {
      const [data, diag] = await Promise.all([
        apiFetch("/api/settings/flowers"),
        apiFetch("/api/diagnostics/runtime").catch(() => null),
      ]);
      setFlowers(Array.isArray(data.flowers) ? data.flowers : []);
      setConnectedCount(data.connectedCount ?? 0);
      setDiagnostics(diag as RuntimeDiagnostics | null);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadFlowers();
    const interval = setInterval(loadFlowers, 8000);
    return () => clearInterval(interval);
  }, [loadFlowers]);

  async function handleToggle(flowerId: string) {
    try {
      await apiFetch(`/api/settings/flowers/${flowerId}/toggle`, { method: "PATCH" });
      loadFlowers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Toggle failed");
    }
  }

  async function handleDelete(flowerId: string) {
    if (!confirm("Delete this Flower?")) return;
    try {
      await apiFetch(`/api/settings/flowers/${flowerId}`, { method: "DELETE" });
      loadFlowers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  function startEdit(flower: FlowerConfig) {
    setEditingId(flower.id);
    const allow = flower.discordChannelAllowlist ?? [];
    const users = flower.discordUserAllowlist ?? [];
    setForm({
      name: flower.name,
      type: flower.type,
      enabled: flower.enabled,
      description: flower.description ?? "",
      apiEndpoint: flower.apiEndpoint ?? "",
      apiKey: flower.apiKey ?? "",
      mcpCommand: flower.mcpCommand ?? "",
      mcpArgs: flower.mcpArgs ?? [],
      mcpEnv: flower.mcpEnv ?? {},
      discordBotToken: "",
      discordChannelAllowlist: allow.length > 0 ? [...allow] : [""],
      discordBotTokenSet: flower.discordBotTokenSet,
      discordChatToolsEnabled: flower.discordChatToolsEnabled !== false,
      discordUserAllowlist: users.length > 0 ? [...users] : [""],
      discordCooldownMsField:
        flower.discordCooldownMs !== undefined && flower.discordCooldownMs !== null
          ? String(flower.discordCooldownMs)
          : "",
      capabilities: flower.capabilities ?? [],
    });
    setMcpArgsText((flower.mcpArgs ?? []).join("\n"));
    setMcpEnvText(Object.entries(flower.mcpEnv ?? {}).map(([k, v]) => `${k}=${v}`).join("\n"));
    setTab("add");
  }

  function startNew() {
    setEditingId(null);
    setForm({ ...defaultForm });
    setMcpArgsText("");
    setMcpEnvText("");
    setTab("add");
  }

  function setAllowlistRow(index: number, value: string) {
    setForm((f) => {
      const rows = [...(f.discordChannelAllowlist ?? [""])];
      rows[index] = value;
      return { ...f, discordChannelAllowlist: rows };
    });
  }

  function addAllowlistRow() {
    setForm((f) => ({
      ...f,
      discordChannelAllowlist: [...(f.discordChannelAllowlist ?? [""]), ""],
    }));
  }

  function removeAllowlistRow(index: number) {
    setForm((f) => {
      const rows = [...(f.discordChannelAllowlist ?? [""])];
      rows.splice(index, 1);
      return { ...f, discordChannelAllowlist: rows.length > 0 ? rows : [""] };
    });
  }

  function setUserAllowlistRow(index: number, value: string) {
    setForm((f) => {
      const rows = [...(f.discordUserAllowlist ?? [""])];
      rows[index] = value;
      return { ...f, discordUserAllowlist: rows };
    });
  }

  function addUserAllowlistRow() {
    setForm((f) => ({
      ...f,
      discordUserAllowlist: [...(f.discordUserAllowlist ?? [""]), ""],
    }));
  }

  function removeUserAllowlistRow(index: number) {
    setForm((f) => {
      const rows = [...(f.discordUserAllowlist ?? [""])];
      rows.splice(index, 1);
      return { ...f, discordUserAllowlist: rows.length > 0 ? rows : [""] };
    });
  }

  async function handleSave() {
    if (!form.name.trim()) { setError("Please enter a name"); return; }
    if (form.type === "discord_bot") {
      const ids = (form.discordChannelAllowlist ?? []).map((s) => s.trim()).filter(Boolean);
      if (ids.length === 0) {
        setError("Add at least one Discord channel ID (numeric snowflake).");
        return;
      }
      if (!editingId && !form.discordBotToken?.trim()) {
        setError("Bot token is required for a new Discord Flower.");
        return;
      }
    }
    setSaving(true);
    setError("");

    const discordAllowIds = (form.discordChannelAllowlist ?? []).map((s) => s.trim()).filter(Boolean);
    const body: Record<string, unknown> = {
      name: form.name,
      type: form.type,
      enabled: form.enabled,
      description: form.description,
      apiEndpoint: form.apiEndpoint,
      apiKey: form.apiKey,
      mcpCommand: form.mcpCommand,
      mcpArgs: mcpArgsText.split("\n").map((s) => s.trim()).filter(Boolean),
      mcpEnv: Object.fromEntries(
        mcpEnvText.split("\n").map((s) => s.trim()).filter(Boolean)
          .map((line) => { const [k, ...v] = line.split("="); return [k, v.join("=")]; })
      ),
      capabilities: form.capabilities,
    };
    if (form.type === "discord_bot") {
      body.discordChannelAllowlist = discordAllowIds;
      body.discordChatToolsEnabled = form.discordChatToolsEnabled === true;
      const userIds = (form.discordUserAllowlist ?? []).map((s) => s.trim()).filter(Boolean);
      body.discordUserAllowlist = userIds;
      const cdRaw = form.discordCooldownMsField.trim();
      if (cdRaw !== "") {
        const n = Number(cdRaw);
        if (Number.isFinite(n) && n >= 0) body.discordCooldownMs = Math.floor(n);
      }
      if (editingId) {
        if (form.discordBotToken?.trim()) body.discordBotToken = form.discordBotToken.trim();
      } else {
        body.discordBotToken = form.discordBotToken?.trim() ?? "";
      }
    }

    try {
      if (editingId) {
        await apiFetch(`/api/settings/flowers/${editingId}`, { method: "PUT", body: JSON.stringify(body) });
      } else {
        await apiFetch("/api/settings/flowers", { method: "POST", body: JSON.stringify(body) });
      }
      setTab("list");
      setEditingId(null);
      setForm({ ...defaultForm });
      loadFlowers();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function toggleCapability(cap: string) {
    setForm((f) => ({
      ...f,
      capabilities: f.capabilities.includes(cap)
        ? f.capabilities.filter((c) => c !== cap)
        : [...f.capabilities, cap],
    }));
  }

  if (loading) return <div className="page-loading">Loading...</div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Flowers</h1>
          <p className="page-subtitle">
            {flowers.length} configurations · {connectedCount} connected
          </p>
        </div>
        <button className="btn-primary" onClick={startNew}>+ New Flower</button>
      </header>

      {error && <p className="page-error">{error}</p>}

      <section className="panel" style={{ marginBottom: "1rem" }}>
        <div className="settings-status-grid">
          <article>
            <p>CDP relay</p>
            <strong>{diagnostics?.cdpRelay?.connected ? "Connected" : "Offline"}</strong>
          </article>
          <article>
            <p>Attached tab</p>
            <strong>{diagnostics?.cdpRelay?.attachedTabId ?? "None"}</strong>
          </article>
          <article>
            <p>Active jobs</p>
            <strong>{diagnostics?.jobs?.activeCount ?? 0}</strong>
          </article>
          <article>
            <p>Discord</p>
            <strong style={{ fontSize: 12 }}>{diagnostics?.discord?.summary ?? "Not configured"}</strong>
          </article>
        </div>
      </section>

      {/* Tabs */}
      <div className="activity-tabs">
        <button className={`activity-tab ${tab === "list" ? "active" : ""}`} onClick={() => { setTab("list"); setEditingId(null); }}>
          Flower list
        </button>
        <button className={`activity-tab ${tab === "add" ? "active" : ""}`} onClick={() => tab !== "add" && startNew()}>
          {editingId ? "Edit" : "Add Flower"}
        </button>
      </div>

      {/* List Tab */}
      {tab === "list" && (
        <section className="flower-list">
          {flowers.length === 0 ? (
            <div className="panel empty-panel">
              <p className="empty-text">No Flowers yet. Add one to get started.</p>
            </div>
          ) : (
            flowers.map((flower) => (
              <div key={flower.id} className={`flower-card ${flower.enabled ? "" : "disabled"}`}>
                <div className="flower-card-header">
                  <div className="flower-card-left">
                    <span className="flower-type-icon">{TYPE_ICONS[flower.type]}</span>
                    <div>
                      <h3>{flower.name}</h3>
                      <span className="flower-type-label">{TYPE_LABELS[flower.type]}</span>
                    </div>
                  </div>
                  <div className="flower-card-right">
                    <span className={`flower-conn-badge ${flower.connected ? "online" : "offline"}`}>
                      <span className={`conn-dot ${flower.connected ? "on" : "off"}`} />
                      {flower.connected ? "Connected" : "Offline"}
                    </span>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={flower.enabled}
                        onChange={() => handleToggle(flower.id)}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                </div>

                {flower.description && (
                  <p className="flower-desc">{flower.description}</p>
                )}

                <div className="flower-details">
                  {flower.type === "api_endpoint" && flower.apiEndpoint && (
                    <div className="flower-detail-row">
                      <span className="detail-label">Endpoint</span>
                      <code>{flower.apiEndpoint}</code>
                    </div>
                  )}
                  {flower.type === "api_endpoint" && flower.apiKey && (
                    <div className="flower-detail-row">
                      <span className="detail-label">API Key</span>
                      <code>{flower.apiKey.slice(0, 8)}••••</code>
                    </div>
                  )}
                  {flower.type === "mcp_server" && flower.mcpCommand && (
                    <div className="flower-detail-row">
                      <span className="detail-label">Command</span>
                      <code>{flower.mcpCommand} {(flower.mcpArgs ?? []).join(" ")}</code>
                    </div>
                  )}
                  {flower.type === "mcp_server" && flower.mcpEnv && Object.keys(flower.mcpEnv).length > 0 && (
                    <div className="flower-detail-row">
                      <span className="detail-label">Env Vars</span>
                      <span>{Object.keys(flower.mcpEnv).length} variables</span>
                    </div>
                  )}
                  {flower.type === "discord_bot" && (
                    <>
                      <div className="flower-detail-row">
                        <span className="detail-label">Bot token</span>
                        <span>{flower.discordBotTokenSet ? "Saved (hidden)" : "Not set"}</span>
                      </div>
                      <div className="flower-detail-row">
                        <span className="detail-label">Allowlisted channels</span>
                        <span>{(flower.discordChannelAllowlist ?? []).length} ID(s)</span>
                      </div>
                      <div className="flower-detail-row">
                        <span className="detail-label">Workspace tools</span>
                        <span>{flower.discordChatToolsEnabled === false ? "Off (answer-only)" : "On"}</span>
                      </div>
                      {flower.discordLastError && (
                        <p className="page-error" style={{ margin: "0.5rem 0 0", fontSize: "0.9rem" }}>
                          Discord: {flower.discordLastError}
                        </p>
                      )}
                    </>
                  )}
                  {flower.capabilities.length > 0 && (
                    <div className="flower-caps">
                      {flower.capabilities.map((cap) => (
                        <span key={cap} className="cap-chip">{cap}</span>
                      ))}
                    </div>
                  )}
                  {flower.lastSeenAt && (
                    <div className="flower-detail-row">
                      <span className="detail-label">Last Seen</span>
                      <span>{new Date(flower.lastSeenAt).toLocaleString()}</span>
                    </div>
                  )}
                </div>

                <div className="flower-card-actions">
                  <button className="btn-secondary btn-sm" onClick={() => startEdit(flower)}>Edit</button>
                  {flower.id !== "chrome-extension" && (
                    <button className="btn-danger-outline btn-sm" onClick={() => handleDelete(flower.id)}>Delete</button>
                  )}
                </div>
              </div>
            ))
          )}
        </section>
      )}

      {/* Add / Edit Tab */}
      {tab === "add" && (
        <section className="panel flower-form-panel">
          <h2>{editingId ? "Edit Flower" : "Add Flower"}</h2>

          {/* Type Selector */}
          <div className="flower-type-selector">
            {(["chrome_extension", "api_endpoint", "mcp_server", "discord_bot"] as FlowerConnectionType[]).map((t) => (
              <button
                key={t}
                className={`type-option ${form.type === t ? "active" : ""}`}
                onClick={() =>
                  setForm((f) => {
                    const next: FlowerFormState = { ...f, type: t };
                    if (t === "discord_bot") {
                      if (!f.discordChannelAllowlist?.length) next.discordChannelAllowlist = [""];
                      if (!f.discordUserAllowlist?.length) next.discordUserAllowlist = [""];
                      if (f.type !== "discord_bot") {
                        next.discordChatToolsEnabled = false;
                        next.discordCooldownMsField = "";
                      }
                    }
                    return next;
                  })}
              >
                <span className="type-option-icon">{TYPE_ICONS[t]}</span>
                <strong>{TYPE_LABELS[t]}</strong>
                <small>{TYPE_DESCRIPTIONS[t]}</small>
              </button>
            ))}
          </div>

          <div className="flower-form-fields">
            <label className="schedule-field">
              <span>Name *</span>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. ChatGPT Browser Worker"
              />
            </label>

            <label className="schedule-field">
              <span>Description</span>
              <textarea
                rows={2}
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Describe what this Flower does"
              />
            </label>

            {/* API Endpoint Fields */}
            {form.type === "api_endpoint" && (
              <>
                <label className="schedule-field">
                  <span>API Endpoint URL *</span>
                  <input
                    value={form.apiEndpoint}
                    onChange={(e) => setForm((f) => ({ ...f, apiEndpoint: e.target.value }))}
                    placeholder="https://api.example.com/v1"
                  />
                </label>
                <label className="schedule-field">
                  <span>API Key</span>
                  <input
                    type="password"
                    value={form.apiKey}
                    onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                    placeholder="sk-..."
                  />
                  <small className="field-hint">Leave empty to send requests without authentication</small>
                </label>
              </>
            )}

            {/* MCP Server Fields */}
            {form.type === "mcp_server" && (
              <>
                <label className="schedule-field">
                  <span>Command *</span>
                  <input
                    value={form.mcpCommand}
                    onChange={(e) => setForm((f) => ({ ...f, mcpCommand: e.target.value }))}
                    placeholder="e.g. npx, uvx, node"
                  />
                </label>
                <label className="schedule-field">
                  <span>Arguments</span>
                  <textarea
                    rows={3}
                    value={mcpArgsText}
                    onChange={(e) => setMcpArgsText(e.target.value)}
                    placeholder={"One per line:\n@modelcontextprotocol/server-filesystem\n/Users/me/workspace"}
                  />
                  <small className="field-hint">One argument per line</small>
                </label>
                <label className="schedule-field">
                  <span>Environment variables</span>
                  <textarea
                    rows={3}
                    value={mcpEnvText}
                    onChange={(e) => setMcpEnvText(e.target.value)}
                    placeholder={"KEY=value format:\nAPI_KEY=sk-abc123\nDATABASE_URL=postgres://..."}
                  />
                  <small className="field-hint">KEY=VALUE format, one per line</small>
                </label>
              </>
            )}

            {/* Discord bot */}
            {form.type === "discord_bot" && (
              <>
                <label className="schedule-field">
                  <span>Bot token{editingId ? "" : " *"}</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={form.discordBotToken ?? ""}
                    onChange={(e) => setForm((f) => ({ ...f, discordBotToken: e.target.value }))}
                    placeholder={editingId ? "Leave blank to keep existing token" : "Discord application bot token"}
                  />
                  {editingId && (
                    <small className="field-hint">
                      Token is never shown after save. Leave blank to keep the current token.
                      {form.discordBotTokenSet === true ? " A token is already stored." : ""}
                    </small>
                  )}
                </label>
                <div className="schedule-field">
                  <span>Channel allowlist *</span>
                  <small className="field-hint" style={{ display: "block", marginBottom: "0.5rem" }}>
                    Add at least one numeric channel ID. Messages from other channels are ignored.
                  </small>
                  {(form.discordChannelAllowlist ?? [""]).map((row, index) => (
                    <div key={index} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
                      <input
                        style={{ flex: 1 }}
                        value={row}
                        onChange={(e) => setAllowlistRow(index, e.target.value)}
                        placeholder="Channel ID (snowflake)"
                      />
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => removeAllowlistRow(index)}
                        title="Remove row"
                      >
                        −
                      </button>
                    </div>
                  ))}
                  <button type="button" className="btn-secondary btn-sm" onClick={() => addAllowlistRow()}>
                    + Add channel ID
                  </button>
                </div>
                <label className="schedule-field" style={{ flexDirection: "row", alignItems: "center", gap: "0.5rem" }}>
                  <input
                    type="checkbox"
                    checked={form.discordChatToolsEnabled === true}
                    onChange={(e) => setForm((f) => ({ ...f, discordChatToolsEnabled: e.target.checked }))}
                  />
                  <span>Allow workspace tools from Discord</span>
                </label>
                <small className="field-hint" style={{ display: "block", marginTop: "-0.5rem", marginBottom: "0.75rem" }}>
                  When off, the bot answers from context only (no task/bridge mutations). Recommended for public servers. Existing Flowers without this setting default to on.
                </small>
                <div className="schedule-field">
                  <span>User allowlist (optional)</span>
                  <small className="field-hint" style={{ display: "block", marginBottom: "0.5rem" }}>
                    Leave rows empty to allow any user in allowlisted channels. Otherwise only these Discord user IDs can trigger replies.
                  </small>
                  {(form.discordUserAllowlist ?? [""]).map((row, index) => (
                    <div key={index} style={{ display: "flex", gap: "0.5rem", marginBottom: "0.5rem", alignItems: "center" }}>
                      <input
                        style={{ flex: 1 }}
                        value={row}
                        onChange={(e) => setUserAllowlistRow(index, e.target.value)}
                        placeholder="User ID (snowflake)"
                      />
                      <button
                        type="button"
                        className="btn-secondary btn-sm"
                        onClick={() => removeUserAllowlistRow(index)}
                        title="Remove row"
                      >
                        −
                      </button>
                    </div>
                  ))}
                  <button type="button" className="btn-secondary btn-sm" onClick={() => addUserAllowlistRow()}>
                    + Add user ID
                  </button>
                </div>
                <label className="schedule-field">
                  <span>Cooldown (ms)</span>
                  <input
                    type="text"
                    inputMode="numeric"
                    value={form.discordCooldownMsField}
                    onChange={(e) => setForm((f) => ({ ...f, discordCooldownMsField: e.target.value }))}
                    placeholder="Default 1200 when empty"
                  />
                  <small className="field-hint">
                    Minimum time between handled messages per channel. Use 0 to disable. Leave blank for gateway default (1200 ms). When editing, blank keeps the saved value.
                  </small>
                </label>
              </>
            )}

            {/* Chrome Extension Info */}
            {form.type === "chrome_extension" && (
              <div className="chrome-ext-info">
                <h4>Chrome extension setup</h4>
                <ol>
                  <li>Open <code>chrome://extensions</code></li>
                  <li>Turn on Developer mode</li>
                  <li>Click <strong>Load unpacked</strong></li>
                  <li>Select the <code>BEEBRIDGE/extension</code> folder</li>
                  <li>In the popup, set the Gateway URL and Token, then connect</li>
                </ol>
              </div>
            )}

            {/* Capabilities */}
            <div className="schedule-field">
              <span>Capabilities</span>
              <div className="cap-grid">
                {ALL_CAPABILITIES.map((cap) => (
                  <label key={cap} className="cap-checkbox">
                    <input
                      type="checkbox"
                      checked={form.capabilities.includes(cap)}
                      onChange={() => toggleCapability(cap)}
                    />
                    <span>{cap}</span>
                  </label>
                ))}
              </div>
            </div>

            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => { setTab("list"); setEditingId(null); }}>Cancel</button>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? "Saving..." : editingId ? "Save" : "Add"}
              </button>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
