"use client";

import { useEffect, useState, useCallback, useRef, type CSSProperties } from "react";
import { useGateway } from "../../context/gateway";

interface BeeJob {
  id: string;
  title: string;
  bee?: string;
  flower?: string;
  priority?: string;
  requiresApproval?: boolean;
  districtId?: string;
  personaId?: string;
}

interface DistrictInfo {
  id: string;
  title: string;
}

interface QueueResult {
  taskId: string;
  status: string;
  output: string;
}

interface DistrictResult {
  districtId: string;
  districtTitle: string;
  tasks: { taskId: string; title: string; bee: string; status: string; output: string }[];
}

function groupByDistrict<T extends { districtId?: string }>(
  items: T[],
  districts: DistrictInfo[],
): { district: DistrictInfo | null; items: T[] }[] {
  const map = new Map<string, T[]>();
  const unassigned: T[] = [];

  for (const item of items) {
    if (item.districtId) {
      const list = map.get(item.districtId) ?? [];
      list.push(item);
      map.set(item.districtId, list);
    } else {
      unassigned.push(item);
    }
  }

  const groups: { district: DistrictInfo | null; items: T[] }[] = [];

  for (const [districtId, groupItems] of map.entries()) {
    const district = districts.find((d) => d.id === districtId) ?? { id: districtId, title: districtId };
    groups.push({ district, items: groupItems });
  }

  if (unassigned.length > 0) {
    groups.push({ district: null, items: unassigned });
  }

  return groups;
}

function isQueueRunLoading(loading: string | null): boolean {
  if (!loading) return false;
  return loading === "run-all" || loading.startsWith("run-one:") || loading.startsWith("run-scope:");
}

function groupByBee(items: BeeJob[]): { key: string; label: string; items: BeeJob[] }[] {
  const map = new Map<string, BeeJob[]>();
  for (const item of items) {
    const key = item.personaId?.trim() || item.bee?.trim() || "__unknown__";
    const list = map.get(key) ?? [];
    list.push(item);
    map.set(key, list);
  }
  return [...map.entries()].map(([key, groupItems]) => ({
    key,
    label: groupItems[0]?.bee?.trim() || groupItems[0]?.personaId || key,
    items: groupItems,
  }));
}

export default function ApprovalsPage() {
  const { apiFetch } = useGateway();
  const [pending, setPending] = useState<BeeJob[]>([]);
  const [approved, setApproved] = useState<BeeJob[]>([]);
  const [districts, setDistricts] = useState<DistrictInfo[]>([]);
  const [runResults, setRunResults] = useState<QueueResult[]>([]);
  const [districtResults, setDistrictResults] = useState<DistrictResult[]>([]);
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState("");
  /** Shared: pending and approved lists can both be viewed grouped by district / bee. */
  const [listView, setListView] = useState<"district" | "bee">("district");
  /** Prevent double-clicks until the queue run request finishes (guards against concurrent clicks before re-render). */
  const queueRunLockRef = useRef(false);

  const loadData = useCallback(async () => {
    try {
      const [approvalData, districtData] = await Promise.all([
        apiFetch("/api/approvals"),
        apiFetch("/api/districts").catch(() => ({ districts: [] })),
      ]);
      setPending(Array.isArray(approvalData.pendingBeeApprovals) ? approvalData.pendingBeeApprovals : []);
      setApproved(Array.isArray(approvalData.approvedBeeJobs) ? approvalData.approvedBeeJobs : []);
      setDistricts(Array.isArray(districtData.districts) ? districtData.districts : []);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => { loadData(); }, [loadData]);

  async function handleApprove(taskId: string) {
    setActionLoading(taskId);
    try {
      await apiFetch(`/api/approvals/${taskId}/approve`, { method: "POST" });
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Approval failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApproveAll() {
    setActionLoading("all");
    try {
      for (const job of pending) {
        await apiFetch(`/api/approvals/${job.id}/approve`, { method: "POST" });
      }
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bulk approval failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApproveDistrict(districtKey: string) {
    const loadingKey = `district:${districtKey}`;
    setActionLoading(loadingKey);
    try {
      await apiFetch("/api/approvals/bulk", {
        method: "POST",
        body: JSON.stringify({ scope: "district", id: districtKey }),
      });
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "District approval failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleApproveBee(beeKey: string) {
    const loadingKey = `bee:${beeKey}`;
    setActionLoading(loadingKey);
    try {
      await apiFetch("/api/approvals/bulk", {
        method: "POST",
        body: JSON.stringify({ scope: "bee", id: beeKey }),
      });
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Bee approval failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function applyQueueRunResponse(data: {
    beeRuns?: QueueResult[];
    districtResults?: DistrictResult[];
    summary?: string;
  }): Promise<void> {
    setRunResults(Array.isArray(data.beeRuns) ? data.beeRuns : []);
    setDistrictResults(Array.isArray(data.districtResults) ? data.districtResults : []);
    setSummary(data.summary ?? "");
    await loadData();
  }

  /** Run queue for a single approved job only (same runner as full Run, one target). */
  async function handleRunOneApproved(taskId: string) {
    if (queueRunLockRef.current) return;
    queueRunLockRef.current = true;
    setActionLoading(`run-one:${taskId}`);
    try {
      const data = await apiFetch(`/api/queue/run/${encodeURIComponent(taskId)}`, { method: "POST" });
      await applyQueueRunResponse(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution failed");
    } finally {
      queueRunLockRef.current = false;
      setActionLoading(null);
    }
  }

  /** Run queue for only the matching district or bee among approved jobs. */
  async function handleRunApprovedScope(scope: "district" | "bee", id: string) {
    if (queueRunLockRef.current) return;
    queueRunLockRef.current = true;
    setActionLoading(`run-scope:${scope}:${id}`);
    try {
      const data = await apiFetch("/api/queue/run-scope", {
        method: "POST",
        body: JSON.stringify({ scope, id }),
      });
      await applyQueueRunResponse(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Scoped execution failed");
    } finally {
      queueRunLockRef.current = false;
      setActionLoading(null);
    }
  }

  /** Run all approved jobs at once (full queue). */
  async function handleRunQueue() {
    if (queueRunLockRef.current) return;
    queueRunLockRef.current = true;
    setActionLoading("run-all");
    try {
      const data = await apiFetch("/api/queue/run", { method: "POST" });
      await applyQueueRunResponse(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Execution failed");
    } finally {
      queueRunLockRef.current = false;
      setActionLoading(null);
    }
  }

  if (loading) return <div className="page-loading">Loading...</div>;

  const queueRunInProgress = isQueueRunLoading(actionLoading);

  const pendingGroups = groupByDistrict(pending, districts);
  const approvedGroups = groupByDistrict(approved, districts);
  const pendingBeeGroups = groupByBee(pending);
  const approvedBeeGroups = groupByBee(approved);

  const toggleBase: CSSProperties = {
    padding: "8px 14px",
    borderRadius: "8px",
    fontSize: "13px",
    fontWeight: 600,
    cursor: "pointer",
    border: "1px solid var(--border, #ccc)",
  };

  const listViewToggle = (
    <div
      role="tablist"
      aria-label="District or bee grouping"
      style={{
        display: "flex",
        gap: "8px",
        marginBottom: "8px",
        flexWrap: "wrap",
        alignItems: "center",
      }}
    >
      <button
        type="button"
        role="tab"
        aria-selected={listView === "district"}
        style={{
          ...toggleBase,
          background: listView === "district" ? "var(--accent, #2563eb)" : "var(--bg-2, #f4f4f5)",
          color: listView === "district" ? "#fff" : "inherit",
          borderColor: listView === "district" ? "var(--accent, #2563eb)" : "var(--border, #ccc)",
        }}
        onClick={() => setListView("district")}
      >
        By district
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={listView === "bee"}
        style={{
          ...toggleBase,
          background: listView === "bee" ? "var(--accent, #2563eb)" : "var(--bg-2, #f4f4f5)",
          color: listView === "bee" ? "#fff" : "inherit",
          borderColor: listView === "bee" ? "var(--accent, #2563eb)" : "var(--border, #ccc)",
        }}
        onClick={() => setListView("bee")}
      >
        By bee
      </button>
    </div>
  );

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Approvals</h1>
        <p className="page-subtitle">{pending.length} pending · {approved.length} approved</p>
      </header>

      {error && <p className="page-error">{error}</p>}

      <div
        className="panel"
        style={{
          marginBottom: "1rem",
          padding: "1rem 1.25rem",
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: "8px",
          background: "var(--bg-1, #fafafa)",
        }}
      >
        {listViewToggle}
        <p style={{ fontSize: "13px", lineHeight: 1.5, margin: 0, opacity: 0.9 }}>
          View lists grouped by <strong>By district</strong> or <strong>By bee</strong>. After approval,{" "}
          <strong>Run</strong> enqueues only that job, or use <strong>Run · district/bee</strong> on a group to run that scope only.{" "}
          <strong>Run All</strong> runs every approved job in one go.
        </p>
      </div>

      <section className="panel approval-section">
        <div className="section-header">
          <h2>Pending Approval</h2>
          {pending.length > 0 && (
            <button
              className="btn-primary"
              onClick={handleApproveAll}
              disabled={actionLoading === "all"}
            >
              {actionLoading === "all" ? "Processing..." : `Approve All (${pending.length})`}
            </button>
          )}
        </div>
        {pending.length === 0 ? (
          <p className="empty-text">No jobs pending approval.</p>
        ) : listView === "district" ? (
          pendingGroups.map((group) => {
            const districtKey = group.district?.id ?? "__unassigned__";
            const districtLoading = actionLoading === `district:${districtKey}`;
            return (
              <div key={group.district?.id ?? "unassigned"} style={{ marginBottom: "1rem" }}>
                <h3
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    margin: "0.75rem 0 0.5rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    flexWrap: "wrap",
                  }}
                >
                  <span>🏗️</span>
                  {group.district?.title ?? "Unassigned"}
                  <span style={{ fontWeight: 400, opacity: 0.6 }}>({group.items.length})</span>
                  {group.items.length > 0 && (
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ fontSize: "12px", padding: "4px 10px" }}
                      onClick={() => handleApproveDistrict(districtKey)}
                      disabled={districtLoading}
                    >
                      {districtLoading ? "…" : `Approve district (${group.items.length})`}
                    </button>
                  )}
                </h3>
                <ul className="approval-list">
                  {group.items.map((job) => (
                    <li key={job.id} className="approval-item">
                      <div>
                        <strong>{job.title}</strong>
                        <div className="approval-meta">
                          {job.bee && <span>🐝 {job.bee}</span>}
                          {job.flower && <span>🌸 {job.flower}</span>}
                          {job.priority && <span className={`priority-tag ${job.priority}`}>{job.priority}</span>}
                        </div>
                      </div>
                      <button
                        className="btn-primary"
                        onClick={() => handleApprove(job.id)}
                        disabled={actionLoading === job.id}
                      >
                        {actionLoading === job.id ? "..." : "Approve"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        ) : (
          pendingBeeGroups.map((group) => {
            const beeLoading = actionLoading === `bee:${group.key}`;
            return (
              <div key={group.key} style={{ marginBottom: "1rem" }}>
                <h3
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    margin: "0.75rem 0 0.5rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    flexWrap: "wrap",
                  }}
                >
                  <span>🐝</span>
                  {group.label}
                  <span style={{ fontWeight: 400, opacity: 0.6 }}>({group.items.length})</span>
                  {group.items.length > 0 && (
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ fontSize: "12px", padding: "4px 10px" }}
                      onClick={() => handleApproveBee(group.key)}
                      disabled={beeLoading}
                    >
                      {beeLoading ? "…" : `Approve bee (${group.items.length})`}
                    </button>
                  )}
                </h3>
                <ul className="approval-list">
                  {group.items.map((job) => (
                    <li key={job.id} className="approval-item">
                      <div>
                        <strong>{job.title}</strong>
                        <div className="approval-meta">
                          {job.districtId && <span>🏗️ {districts.find((d) => d.id === job.districtId)?.title ?? job.districtId}</span>}
                          {job.flower && <span>🌸 {job.flower}</span>}
                          {job.priority && <span className={`priority-tag ${job.priority}`}>{job.priority}</span>}
                        </div>
                      </div>
                      <button
                        className="btn-primary"
                        onClick={() => handleApprove(job.id)}
                        disabled={actionLoading === job.id}
                      >
                        {actionLoading === job.id ? "..." : "Approve"}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </section>

      <section className="panel approval-section">
        <div className="section-header">
          <h2>Approved</h2>
          {approved.length > 0 && (
            <button
              className="btn-primary"
              type="button"
              onClick={handleRunQueue}
              disabled={queueRunInProgress}
              aria-busy={queueRunInProgress}
            >
              {actionLoading === "run-all" ? "Running" : `Run All (${approved.length})`}
            </button>
          )}
        </div>
        {approved.length === 0 ? (
          <p className="empty-text">No approved jobs.</p>
        ) : listView === "district" ? (
          approvedGroups.map((group) => {
            const districtKey = group.district?.id ?? "__unassigned__";
            const runDistActive = actionLoading === `run-scope:district:${districtKey}`;
            return (
              <div key={group.district?.id ?? "unassigned"} style={{ marginBottom: "1rem" }}>
                <h3
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    margin: "0.75rem 0 0.5rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    flexWrap: "wrap",
                  }}
                >
                  <span>🏗️</span>
                  {group.district?.title ?? "Unassigned"}
                  <span style={{ fontWeight: 400, opacity: 0.6 }}>({group.items.length})</span>
                  {group.items.length > 0 && (
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ fontSize: "12px", padding: "4px 10px" }}
                      onClick={() => handleRunApprovedScope("district", districtKey)}
                      disabled={queueRunInProgress}
                      aria-busy={runDistActive}
                      title="For this district, enqueue and run only approved jobs in this group."
                    >
                      {runDistActive ? "Running" : `Run · district (${group.items.length})`}
                    </button>
                  )}
                </h3>
                <ul className="approval-list">
                  {group.items.map((job) => (
                    <li key={job.id} className="approval-item done">
                      <div>
                        <strong>{job.title}</strong>
                        <div className="approval-meta">
                          {job.bee && <span>🐝 {job.bee}</span>}
                          {job.priority && <span className={`priority-tag ${job.priority}`}>{job.priority}</span>}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                        <span className="approved-badge">✓ Approved</span>
                        <button
                          type="button"
                          className="btn-primary"
                          style={{ fontSize: "12px", padding: "4px 10px" }}
                          onClick={() => handleRunOneApproved(job.id)}
                          disabled={queueRunInProgress}
                          aria-busy={actionLoading === `run-one:${job.id}`}
                        >
                          {actionLoading === `run-one:${job.id}` ? "Running" : "Run"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        ) : (
          approvedBeeGroups.map((group) => {
            const runBeeActive = actionLoading === `run-scope:bee:${group.key}`;
            return (
              <div key={group.key} style={{ marginBottom: "1rem" }}>
                <h3
                  style={{
                    fontSize: "14px",
                    fontWeight: 600,
                    margin: "0.75rem 0 0.5rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    flexWrap: "wrap",
                  }}
                >
                  <span>🐝</span>
                  {group.label}
                  <span style={{ fontWeight: 400, opacity: 0.6 }}>({group.items.length})</span>
                  {group.items.length > 0 && (
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ fontSize: "12px", padding: "4px 10px" }}
                      onClick={() => handleRunApprovedScope("bee", group.key)}
                      disabled={queueRunInProgress}
                      aria-busy={runBeeActive}
                      title="Bound to this Bee: enqueue and run only approved jobs tied to this bee."
                    >
                      {runBeeActive ? "Running" : `Run · bee (${group.items.length})`}
                    </button>
                  )}
                </h3>
                <ul className="approval-list">
                  {group.items.map((job) => (
                    <li key={job.id} className="approval-item done">
                      <div>
                        <strong>{job.title}</strong>
                        <div className="approval-meta">
                          {job.districtId && (
                            <span>
                              🏗️ {districts.find((d) => d.id === job.districtId)?.title ?? job.districtId}
                            </span>
                          )}
                          {job.priority && <span className={`priority-tag ${job.priority}`}>{job.priority}</span>}
                        </div>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                        <span className="approved-badge">✓ Approved</span>
                        <button
                          type="button"
                          className="btn-primary"
                          style={{ fontSize: "12px", padding: "4px 10px" }}
                          onClick={() => handleRunOneApproved(job.id)}
                          disabled={queueRunInProgress}
                          aria-busy={actionLoading === `run-one:${job.id}`}
                        >
                          {actionLoading === `run-one:${job.id}` ? "Running" : "Run"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })
        )}
      </section>

      {(runResults.length > 0 || summary) && (
        <section className="panel approval-section">
          <h2>Execution Report</h2>

          {summary && (
            <div style={{
              background: "var(--bg-2, #f5f5f5)",
              borderRadius: "8px",
              padding: "1rem",
              marginBottom: "1rem",
              fontFamily: "monospace",
              fontSize: "13px",
              whiteSpace: "pre-wrap",
              lineHeight: "1.6",
            }}>
              {summary}
            </div>
          )}

          {districtResults.length > 0 && districtResults.map((dr) => {
            const done = dr.tasks.filter((t) => t.status === "done").length;
            return (
              <div key={dr.districtId} style={{ marginBottom: "1.5rem" }}>
                <h3 style={{ fontSize: "14px", fontWeight: 600, margin: "0 0 0.5rem", display: "flex", alignItems: "center", gap: "6px" }}>
                  <span>🏗️</span>
                  {dr.districtTitle}
                  <span style={{ fontWeight: 400, opacity: 0.6 }}>{done}/{dr.tasks.length} completed</span>
                </h3>
                <ul className="result-list">
                  {dr.tasks.map((t) => (
                    <li key={t.taskId} className={`run-result ${t.status}`}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <strong>{t.title}</strong>
                        <span className="run-status">{t.status === "done" ? "✓ Done" : "✗ Failed"}</span>
                      </div>
                      {t.bee && <div style={{ fontSize: "12px", opacity: 0.6, marginTop: "4px" }}>Bee: {t.bee}</div>}
                      {t.output && (
                        <p style={{ marginTop: "8px", fontSize: "13px", background: "var(--bg-2, #f8f8f8)", padding: "8px 12px", borderRadius: "6px", whiteSpace: "pre-wrap" }}>
                          {t.output}
                        </p>
                      )}
                      {t.status === "failed" && (
                        <button
                          className="btn-danger btn-sm"
                          style={{ marginTop: 8 }}
                          onClick={async () => {
                            try {
                              await apiFetch(`/api/jobs/${t.taskId}/retry`, { method: "POST" });
                              await loadData();
                            } catch (e) {
                              setError(e instanceof Error ? e.message : "Retry failed");
                            }
                          }}
                        >
                          Restart
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}

          {districtResults.length === 0 && runResults.length > 0 && (
            <ul className="result-list">
              {runResults.map((r, i) => (
                <li key={i} className={`run-result ${r.status}`}>
                  <strong>{r.taskId}</strong>
                  <span className="run-status">{r.status}</span>
                  <p>{r.output}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
