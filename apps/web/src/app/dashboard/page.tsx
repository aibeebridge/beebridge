"use client";

import { useEffect, useState } from "react";
import { useGateway } from "../../context/gateway";
import Link from "next/link";

interface Stats {
  totalTasks: number;
  pendingApprovals: number;
  approvedTasks: number;
  flowers: number;
  pmProvider: string;
  pmModel: string;
}

interface AuditEvent {
  type: string;
  payload: Record<string, unknown>;
  at?: string;
}

export default function DashboardPage() {
  const { apiFetch } = useGateway();
  const [stats, setStats] = useState<Stats>({
    totalTasks: 0,
    pendingApprovals: 0,
    approvedTasks: 0,
    flowers: 0,
    pmProvider: "-",
    pmModel: "-",
  });
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [approvals, audit, flowers, pm] = await Promise.all([
          apiFetch("/api/approvals").catch(() => ({ pendingBeeApprovals: [], approvedBeeJobs: [] })),
          apiFetch("/api/audit?limit=200").catch(() => ({ hiveEvents: [] })),
          apiFetch("/api/flowers/connected").catch(() => ({ flowers: [] })),
          apiFetch("/api/settings/pm").catch(() => ({ modelPolicy: {} })),
        ]);
        if (cancelled) return;

        const pending = Array.isArray(approvals.pendingBeeApprovals) ? approvals.pendingBeeApprovals : [];
        const approved = Array.isArray(approvals.approvedBeeJobs) ? approvals.approvedBeeJobs : [];
        const flowerList = Array.isArray(flowers.flowers) ? flowers.flowers : [];
        const policy = pm.modelPolicy ?? {};

        setStats({
          totalTasks: pending.length + approved.length,
          pendingApprovals: pending.length,
          approvedTasks: approved.length,
          flowers: flowerList.length,
          pmProvider: String(policy.defaultProviderId ?? "-"),
          pmModel: String(policy.defaultModel ?? "-"),
        });

        const allEvents: AuditEvent[] = Array.isArray(audit.hiveEvents) ? audit.hiveEvents : [];
        setEvents(allEvents.slice(0, 8));
        setError("");
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [apiFetch]);

  if (loading) return <div className="page-loading">Loading...</div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="page-subtitle">beebridge District Workspace Overview</p>
      </header>

      {error && <p className="page-error">{error}</p>}

      <section className="stat-grid">
        <article className="stat-card">
          <span className="stat-label">Total Tasks</span>
          <strong className="stat-value">{stats.totalTasks}</strong>
        </article>
        <article className="stat-card accent">
          <span className="stat-label">Pending Approval</span>
          <strong className="stat-value">{stats.pendingApprovals}</strong>
        </article>
        <article className="stat-card ok">
          <span className="stat-label">Approved</span>
          <strong className="stat-value">{stats.approvedTasks}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">Connected Flowers</span>
          <strong className="stat-value">{stats.flowers}</strong>
        </article>
      </section>

      <section className="dash-row">
        <div className="panel dash-panel">
          <h2>PM Settings</h2>
          <div className="pm-info">
            <p><span className="info-label">Provider</span> {stats.pmProvider}</p>
            <p><span className="info-label">Model</span> {stats.pmModel}</p>
          </div>
          <Link href="/settings" className="btn-secondary">Change Settings</Link>
        </div>

        <div className="panel dash-panel">
          <h2>Quick Actions</h2>
          <div className="quick-actions">
            <Link href="/jobs/new" className="btn-primary">New Task</Link>
            <Link href="/jobs" className="btn-secondary">Districts</Link>
            <Link href="/approvals" className="btn-secondary">Approvals</Link>
          </div>
        </div>
      </section>

      <section className="panel dash-panel">
        <h2>Recent Activity</h2>
        {events.length === 0 ? (
          <p className="empty-text">No activity yet. Try creating a new task to establish your first district.</p>
        ) : (
          <ul className="activity-mini">
            {events.map((ev, i) => (
              <li key={i}>
                <span className={`event-dot ${eventColor(ev.type)}`} />
                <div>
                  <strong>{formatEventType(ev.type)}</strong>
                  <span className="event-detail">{formatPayload(ev.payload)}</span>
                </div>
                {ev.at && <time>{new Date(ev.at).toLocaleTimeString()}</time>}
              </li>
            ))}
          </ul>
        )}
        {events.length > 0 && <Link href="/activity" className="btn-text">View All →</Link>}
      </section>
    </div>
  );
}

function eventColor(type: string): string {
  if (type.includes("plan") || type.includes("city")) return "blue";
  if (type.includes("approved") || type.includes("activated")) return "green";
  if (type.includes("executed")) return "purple";
  if (type.includes("auth")) return "orange";
  if (type.includes("model")) return "blue";
  if (type.includes("removed") || type.includes("failed")) return "red";
  return "";
}

function formatEventType(type: string): string {
  const map: Record<string, string> = {
    "hive.plan.created": "City Blueprint Created",
    "city.plan.created": "City Blueprint Created",
    "bee.job.approved": "Task Approved",
    "bee.task.approved": "Task Approved",
    "bee.queue.executed": "Tasks Dispatched",
    "pm.auth.device.start": "Auth Started",
    "pm.auth.device.complete": "Auth Completed",
    "pm.auth.profile.created": "Profile Created",
    "pm.auth.profile.activated": "Profile Activated",
    "pm.auth.profile.removed": "Profile Removed",
    "pm.model.policy.updated": "Model Changed",
    "bee.job.done": "Task Completed",
    "bee.task.done": "Task Completed",
    "bee.job.failed": "Task Failed",
    "bee.task.failed": "Task Failed",
    "bee.task.retried": "Task Retried",
  };
  return map[type] ?? type;
}

function formatPayload(payload: Record<string, unknown>): string {
  const parts: string[] = [];
  if (payload.goal) parts.push(String(payload.goal));
  if (payload.jobCount) parts.push(`${payload.jobCount} jobs`);
  if (payload.provider || payload.providerId) parts.push(String(payload.provider ?? payload.providerId));
  if (payload.model) parts.push(String(payload.model));
  if (payload.jobId) parts.push(`ID: ${payload.jobId}`);
  if (payload.profileId) parts.push(`Profile: ${payload.profileId}`);
  if (payload.count) parts.push(`${payload.count} executed`);
  if (payload.mode) parts.push(`Mode: ${payload.mode}`);
  return parts.join(" · ") || JSON.stringify(payload);
}
