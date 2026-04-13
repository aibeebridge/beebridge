"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { useGateway, parseGatewayJsonBody, gatewayWsUrl } from "../../context/gateway";
import Link from "next/link";

/** In browser DevTools console, filter by `[beebridge][task-delete]` */
function debugTaskDelete(phase: string, payload?: Record<string, unknown>): void {
  if (typeof console !== "undefined" && console.debug) {
    console.debug(`[beebridge][task-delete] ${phase}`, payload ?? {});
  }
}

interface BeeTask {
  id: string;
  title: string;
  districtId?: string;
  cityId?: string;
  bee?: string;
  flower?: string;
  priority?: string;
  status?: string;
  dueDate?: string;
  requiresApproval?: boolean;
  personaId?: string;
}

interface TaskConversation {
  jobId: string;
  beeId: string;
  status: "running" | "done" | "failed";
  entries: unknown[];
}

type WaggleMode = "off" | "browser" | "api";

interface WaggleConfig {
  enabled: boolean;
  mode: WaggleMode;
  browserTargetUrl?: string;
  apiProviderId?: string;
  apiModel?: string;
  apiKey?: string;
  autoDetect: boolean;
  allowBrowserBeforeFirstWaggle?: boolean;
}

interface BeeDistrict {
  id: string;
  title: string;
  objective?: string;
  status?: string;
  waggle?: WaggleConfig;
  /** false = do not inject automatic upstream context in bridge runs */
  useUpstreamBridgeContext?: boolean;
}

type Column = "pending" | "approved" | "working" | "failed" | "done";

const COLUMNS: { id: Column; label: string; icon: string }[] = [
  { id: "pending", label: "Planned", icon: "📐" },
  { id: "approved", label: "Approved", icon: "✅" },
  { id: "working", label: "Building", icon: "🔨" },
  { id: "failed", label: "Blocked", icon: "🚧" },
  { id: "done", label: "Built", icon: "🏛️" },
];

function taskToColumn(task: BeeTask, isPending: boolean, convStatus?: string): Column {
  if (convStatus === "running") return "working";
  if (convStatus === "done") return "done";
  if (convStatus === "failed") return "failed";
  if (isPending) return "pending";
  const s = task.status ?? "approved";
  if (s === "working") return "working";
  if (s === "done") return "done";
  return "approved";
}

function districtProgress(tasks: Array<BeeTask & { _column: Column }>): { done: number; total: number; percent: number } {
  const total = tasks.length;
  const done = tasks.filter((t) => t._column === "done").length;
  return { done, total, percent: total > 0 ? Math.round((done / total) * 100) : 0 };
}

/** Matches gateway `UNASSIGNED_DISTRICT_ID`: tasks with no / stale district land here in the UI. */
const UNASSIGNED_DISTRICT_ID = "district-unassigned";

function effectiveDistrictIdForTask(task: BeeTask, districts: BeeDistrict[]): string {
  const tid = task.districtId?.trim();
  if (tid && districts.some((d) => d.id === tid)) return tid;
  return UNASSIGNED_DISTRICT_ID;
}

const DEFAULT_WAGGLE: WaggleConfig = { enabled: false, mode: "off", autoDetect: true };

function DistrictWaggleFields({
  waggle,
  onWaggleChange,
}: {
  waggle: WaggleConfig;
  onWaggleChange: (next: WaggleConfig) => void;
}) {
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "0.5rem", padding: "0.75rem", background: "var(--bg-secondary, #f8f9fa)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
        <label style={{ fontWeight: 600, fontSize: "0.9rem" }}>Waggle Mode</label>
        <input
          type="checkbox"
          checked={waggle.enabled}
          onChange={(e) =>
            onWaggleChange({
              ...waggle,
              enabled: e.target.checked,
              mode: e.target.checked ? (waggle.mode === "off" ? "browser" : waggle.mode) : "off",
            })
          }
        />
        <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>
          {waggle.enabled ? "Enabled" : "Disabled"}
        </span>
      </div>

      {waggle.enabled && (
        <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <label style={{ fontSize: "0.85rem", minWidth: "4rem" }}>Mode:</label>
            <select
              className="input"
              value={waggle.mode}
              onChange={(e) => onWaggleChange({ ...waggle, mode: e.target.value as WaggleMode })}
              style={{ flex: 1 }}
            >
              <option value="browser">Browser — Chrome relay (Flower)</option>
              <option value="api">API — direct call</option>
            </select>
          </div>

          {waggle.mode === "browser" && (
            <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", margin: 0, lineHeight: 1.45 }}>
              The executing Bee is the <strong>hands (browser automation)</strong> role; the web AI you configure is the{" "}
              <strong>upper advisor</strong>. For each task, after syncing plan and approach with <strong>waggle_ask</strong> first, it
              proceeds with Flower for navigation, snapshot, click, and input. If blocked, it asks again via waggle_ask and repeats. Flower
              keeps <strong>one automation tab</strong>; later navigation changes only the URL in that tab instead of opening new tabs.
              Flower must be connected to the gateway.
            </p>
          )}

          {waggle.mode === "browser" && (() => {
            const PRESET_URLS = ["https://chatgpt.com", "https://claude.ai", "https://gemini.google.com"];
            const currentUrl = waggle.browserTargetUrl || "https://chatgpt.com";
            const isCustom = !PRESET_URLS.includes(currentUrl);
            return (
              <>
                <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                  <label style={{ fontSize: "0.85rem", minWidth: "4rem" }}>URL:</label>
                  <select
                    className="input"
                    value={isCustom ? "custom" : currentUrl}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === "custom") onWaggleChange({ ...waggle, browserTargetUrl: "" });
                      else onWaggleChange({ ...waggle, browserTargetUrl: val });
                    }}
                    style={{ flex: 1 }}
                  >
                    <option value="https://chatgpt.com">ChatGPT</option>
                    <option value="https://claude.ai">Claude</option>
                    <option value="https://gemini.google.com">Gemini</option>
                    <option value="custom">Custom URL...</option>
                  </select>
                </div>
                {isCustom && (
                  <input
                    type="text"
                    className="input"
                    placeholder="https://your-ai-site.com"
                    value={currentUrl}
                    onChange={(e) => onWaggleChange({ ...waggle, browserTargetUrl: e.target.value })}
                  />
                )}
              </>
            );
          })()}

          {waggle.mode === "api" && (
            <>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <label style={{ fontSize: "0.85rem", minWidth: "4rem" }}>Provider:</label>
                <select
                  className="input"
                  value={waggle.apiProviderId || "openai"}
                  onChange={(e) => onWaggleChange({ ...waggle, apiProviderId: e.target.value })}
                  style={{ flex: 1 }}
                >
                  <option value="openai">OpenAI</option>
                  <option value="anthropic">Anthropic</option>
                  <option value="google">Google</option>
                  <option value="github-copilot">GitHub Copilot</option>
                </select>
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <label style={{ fontSize: "0.85rem", minWidth: "4rem" }}>Model:</label>
                <input
                  type="text"
                  className="input"
                  placeholder="e.g. gpt-4o, claude-3.5-sonnet"
                  value={waggle.apiModel || ""}
                  onChange={(e) => onWaggleChange({ ...waggle, apiModel: e.target.value })}
                  style={{ flex: 1 }}
                />
              </div>
              <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
                <label style={{ fontSize: "0.85rem", minWidth: "4rem" }}>API Key:</label>
                <input
                  type="password"
                  className="input"
                  placeholder="Leave empty to use active profile"
                  value={waggle.apiKey || ""}
                  onChange={(e) => onWaggleChange({ ...waggle, apiKey: e.target.value })}
                  style={{ flex: 1 }}
                />
              </div>
              <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", margin: 0, lineHeight: 1.45 }}>
                API mode works the same way: the harness requires the <strong>first waggle_ask</strong> and at least one upper-model
                response before completion. After that, the Bee performs browser work and asks the API upper model again whenever blocked.
              </p>
            </>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
            <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
              <input
                type="checkbox"
                checked={waggle.autoDetect}
                onChange={(e) => onWaggleChange({ ...waggle, autoDetect: e.target.checked })}
              />
              <label style={{ fontSize: "0.85rem" }}>
                Additional preemptive waggle (for heavy analysis/reasoning steps, ask first)
              </label>
            </div>
            <p style={{ fontSize: "0.75rem", color: "var(--text-secondary)", margin: 0, marginLeft: "1.5rem" }}>
              The harness handles the first waggle_ask and at least one successful response before completion — always enforced. When off:
              beyond that, mostly when blocked. When on: also encourages preemptive waggle_ask in heavy analysis/reasoning steps.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function CityBoardPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { apiFetch, url, token } = useGateway();
  const [tasks, setTasks] = useState<Array<BeeTask & { _column: Column; _convStatus?: string }>>([]);
  const [districts, setDistricts] = useState<BeeDistrict[]>([]);
  const [loading, setLoading] = useState(true);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<"city" | "kanban">("city");

  const [districtPanelMode, setDistrictPanelMode] = useState<null | "create" | "edit">(null);
  const [districtPanelId, setDistrictPanelId] = useState<string | null>(null);
  const [districtForm, setDistrictForm] = useState<{
    title: string;
    objective: string;
    waggle: WaggleConfig;
    useUpstreamBridgeContext: boolean;
  }>({
    title: "",
    objective: "",
    waggle: DEFAULT_WAGGLE,
    useUpstreamBridgeContext: true,
  });
  const [saving, setSaving] = useState(false);

  const loadDistricts = useCallback(async () => {
    try {
      const data = await apiFetch("/api/districts");
      const districtList: BeeDistrict[] = Array.isArray(data.districts) ? data.districts : [];
      setDistricts(districtList);
    } catch {
      // fallback: derive from tasks
    }
  }, [apiFetch]);

  const loadTasks = useCallback(async () => {
    try {
      const [approvalData, convData, jobsData] = await Promise.all([
        apiFetch("/api/approvals"),
        apiFetch("/api/jobs/conversations").catch(() => ({ conversations: [] })),
        apiFetch("/api/jobs").catch(() => ({ jobs: [], tasks: [] })),
      ]);

      const pending: BeeTask[] = Array.isArray(approvalData.pendingBeeApprovals) ? approvalData.pendingBeeApprovals : [];
      const approved: BeeTask[] = Array.isArray(approvalData.approvedBeeJobs) ? approvalData.approvedBeeJobs : [];
      const conversations: TaskConversation[] = Array.isArray(convData.conversations) ? convData.conversations : [];
      const convMap = new Map(conversations.map((c) => [c.jobId, c.status]));

      const allJobs = Array.isArray(jobsData.tasks) ? jobsData.tasks : (Array.isArray(jobsData.jobs) ? jobsData.jobs : []);

      const districtMap = new Map<string, BeeDistrict>();
      for (const t of allJobs) {
        if (t.districtId && !districtMap.has(t.districtId)) {
          districtMap.set(t.districtId, {
            id: t.districtId,
            title: t.districtId.replace("district-", "").replace(/-/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()) + " District",
          });
        }
      }

      const pendingIds = new Set(pending.map((t) => t.id));

      type Row = BeeTask & { _column: Column; _convStatus?: string };
      const byId = new Map<string, Row>();

      // Canonical list: gateway allTasks (unique ids). Avoids duplicate keys when the same id appears in both pending and approved.
      for (const t of allJobs) {
        const isPending = pendingIds.has(t.id);
        byId.set(t.id, {
          ...t,
          _column: taskToColumn(t, isPending, convMap.get(t.id)),
          _convStatus: convMap.get(t.id),
        });
      }

      for (const t of pending) {
        if (byId.has(t.id)) continue;
        byId.set(t.id, {
          ...t,
          _column: taskToColumn(t, true, convMap.get(t.id)),
          _convStatus: convMap.get(t.id),
        });
      }
      for (const t of approved) {
        if (byId.has(t.id)) continue;
        byId.set(t.id, {
          ...t,
          _column: taskToColumn(t, false, convMap.get(t.id)),
          _convStatus: convMap.get(t.id),
        });
      }

      setTasks([...byId.values()]);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tasks");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  const loadAll = useCallback(async () => {
    await Promise.all([loadDistricts(), loadTasks()]);
  }, [loadDistricts, loadTasks]);

  function openDistrictPanelCreate() {
    setDistrictPanelMode("create");
    setDistrictPanelId(null);
    setDistrictForm({ title: "", objective: "", waggle: DEFAULT_WAGGLE, useUpstreamBridgeContext: true });
  }

  const openDistrictPanelEdit = useCallback((district: BeeDistrict) => {
    setDistrictPanelMode("edit");
    setDistrictPanelId(district.id);
    setDistrictForm({
      title: district.title,
      objective: district.objective ?? "",
      waggle: district.waggle ?? DEFAULT_WAGGLE,
      useUpstreamBridgeContext: district.useUpstreamBridgeContext !== false,
    });
  }, []);

  function closeDistrictPanel() {
    setDistrictPanelMode(null);
    setDistrictPanelId(null);
  }

  async function submitDistrictPanel() {
    if (!districtForm.title.trim()) return;
    setSaving(true);
    try {
      if (districtPanelMode === "create") {
        await apiFetch("/api/districts", {
          method: "POST",
          body: JSON.stringify({
            title: districtForm.title,
            objective: districtForm.objective,
            waggle: districtForm.waggle,
            useUpstreamBridgeContext: districtForm.useUpstreamBridgeContext,
          }),
        });
      } else if (districtPanelMode === "edit" && districtPanelId) {
        await apiFetch(`/api/districts/${districtPanelId}`, {
          method: "PUT",
          body: JSON.stringify({
            title: districtForm.title,
            objective: districtForm.objective,
            waggle: districtForm.waggle,
            useUpstreamBridgeContext: districtForm.useUpstreamBridgeContext,
          }),
        });
      }
      closeDistrictPanel();
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save district");
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteDistrict(districtId: string) {
    if (!confirm("Are you sure you want to delete this district and all its tasks?")) return;
    try {
      await apiFetch(`/api/districts/${districtId}`, { method: "DELETE" });
      loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete district");
    }
  }

  async function handleRetry(taskId: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setRetryingId(taskId);
    try {
      await apiFetch(`/api/jobs/${taskId}/retry`, { method: "POST" });
      loadTasks();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetryingId(null);
    }
  }

  async function handleDeleteTask(taskId: string, e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    const path = `/api/jobs/${encodeURIComponent(taskId)}/delete`;
    debugTaskDelete("trash:click", { taskId, path });
    if (!confirm("Delete this task? This cannot be undone.")) {
      debugTaskDelete("trash:cancelled", { taskId });
      return;
    }
    setDeletingId(taskId);
    try {
      debugTaskDelete("trash:request", { taskId, method: "POST", path });
      const res = await apiFetch(path, {
        method: "POST",
        body: JSON.stringify({}),
      });
      debugTaskDelete("trash:response_ok", { taskId, response: res });
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      setError("");
      await loadAll();
      debugTaskDelete("trash:loadAll_done", { taskId });
    } catch (err) {
      debugTaskDelete("trash:error", {
        taskId,
        message: err instanceof Error ? err.message : String(err),
      });
      setError(err instanceof Error ? err.message : "Failed to delete task");
    } finally {
      setDeletingId(null);
    }
  }

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    const raw = searchParams.get("editDistrict");
    if (!raw) return;
    const id = raw.trim();
    if (!id) return;

    let cancelled = false;
    (async () => {
      const fromList = districts.find((d) => d.id === id);
      if (fromList) {
        openDistrictPanelEdit(fromList);
        router.replace("/jobs", { scroll: false });
        return;
      }
      if (loading) return;
      try {
        const data = await apiFetch(`/api/districts/${encodeURIComponent(id)}`);
        if (cancelled) return;
        const d = data.district as BeeDistrict | undefined;
        if (d) {
          openDistrictPanelEdit(d);
          router.replace("/jobs", { scroll: false });
        } else {
          setError("District not found.");
          router.replace("/jobs", { scroll: false });
        }
      } catch {
        if (!cancelled) {
          setError("Failed to load district.");
          router.replace("/jobs", { scroll: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [searchParams, districts, loading, apiFetch, router, openDistrictPanelEdit]);

  useEffect(() => {
    const wsUrl = gatewayWsUrl(url, token);
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl); } catch { return; }
    ws.onopen = () => ws.send(JSON.stringify({ type: "web.register" }));
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw.trim()) return;
      try {
        const msg = parseGatewayJsonBody(raw, "ws") as { type?: string };
        if (msg.type === "districts.updated") loadAll();
        else loadTasks();
      } catch {
        /* ignore non-JSON frames */
      }
    };
    return () => ws.close();
  }, [url, token, loadAll, loadTasks]);

  if (loading) return <div className="page-loading">Loading...</div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Districts</h1>
          <p className="page-subtitle">
            {districts.length} districts &middot; {tasks.length} tasks
          </p>
        </div>
        <div className="header-actions">
          <div className="view-toggle">
            <button
              className={`btn-toggle ${viewMode === "city" ? "active" : ""}`}
              onClick={() => setViewMode("city")}
            >
              Districts
            </button>
            <button
              className={`btn-toggle ${viewMode === "kanban" ? "active" : ""}`}
              onClick={() => setViewMode("kanban")}
            >
              Kanban
            </button>
          </div>
          <button className="btn-secondary" onClick={() => loadAll()}>Refresh</button>
          <button className="btn-primary" onClick={openDistrictPanelCreate}>+ New District</button>
          <Link href="/jobs/new" className="btn-secondary">+ New Task</Link>
        </div>
      </header>

      {error && <p className="page-error">{error}</p>}

      {districtPanelMode && (
        <section className="panel" style={{ marginBottom: "1rem" }}>
          <h3 style={{ margin: "0 0 0.75rem 0" }}>
            {districtPanelMode === "create" ? "Create New District" : "Edit District"}
          </h3>
          <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
            <input
              type="text"
              placeholder="District name"
              value={districtForm.title}
              onChange={(e) => setDistrictForm((f) => ({ ...f, title: e.target.value }))}
              className="input"
              autoFocus
            />
            <input
              type="text"
              placeholder="Objective (optional)"
              value={districtForm.objective}
              onChange={(e) => setDistrictForm((f) => ({ ...f, objective: e.target.value }))}
              className="input"
            />
            <DistrictWaggleFields
              waggle={districtForm.waggle}
              onWaggleChange={(w) => setDistrictForm((f) => ({ ...f, waggle: w }))}
            />
            <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
              <input
                type="checkbox"
                checked={districtForm.useUpstreamBridgeContext}
                onChange={(e) => setDistrictForm((f) => ({ ...f, useUpstreamBridgeContext: e.target.checked }))}
              />
              Automatically includes previous district context from bridge pipeline (when off, only <code>{"{{bridgeOut:taskId}}"}</code> is used)
            </label>
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button
                className="btn-primary"
                onClick={submitDistrictPanel}
                disabled={saving || !districtForm.title.trim()}
              >
                {saving ? (districtPanelMode === "create" ? "Creating..." : "Saving...") : districtPanelMode === "create" ? "Create" : "Save"}
              </button>
              <button className="btn-secondary" onClick={closeDistrictPanel}>Cancel</button>
            </div>
          </div>
        </section>
      )}

      {viewMode === "city" ? (
        <div className="city-districts">
          {districts.length === 0 && tasks.length === 0 && !districtPanelMode && (
            <div className="empty-city">
              <p className="empty-city-text">No districts built yet. Create a new district or task to get started.</p>
              <button className="btn-primary" onClick={openDistrictPanelCreate}>+ Build First District</button>
            </div>
          )}

          {districts.map((district) => {
            const districtTasks = tasks.filter((t) => effectiveDistrictIdForTask(t, districts) === district.id);
            const progress = districtProgress(districtTasks);
            return (
              <section key={district.id} className="district-section">
                <header className="district-header">
                  <div className="district-title-row">
                    <span className="district-icon">🏗️</span>
                    <h2>{district.title}</h2>
                    <span className="district-count">{districtTasks.length} tasks</span>
                    <div style={{ marginLeft: "auto", display: "flex", gap: "0.25rem" }}>
                      {district.id !== UNASSIGNED_DISTRICT_ID && (
                        <>
                          <button
                            className="btn-icon"
                            title="Edit district"
                            onClick={() => openDistrictPanelEdit(district)}
                          >✏️</button>
                          <button
                            className="btn-icon"
                            title="Delete district"
                            onClick={() => handleDeleteDistrict(district.id)}
                          >🗑️</button>
                        </>
                      )}
                    </div>
                  </div>
                  {district.objective && (
                    <p className="district-objective">{district.objective}</p>
                  )}
                  {district.waggle?.enabled && (
                    <span style={{ fontSize: "0.75rem", background: "#fbbf24", color: "#1a1a1a", padding: "0.15rem 0.5rem", borderRadius: "0.25rem", fontWeight: 600 }}>
                      Waggle: {district.waggle.mode === "browser" ? "Chrome Relay" : "API"}
                    </span>
                  )}
                  <div className="district-progress">
                    <div className="progress-bar">
                      <div className="progress-fill" style={{ width: `${progress.percent}%` }} />
                    </div>
                    <span className="progress-text">{progress.done}/{progress.total} built ({progress.percent}%)</span>
                  </div>
                </header>

                <div className="district-tasks">
                  {districtTasks.length === 0 && <p className="empty-lane">No tasks in this district</p>}
                  {districtTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      retryingId={retryingId}
                      deletingId={deletingId}
                      onRetry={handleRetry}
                      onDelete={handleDeleteTask}
                    />
                  ))}
                </div>
              </section>
            );
          })}

          {(() => {
            if (districts.some((d) => d.id === UNASSIGNED_DISTRICT_ID)) return null;
            const unassigned = tasks.filter((t) => effectiveDistrictIdForTask(t, districts) === UNASSIGNED_DISTRICT_ID);
            if (unassigned.length === 0) return null;
            return (
              <section className="district-section district-unassigned">
                <header className="district-header">
                  <div className="district-title-row">
                    <span className="district-icon">📦</span>
                    <h2>Unassigned Tasks</h2>
                    <span className="district-count">{unassigned.length} tasks</span>
                  </div>
                </header>
                <div className="district-tasks">
                  {unassigned.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      retryingId={retryingId}
                      deletingId={deletingId}
                      onRetry={handleRetry}
                      onDelete={handleDeleteTask}
                    />
                  ))}
                </div>
              </section>
            );
          })()}
        </div>
      ) : (
        <div className="kanban-grid">
          {COLUMNS.map((col) => {
            const colTasks = tasks.filter((t) => t._column === col.id);
            return (
              <div key={col.id} className="kanban-column">
                <header>
                  <h3>{col.icon} {col.label}</h3>
                  <span>{colTasks.length}</span>
                </header>
                <div className="kanban-cards">
                  {colTasks.length === 0 && <p className="empty-lane">None</p>}
                  {colTasks.map((task) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      retryingId={retryingId}
                      deletingId={deletingId}
                      onRetry={handleRetry}
                      onDelete={handleDeleteTask}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TaskCard({
  task,
  retryingId,
  deletingId,
  onRetry,
  onDelete,
}: {
  task: BeeTask & { _column: Column; _convStatus?: string };
  retryingId: string | null;
  deletingId: string | null;
  onRetry: (taskId: string, e: React.MouseEvent) => void;
  onDelete?: (taskId: string, e: React.MouseEvent) => void;
}) {
  const jobHref = `/jobs/${encodeURIComponent(task.id)}`;
  return (
    <div className="task-card task-card-with-actions">
      <Link href={jobHref} className="task-card-link">
        <div className="task-card-top">
          <div className="task-card-title-cluster">
            <strong>{task.title}</strong>
            <span className="task-card-status-dots">
              {task._convStatus === "running" && <span className="status-dot running" />}
              {task._convStatus === "done" && <span className="status-dot done" />}
              {task._convStatus === "failed" && <span className="status-dot failed" />}
            </span>
          </div>
        </div>
        <div className="task-meta">
          {task.bee && <span>Bee: {task.bee}</span>}
          {task.flower && <span>Flower: {task.flower}</span>}
        </div>
        <div className="task-tags">
          {task.priority && <span className={`priority-tag ${task.priority}`}>{task.priority}</span>}
          {task.dueDate && <span className="due-tag">{task.dueDate}</span>}
          {task.requiresApproval && <span className="approval-badge">Approval</span>}
          {task.districtId && <span className="district-badge">{task.districtId.replace("district-", "")}</span>}
        </div>
      </Link>
      {onDelete && (
        <button
          type="button"
          className="btn-icon task-card-delete-btn"
          title="Delete task"
          aria-label="Delete task"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onDelete(task.id, e);
          }}
          disabled={deletingId === task.id}
        >
          {deletingId === task.id ? "…" : "🗑️"}
        </button>
      )}
      {task._convStatus === "failed" && (
        <div className="task-card-retry-wrap">
          <button
            type="button"
            className="btn-retry-small"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRetry(task.id, e);
            }}
            disabled={retryingId === task.id}
          >
            {retryingId === task.id ? "..." : "Restart"}
          </button>
        </div>
      )}
    </div>
  );
}

export default function JobsPage() {
  return (
    <Suspense fallback={<div className="page-loading">Loading...</div>}>
      <CityBoardPage />
    </Suspense>
  );
}
