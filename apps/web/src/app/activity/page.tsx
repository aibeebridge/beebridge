"use client";

import { useEffect, useState, useCallback } from "react";
import { useGateway, gatewayWsUrl, parseGatewayJsonBody } from "../../context/gateway";
import Link from "next/link";

interface AuditEvent {
  type: string;
  payload: Record<string, unknown>;
  at?: string;
}

interface ConversationEntry {
  role: "bee" | "flower" | "system";
  action: string;
  content: string;
  timestamp: string;
  source?: string;
}

interface JobConversation {
  jobId: string;
  beeId: string;
  entries: ConversationEntry[];
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
}

interface TeamPlan {
  id: string;
  goal: string;
  bees: Array<{ id: string; name: string; role: string; providerId: string; model: string }>;
  jobs: Array<{ id: string; title: string; personaId?: string; bee?: string }>;
}

type TabId = "timeline" | "projects" | "jobs";

const EVENT_LABELS: Record<string, string> = {
  "hive.plan.created": "Plan Created",
  "bee.job.approved": "Job Approved",
  "bee.job.restart_pending": "Restart (→ pending)",
  "bee.job.revoked": "Approval Revoked",
  "bee.queue.executed": "Queue Executed",
  "bee.job.done": "Job Completed",
  "bee.job.failed": "Job Failed",
  "pm.auth.device.start": "Auth Started",
  "pm.auth.device.complete": "Auth Completed",
  "pm.auth.profile.created": "Profile Created",
  "pm.auth.profile.activated": "Profile Activated",
  "pm.auth.profile.removed": "Profile Removed",
  "pm.model.policy.updated": "Model Updated",
  "bee.job.retried": "Job Retried",
  "bee.job.schedule.updated": "Schedule Updated",
};

const EVENT_COLORS: Record<string, string> = {
  "hive.plan.created": "var(--accent)",
  "bee.job.approved": "var(--ok)",
  "bee.queue.executed": "#7c3aed",
  "bee.job.done": "var(--ok)",
  "bee.job.failed": "var(--danger)",
  "pm.auth": "#e67e22",
  "pm.model": "var(--accent)",
  "bee.job.retried": "#e67e22",
  "bee.job.schedule": "#7c3aed",
};

function getEventColor(type: string): string {
  if (EVENT_COLORS[type]) return EVENT_COLORS[type];
  for (const [key, color] of Object.entries(EVENT_COLORS)) {
    if (type.startsWith(key)) return color;
  }
  return "var(--muted)";
}

export default function ActivityPage() {
  const { apiFetch, url, token } = useGateway();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [conversations, setConversations] = useState<JobConversation[]>([]);
  const [teamPlan, setTeamPlan] = useState<TeamPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<TabId>("timeline");
  const [expandedJob, setExpandedJob] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [auditData, convData, teamData] = await Promise.all([
        apiFetch("/api/audit").catch(() => ({ hiveEvents: [] })),
        apiFetch("/api/jobs/conversations").catch(() => ({ conversations: [] })),
        apiFetch("/api/team").catch(() => ({ teamPlan: null })),
      ]);
      setEvents(Array.isArray(auditData.hiveEvents) ? auditData.hiveEvents : []);
      setConversations(Array.isArray(convData.conversations) ? convData.conversations : []);
      setTeamPlan(teamData.teamPlan ?? null);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  useEffect(() => {
    const wsUrl = gatewayWsUrl(url, token);
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl);
    } catch {
      return;
    }
    ws.onopen = () => ws.send(JSON.stringify({ type: "web.register" }));
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === "string" ? ev.data : "";
      if (!raw.trim()) return;
      try {
        const msg = parseGatewayJsonBody(raw, "ws") as { type?: string };
        if (msg.type === "queue.complete") loadData();
      } catch {
        /* ignore */
      }
    };
    return () => ws.close();
  }, [url, token, loadData]);

  const planEvents = events.filter((e) => e.type === "hive.plan.created");
  const jobEvents = events.filter((e) => e.type.startsWith("bee.job."));
  const settingsEvents = events.filter((e) => e.type.startsWith("pm."));

  const typeCounts: Record<string, number> = {};
  for (const e of events) {
    const label = EVENT_LABELS[e.type] ?? e.type;
    typeCounts[label] = (typeCounts[label] ?? 0) + 1;
  }
  const maxCount = Math.max(1, ...Object.values(typeCounts));

  if (loading) return <div className="page-loading">Loading...</div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Activity Log</h1>
          <p className="page-subtitle">
            {events.length} events · {conversations.length} conversations · Auto-refreshes 10s
          </p>
        </div>
        <button className="btn-secondary" onClick={loadData}>Refresh</button>
      </header>

      {error && <p className="page-error">{error}</p>}

      {/* Summary Chart */}
      <section className="panel activity-chart-panel">
        <h2>Event Overview</h2>
        <div className="activity-bar-chart">
          {Object.entries(typeCounts).map(([label, count]) => (
            <div key={label} className="bar-row">
              <span className="bar-label">{label}</span>
              <div className="bar-track">
                <div
                  className="bar-fill"
                  style={{ width: `${(count / maxCount) * 100}%` }}
                />
              </div>
              <span className="bar-count">{count}</span>
            </div>
          ))}
        </div>
        {events.length === 0 && (
          <p className="empty-text">No events recorded yet.</p>
        )}
      </section>

      {/* Tabs */}
      <div className="activity-tabs">
        <button className={`activity-tab ${tab === "timeline" ? "active" : ""}`} onClick={() => setTab("timeline")}>
          Timeline ({events.length})
        </button>
        <button className={`activity-tab ${tab === "projects" ? "active" : ""}`} onClick={() => setTab("projects")}>
          Projects ({planEvents.length})
        </button>
        <button className={`activity-tab ${tab === "jobs" ? "active" : ""}`} onClick={() => setTab("jobs")}>
          Job History ({conversations.length})
        </button>
      </div>

      {/* Tab: Timeline */}
      {tab === "timeline" && (
        <section className="panel">
          {events.length === 0 ? (
            <p className="empty-text" style={{ padding: 24 }}>No activity yet. Create a new job to start.</p>
          ) : (
            <ul className="activity-timeline-v2">
              {events.map((ev, i) => (
                <li key={i} className="tl2-item">
                  <div className="tl2-dot" style={{ background: getEventColor(ev.type) }} />
                  <div className="tl2-line" />
                  <div className="tl2-body">
                    <div className="tl2-header">
                      <strong>{EVENT_LABELS[ev.type] ?? ev.type}</strong>
                      {ev.at && <time>{new Date(ev.at).toLocaleString()}</time>}
                    </div>
                    <p className="tl2-detail">{formatPayload(ev.type, ev.payload)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* Tab: Projects */}
      {tab === "projects" && (
        <section className="panel">
          {planEvents.length === 0 ? (
            <p className="empty-text" style={{ padding: 24 }}>No projects created yet.</p>
          ) : (
            <div className="project-list">
              {planEvents.map((ev, i) => {
                const goal = String(ev.payload.goal ?? "Untitled");
                const jobCount = Number(ev.payload.jobCount ?? 0);
                const beeCount = Number(ev.payload.beeCount ?? 0);
                const provider = String(ev.payload.provider ?? ev.payload.providerId ?? "");
                const model = String(ev.payload.model ?? "");
                const relatedJobs = jobEvents.filter((je) =>
                  String(je.payload.jobId ?? "").startsWith("job-bee-")
                );

                return (
                  <div key={i} className="project-card">
                    <div className="project-card-header">
                      <h3>{goal}</h3>
                      {ev.at && <time>{new Date(ev.at).toLocaleString()}</time>}
                    </div>
                    <div className="project-card-stats">
                      <span className="project-stat">{beeCount || jobCount} Bees</span>
                      <span className="project-stat">{jobCount} Jobs</span>
                      {provider && <span className="project-stat">{provider}/{model}</span>}
                    </div>
                    <div className="project-card-events">
                      {relatedJobs.length > 0 ? (
                        relatedJobs.map((je, ji) => (
                          <div key={ji} className="project-mini-event">
                            <span className="tl2-dot small" style={{ background: getEventColor(je.type) }} />
                            <span>{EVENT_LABELS[je.type] ?? je.type}</span>
                            <span className="text-muted">{String(je.payload.jobId ?? "")}</span>
                          </div>
                        ))
                      ) : (
                        <p className="text-muted" style={{ fontSize: 13 }}>No job activity yet</p>
                      )}
                    </div>
                    {teamPlan && (
                      <div className="project-team">
                        <strong>Team:</strong>
                        {teamPlan.bees.map((b) => (
                          <span key={b.id} className="bee-chip">{b.name} ({b.role})</span>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Tab: Job History */}
      {tab === "jobs" && (
        <section className="panel">
          {conversations.length === 0 ? (
            <p className="empty-text" style={{ padding: 24 }}>No job conversations recorded yet.</p>
          ) : (
            <div className="job-history-list">
              {conversations.map((conv) => {
                const isExpanded = expandedJob === conv.jobId;
                const teamJob = teamPlan?.jobs?.find((j) => j.id === conv.jobId);
                const bee = teamPlan?.bees?.find((b) => b.id === conv.beeId);

                return (
                  <div key={conv.jobId} className={`job-history-card ${isExpanded ? "expanded" : ""}`}>
                    <div
                      className="job-history-header"
                      onClick={() => setExpandedJob(isExpanded ? null : conv.jobId)}
                    >
                      <div className="job-history-left">
                        <span className={`status-dot ${conv.status}`} />
                        <div>
                          <strong>{teamJob?.title ?? conv.jobId}</strong>
                          <span className="job-history-meta">
                            Bee: {bee?.name ?? conv.beeId} · {conv.entries.length} entries · {conv.status}
                          </span>
                        </div>
                      </div>
                      <div className="job-history-right">
                        <time>{new Date(conv.startedAt).toLocaleString()}</time>
                        <span className="expand-icon">{isExpanded ? "▲" : "▼"}</span>
                      </div>
                    </div>

                    {isExpanded && (
                      <div className="job-history-detail">
                        {bee && (
                          <div className="job-persona-info">
                            <h4>{bee.name} — {bee.role}</h4>
                            <p>{bee.providerId}/{bee.model}</p>
                          </div>
                        )}

                        <div className="conversation-view compact">
                          {conv.entries.map((entry, ei) => (
                            <div key={ei} className={`chat-entry ${entry.role}`}>
                              {entry.role !== "system" && (
                                <div className={`chat-avatar ${entry.role}-avatar`}>
                                  {entry.role === "bee" ? "B" : "F"}
                                </div>
                              )}
                              <div className={`chat-bubble ${entry.role}-bubble`}>
                                {entry.source ? <div className="chat-source">{entry.source}</div> : null}
                                <div className="chat-action">{entry.action}</div>
                                <div className="chat-content" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{entry.content}</div>
                                <div className="chat-time">
                                  {new Date(entry.timestamp).toLocaleTimeString()}
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>

                        {conv.finishedAt && (
                          <p className="job-history-footer">
                            Completed: {new Date(conv.finishedAt).toLocaleString()}
                            {" · "}
                            Duration: {formatDuration(conv.startedAt, conv.finishedAt)}
                          </p>
                        )}

                        <Link href={`/jobs/${conv.jobId}`} className="btn-text">
                          View Full Detail →
                        </Link>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function formatPayload(type: string, payload: Record<string, unknown>): string {
  if (type === "hive.plan.created") {
    const parts: string[] = [];
    if (payload.goal) parts.push(`Goal: ${String(payload.goal)}`);
    if (payload.jobCount) parts.push(`${payload.jobCount} jobs`);
    if (payload.beeCount) parts.push(`${payload.beeCount} bees`);
    if (payload.provider && payload.model) parts.push(`${payload.provider}/${payload.model}`);
    return parts.join(" · ") || JSON.stringify(payload);
  }
  if (type === "bee.job.approved" || type === "bee.job.done" || type === "bee.job.failed") {
    const parts: string[] = [];
    if (payload.jobId) parts.push(`Job: ${String(payload.jobId)}`);
    if (payload.error) parts.push(`Error: ${String(payload.error)}`);
    if (payload.resultLength) parts.push(`Result: ${payload.resultLength} chars`);
    return parts.join(" · ") || JSON.stringify(payload);
  }
  if (type === "bee.queue.executed") {
    const n = typeof payload.count === "number" ? payload.count : Number(payload.count);
    const d = typeof payload.doneCount === "number" ? payload.doneCount : Number(payload.doneCount);
    const f = typeof payload.failedCount === "number" ? payload.failedCount : Number(payload.failedCount);
    if (Number.isFinite(n) && Number.isFinite(d) && Number.isFinite(f)) {
      return `${n} jobs · ${d} succeeded · ${f} failed`;
    }
    return payload.count ? `${payload.count} jobs executed` : JSON.stringify(payload);
  }
  if (type === "pm.model.policy.updated") {
    return `${payload.providerId ?? "?"}/${payload.model ?? "?"} · ${payload.allowCount ?? 0} allowed`;
  }
  if (type.startsWith("pm.auth")) {
    const parts: string[] = [];
    if (payload.providerId) parts.push(String(payload.providerId));
    if (payload.profileId) parts.push(`Profile: ${payload.profileId}`);
    if (payload.mode) parts.push(`Mode: ${payload.mode}`);
    return parts.join(" · ") || JSON.stringify(payload);
  }
  return JSON.stringify(payload);
}

function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}
