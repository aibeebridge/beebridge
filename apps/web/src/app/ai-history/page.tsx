"use client";

import { useEffect, useState, useCallback } from "react";
import { useGateway } from "../../context/gateway";

interface AiHistoryEntry {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  jobId?: string;
  beeId?: string;
  action: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  promptPreview: string;
  responsePreview: string;
  status: "success" | "error";
  error?: string;
}

interface AiHistoryStats {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  avgDurationMs: number;
  errorCount: number;
  byProvider: Record<string, { calls: number; tokens: number }>;
  byModel: Record<string, { calls: number; tokens: number }>;
}

interface ChainStats {
  totalNodes: number;
  totalEntries: number;
  hits: number;
  misses: number;
  hitRate: number;
  tokensSaved: number;
  topPatterns: { domain: string; intent: string; description: string; entryCount: number; bestScore: number }[];
}

export default function AiHistoryPage() {
  const { apiFetch } = useGateway();
  const [entries, setEntries] = useState<AiHistoryEntry[]>([]);
  const [stats, setStats] = useState<AiHistoryStats | null>(null);
  const [chainStats, setChainStats] = useState<ChainStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filterProvider, setFilterProvider] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");

  const loadData = useCallback(async () => {
    try {
      const [historyData, chainData] = await Promise.all([
        apiFetch("/api/ai-history"),
        apiFetch("/api/chain/stats").catch(() => null),
      ]);
      setEntries(Array.isArray(historyData.entries) ? historyData.entries : []);
      setStats(historyData.stats ?? null);
      setChainStats(chainData ?? null);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load AI history");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10000);
    return () => clearInterval(interval);
  }, [loadData]);

  const providers = Array.from(new Set(entries.map((e) => e.provider)));

  const filtered = entries.filter((e) => {
    if (filterProvider !== "all" && e.provider !== filterProvider) return false;
    if (filterStatus !== "all" && e.status !== filterStatus) return false;
    return true;
  });

  if (loading) return <div className="page-loading">Loading...</div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>AI History</h1>
          <p className="page-subtitle">
            {entries.length} API calls · Auto-refreshes every 10s
          </p>
        </div>
        <button className="btn-secondary" onClick={loadData}>Refresh</button>
      </header>

      {error && <p className="page-error">{error}</p>}

      {/* Stats Summary */}
      {stats && (
        <div className="ai-stats-grid">
          <div className="ai-stat-card">
            <div className="ai-stat-value">{stats.totalCalls}</div>
            <div className="ai-stat-label">Total Calls</div>
          </div>
          <div className="ai-stat-card">
            <div className="ai-stat-value">{formatTokenCount(stats.totalInputTokens)}</div>
            <div className="ai-stat-label">Input Tokens</div>
          </div>
          <div className="ai-stat-card">
            <div className="ai-stat-value">{formatTokenCount(stats.totalOutputTokens)}</div>
            <div className="ai-stat-label">Output Tokens</div>
          </div>
          <div className="ai-stat-card">
            <div className="ai-stat-value">{formatTokenCount(stats.totalTokens)}</div>
            <div className="ai-stat-label">Total Tokens</div>
          </div>
          <div className="ai-stat-card">
            <div className="ai-stat-value">{stats.avgDurationMs}ms</div>
            <div className="ai-stat-label">Avg Latency</div>
          </div>
          <div className="ai-stat-card">
            <div className="ai-stat-value error-value">{stats.errorCount}</div>
            <div className="ai-stat-label">Errors</div>
          </div>
        </div>
      )}

      {/* Provider / Model Breakdown */}
      {stats && (Object.keys(stats.byProvider).length > 0 || Object.keys(stats.byModel).length > 0) && (
        <div className="ai-breakdown-row">
          {Object.keys(stats.byProvider).length > 0 && (
            <section className="panel ai-breakdown-panel">
              <h3>By Provider</h3>
              <table className="ai-breakdown-table">
                <thead>
                  <tr><th>Provider</th><th>Calls</th><th>Tokens</th></tr>
                </thead>
                <tbody>
                  {Object.entries(stats.byProvider).map(([name, data]) => (
                    <tr key={name}>
                      <td className="ai-breakdown-name">{name}</td>
                      <td>{data.calls}</td>
                      <td>{formatTokenCount(data.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
          {Object.keys(stats.byModel).length > 0 && (
            <section className="panel ai-breakdown-panel">
              <h3>By Model</h3>
              <table className="ai-breakdown-table">
                <thead>
                  <tr><th>Model</th><th>Calls</th><th>Tokens</th></tr>
                </thead>
                <tbody>
                  {Object.entries(stats.byModel).map(([name, data]) => (
                    <tr key={name}>
                      <td className="ai-breakdown-name">{name}</td>
                      <td>{data.calls}</td>
                      <td>{formatTokenCount(data.tokens)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}
        </div>
      )}

      {/* Chain Cache Stats */}
      {chainStats && (chainStats.totalNodes > 0 || chainStats.hits > 0 || chainStats.misses > 0) && (
        <section className="panel" style={{ padding: "16px 20px", marginBottom: 16 }}>
          <h3 style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 600 }}>Interaction Chain Cache</h3>
          <div className="ai-stats-grid">
            <div className="ai-stat-card">
              <div className="ai-stat-value">{(chainStats.hitRate * 100).toFixed(1)}%</div>
              <div className="ai-stat-label">Hit Rate</div>
            </div>
            <div className="ai-stat-card">
              <div className="ai-stat-value">{chainStats.hits}/{chainStats.hits + chainStats.misses}</div>
              <div className="ai-stat-label">Hits / Lookups</div>
            </div>
            <div className="ai-stat-card">
              <div className="ai-stat-value" style={{ color: "var(--color-success, #22c55e)" }}>{formatTokenCount(chainStats.tokensSaved)}</div>
              <div className="ai-stat-label">Tokens Saved</div>
            </div>
            <div className="ai-stat-card">
              <div className="ai-stat-value">{chainStats.totalNodes}</div>
              <div className="ai-stat-label">Cached Patterns</div>
            </div>
            <div className="ai-stat-card">
              <div className="ai-stat-value">{chainStats.totalEntries}</div>
              <div className="ai-stat-label">Chain Entries</div>
            </div>
          </div>
          {chainStats.topPatterns.length > 0 && (
            <div style={{ marginTop: 12 }}>
              <h4 style={{ margin: "0 0 8px", fontSize: 12, fontWeight: 500, opacity: 0.7 }}>Top Cached Patterns (Domain Catalog)</h4>
              <table className="ai-breakdown-table">
                <thead>
                  <tr><th>Domain</th><th>Intent</th><th>Description</th><th>Entries</th><th>Score</th></tr>
                </thead>
                <tbody>
                  {chainStats.topPatterns.map((p, i) => (
                    <tr key={i}>
                      <td className="ai-breakdown-name">{p.domain}</td>
                      <td><span style={{ fontFamily: "monospace", fontSize: 11 }}>{p.intent.length > 16 ? p.intent.slice(0, 12) + "..." : p.intent}</span></td>
                      <td style={{ maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.description || "-"}</td>
                      <td>{p.entryCount}</td>
                      <td>{p.bestScore.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {/* Filters */}
      <div className="ai-history-filters">
        <select
          value={filterProvider}
          onChange={(e) => setFilterProvider(e.target.value)}
          className="ai-filter-select"
        >
          <option value="all">All Providers</option>
          {providers.map((p) => (
            <option key={p} value={p}>{p}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={(e) => setFilterStatus(e.target.value)}
          className="ai-filter-select"
        >
          <option value="all">All Status</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
        </select>
        <span className="ai-filter-count">
          Showing {filtered.length} of {entries.length}
        </span>
      </div>

      {/* History Table */}
      <section className="panel ai-history-table-panel">
        {filtered.length === 0 ? (
          <p className="empty-text" style={{ padding: 24 }}>
            No AI history recorded yet. Interactions will appear here when LLM API calls are made.
          </p>
        ) : (
          <div className="ai-history-table-wrapper">
            <table className="ai-history-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Provider / Model</th>
                  <th>Action</th>
                  <th className="text-right">Input</th>
                  <th className="text-right">Output</th>
                  <th className="text-right">Total</th>
                  <th className="text-right">Latency</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((entry) => {
                  const isExpanded = expandedId === entry.id;
                  return (
                    <AiHistoryRow
                      key={entry.id}
                      entry={entry}
                      isExpanded={isExpanded}
                      onToggle={() => setExpandedId(isExpanded ? null : entry.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function AiHistoryRow({
  entry,
  isExpanded,
  onToggle,
}: {
  entry: AiHistoryEntry;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className={`ai-row ${entry.status} ${isExpanded ? "expanded" : ""}`} onClick={onToggle}>
        <td className="ai-cell-time">
          {new Date(entry.timestamp).toLocaleTimeString("en-US", { hour12: false })}
          <span className="ai-cell-date">
            {new Date(entry.timestamp).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
          </span>
        </td>
        <td>
          <span className="ai-provider-badge">{entry.provider}</span>
          <span className="ai-model-name">{entry.model}</span>
        </td>
        <td className="ai-cell-action">{entry.action}</td>
        <td className="text-right ai-token-input">{formatTokenCount(entry.inputTokens)}</td>
        <td className="text-right ai-token-output">{formatTokenCount(entry.outputTokens)}</td>
        <td className="text-right ai-token-total">{formatTokenCount(entry.totalTokens)}</td>
        <td className="text-right ai-cell-latency">{entry.durationMs}ms</td>
        <td>
          <span className={`ai-status-badge ${entry.status}`}>
            {entry.status === "success" ? "OK" : "ERR"}
          </span>
        </td>
      </tr>
      {isExpanded && (
        <tr className="ai-row-detail">
          <td colSpan={8}>
            <div className="ai-detail-content">
              <div className="ai-detail-grid">
                {entry.jobId && (
                  <div className="ai-detail-field">
                    <label>Job ID</label>
                    <span>{entry.jobId}</span>
                  </div>
                )}
                {entry.beeId && (
                  <div className="ai-detail-field">
                    <label>Bee ID</label>
                    <span>{entry.beeId}</span>
                  </div>
                )}
                <div className="ai-detail-field">
                  <label>Full Timestamp</label>
                  <span>{new Date(entry.timestamp).toLocaleString()}</span>
                </div>
              </div>
              {entry.promptPreview && (
                <div className="ai-detail-preview">
                  <label>Prompt Preview</label>
                  <pre>{entry.promptPreview}</pre>
                </div>
              )}
              {entry.responsePreview && (
                <div className="ai-detail-preview">
                  <label>Response Preview</label>
                  <pre>{entry.responsePreview}</pre>
                </div>
              )}
              {entry.error && (
                <div className="ai-detail-preview error">
                  <label>Error</label>
                  <pre>{entry.error}</pre>
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
