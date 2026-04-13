"use client";

import { useEffect, useState, useCallback, useMemo, useRef, type ChangeEvent } from "react";
import { useGateway, parseGatewayJsonBody, gatewayWsUrl } from "../../context/gateway";
import BeeGraphEditor, { type BeeGraphTask } from "../../components/bee-graph/bee-graph-editor";

interface District {
  id: string;
  title: string;
  taskCount: number;
  status: string;
  bridgeLayout?: { x: number; y: number };
}

interface Bridge {
  id: string;
  fromDistrictId: string;
  toDistrictId: string;
  label: string;
  description?: string;
  direction: "one_way" | "two_way";
  status: "active" | "inactive" | "pending";
  dataFlow?: string[];
  createdAt: string;
}

type DistrictDetail = {
  district: { id: string; title: string; objective: string };
  bees: { id: string; name: string; role: string }[];
  tasks: { id: string; title: string; bee: string }[];
};

type ExportDistrictBundle = {
  district: {
    id: string;
    title: string;
    objective: string;
    status: string;
    cityId: string;
    waggle?: unknown;
    beeRosterIds?: string[];
    bridgeLayout?: { x: number; y: number };
    useUpstreamBridgeContext?: boolean;
    codeProjectPath?: string;
  };
  bees: Array<{
    id: string;
    name: string;
    role: string;
    systemPrompt: string;
    providerId: string;
    model: string;
    flowerType: string;
    scopedTaskId?: string;
  }>;
  tasks: Array<{
    id: string;
    title: string;
    description?: string;
    districtId: string;
    cityId: string;
    bee: string;
    flower: string;
    assignee: string;
    dueDate: string;
    priority: "low" | "medium" | "high";
    requiresApproval: boolean;
    status: "waiting" | "assigned" | "working" | "review" | "done";
    personaId?: string;
    dependsOn?: string[];
    schedule?: Record<string, unknown>;
  }>;
};

type BridgeSettingsExport = {
  format: "beebridge.bridge-settings.v1";
  exportedAt: string;
  startDistrictId: string | null;
  districts: ExportDistrictBundle[];
  bridges: Bridge[];
};

export default function BridgesPage() {
  const { apiFetch, url, token } = useGateway();
  const [districts, setDistricts] = useState<District[]>([]);
  const [bridges, setBridges] = useState<Bridge[]>([]);
  const [startDistrictId, setStartDistrictId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [showForm, setShowForm] = useState(false);
  const [formFrom, setFormFrom] = useState("");
  const [formTo, setFormTo] = useState("");
  const [formLabel, setFormLabel] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formDir, setFormDir] = useState<"one_way" | "two_way">("one_way");
  const [formDataFlow, setFormDataFlow] = useState("");
  const [saving, setSaving] = useState(false);

  const [selectedBridge, setSelectedBridge] = useState<Bridge | null>(null);
  const [detailDistrictId, setDetailDistrictId] = useState<string | null>(null);
  const [districtDetail, setDistrictDetail] = useState<DistrictDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [selectedEdgeIds, setSelectedEdgeIds] = useState<string[]>([]);
  const [lastSelectedNodeIds, setLastSelectedNodeIds] = useState<string[]>([]);
  const [lastSelectedEdgeIds, setLastSelectedEdgeIds] = useState<string[]>([]);
  const [exportingSelection, setExportingSelection] = useState(false);
  const [importingSelection, setImportingSelection] = useState(false);
  const [notice, setNotice] = useState("");
  const saveTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const importInputRef = useRef<HTMLInputElement | null>(null);

  /** Current task’s district while queue runs (from gateway WebSocket). */
  const [activeRunDistrictId, setActiveRunDistrictId] = useState<string | null>(null);
  /** True while POST /api/bridge-graph/run is in flight (blocks until pipeline finishes). */
  const [pipelineBusy, setPipelineBusy] = useState(false);
  type DistrictResultRow = {
    districtId: string;
    districtTitle: string;
    tasks: { taskId: string; title: string; bee: string; status: string; output: string }[];
  };

  /** Last pipeline run output (full text + per-district, below graph). */
  const [lastPipelineResult, setLastPipelineResult] = useState<{
    done: number;
    failed: number;
    summaryFull: string;
    districtResults: DistrictResultRow[];
  } | null>(null);

  type PipelineRunRecord = {
    id: string;
    startedAt: string;
    finishedAt: string;
    startDistrictId: string;
    orderedTaskIds: string[];
    summary: string;
    districtResults: DistrictResultRow[];
    status: "completed" | "failed_partial";
    doneCount: number;
    failedCount: number;
  };

  const [pipelineHistory, setPipelineHistory] = useState<PipelineRunRecord[]>([]);
  const [pipelineHistoryLoading, setPipelineHistoryLoading] = useState(false);
  const [selectedHistoryRunId, setSelectedHistoryRunId] = useState<string | null>(null);
  const NODE_HALF_W = 92;
  const NODE_HALF_H = 44;

  const loadPipelineHistory = useCallback(async () => {
    setPipelineHistoryLoading(true);
    try {
      const h = await apiFetch("/api/bridge-pipeline/history").catch(() => ({ runs: [] }));
      setPipelineHistory(Array.isArray(h.runs) ? h.runs : []);
    } catch {
      setPipelineHistory([]);
    } finally {
      setPipelineHistoryLoading(false);
    }
  }, [apiFetch]);

  const loadData = useCallback(async () => {
    try {
      const [dData, gData] = await Promise.all([
        apiFetch("/api/districts").catch(() => ({ districts: [] })),
        apiFetch("/api/bridge-graph").catch(() => ({ bridges: [], startDistrictId: null, districts: [] })),
      ]);
      const dList = Array.isArray(dData.districts) ? dData.districts : [];
      setDistricts(dList);
      setBridges(Array.isArray(gData.bridges) ? gData.bridges : []);
      setStartDistrictId(gData.startDistrictId == null ? null : String(gData.startDistrictId));
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [apiFetch]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (!selectedBridge) return;
    if (!bridges.some((b) => b.id === selectedBridge.id)) {
      setSelectedBridge(null);
    }
  }, [bridges, selectedBridge]);

  useEffect(() => {
    const districtIdSet = new Set(districts.map((d) => d.id));
    const bridgeIdSet = new Set(bridges.map((b) => b.id));
    setSelectedNodeIds((prev) => prev.filter((id) => districtIdSet.has(id)));
    setSelectedEdgeIds((prev) => prev.filter((id) => bridgeIdSet.has(id)));
    setLastSelectedNodeIds((prev) => prev.filter((id) => districtIdSet.has(id)));
    setLastSelectedEdgeIds((prev) => prev.filter((id) => bridgeIdSet.has(id)));
  }, [districts, bridges]);

  useEffect(() => {
    return () => {
      for (const t of Object.values(saveTimersRef.current)) {
        clearTimeout(t);
      }
    };
  }, []);

  useEffect(() => {
    loadPipelineHistory();
  }, [loadPipelineHistory]);

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
        const msg = parseGatewayJsonBody(raw, "ws") as {
          type?: string;
          districtId?: string | null;
          taskId?: string | null;
        };
        if (msg.type === "queue.task.running") {
          setActiveRunDistrictId(msg.districtId ?? null);
        }
        if (msg.type === "queue.complete") {
          setActiveRunDistrictId(null);
        }
      } catch {
        /* ignore */
      }
    };
    return () => ws.close();
  }, [url, token]);

  function scheduleSaveLayout(districtId: string, x: number, y: number) {
    const prev = saveTimersRef.current[districtId];
    if (prev) clearTimeout(prev);
    saveTimersRef.current[districtId] = setTimeout(async () => {
      try {
        await apiFetch(`/api/districts/${encodeURIComponent(districtId)}`, {
          method: "PUT",
          body: JSON.stringify({ bridgeLayout: { x, y } }),
        });
      } catch {
        /* best-effort */
      }
    }, 400);
  }

  async function handleSetStartOnly(districtId: string | null) {
    try {
      await apiFetch("/api/bridge-graph/start", {
        method: "PUT",
        body: JSON.stringify({ districtId }),
      });
      setStartDistrictId(districtId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set start");
    }
  }

  /** Start: if already a start node, just deselect. Otherwise set this district as start and run incomplete tasks reachable via one_way in bridge order. */
  async function handleStartOrRun(districtId: string, isCurrentlyStart: boolean) {
    if (pipelineBusy) return;
    if (isCurrentlyStart) {
      await handleSetStartOnly(null);
      return;
    }
    setPipelineBusy(true);
    setStartDistrictId(districtId);
    setError("");
    setLastPipelineResult(null);
    try {
      const data = await apiFetch("/api/bridge-graph/run", {
        method: "POST",
        body: JSON.stringify({ districtId }),
      });
      const runs = Array.isArray(data.beeRuns) ? data.beeRuns : [];
      const done = runs.filter((r: { status?: string }) => r.status === "done").length;
      const failed = runs.filter((r: { status?: string }) => r.status === "failed").length;
      const summary = typeof data.summary === "string" ? data.summary : "";
      const districtResults = Array.isArray(data.districtResults)
        ? (data.districtResults as DistrictResultRow[])
        : [];
      setLastPipelineResult({ done, failed, summaryFull: summary, districtResults });
      await loadData();
      await loadPipelineHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pipeline run failed");
    } finally {
      setPipelineBusy(false);
      setActiveRunDistrictId(null);
    }
  }

  async function openDetail(districtId: string) {
    setDetailDistrictId(districtId);
    setDetailLoading(true);
    setDistrictDetail(null);
    try {
      const data = await apiFetch(`/api/districts/${encodeURIComponent(districtId)}`);
      setDistrictDetail({
        district: data.district,
        bees: Array.isArray(data.bees) ? data.bees : [],
        tasks: Array.isArray(data.tasks) ? data.tasks : [],
      });
    } catch {
      setDistrictDetail(null);
    } finally {
      setDetailLoading(false);
    }
  }

  async function handleCreate() {
    if (!formFrom || !formTo || !formLabel.trim()) return;
    setSaving(true);
    try {
      await apiFetch("/api/bridges", {
        method: "POST",
        body: JSON.stringify({
          fromDistrictId: formFrom,
          toDistrictId: formTo,
          label: formLabel.trim(),
          description: formDesc.trim() || undefined,
          direction: formDir,
          dataFlow: formDataFlow ? formDataFlow.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
        }),
      });
      setShowForm(false);
      setFormFrom("");
      setFormTo("");
      setFormLabel("");
      setFormDesc("");
      setFormDir("one_way");
      setFormDataFlow("");
      loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(bridgeId: string) {
    try {
      await apiFetch(`/api/bridges/${bridgeId}`, { method: "DELETE" });
      setSelectedBridge(null);
      loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  const districtGraphTasks: BeeGraphTask[] = useMemo(() => {
    const incoming = new Map<string, string[]>();
    for (const d of districts) incoming.set(d.id, []);
    for (const b of bridges) {
      if (b.direction !== "one_way") continue;
      incoming.get(b.toDistrictId)?.push(b.fromDistrictId);
    }
    return districts.map((d) => ({
      id: d.id,
      title: d.title,
      bee: d.title,
      status:
        activeRunDistrictId === d.id
          ? "working"
          : startDistrictId === d.id
            ? "assigned"
            : d.status === "active"
              ? "done"
              : d.status === "inactive"
                ? "waiting"
                : "review",
      personaRole: `${d.taskCount} task${d.taskCount !== 1 ? "s" : ""}`,
      dependsOn: incoming.get(d.id) ?? [],
    }));
  }, [districts, bridges, activeRunDistrictId, startDistrictId]);

  const graphPositions = useMemo<Record<string, { x: number; y: number }>>(() => {
    const out: Record<string, { x: number; y: number }> = {};
    for (const d of districts) {
      const p = positions[d.id] ?? d.bridgeLayout;
      if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      out[d.id] = { x: p.x - NODE_HALF_W, y: p.y - NODE_HALF_H };
    }
    return out;
  }, [districts, positions]);

  const onDistrictGraphChange = useCallback(
    async (edges: Array<{ from: string; to: string }>) => {
      const currentOneWay = bridges.filter((b) => b.direction === "one_way");
      const currentSet = new Set(currentOneWay.map((b) => `${b.fromDistrictId}->${b.toDistrictId}`));
      const nextSet = new Set(edges.map((e) => `${e.from}->${e.to}`));

      const toAdd = [...nextSet].filter((k) => !currentSet.has(k));
      const toRemove = [...currentSet].filter((k) => !nextSet.has(k));
      if (toAdd.length === 0 && toRemove.length === 0) return;

      await Promise.all([
        ...toAdd.map(async (k) => {
          const [fromId, toId] = k.split("->");
          const fromT = districts.find((x) => x.id === fromId)?.title ?? fromId;
          const toT = districts.find((x) => x.id === toId)?.title ?? toId;
          const label = `${fromT.slice(0, 12)} → ${toT.slice(0, 12)}`;
          await apiFetch("/api/bridges", {
            method: "POST",
            body: JSON.stringify({
              fromDistrictId: fromId,
              toDistrictId: toId,
              label,
              direction: "one_way",
            }),
          });
        }),
        ...toRemove.map(async (k) => {
          const [fromId, toId] = k.split("->");
          const targets = currentOneWay.filter((b) => b.fromDistrictId === fromId && b.toDistrictId === toId);
          await Promise.all(
            targets.map((b) =>
              apiFetch(`/api/bridges/${encodeURIComponent(b.id)}`, { method: "DELETE" }),
            ),
          );
        }),
      ]);
      await loadData();
    },
    [apiFetch, bridges, districts, loadData],
  );

  const onDistrictNodeDragStop = useCallback(
    (nodeId: string, pos: { x: number; y: number }) => {
      const centerX = pos.x + NODE_HALF_W;
      const centerY = pos.y + NODE_HALF_H;
      setPositions((prev) => ({ ...prev, [nodeId]: { x: centerX, y: centerY } }));
      scheduleSaveLayout(nodeId, centerX, centerY);
    },
    [],
  );

  const effectiveNodeIds = useMemo(
    () => (selectedNodeIds.length > 0 ? selectedNodeIds : lastSelectedNodeIds),
    [selectedNodeIds, lastSelectedNodeIds],
  );
  const effectiveEdgeIds = useMemo(
    () => (selectedEdgeIds.length > 0 ? selectedEdgeIds : lastSelectedEdgeIds),
    [selectedEdgeIds, lastSelectedEdgeIds],
  );

  const selectedBridgeIdSet = useMemo(() => {
    const ids = new Set<string>(effectiveEdgeIds);
    if (effectiveNodeIds.length === 0) return ids;
    const districtSet = new Set(effectiveNodeIds);
    for (const b of bridges) {
      if (districtSet.has(b.fromDistrictId) && districtSet.has(b.toDistrictId)) {
        ids.add(b.id);
      }
    }
    return ids;
  }, [bridges, effectiveEdgeIds, effectiveNodeIds]);

  function normalizeDistrictBundle(raw: unknown, districtId: string): ExportDistrictBundle | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const rawDistrict = rec.district as Record<string, unknown> | undefined;
    if (!rawDistrict || typeof rawDistrict.id !== "string") return null;

    const district = {
      id: String(rawDistrict.id),
      title: String(rawDistrict.title ?? districtId),
      objective: String(rawDistrict.objective ?? ""),
      status: String(rawDistrict.status ?? "active"),
      cityId: String(rawDistrict.cityId ?? ""),
      waggle: rawDistrict.waggle,
      beeRosterIds: Array.isArray(rawDistrict.beeRosterIds) ? rawDistrict.beeRosterIds.map(String) : undefined,
      bridgeLayout:
        rawDistrict.bridgeLayout &&
        typeof rawDistrict.bridgeLayout === "object" &&
        Number.isFinite((rawDistrict.bridgeLayout as { x?: unknown }).x) &&
        Number.isFinite((rawDistrict.bridgeLayout as { y?: unknown }).y)
          ? {
              x: Number((rawDistrict.bridgeLayout as { x: unknown }).x),
              y: Number((rawDistrict.bridgeLayout as { y: unknown }).y),
            }
          : undefined,
      useUpstreamBridgeContext:
        rawDistrict.useUpstreamBridgeContext === undefined
          ? undefined
          : Boolean(rawDistrict.useUpstreamBridgeContext),
      codeProjectPath:
        typeof rawDistrict.codeProjectPath === "string" ? rawDistrict.codeProjectPath : undefined,
    };

    const bees = Array.isArray(rec.bees)
      ? rec.bees
          .filter((b): b is Record<string, unknown> => Boolean(b && typeof b === "object"))
          .map((b) => ({
            id: String(b.id ?? ""),
            name: String(b.name ?? ""),
            role: String(b.role ?? ""),
            systemPrompt: String(b.systemPrompt ?? ""),
            providerId: String(b.providerId ?? ""),
            model: String(b.model ?? ""),
            flowerType: String(b.flowerType ?? "browser"),
            scopedTaskId: typeof b.scopedTaskId === "string" ? b.scopedTaskId : undefined,
          }))
          .filter((b) => b.id)
      : [];

    const tasks = Array.isArray(rec.tasks)
      ? rec.tasks
          .filter((t): t is Record<string, unknown> => Boolean(t && typeof t === "object"))
          .map((t) => {
            const priority: "low" | "medium" | "high" =
              t.priority === "low" || t.priority === "high" ? t.priority : "medium";
            const status: "waiting" | "assigned" | "working" | "review" | "done" =
              t.status === "assigned" ||
              t.status === "working" ||
              t.status === "review" ||
              t.status === "done"
                ? t.status
                : "waiting";
            return {
              id: String(t.id ?? ""),
              title: String(t.title ?? ""),
              description: t.description == null ? undefined : String(t.description),
              districtId: String(t.districtId ?? district.id),
              cityId: String(t.cityId ?? district.cityId),
              bee: String(t.bee ?? ""),
              flower: String(t.flower ?? "openai-web"),
              assignee: String(t.assignee ?? ""),
              dueDate: String(t.dueDate ?? ""),
              priority,
              requiresApproval: Boolean(t.requiresApproval),
              status,
              personaId: t.personaId == null ? undefined : String(t.personaId),
              dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String).filter(Boolean) : undefined,
              schedule:
                t.schedule && typeof t.schedule === "object"
                  ? (t.schedule as Record<string, unknown>)
                  : undefined,
            };
          })
          .filter((t) => t.id)
      : [];

    return { district, bees, tasks };
  }

  async function handleExportSelection() {
    if (effectiveNodeIds.length === 0) {
      setError("Select at least one district on the graph first.");
      return;
    }

    setExportingSelection(true);
    setError("");
    setNotice("");
    try {
      const selectedDistrictSet = new Set(effectiveNodeIds);
      const districtPayloads = await Promise.all(
        effectiveNodeIds.map(async (districtId) => {
          const raw = await apiFetch(`/api/districts/${encodeURIComponent(districtId)}`);
          const normalized = normalizeDistrictBundle(raw, districtId);
          if (!normalized) {
            throw new Error(`Failed to collect district payload: ${districtId}`);
          }
          return normalized;
        }),
      );

      const selectedBridges = bridges
        .filter(
          (b) =>
            selectedBridgeIdSet.has(b.id) ||
            (selectedDistrictSet.has(b.fromDistrictId) && selectedDistrictSet.has(b.toDistrictId)),
        )
        .map((b) => ({
          id: b.id,
          fromDistrictId: b.fromDistrictId,
          toDistrictId: b.toDistrictId,
          label: b.label,
          description: b.description,
          direction: b.direction,
          status: b.status,
          dataFlow: b.dataFlow,
          createdAt: b.createdAt,
        }));

      const payload: BridgeSettingsExport = {
        format: "beebridge.bridge-settings.v1",
        exportedAt: new Date().toISOString(),
        startDistrictId: startDistrictId && selectedDistrictSet.has(startDistrictId) ? startDistrictId : null,
        districts: districtPayloads,
        bridges: selectedBridges,
      };

      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = `bridge-settings-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(href);
      setNotice(`Exported ${payload.districts.length} districts and ${payload.bridges.length} bridges.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to export selection");
    } finally {
      setExportingSelection(false);
    }
  }

  function openImportPicker() {
    importInputRef.current?.click();
  }

  async function handleImportFileChange(ev: ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    if (!file) return;
    setImportingSelection(true);
    setError("");
    setNotice("");
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as BridgeSettingsExport;
      if (!parsed || parsed.format !== "beebridge.bridge-settings.v1") {
        throw new Error("Unsupported file format. Expected beebridge.bridge-settings.v1.");
      }
      const data = await apiFetch("/api/bridge-graph/import", {
        method: "POST",
        body: JSON.stringify({ payload: parsed }),
      });
      const summary = (data?.summary ?? {}) as Record<string, unknown>;
      await loadData();
      setNotice(
        `Imported districts ${Number(summary.districts ?? 0)}, tasks ${Number(summary.tasks ?? 0)}, bees ${Number(summary.bees ?? 0)}, bridges ${Number(summary.bridges ?? 0)}.`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Import failed");
    } finally {
      setImportingSelection(false);
      ev.target.value = "";
    }
  }

  if (loading) return <div className="page-loading">Loading...</div>;

  function districtTitle(id: string): string {
    return districts.find((d) => d.id === id)?.title ?? id;
  }

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Bridges</h1>
          <p className="page-subtitle">
            {districts.length} districts &middot; {bridges.length} bridges
            {startDistrictId && (
              <>
                {" "}
                &middot; start: <strong>{districtTitle(startDistrictId)}</strong>
              </>
            )}
            {pipelineBusy && (
              <>
                {" "}
                &middot; <span className="bridge-pipeline-busy">Running…</span>
              </>
            )}
          </p>
        </div>
        <div className="header-actions">
          <button className="btn-secondary" onClick={loadData}>
            Refresh
          </button>
          <button className="btn-primary" onClick={() => setShowForm(!showForm)}>
            {showForm ? "Cancel" : "+ New Bridge"}
          </button>
        </div>
      </header>

      {error && <p className="page-error">{error}</p>}
      {notice && <p className="empty-text">{notice}</p>}

      {showForm && (
        <section className="panel bridge-form-panel">
          <h2>Create Bridge</h2>
          <p className="wizard-hint">Connect two districts to define data flow and dependencies between them.</p>
          <div className="bridge-form-grid">
            <label className="bridge-form-field">
              <span>From District</span>
              <select value={formFrom} onChange={(e) => setFormFrom(e.target.value)}>
                <option value="">Select...</option>
                {districts.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title}
                  </option>
                ))}
              </select>
            </label>

            <label className="bridge-form-field">
              <span>To District</span>
              <select value={formTo} onChange={(e) => setFormTo(e.target.value)}>
                <option value="">Select...</option>
                {districts
                  .filter((d) => d.id !== formFrom)
                  .map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.title}
                    </option>
                  ))}
              </select>
            </label>

            <label className="bridge-form-field">
              <span>Bridge Label</span>
              <input
                type="text"
                placeholder="e.g. Research Output"
                value={formLabel}
                onChange={(e) => setFormLabel(e.target.value)}
              />
            </label>

            <label className="bridge-form-field">
              <span>Direction</span>
              <select value={formDir} onChange={(e) => setFormDir(e.target.value as "one_way" | "two_way")}>
                <option value="one_way">One Way</option>
                <option value="two_way">Two Way</option>
              </select>
            </label>

            <label className="bridge-form-field full-width">
              <span>Description</span>
              <input
                type="text"
                placeholder="What flows across this bridge?"
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
              />
            </label>

            <label className="bridge-form-field full-width">
              <span>Data Flow Tags (comma-separated)</span>
              <input
                type="text"
                placeholder="e.g. research data, report draft, feedback"
                value={formDataFlow}
                onChange={(e) => setFormDataFlow(e.target.value)}
              />
            </label>
          </div>

          <div className="wizard-actions">
            <button className="btn-secondary" onClick={() => setShowForm(false)}>
              Cancel
            </button>
            <button
              className="btn-primary"
              onClick={handleCreate}
              disabled={saving || !formFrom || !formTo || !formLabel.trim()}
            >
              {saving ? "Creating..." : "Create Bridge"}
            </button>
          </div>
        </section>
      )}

      <section className="panel bridge-graph-panel">
        <div className="bridge-graph-header">
          <h2>District Network</h2>
          <div className="header-actions">
            <span className="page-subtitle" style={{ margin: 0 }}>
              Selected: {effectiveNodeIds.length} districts · {selectedBridgeIdSet.size} bridges
            </span>
            <button
              className="btn-secondary btn-sm"
              type="button"
              onClick={handleExportSelection}
              disabled={exportingSelection || effectiveNodeIds.length === 0}
            >
              {exportingSelection ? "Exporting..." : "Export JSON"}
            </button>
            <button
              className="btn-secondary btn-sm"
              type="button"
              onClick={openImportPicker}
              disabled={importingSelection}
            >
              {importingSelection ? "Importing..." : "Import JSON"}
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              style={{ display: "none" }}
              onChange={(e) => {
                void handleImportFileChange(e);
              }}
            />
          </div>
          {districts.length === 0 && (
            <p className="empty-text">
              No districts yet. Create tasks to establish districts, then connect them with bridges.
            </p>
          )}
        </div>

        {(activeRunDistrictId || pipelineBusy) && (
          <p className="bridge-run-banner" role="status">
            {activeRunDistrictId
              ? `Running: ${districtTitle(activeRunDistrictId)}`
              : "Pipeline running…"}
          </p>
        )}

        {districts.length > 0 && (
          <div className="bridge-svg-container bridge-rf-container">
            <BeeGraphEditor
              tasks={districtGraphTasks}
              positions={graphPositions}
              edgeDeleteMode="button"
              selectionOnDrag
              onSelectionChange={({ nodeIds, edgeIds }) => {
                setSelectedNodeIds(nodeIds);
                setSelectedEdgeIds(edgeIds);
                if (nodeIds.length > 0 || edgeIds.length > 0) {
                  setLastSelectedNodeIds(nodeIds);
                  setLastSelectedEdgeIds(edgeIds);
                }
              }}
              onNodeClick={(districtId) => {
                void openDetail(districtId);
              }}
              onEdgeClick={(edgeId) => {
                const b = bridges.find((x) => x.id === edgeId);
                if (!b) return;
                setSelectedBridge((prev) => (prev?.id === b.id ? null : b));
              }}
              onNodeDragStop={onDistrictNodeDragStop}
              onGraphChange={onDistrictGraphChange}
            />
          </div>
        )}
      </section>

      <section className="panel bridge-pipeline-history-panel" aria-labelledby="pipeline-history-heading">
        <div className="bridge-pipeline-result-head">
          <strong id="pipeline-history-heading">Pipeline Run History</strong>
          <button type="button" className="btn-secondary btn-sm" onClick={() => void loadPipelineHistory()}>
            Refresh
          </button>
        </div>
        {pipelineHistoryLoading && <p className="empty-text">Loading…</p>}
        {!pipelineHistoryLoading && pipelineHistory.length === 0 && (
          <p className="empty-text">No saved run history. Press Start on the graph to run the pipeline.</p>
        )}
        {!pipelineHistoryLoading && pipelineHistory.length > 0 && (
          <ul className="bridge-pipeline-history-list" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {pipelineHistory.map((run) => (
              <li key={run.id} style={{ borderBottom: "1px solid var(--border, #ddd)" }}>
                <button
                  type="button"
                  onClick={() => setSelectedHistoryRunId((id) => (id === run.id ? null : run.id))}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    padding: "0.5rem 0",
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    font: "inherit",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{new Date(run.startedAt).toLocaleString()}</span>
                  {" · "}
                  Start: {districtTitle(run.startDistrictId)}
                  {" · "}
                  {run.status === "completed" ? "Completed" : "Partial Failure"} ({run.doneCount}✓ / {run.failedCount}✗)
                </button>
                {selectedHistoryRunId === run.id && (
                  <div style={{ padding: "0 0 0.75rem 0" }}>
                    <p style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                      Run ID: <code>{run.id}</code> · {run.orderedTaskIds.length}{" "}
                      task{run.orderedTaskIds.length !== 1 ? "s" : ""}
                    </p>
                    {run.districtResults.length > 0 && (
                      <div className="bridge-pipeline-district-results">
                        {run.districtResults.map((dr) => (
                          <div key={dr.districtId} className="bridge-district-result-block">
                            <h4 className="bridge-district-result-title">{dr.districtTitle}</h4>
                            <ul className="bridge-district-result-list">
                              {dr.tasks.map((t) => (
                                <li key={t.taskId} className="bridge-district-result-item">
                                  <span className={`bridge-task-status-mark ${t.status === "done" ? "ok" : "fail"}`}>
                                    {t.status === "done" ? "✓" : "✗"}
                                  </span>
                                  <span className="bridge-task-title">{t.title}</span>
                                  {t.output ? <pre className="bridge-task-output-snippet">{t.output}</pre> : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ))}
                      </div>
                    )}
                    <h3 className="bridge-pipeline-result-h3">Full Report</h3>
                    <pre className="bridge-pipeline-result-pre bridge-pipeline-result-pre--full">{run.summary}</pre>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {lastPipelineResult && (
        <section className="panel bridge-pipeline-result-panel" aria-live="polite">
          <div className="bridge-pipeline-result-head">
            <strong>Final Run Results</strong>
            <span className="bridge-pipeline-result-counts">
              Success {lastPipelineResult.done} · Failed {lastPipelineResult.failed}
            </span>
            <button type="button" className="btn-secondary btn-sm" onClick={() => setLastPipelineResult(null)}>
              Close
            </button>
          </div>

          {lastPipelineResult.districtResults.length > 0 && (
            <div className="bridge-pipeline-district-results">
              <h3 className="bridge-pipeline-result-h3">By District</h3>
              {lastPipelineResult.districtResults.map((dr) => (
                <div key={dr.districtId} className="bridge-district-result-block">
                  <h4 className="bridge-district-result-title">{dr.districtTitle}</h4>
                  <ul className="bridge-district-result-list">
                    {dr.tasks.map((t) => (
                      <li key={t.taskId} className="bridge-district-result-item">
                        <span className={`bridge-task-status-mark ${t.status === "done" ? "ok" : "fail"}`}>
                          {t.status === "done" ? "✓" : "✗"}
                        </span>
                        <span className="bridge-task-title">{t.title}</span>
                        <span className="bridge-task-bee">{t.bee}</span>
                        {t.output ? (
                          <pre className="bridge-task-output-snippet">{t.output}</pre>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <h3 className="bridge-pipeline-result-h3">Full Report</h3>
          {lastPipelineResult.summaryFull ? (
            <pre className="bridge-pipeline-result-pre bridge-pipeline-result-pre--full">
              {lastPipelineResult.summaryFull}
            </pre>
          ) : (
            <p className="empty-text">No summary</p>
          )}
        </section>
      )}

      {selectedBridge && (
        <section className="panel bridge-detail-panel">
          <div className="bridge-detail-header">
            <div>
              <h2>{selectedBridge.label}</h2>
              <p className="page-subtitle">
                {districtTitle(selectedBridge.fromDistrictId)}
                {selectedBridge.direction === "two_way" ? " ↔ " : " → "}
                {districtTitle(selectedBridge.toDistrictId)}
              </p>
            </div>
            <div className="header-actions">
              <span className={`bridge-status-badge ${selectedBridge.status}`}>{selectedBridge.status}</span>
              <button className="btn-danger btn-sm" onClick={() => handleDelete(selectedBridge.id)}>
                Delete
              </button>
            </div>
          </div>

          {selectedBridge.description && <p className="bridge-description">{selectedBridge.description}</p>}

          <div className="bridge-detail-grid">
            <div className="bridge-detail-item">
              <span className="bridge-detail-label">Direction</span>
              <span>{selectedBridge.direction === "two_way" ? "Two-way" : "One-way"}</span>
            </div>
            <div className="bridge-detail-item">
              <span className="bridge-detail-label">Created</span>
              <span>{new Date(selectedBridge.createdAt).toLocaleString()}</span>
            </div>
          </div>

          {selectedBridge.dataFlow && selectedBridge.dataFlow.length > 0 && (
            <div className="bridge-flow-tags">
              <span className="bridge-detail-label">Data Flow</span>
              <div className="bridge-tags">
                {selectedBridge.dataFlow.map((tag, i) => (
                  <span key={i} className="bridge-flow-tag">
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </section>
      )}

      {detailDistrictId && (
        <section className="panel bridge-detail-panel">
          <div className="bridge-detail-header">
            <div>
              <h2>{districtDetail?.district.title ?? districtTitle(detailDistrictId)}</h2>
              <p className="page-subtitle">District bees & tasks</p>
            </div>
            <button className="btn-secondary btn-sm" type="button" onClick={() => setDetailDistrictId(null)}>
              Close
            </button>
          </div>
          {detailLoading && <p className="empty-text">Loading…</p>}
          {!detailLoading && districtDetail && (
            <>
              <p className="bridge-description">{districtDetail.district.objective || "—"}</p>
              <h3 style={{ fontSize: "14px", margin: "12px 0 8px" }}>Bees</h3>
              {districtDetail.bees.length === 0 ? (
                <p className="empty-text">No bees linked to this district.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
                  {districtDetail.bees.map((b) => (
                    <li key={b.id}>
                      <strong>{b.name}</strong> <span style={{ color: "#5b6b84" }}>({b.role})</span>{" "}
                      <code style={{ fontSize: "11px" }}>{b.id}</code>
                    </li>
                  ))}
                </ul>
              )}
              <h3 style={{ fontSize: "14px", margin: "12px 0 8px" }}>Tasks</h3>
              {districtDetail.tasks.length === 0 ? (
                <p className="empty-text">No tasks.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: "1.2rem" }}>
                  {districtDetail.tasks.map((t) => (
                    <li key={t.id}>
                      {t.title} <span style={{ color: "#5b6b84" }}>· {t.bee}</span>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </section>
      )}

      {bridges.length > 0 && (
        <section className="panel bridge-list-panel">
          <h2>All Bridges</h2>
          <div className="bridge-list">
            {bridges.map((bridge) => (
              <div
                key={bridge.id}
                className={`bridge-list-item ${selectedBridge?.id === bridge.id ? "selected" : ""}`}
                onClick={() => setSelectedBridge(selectedBridge?.id === bridge.id ? null : bridge)}
              >
                <div className="bridge-list-left">
                  <span className={`bridge-dir-icon ${bridge.direction}`}>
                    {bridge.direction === "two_way" ? "↔" : "→"}
                  </span>
                  <div>
                    <strong>{bridge.label}</strong>
                    <span className="bridge-list-path">
                      {districtTitle(bridge.fromDistrictId)} → {districtTitle(bridge.toDistrictId)}
                    </span>
                  </div>
                </div>
                <div className="bridge-list-right">
                  {bridge.dataFlow && bridge.dataFlow.length > 0 && (
                    <span className="bridge-flow-count">{bridge.dataFlow.length} flows</span>
                  )}
                  <span className={`bridge-status-dot ${bridge.status}`} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
