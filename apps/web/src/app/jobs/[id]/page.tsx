"use client";

import { newBeeId } from "@beebridge/shared";
import { useEffect, useState, useCallback, useRef } from "react";
import { useParams } from "next/navigation";
import { useGateway, parseGatewayJsonBody, gatewayWsUrl } from "../../../context/gateway";
import Link from "next/link";
import dynamic from "next/dynamic";
import type { BeeGraphTask } from "../../../components/bee-graph/bee-graph-editor";

const BeeGraphEditor = dynamic(() => import("../../../components/bee-graph/bee-graph-editor"), { ssr: false });

interface ConversationEntry {
  role: "bee" | "flower" | "system";
  action: string;
  content: string;
  timestamp: string;
  source?: string;
}

interface TaskConversation {
  jobId: string;
  beeId: string;
  entries: ConversationEntry[];
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  sessionId?: string;
}

interface AiHistorySummary {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
}

const ACTION_LABELS: Record<string, string> = {
  llm_call: "Thinking",
  worker_tool_plan: "Plan",
  list_files: "List Files",
  read_file: "Read File",
  write_file: "Write File",
  edit_file: "Edit File",
  run_command: "Run Command",
  grep: "Search",
  done: "Done",
  error: "Error",
  system: "System",
  spawn_task: "Spawn Task",
  check_task: "Check Task",
  process: "Process",
  waggle_ask: "Waggle Ask",
  warning: "Warning",
};

const CODE_ACTIONS = new Set([
  "run_command", "write_file", "edit_file", "grep", "read_file", "list_files",
]);

function formatDurationMs(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
}

function formatTokenCount(n: number): string {
  return n.toLocaleString();
}

interface TaskInfo {
  id: string;
  title: string;
  description?: string;
  bee: string;
  flower?: string;
  priority: string;
  requiresApproval: boolean;
  status: string;
  districtId?: string;
  personaId?: string;
}

type ContextSuggestion = {
  sourceType: "conversation" | "pipeline";
  sourceId: string;
  title: string;
  preview: string;
  score: number;
  createdAt: string;
};

interface BeePersonaRow {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  flowerType: "browser";
}

interface ProviderItem {
  id: string;
  label: string;
  models: string[];
}

const TEAM_ROLE_PRESETS = [
  { name: "Researcher", role: "researcher", prompt: "Collects and organizes key information through web searches and document exploration." },
  { name: "Analyst", role: "analyst", prompt: "Analyzes gathered information and derives actionable insights." },
  { name: "Writer", role: "writer", prompt: "Creates reports, blog posts, and summaries based on collected information." },
  { name: "Coder", role: "coder", prompt: "Writes code, debugs issues, and performs refactoring." },
  { name: "Reviewer", role: "reviewer", prompt: "Validates deliverables and suggests improvements." },
] as const;

type ScheduleRepeat = "once" | "hourly" | "daily" | "custom";

interface TaskSchedule {
  deadline?: string;
  repeatType: ScheduleRepeat;
  intervalHours?: number;
  dailyAtHour?: number;
  dailyAtMinute?: number;
  maxRetries: number;
  retryCount: number;
  lastRunAt?: string;
  nextRunAt?: string;
  enabled: boolean;
}

export default function TaskDetailPage() {
  const params = useParams();
  const taskId = params.id as string;
  const { apiFetch, url, token } = useGateway();
  /** Latest run from gateway (live WebSocket updates). */
  const [conv, setConv] = useState<TaskConversation | null>(null);
  /** Past runs (workspace), newest first. */
  const [conversationHistory, setConversationHistory] = useState<TaskConversation[]>([]);
  /** `live` = show `conv`; else archived `sessionId`. */
  const [conversationViewKey, setConversationViewKey] = useState<string>("live");
  const [taskInfo, setTaskInfo] = useState<TaskInfo | null>(null);
  const [schedule, setSchedule] = useState<TaskSchedule | null>(null);
  const [editSchedule, setEditSchedule] = useState(false);
  const [editTask, setEditTask] = useState(false);
  const [taskForm, setTaskForm] = useState<Partial<TaskInfo>>({});
  const [schedForm, setSchedForm] = useState<Partial<TaskSchedule>>({});
  const [loading, setLoading] = useState(true);
  const [retrying, setRetrying] = useState(false);
  const [resuming, setResuming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [retryMsg, setRetryMsg] = useState("");
  const [districtLabel, setDistrictLabel] = useState<string | null>(null);
  const [districtBees, setDistrictBees] = useState<BeePersonaRow[]>([]);
  const [editDistrictTeam, setEditDistrictTeam] = useState(false);
  const [teamFormBees, setTeamFormBees] = useState<BeePersonaRow[]>([]);
  const [teamSaving, setTeamSaving] = useState(false);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [defaultProvider, setDefaultProvider] = useState("openai");
  const [defaultModel, setDefaultModel] = useState("gpt-4o");
  const [aiSummary, setAiSummary] = useState<AiHistorySummary | null>(null);
  const [contextSuggestions, setContextSuggestions] = useState<ContextSuggestion[]>([]);
  const [expandedEntries, setExpandedEntries] = useState<Set<number>>(new Set());
  const [districtGraphTasks, setDistrictGraphTasks] = useState<BeeGraphTask[]>([]);
  const [graphSaving, setGraphSaving] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const descriptionTextareaRef = useRef<HTMLTextAreaElement>(null);

  type UpstreamBridgeTaskRow = {
    taskId: string;
    title: string;
    districtId: string;
    districtTitle: string;
    beeId: string;
    beeName: string;
  };
  const [upstreamBridgeTasks, setUpstreamBridgeTasks] = useState<UpstreamBridgeTaskRow[]>([]);

  const loadConversation = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/jobs/${encodeURIComponent(taskId)}/conversation`);
      const nextConv = (data.conversation as TaskConversation | null | undefined) ?? null;
      const hist = Array.isArray(data.history) ? (data.history as TaskConversation[]) : [];
      setConv(nextConv);
      setConversationHistory(hist);
      if (nextConv) setConversationViewKey("live");
      else if (hist[0]?.sessionId) setConversationViewKey(hist[0].sessionId);
      else setConversationViewKey("live");
      setError("");
    } catch (e) {
      setConv(null);
      setConversationHistory([]);
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [apiFetch, taskId]);

  const loadSchedule = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/jobs/${taskId}/schedule`);
      setSchedule(data.schedule ?? null);
    } catch {
      /* no schedule */
    }
  }, [apiFetch, taskId]);

  const loadTask = useCallback(async () => {
    try {
      const data = await apiFetch(`/api/jobs`);
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      const found = jobs.find((j: TaskInfo) => j.id === taskId);
      if (found) setTaskInfo(found);
    } catch {
      /* task info is supplementary */
    }
  }, [apiFetch, taskId]);

  const loadAiSummary = useCallback(async () => {
    try {
      const data = await apiFetch("/api/ai-history");
      const entries = Array.isArray(data.entries) ? data.entries : [];
      const match = entries.find(
        (e: Record<string, unknown>) =>
          e.jobId === taskId && e.action === "code_agent_loop",
      );
      if (match) {
        setAiSummary({
          inputTokens: Number(match.inputTokens ?? 0),
          outputTokens: Number(match.outputTokens ?? 0),
          totalTokens: Number(match.totalTokens ?? 0),
          durationMs: Number(match.durationMs ?? 0),
        });
      }
    } catch {
      /* ai-history is supplementary */
    }
  }, [apiFetch, taskId]);

  useEffect(() => {
    loadConversation();
    loadSchedule();
    loadTask();
    loadAiSummary();
  }, [loadConversation, loadSchedule, loadTask, loadAiSummary]);

  useEffect(() => {
    const id = taskInfo?.districtId;
    if (!id) {
      setDistrictLabel(null);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/districts/${encodeURIComponent(id)}`)
      .then((data) => {
        if (cancelled) return;
        const title = data.district?.title;
        setDistrictLabel(typeof title === "string" && title.trim() ? title : id);
      })
      .catch(() => {
        if (!cancelled) setDistrictLabel(id);
      });
    return () => {
      cancelled = true;
    };
  }, [taskInfo?.districtId, apiFetch]);

  const loadDistrictBees = useCallback(async () => {
    const id = taskInfo?.districtId;
    if (!id) {
      setDistrictBees([]);
      return;
    }
    try {
      const data = await apiFetch(
        `/api/districts/${encodeURIComponent(id)}?taskId=${encodeURIComponent(taskId)}`,
      );
      const raw = Array.isArray(data.bees) ? data.bees : [];
      const rows: BeePersonaRow[] = raw
        .map((b: Record<string, unknown>) => ({
          id: String(b.id ?? ""),
          name: String(b.name ?? ""),
          role: String(b.role ?? ""),
          systemPrompt: String(b.systemPrompt ?? ""),
          providerId: String(b.providerId ?? "openai"),
          model: String(b.model ?? ""),
          flowerType: "browser" as const,
        }))
        .filter((b: BeePersonaRow) => b.id);
      setDistrictBees(rows);
    } catch {
      setDistrictBees([]);
    }
  }, [apiFetch, taskInfo?.districtId, taskId]);

  const loadDistrictGraphTasks = useCallback(async () => {
    const id = taskInfo?.districtId;
    if (!id) { setDistrictGraphTasks([]); return; }
    try {
      const data = await apiFetch(`/api/districts/${encodeURIComponent(id)}`);
      const tasks: BeeGraphTask[] = (Array.isArray(data.tasks) ? data.tasks : []).map(
        (t: Record<string, unknown>) => {
          const bees = Array.isArray(data.bees) ? data.bees as Array<Record<string, unknown>> : [];
          const persona = t.personaId ? bees.find((b) => b.id === t.personaId) : undefined;
          return {
            id: String(t.id ?? ""),
            title: String(t.title ?? ""),
            bee: String(t.bee ?? ""),
            status: String(t.status ?? "waiting"),
            personaId: t.personaId ? String(t.personaId) : undefined,
            personaName: persona ? String(persona.name ?? "") : undefined,
            personaRole: persona ? String(persona.role ?? "") : undefined,
            dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : undefined,
          };
        },
      );
      setDistrictGraphTasks(tasks);
    } catch {
      setDistrictGraphTasks([]);
    }
  }, [apiFetch, taskInfo?.districtId]);

  const onGraphChange = useCallback(async (edges: Array<{ from: string; to: string }>) => {
    const id = taskInfo?.districtId;
    if (!id) return;
    setGraphSaving(true);
    try {
      await apiFetch(`/api/districts/${encodeURIComponent(id)}/task-graph`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ edges }),
      });
      await loadDistrictGraphTasks();
    } catch (e: any) {
      const msg = e?.message ?? "";
      if (msg.includes("cycle_detected")) {
        alert("A circular dependency was detected. The connection was not saved.");
      } else {
        console.error("Failed to save task graph:", e);
      }
      await loadDistrictGraphTasks();
    } finally {
      setGraphSaving(false);
    }
  }, [apiFetch, taskInfo?.districtId, loadDistrictGraphTasks]);

  useEffect(() => {
    loadDistrictBees();
    loadDistrictGraphTasks();
  }, [loadDistrictBees, loadDistrictGraphTasks]);

  useEffect(() => {
    const id = taskInfo?.districtId;
    if (!id || !editTask) {
      setUpstreamBridgeTasks([]);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/bridge-graph/upstream-tasks?districtId=${encodeURIComponent(id)}`)
      .then((data) => {
        if (cancelled) return;
        setUpstreamBridgeTasks(Array.isArray(data.tasks) ? data.tasks : []);
      })
      .catch(() => {
        if (!cancelled) setUpstreamBridgeTasks([]);
      });
    return () => {
      cancelled = true;
    };
  }, [taskInfo?.districtId, editTask, apiFetch]);

  useEffect(() => {
    apiFetch("/api/settings/pm")
      .then((data) => {
        const provs = Array.isArray(data.providers) ? data.providers : [];
        setProviders(provs);
        const policy = data.modelPolicy ?? {};
        setDefaultProvider(policy.defaultProviderId ?? provs[0]?.id ?? "openai");
        setDefaultModel(policy.defaultModel ?? "gpt-4o");
      })
      .catch(() => {});
  }, [apiFetch]);

  useEffect(() => {
    const wsUrl = gatewayWsUrl(url, token);
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl); } catch { return; }

    ws.onopen = () => { ws.send(JSON.stringify({ type: "web.register" })); };
    ws.onmessage = (event) => {
      const raw = typeof event.data === "string" ? event.data : "";
      if (!raw.trim()) return;
      try {
        const msg = parseGatewayJsonBody(raw, "ws") as {
          type?: string;
          jobId?: string;
          conversation?: TaskConversation;
        };
        if (msg.type === "districts.updated") {
          loadDistrictBees();
        }
        if (msg.type === "job.update" && msg.jobId === taskId && msg.conversation) {
          const c = msg.conversation as TaskConversation;
          setConv(c);
          if (c.status === "running" && c.entries.length === 0) {
            void loadConversation();
          }
          if (c.status === "done" || c.status === "failed") {
            void loadAiSummary();
          }
        }
      } catch {
        /* ignore */
      }
    };

    return () => ws.close();
  }, [url, token, taskId, loadDistrictBees, loadConversation, loadAiSummary]);

  useEffect(() => {
    if (conversationViewKey === "live" && !conv && conversationHistory.length > 0 && conversationHistory[0]?.sessionId) {
      setConversationViewKey(conversationHistory[0].sessionId!);
    }
  }, [conv, conversationHistory, conversationViewKey]);

  useEffect(() => {
    if (
      conversationViewKey !== "live" &&
      !conversationHistory.some((h) => h.sessionId === conversationViewKey)
    ) {
      if (conv) setConversationViewKey("live");
      else if (conversationHistory[0]?.sessionId) setConversationViewKey(conversationHistory[0].sessionId!);
    }
  }, [conv, conversationHistory, conversationViewKey]);

  const displayConv: TaskConversation | null =
    conversationViewKey === "live"
      ? conv
      : conversationHistory.find((h) => h.sessionId === conversationViewKey) ?? null;

  const showHistoryPicker = conversationHistory.length > 0;

  const historySelectValue =
    conv && conversationViewKey === "live"
      ? "live"
      : conversationHistory.some((h) => h.sessionId === conversationViewKey)
      ? conversationViewKey
      : conv
      ? "live"
      : conversationHistory[0]?.sessionId ?? "";

  useEffect(() => {
    setExpandedEntries(new Set());
  }, [conversationViewKey]);

  useEffect(() => {
    if (!taskInfo?.districtId) {
      setContextSuggestions([]);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/context/suggestions?districtId=${encodeURIComponent(taskInfo.districtId)}&taskId=${encodeURIComponent(taskId)}&limit=5`)
      .then((data) => {
        if (!cancelled) setContextSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      })
      .catch(() => {
        if (!cancelled) setContextSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch, taskId, taskInfo?.districtId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [displayConv?.entries.length]);

  async function handleRetry() {
    setRetrying(true);
    setRetryMsg("");
    try {
      await apiFetch(`/api/jobs/${taskId}/retry`, { method: "POST" });
      setRetryMsg("Restart started (failure count reset).");
      loadConversation();
      loadSchedule();
    } catch (e) {
      setRetryMsg(e instanceof Error ? e.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  }

  async function handleResume() {
    setResuming(true);
    setRetryMsg("");
    try {
      await apiFetch(`/api/jobs/${taskId}/resume`, { method: "POST" });
      setRetryMsg("Resume started.");
      loadConversation();
      loadSchedule();
    } catch (e) {
      setRetryMsg(e instanceof Error ? e.message : "Resume failed");
    } finally {
      setResuming(false);
    }
  }

  function insertBridgeOutPlaceholder(taskId: string) {
    const insert = `{{bridgeOut:${taskId}}}`;
    const el = descriptionTextareaRef.current;
    setTaskForm((s) => {
      const cur = s.description ?? "";
      if (!el) {
        return { ...s, description: cur + insert };
      }
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const next = cur.slice(0, start) + insert + cur.slice(end);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + insert.length;
        el.setSelectionRange(pos, pos);
      });
      return { ...s, description: next };
    });
  }

  function insertContextSuggestion(s: ContextSuggestion) {
    setEditTask(true);
    setTaskForm((cur) => {
      const current = String(cur.description ?? taskInfo?.description ?? "");
      return {
        ...cur,
        description: `${current.trim()}${current.trim() ? "\n\n" : ""}Prior output (${s.title}):\n${s.preview}`,
      };
    });
  }

  function openTaskEditor() {
    setTaskForm({
      title: taskInfo?.title ?? "",
      description: taskInfo?.description ?? "",
      bee: taskInfo?.bee ?? conv?.beeId ?? "",
      flower: taskInfo?.flower ?? "",
      personaId: taskInfo?.personaId ?? "",
      priority: taskInfo?.priority ?? "medium",
      requiresApproval: taskInfo?.requiresApproval ?? false,
    });
    setEditTask(true);
  }

  function getModelsForProvider(providerId: string): string[] {
    if (providerId === "default") {
      const p = providers.find((pr) => pr.id === defaultProvider);
      return p?.models ?? [];
    }
    return providers.find((pr) => pr.id === providerId)?.models ?? [];
  }

  function personaPromptPlaceholder(index: number): string {
    return TEAM_ROLE_PRESETS[index % TEAM_ROLE_PRESETS.length].prompt;
  }

  function createDefaultBeeRow(index: number): BeePersonaRow {
    const preset = TEAM_ROLE_PRESETS[index % TEAM_ROLE_PRESETS.length];
    return {
      id: newBeeId(),
      name: preset.name,
      role: preset.role,
      systemPrompt: "",
      providerId: "default",
      model: "default",
      flowerType: "browser",
    };
  }

  function openDistrictTeamEditor() {
    if (districtBees.length > 0) {
      setTeamFormBees(
        districtBees.map((b) => ({
          ...b,
          providerId: b.providerId === defaultProvider ? "default" : b.providerId,
          model: b.model === defaultModel ? "default" : b.model,
        })),
      );
    } else {
      setTeamFormBees([createDefaultBeeRow(0)]);
    }
    setEditDistrictTeam(true);
  }

  function updateTeamBee(index: number, patch: Partial<BeePersonaRow>) {
    setTeamFormBees((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }

  function applyTeamPreset(index: number, presetIdx: number) {
    const preset = TEAM_ROLE_PRESETS[presetIdx];
    updateTeamBee(index, { name: preset.name, role: preset.role, systemPrompt: preset.prompt });
  }

  function handleTeamBeeCountChange(count: number) {
    const clamped = Math.max(1, Math.min(count, 5));
    setTeamFormBees((prev) => {
      const next: BeePersonaRow[] = [];
      for (let i = 0; i < clamped; i++) {
        next.push(prev[i] ?? createDefaultBeeRow(i));
      }
      return next;
    });
  }

  async function saveDistrictTeam() {
    if (!taskInfo?.districtId || teamFormBees.length === 0) return;
    setTeamSaving(true);
    try {
      const resolved = teamFormBees.map((b, i) => {
        const trimmed = b.systemPrompt.trim();
        const systemPrompt = trimmed || personaPromptPlaceholder(i);
        return {
          ...b,
          systemPrompt,
          providerId: b.providerId === "default" ? defaultProvider : b.providerId,
          model: b.model === "default" ? defaultModel : b.model,
        };
      });
      const data = await apiFetch(`/api/districts/${encodeURIComponent(taskInfo.districtId)}/bees`, {
        method: "PUT",
        body: JSON.stringify({ bees: resolved, taskId: taskInfo.id }),
      });
      const raw = Array.isArray(data.bees) ? data.bees : [];
      setDistrictBees(
        raw
          .map((b: Record<string, unknown>) => ({
            id: String(b.id ?? ""),
            name: String(b.name ?? ""),
            role: String(b.role ?? ""),
            systemPrompt: String(b.systemPrompt ?? ""),
            providerId: String(b.providerId ?? "openai"),
            model: String(b.model ?? ""),
            flowerType: "browser" as const,
          }))
          .filter((b: BeePersonaRow) => b.id),
      );
      setEditDistrictTeam(false);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save team");
    } finally {
      setTeamSaving(false);
    }
  }

  async function saveTask() {
    setSaving(true);
    try {
      const data = await apiFetch(`/api/jobs/${taskId}`, {
        method: "PUT",
        body: JSON.stringify(taskForm),
      });
      setTaskInfo(data.task);
      setEditTask(false);
      loadDistrictBees();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function openScheduleEditor() {
    setSchedForm({
      deadline: schedule?.deadline ?? "",
      repeatType: schedule?.repeatType ?? "once",
      intervalHours: schedule?.intervalHours ?? 1,
      dailyAtHour: schedule?.dailyAtHour ?? 9,
      dailyAtMinute: schedule?.dailyAtMinute ?? 0,
      maxRetries: schedule?.maxRetries ?? 3,
      enabled: schedule?.enabled ?? true,
    });
    setEditSchedule(true);
  }

  async function saveSchedule() {
    setSaving(true);
    try {
      const data = await apiFetch(`/api/jobs/${taskId}/schedule`, {
        method: "PUT",
        body: JSON.stringify(schedForm),
      });
      setSchedule(data.schedule);
      setEditSchedule(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="page-loading">Loading...</div>;

  return (
    <div className="page-container">
      <header className="page-header">
        <div>
          <h1>Task: {taskId}</h1>
          <p className="page-subtitle">
            {conv ? (
              <>
                Bee: {conv.beeId} &middot;
                <span className={`status-badge ${conv.status}`}>
                  <span className={`status-dot ${conv.status}`} />
                  {conv.status}
                </span>
              </>
            ) : taskInfo ? (
              <>
                Bee: {taskInfo.bee}
                <span className="status-badge" style={{ marginLeft: "0.35rem" }}>
                  <span className="status-dot" style={{ background: "var(--muted)" }} />
                  not started
                </span>
              </>
            ) : (
              <>Loading task details…</>
            )}
          </p>
        </div>
        <div className="header-actions">
          {conv?.status === "failed" && (
            <button className="btn-danger" onClick={handleRetry} disabled={retrying}>
              {retrying ? "Retrying..." : "Restart"}
            </button>
          )}
          <Link href="/jobs" className="btn-secondary">&larr; Districts</Link>
        </div>
      </header>

      {error && <p className="page-error">{error}</p>}
      {retryMsg && <p className="page-notice">{retryMsg}</p>}

      <section className="panel schedule-panel">
        <div className="section-header">
          <h2>Task Info</h2>
          {!editTask && (
            <button className="btn-secondary btn-sm" onClick={openTaskEditor}>Edit</button>
          )}
        </div>

        {editTask ? (
          <div className="schedule-form">
            <label className="schedule-field">
              <span>Title</span>
              <input
                type="text"
                value={taskForm.title ?? ""}
                onChange={(e) => setTaskForm((s) => ({ ...s, title: e.target.value }))}
              />
            </label>
            <label className="schedule-field">
              <span>Description</span>
              <textarea
                ref={descriptionTextareaRef}
                rows={4}
                value={taskForm.description ?? ""}
                onChange={(e) => setTaskForm((s) => ({ ...s, description: e.target.value }))}
                placeholder="Task details, instructions, or goals..."
                style={{ width: "100%", resize: "vertical" }}
              />
            </label>
            <div className="schedule-field" style={{ marginTop: "-0.25rem" }}>
              <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}>Insert previous district output</span>
              {upstreamBridgeTasks.length === 0 ? (
                <p style={{ fontSize: "0.85rem", margin: "0.35rem 0 0", color: "var(--text-secondary)" }}>
                  No tasks in upstream district or the bridge is not connected yet. In the description you can use the format{" "}
                  <code>{"{{bridgeOut:taskId}}"}</code> directly.
                </p>
              ) : (
                <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginTop: "0.35rem" }}>
                  {upstreamBridgeTasks.map((u) => (
                    <button
                      key={u.taskId}
                      type="button"
                      className="btn-secondary btn-sm"
                      title={`${u.districtTitle} · ${u.beeName || u.beeId}`}
                      onClick={() => insertBridgeOutPlaceholder(u.taskId)}
                    >
                      {u.title.length > 28 ? `${u.title.slice(0, 27)}…` : u.title}
                    </button>
                  ))}
                </div>
              )}
            </div>
            {districtBees.length > 0 && (
              <label className="schedule-field">
                <span>District team (persona)</span>
                <select
                  value={taskForm.personaId || taskForm.bee || ""}
                  onChange={(e) => {
                    const pid = e.target.value;
                    if (!pid) {
                      setTaskForm((s) => ({ ...s, personaId: "", bee: s.bee ?? "" }));
                      return;
                    }
                    const p = districtBees.find((b) => b.id === pid);
                    const prov = p?.providerId ?? defaultProvider;
                    setTaskForm((s) => ({
                      ...s,
                      personaId: pid,
                      bee: pid,
                      flower: `${prov}-browser`,
                    }));
                  }}
                >
                  <option value="">Select…</option>
                  {districtBees.map((b) => (
                    <option key={b.id} value={b.id}>{b.name} ({b.id})</option>
                  ))}
                </select>
              </label>
            )}
            <label className="schedule-field">
              <span>Bee Worker ID</span>
              <input
                type="text"
                value={taskForm.bee ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  setTaskForm((s) => ({
                    ...s,
                    bee: v,
                    personaId: districtBees.some((x) => x.id === v) ? v : "",
                  }));
                }}
                placeholder={districtBees.length ? "Select from team or type manually" : "e.g. bee-a1b2c3d4e5f6789"}
              />
            </label>
            <label className="schedule-field">
              <span>Priority</span>
              <select
                value={taskForm.priority ?? "medium"}
                onChange={(e) => setTaskForm((s) => ({ ...s, priority: e.target.value }))}
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="schedule-field">
              <span>Requires Approval</span>
              <select
                value={taskForm.requiresApproval ? "true" : "false"}
                onChange={(e) => setTaskForm((s) => ({ ...s, requiresApproval: e.target.value === "true" }))}
              >
                <option value="false">No</option>
                <option value="true">Yes</option>
              </select>
            </label>
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setEditTask(false)}>Cancel</button>
              <button className="btn-primary" onClick={saveTask} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ) : (
          <div className="schedule-summary">
            <div className="schedule-row">
              <span className="schedule-label">Title</span>
              <span>{taskInfo?.title ?? taskId}</span>
            </div>
            {taskInfo?.description && (
              <div className="schedule-row">
                <span className="schedule-label">Description</span>
                <span style={{ whiteSpace: "pre-wrap" }}>{taskInfo.description}</span>
              </div>
            )}
            {contextSuggestions.length > 0 && (
              <div className="schedule-row">
                <span className="schedule-label">Prior outputs</span>
                <span style={{ display: "flex", flexDirection: "column", gap: "0.35rem" }}>
                  {contextSuggestions.map((s) => (
                    <button
                      key={`${s.sourceType}:${s.sourceId}`}
                      type="button"
                      className="btn-secondary btn-sm"
                      style={{ textAlign: "left", whiteSpace: "normal" }}
                      onClick={() => insertContextSuggestion(s)}
                    >
                      {s.title}: {s.preview.slice(0, 120)}
                    </button>
                  ))}
                </span>
              </div>
            )}
            <div className="schedule-row">
              <span className="schedule-label">Bee</span>
              <span>
                {(() => {
                  const id = taskInfo?.personaId || taskInfo?.bee || conv?.beeId;
                  const name = id ? districtBees.find((b) => b.id === id)?.name : undefined;
                  return name ? `${name} (${id})` : (id ?? "-");
                })()}
              </span>
            </div>
            {taskInfo?.flower && (
              <div className="schedule-row">
                <span className="schedule-label">Flower</span>
                <span>{taskInfo.flower}</span>
              </div>
            )}
            <div className="schedule-row">
              <span className="schedule-label">Priority</span>
              <span className={`priority-tag ${taskInfo?.priority ?? "medium"}`}>
                {taskInfo?.priority ?? "medium"}
              </span>
            </div>
            <div className="schedule-row">
              <span className="schedule-label">Approval</span>
              <span>{taskInfo?.requiresApproval ? "Required" : "Not required"}</span>
            </div>
            {taskInfo?.districtId && (
              <div className="schedule-row schedule-row-with-action">
                <span className="schedule-label">District</span>
                <span className="schedule-row-value">
                  <span>{districtLabel ?? taskInfo.districtId}</span>
                  <Link
                    href={`/jobs?editDistrict=${encodeURIComponent(taskInfo.districtId)}`}
                    className="btn-secondary btn-sm"
                  >
                    Edit District
                  </Link>
                </span>
              </div>
            )}
          </div>
        )}
      </section>

      {taskInfo?.districtId && (
        <section className="panel schedule-panel">
          <div className="section-header">
            <h2>District team (Bee workers)</h2>
            {!editDistrictTeam && (
              <button type="button" className="btn-secondary btn-sm" onClick={openDistrictTeamEditor}>
                {districtBees.length ? "Edit" : "Team Setup"}
              </button>
            )}
          </div>
          <p className="wizard-hint" style={{ marginTop: 0 }}>
            Bee personas for this District (role, prompt, model) are configured like in the New Task wizard. After saving, you can assign a persona to the task in Task Info above.
          </p>

          {editDistrictTeam ? (
            <div className="schedule-form">
              <div className="team-count-row">
                <label>Bee count</label>
                <div className="bee-count-btns">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      type="button"
                      className={`bee-count-btn ${teamFormBees.length === n ? "active" : ""}`}
                      onClick={() => handleTeamBeeCountChange(n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>
              <div className="team-cards">
                {teamFormBees.map((bee, i) => (
                  <div key={`${bee.id}-${i}`} className="persona-card">
                    <div className="persona-header">
                      <span className="persona-number">Bee {i + 1}</span>
                      <select
                        className="preset-select"
                        value=""
                        onChange={(e) => {
                          const v = e.target.value;
                          if (v !== "") applyTeamPreset(i, Number(v));
                        }}
                      >
                        <option value="">Preset…</option>
                        {TEAM_ROLE_PRESETS.map((p, pi) => (
                          <option key={pi} value={pi}>{p.name}</option>
                        ))}
                      </select>
                    </div>
                    <div className="persona-fields">
                      <label>
                        <span>ID</span>
                        <input
                          value={bee.id}
                          onChange={(e) => updateTeamBee(i, { id: e.target.value })}
                        />
                      </label>
                      <label>
                        <span>Name</span>
                        <input
                          value={bee.name}
                          onChange={(e) => updateTeamBee(i, { name: e.target.value })}
                        />
                      </label>
                      <label>
                        <span>Role</span>
                        <input
                          value={bee.role}
                          onChange={(e) => updateTeamBee(i, { role: e.target.value })}
                        />
                      </label>
                      <label>
                        <span>Persona prompt</span>
                        <textarea
                          rows={2}
                          value={bee.systemPrompt}
                          placeholder={personaPromptPlaceholder(i)}
                          onChange={(e) => updateTeamBee(i, { systemPrompt: e.target.value })}
                        />
                      </label>
                      <div className="persona-row">
                        <label>
                          <span>AI Provider</span>
                          <select
                            value={bee.providerId}
                            onChange={(e) => updateTeamBee(i, { providerId: e.target.value, model: "default" })}
                          >
                            <option value="default">Default ({defaultProvider})</option>
                            {providers.map((p) => (
                              <option key={p.id} value={p.id}>{p.label}</option>
                            ))}
                          </select>
                        </label>
                        <label>
                          <span>Model</span>
                          <select
                            value={bee.model}
                            onChange={(e) => updateTeamBee(i, { model: e.target.value })}
                          >
                            <option value="default">Default ({defaultModel})</option>
                            {getModelsForProvider(bee.providerId).map((m) => (
                              <option key={m} value={m}>{m}</option>
                            ))}
                          </select>
                        </label>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              <div className="wizard-actions">
                <button type="button" className="btn-secondary" onClick={() => setEditDistrictTeam(false)}>Cancel</button>
                <button type="button" className="btn-primary" onClick={saveDistrictTeam} disabled={teamSaving}>
                  {teamSaving ? "Saving…" : "Save Team"}
                </button>
              </div>
            </div>
          ) : districtBees.length === 0 ? (
            <p className="empty-text">No registered Bees. Use «Team Setup» to add personas.</p>
          ) : (
            <ul className="district-team-list" style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {districtBees.map((b) => (
                <li key={b.id} style={{ marginBottom: "0.35rem" }}>
                  <strong>{b.name}</strong> <span style={{ color: "var(--muted)" }}>({b.id})</span>
                  {" · "}{b.role}
                  {" · "}{b.providerId}/{b.model || defaultModel}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {taskInfo?.districtId && districtGraphTasks.length > 0 && (
        <section className="panel schedule-panel">
          <div className="section-header">
            <h2>Execution Graph</h2>
            {graphSaving && <span style={{ fontSize: 12, opacity: 0.6 }}>Saving…</span>}
          </div>
          <p className="wizard-hint" style={{ marginTop: 0 }}>
            Drag from a node handle to another to create a dependency edge. Tasks without incoming edges run first (or in parallel). Press Backspace to delete a selected edge.
          </p>
          <div style={{ height: 340, border: "1px solid var(--border, #333)", borderRadius: 8, overflow: "hidden" }}>
            <BeeGraphEditor tasks={districtGraphTasks} onGraphChange={onGraphChange} />
          </div>
        </section>
      )}

      <section className="panel schedule-panel">
        <div className="section-header">
          <h2>Schedule</h2>
          {!editSchedule && (
            <button className="btn-secondary btn-sm" onClick={openScheduleEditor}>Edit</button>
          )}
        </div>

        {editSchedule ? (
          <div className="schedule-form">
            <label className="schedule-field">
              <span>Deadline</span>
              <input
                type="datetime-local"
                value={schedForm.deadline ?? ""}
                onChange={(e) => setSchedForm((s) => ({ ...s, deadline: e.target.value }))}
              />
            </label>
            <label className="schedule-field">
              <span>Repeat Type</span>
              <select
                value={schedForm.repeatType ?? "once"}
                onChange={(e) => setSchedForm((s) => ({ ...s, repeatType: e.target.value as ScheduleRepeat }))}
              >
                <option value="once">Run Once</option>
                <option value="hourly">Hourly Interval</option>
                <option value="daily">Daily at Specific Time</option>
              </select>
            </label>
            {schedForm.repeatType === "hourly" && (
              <label className="schedule-field">
                <span>Interval</span>
                <div className="schedule-input-row">
                  <input
                    type="number" min={1} max={24}
                    value={schedForm.intervalHours ?? 1}
                    onChange={(e) => setSchedForm((s) => ({ ...s, intervalHours: Number(e.target.value) }))}
                  />
                  <span className="schedule-unit">hours</span>
                </div>
              </label>
            )}
            {schedForm.repeatType === "daily" && (
              <label className="schedule-field">
                <span>Run Time</span>
                <div className="schedule-input-row">
                  <select
                    value={schedForm.dailyAtHour ?? 9}
                    onChange={(e) => setSchedForm((s) => ({ ...s, dailyAtHour: Number(e.target.value) }))}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>
                    ))}
                  </select>
                  <select
                    value={schedForm.dailyAtMinute ?? 0}
                    onChange={(e) => setSchedForm((s) => ({ ...s, dailyAtMinute: Number(e.target.value) }))}
                  >
                    {[0, 15, 30, 45].map((m) => (
                      <option key={m} value={m}>{String(m).padStart(2, "0")}m</option>
                    ))}
                  </select>
                </div>
              </label>
            )}
            <label className="schedule-field">
              <span>Max Retries</span>
              <div className="schedule-input-row">
                <input
                  type="number" min={0} max={10}
                  value={schedForm.maxRetries ?? 3}
                  onChange={(e) => setSchedForm((s) => ({ ...s, maxRetries: Number(e.target.value) }))}
                />
                <span className="schedule-unit">times</span>
              </div>
            </label>
            <label className="schedule-field">
              <span>Status</span>
              <select
                value={schedForm.enabled ? "true" : "false"}
                onChange={(e) => setSchedForm((s) => ({ ...s, enabled: e.target.value === "true" }))}
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </label>
            <div className="wizard-actions">
              <button className="btn-secondary" onClick={() => setEditSchedule(false)}>Cancel</button>
              <button className="btn-primary" onClick={saveSchedule} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        ) : schedule ? (
          <div className="schedule-summary">
            <div className="schedule-row">
              <span className="schedule-label">Repeat</span>
              <span>{schedule.repeatType === "once" ? "Run Once" :
                     schedule.repeatType === "hourly" ? `Every ${schedule.intervalHours}h` :
                     schedule.repeatType === "daily" ? `Daily at ${String(schedule.dailyAtHour ?? 0).padStart(2, "0")}:${String(schedule.dailyAtMinute ?? 0).padStart(2, "0")}` :
                     schedule.repeatType}</span>
            </div>
            {schedule.deadline && (
              <div className="schedule-row">
                <span className="schedule-label">Deadline</span>
                <span>{new Date(schedule.deadline).toLocaleString()}</span>
              </div>
            )}
            <div className="schedule-row">
              <span className="schedule-label">Retries</span>
              <span>{schedule.retryCount} / {schedule.maxRetries}</span>
            </div>
            {schedule.lastRunAt && (
              <div className="schedule-row">
                <span className="schedule-label">Last Run</span>
                <span>{new Date(schedule.lastRunAt).toLocaleString()}</span>
              </div>
            )}
            <div className="schedule-row">
              <span className="schedule-label">Status</span>
              <span className={`sched-badge ${schedule.enabled ? "on" : "off"}`}>
                {schedule.enabled ? "Enabled" : "Disabled"}
              </span>
            </div>
          </div>
        ) : (
          <p className="empty-text">No schedule configured</p>
        )}
      </section>

      {conv || conversationHistory.length > 0 ? (
        <>
          <div className="job-persona-info">
            <h3>
              Bee Worker:{" "}
              {(() => {
                const beeId = displayConv?.beeId ?? conv?.beeId ?? "—";
                const beeName = districtBees.find((b) => b.id === beeId)?.name;
                return beeName ? `${beeName} (${beeId})` : beeId;
              })()}
            </h3>
            <p>
              {displayConv ? (
                <>
                  Started: {new Date(displayConv.startedAt).toLocaleString()}
                  {displayConv.finishedAt && (
                    <> &middot; Duration: {formatDurationMs(new Date(displayConv.finishedAt).getTime() - new Date(displayConv.startedAt).getTime())}</>
                  )}
                  {conversationViewKey !== "live" && (
                    <span style={{ marginLeft: "0.5rem", fontSize: "0.85rem", color: "var(--text-secondary)" }}>
                      (Previous run)
                    </span>
                  )}
                </>
              ) : (
                <span style={{ color: "var(--muted)" }}>Select a run to display.</span>
              )}
            </p>
            {aiSummary && (
              <div className="job-token-stats">
                <span className="job-token-chip">
                  In <strong>{formatTokenCount(aiSummary.inputTokens)}</strong>
                </span>
                <span className="job-token-chip">
                  Out <strong>{formatTokenCount(aiSummary.outputTokens)}</strong>
                </span>
                <span className="job-token-chip">
                  Total <strong>{formatTokenCount(aiSummary.totalTokens)}</strong> tokens
                </span>
                <span className="job-token-chip">
                  LLM <strong>{formatDurationMs(aiSummary.durationMs)}</strong>
                </span>
              </div>
            )}
          </div>

          <section className="panel">
            <div
              className="section-header"
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "0.75rem",
                marginBottom: showHistoryPicker ? "0.75rem" : 0,
              }}
            >
              <h2 style={{ margin: 0 }}>Chat History</h2>
              {showHistoryPicker ? (
                <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.9rem" }}>
                  <span style={{ whiteSpace: "nowrap" }}>Run History</span>
                  <select
                    className="input"
                    style={{ minWidth: "14rem", maxWidth: "100%" }}
                    value={historySelectValue}
                    onChange={(e) => setConversationViewKey(e.target.value)}
                  >
                    {conv ? (
                      <option value="live">
                        Current · {conv.status} · {new Date(conv.startedAt).toLocaleString()} · {conv.entries.length} entries
                      </option>
                    ) : null}
                    {conversationHistory.map((h, i) => (
                      <option key={h.sessionId ?? `hist-${i}`} value={h.sessionId ?? `hist-${i}`}>
                        Previous #{i + 1} · {new Date(h.startedAt).toLocaleString()} · {h.status} · {h.entries.length} entries
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>

            <div className="conversation-view">
              {!displayConv ? (
                <p style={{ textAlign: "center", color: "var(--muted)", padding: "24px" }}>Could not load selected history.</p>
              ) : displayConv.entries.length === 0 ? (
                <p style={{ textAlign: "center", color: "var(--muted)", padding: "24px" }}>
                  Waiting for task execution to start...
                </p>
              ) : (
                displayConv.entries.map((entry, i) => {
                  const isLlmCall = entry.action === "llm_call";
                  const isCodeAction = CODE_ACTIONS.has(entry.action);
                  const isDone = entry.role === "system" && entry.action === "done";
                  const isError = entry.role === "system" && entry.action === "error";
                  const actionLabel = ACTION_LABELS[entry.action] ?? entry.action;
                  const isExpanded = expandedEntries.has(i);
                  const COLLAPSE_THRESHOLD = 300;
                  const needsCollapse = entry.content.length > COLLAPSE_THRESHOLD;

                  const toggleExpand = () => {
                    setExpandedEntries((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i); else next.add(i);
                      return next;
                    });
                  };

                  // llm_call: compact inline thinking row
                  if (isLlmCall) {
                    return (
                      <div key={i} className="chat-entry-thinking">
                        <span className="thinking-icon">⋯</span>
                        <span>{actionLabel} &middot; {entry.content.replace("LLM thinking... ", "")}</span>
                        <span className="chat-time-inline">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                      </div>
                    );
                  }

                  // system done / error: badge style
                  if (isDone || isError) {
                    const displayContent = (!isExpanded && needsCollapse)
                      ? entry.content.slice(0, COLLAPSE_THRESHOLD) + "…"
                      : entry.content;
                    return (
                      <div key={i} className={`chat-entry-system-result ${isDone ? "success" : "failure"}`}>
                        <span className={`system-result-badge ${isDone ? "badge-done" : "badge-error"}`}>
                          {isDone ? "✓ Done" : "✗ Error"}
                        </span>
                        <div className="system-result-content" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                          {displayContent}
                        </div>
                        {needsCollapse && (
                          <button className="chat-expand-btn" onClick={toggleExpand}>
                            {isExpanded ? "Show less" : "Show more"}
                          </button>
                        )}
                        <span className="chat-time">{new Date(entry.timestamp).toLocaleTimeString()}</span>
                      </div>
                    );
                  }

                  // code actions: pre/code block with collapse
                  const contentToShow = (!isExpanded && needsCollapse && isCodeAction)
                    ? entry.content.split("\n").slice(0, 8).join("\n") + (entry.content.split("\n").length > 8 ? "\n…" : "")
                    : entry.content;

                  return (
                    <div key={i} className={`chat-entry ${entry.role}`}>
                      {entry.role !== "system" && (
                        <div
                          className={`chat-avatar ${entry.role}-avatar`}
                          title={entry.role === "bee" ? "Bee (LLM Planner)" : "Flower (Code Executor)"}
                        >
                          {entry.role === "bee" ? "B" : "F"}
                        </div>
                      )}
                      <div className={`chat-bubble ${entry.role}-bubble`}>
                        {entry.source ? <div className="chat-source">{entry.source}</div> : null}
                        <div className="chat-action">{actionLabel}</div>
                        {isCodeAction ? (
                          <pre className="chat-code-block"><code>{contentToShow}</code></pre>
                        ) : (
                          <div className="chat-content" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                            {contentToShow}
                          </div>
                        )}
                        {needsCollapse && (
                          <button className="chat-expand-btn" onClick={toggleExpand}>
                            {isExpanded ? "Show less" : "Show more"}
                          </button>
                        )}
                        <div className="chat-time">
                          {new Date(entry.timestamp).toLocaleTimeString()}
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
              <div ref={bottomRef} />
            </div>
          </section>

          {conv?.status === "running" && conversationViewKey === "live" && (
            <div style={{ textAlign: "center", padding: "16px", color: "var(--accent)" }}>
              <span className="status-dot running" style={{ marginRight: 8 }} />
              Building...
            </div>
          )}

          {conv?.status === "failed" && conversationViewKey === "live" && (
            <div className="retry-banner">
              <p>This task has failed. {schedule && schedule.retryCount < schedule.maxRetries
                ? `Retry available (${schedule.retryCount}/${schedule.maxRetries})`
                : schedule && schedule.retryCount >= schedule.maxRetries
                ? "Maximum retry count reached"
                : ""}</p>
              <button className="btn-danger" onClick={handleRetry} disabled={retrying}>
                {retrying ? "Retrying..." : "Restart"}
              </button>
              <button className="btn-secondary" onClick={handleResume} disabled={resuming}>
                {resuming ? "Resuming..." : "Resume"}
              </button>
            </div>
          )}
        </>
      ) : (
        <section className="panel schedule-panel">
          <div className="section-header">
            <h2>Conversation</h2>
          </div>
          <p className="empty-text" style={{ marginTop: 0 }}>
            No execution or conversation history for this task yet. After you approve in <strong>Approvals</strong>, when the queue starts, Bee/Flower logs appear here.
            Tasks that do not require approval create history as soon as they run. On restart or the next run, previous records are kept in the workspace and you can open them from the list above.
          </p>
        </section>
      )}
    </div>
  );
}
