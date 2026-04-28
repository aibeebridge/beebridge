"use client";

import { newBeeId } from "@beebridge/shared";
import { useState, useEffect, useRef } from "react";
import { useGateway } from "../../../context/gateway";
import Link from "next/link";

type Step = "goal" | "questions" | "team" | "schedule" | "planning" | "result";
type ScheduleRepeat = "once" | "hourly" | "daily" | "custom";

interface ScheduleConfig {
  deadline: string;
  repeatType: ScheduleRepeat;
  intervalHours: number;
  dailyAtHour: number;
  dailyAtMinute: number;
  maxRetries: number;
}

interface IntakeQuestion {
  key: string;
  prompt: string;
}

interface BeePersonaInput {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  flowerType: "browser" | "code";
}

interface BeeTask {
  id: string;
  title: string;
  bee?: string;
  flower?: string;
  priority?: string;
  status?: string;
  requiresApproval?: boolean;
  personaId?: string;
  districtId?: string;
}

interface BeeDistrict {
  id: string;
  title: string;
  objective?: string;
}

interface PlanResult {
  managerPlan: {
    projectTitle: string;
    missions: BeeDistrict[];
    districts?: BeeDistrict[];
    jobs: BeeTask[];
    tasks?: BeeTask[];
    bees: BeePersonaInput[];
  };
  hive: { id: string; title: string };
  city?: { id: string; title: string };
  runtime: { providerId: string; model: string };
  pendingBeeApprovals: BeeTask[];
}

interface ProviderItem {
  id: string;
  label: string;
  models: string[];
}

const ROLE_PRESETS: { name: string; role: string; prompt: string; flowerType?: "browser" | "code" }[] = [
  { name: "Researcher", role: "researcher", prompt: "Collects and organizes key information through web searches and document exploration." },
  { name: "Analyst", role: "analyst", prompt: "Analyzes gathered information and derives actionable insights." },
  { name: "Writer", role: "writer", prompt: "Creates reports, blog posts, and summaries based on collected information." },
  { name: "Coder", role: "coder", prompt: "Writes code, debugs issues, and performs refactoring.", flowerType: "code" },
  { name: "Reviewer", role: "reviewer", prompt: "Validates deliverables and suggests improvements." },
];

interface ExistingDistrict {
  id: string;
  title: string;
  objective?: string;
  taskCount?: number;
}

interface UpstreamOverviewDistrict {
  districtId: string;
  districtTitle: string;
  bees: { id: string; name: string; role: string }[];
  tasks: { taskId: string; title: string; beeId: string; beeName: string }[];
}

type ContextSuggestion = {
  sourceType: "conversation" | "pipeline";
  sourceId: string;
  title: string;
  preview: string;
  score: number;
  createdAt: string;
};

export default function NewTaskPage() {
  const { apiFetch } = useGateway();
  const [step, setStep] = useState<Step>("goal");
  const [goal, setGoal] = useState("");
  const [questions, setQuestions] = useState<IntakeQuestion[]>([]);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [bees, setBees] = useState<BeePersonaInput[]>([]);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [defaultProvider, setDefaultProvider] = useState("");
  const [defaultModel, setDefaultModel] = useState("");
  const [planResult, setPlanResult] = useState<PlanResult | null>(null);
  const [schedule, setSchedule] = useState<ScheduleConfig>({
    deadline: "",
    repeatType: "once",
    intervalHours: 1,
    dailyAtHour: 9,
    dailyAtMinute: 0,
    maxRetries: 3,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [existingDistricts, setExistingDistricts] = useState<ExistingDistrict[]>([]);
  const [selectedDistrictId, setSelectedDistrictId] = useState<string>("__new__");

  const personaPromptRefs = useRef<(HTMLTextAreaElement | null)[]>([]);
  const [activeBeeIndex, setActiveBeeIndex] = useState(0);
  const [upstreamOverview, setUpstreamOverview] = useState<UpstreamOverviewDistrict[]>([]);
  const [upstreamLoading, setUpstreamLoading] = useState(false);
  const [suggestions, setSuggestions] = useState<ContextSuggestion[]>([]);

  useEffect(() => {
    apiFetch("/api/districts")
      .then((data) => {
        const list: ExistingDistrict[] = Array.isArray(data.districts) ? data.districts : [];
        setExistingDistricts(list);
      })
      .catch(() => {});
  }, [apiFetch]);

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
    if (step !== "team" || selectedDistrictId === "__new__") {
      setUpstreamOverview([]);
      return;
    }
    let cancelled = false;
    setUpstreamLoading(true);
    apiFetch(`/api/bridge-graph/upstream-overview?districtId=${encodeURIComponent(selectedDistrictId)}`)
      .then((data) => {
        if (cancelled) return;
        setUpstreamOverview(Array.isArray(data.districts) ? data.districts : []);
      })
      .catch(() => {
        if (!cancelled) setUpstreamOverview([]);
      })
      .finally(() => {
        if (!cancelled) setUpstreamLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [step, selectedDistrictId, apiFetch]);

  useEffect(() => {
    if (selectedDistrictId === "__new__") {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    apiFetch(`/api/context/suggestions?districtId=${encodeURIComponent(selectedDistrictId)}&limit=5`)
      .then((data) => {
        if (!cancelled) setSuggestions(Array.isArray(data.suggestions) ? data.suggestions : []);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedDistrictId, apiFetch]);

  function insertSuggestionIntoGoal(s: ContextSuggestion) {
    setGoal((cur) => `${cur.trim()}${cur.trim() ? "\n\n" : ""}Prior output (${s.title}):\n${s.preview}`);
  }

  useEffect(() => {
    if (bees.length === 0) return;
    setActiveBeeIndex((i) => Math.min(i, bees.length - 1));
  }, [bees.length]);

  function insertBridgeOutInPersona(beeIndex: number, taskId: string) {
    const insert = `{{bridgeOut:${taskId}}}`;
    const el = personaPromptRefs.current[beeIndex];
    setBees((prev) => {
      const row = prev[beeIndex];
      if (!row) return prev;
      const cur = row.systemPrompt;
      if (!el) {
        return prev.map((b, i) => (i === beeIndex ? { ...b, systemPrompt: cur + insert } : b));
      }
      const start = el.selectionStart ?? 0;
      const end = el.selectionEnd ?? 0;
      const next = cur.slice(0, start) + insert + cur.slice(end);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + insert.length;
        el.setSelectionRange(pos, pos);
      });
      return prev.map((b, i) => (i === beeIndex ? { ...b, systemPrompt: next } : b));
    });
  }

  function personaPromptPlaceholder(index: number): string {
    return ROLE_PRESETS[index % ROLE_PRESETS.length].prompt;
  }

  function createDefaultBee(index: number): BeePersonaInput {
    const preset = ROLE_PRESETS[index % ROLE_PRESETS.length];
    return {
      id: newBeeId(),
      name: preset.name,
      role: preset.role,
      systemPrompt: "",
      providerId: "default",
      model: "default",
      flowerType: preset.flowerType ?? "browser",
    };
  }

  function handleBeeCountChange(count: number) {
    const clamped = Math.max(1, Math.min(count, 5));
    const next: BeePersonaInput[] = [];
    for (let i = 0; i < clamped; i++) {
      next.push(bees[i] ?? createDefaultBee(i));
    }
    setBees(next);
  }

  function updateBee(index: number, patch: Partial<BeePersonaInput>) {
    setBees((prev) => prev.map((b, i) => (i === index ? { ...b, ...patch } : b)));
  }

  function applyPreset(index: number, presetIdx: number) {
    const preset = ROLE_PRESETS[presetIdx];
    updateBee(index, { name: preset.name, role: preset.role, systemPrompt: preset.prompt, flowerType: preset.flowerType ?? "browser" });
  }

  async function handleGoalSubmit() {
    if (!goal.trim()) return;
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/api/intake", {
        method: "POST",
        body: JSON.stringify({ goal, answers: {} }),
      });
      const qs: IntakeQuestion[] = Array.isArray(data.managerQuestions) ? data.managerQuestions : [];
      setQuestions(qs.filter((q) => q.key !== "beeCount" && q.key !== "beeRoles"));
      if (qs.length > 0) {
        setStep("questions");
      } else {
        setStep("team");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Intake request failed");
    } finally {
      setLoading(false);
    }
  }

  function goToTeam() {
    if (bees.length === 0) handleBeeCountChange(1);
    setStep("team");
  }

  async function createPlan() {
    setStep("planning");
    setLoading(true);
    setError("");
    try {
      const resolvedBees = bees.map((b, i) => {
        const trimmed = b.systemPrompt.trim();
        const systemPrompt = trimmed || personaPromptPlaceholder(i);
        return {
          ...b,
          systemPrompt,
          providerId: b.providerId === "default" ? defaultProvider : b.providerId,
          model: b.model === "default" ? defaultModel : b.model,
        };
      });

      const body: Record<string, unknown> = {
        goal,
        beeCount: resolvedBees.length,
        bees: resolvedBees,
        districtId: selectedDistrictId !== "__new__" ? selectedDistrictId : undefined,
        schedule: {
          deadline: schedule.deadline || undefined,
          repeatType: schedule.repeatType,
          intervalHours: schedule.repeatType === "hourly" ? schedule.intervalHours : undefined,
          dailyAtHour: schedule.repeatType === "daily" ? schedule.dailyAtHour : undefined,
          dailyAtMinute: schedule.repeatType === "daily" ? schedule.dailyAtMinute : undefined,
          maxRetries: schedule.maxRetries,
        },
      };
      if (answers.deadline) body.deadline = answers.deadline;
      if (answers.priority) body.priority = answers.priority;
      if (answers.constraints) body.constraints = answers.constraints.split(",").map((s) => s.trim()).filter(Boolean);

      const data = await apiFetch("/api/plan", {
        method: "POST",
        body: JSON.stringify(body),
      });
      setPlanResult(data as PlanResult);
      setStep("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Plan creation failed");
      setStep("schedule");
    } finally {
      setLoading(false);
    }
  }

  function handleAnswerChange(key: string, value: string) {
    setAnswers((prev) => ({ ...prev, [key]: value }));
  }

  function getModelsForProvider(providerId: string): string[] {
    if (providerId === "default") {
      const p = providers.find((pr) => pr.id === defaultProvider);
      return p?.models ?? [];
    }
    return providers.find((pr) => pr.id === providerId)?.models ?? [];
  }

  const resultDistricts = planResult?.managerPlan.districts ?? planResult?.managerPlan.missions ?? [];
  const resultTasks = planResult?.managerPlan.tasks ?? planResult?.managerPlan.jobs ?? [];
  const resultCityTitle = planResult?.city?.title ?? planResult?.hive?.title ?? "";

  return (
    <div className="page-container">
      <header className="page-header">
        <h1>New Task</h1>
        <p className="page-subtitle">Create a new district and assign tasks to your bee workers</p>
      </header>

      {error && <p className="page-error">{error}</p>}

      <div className="wizard-steps">
        <span className={`wizard-step ${step === "goal" ? "active" : "done"}`}>1. Goal</span>
        <span className={`wizard-step ${step === "questions" ? "active" : ["team", "schedule", "planning", "result"].includes(step) ? "done" : ""}`}>2. Details</span>
        <span className={`wizard-step ${step === "team" ? "active" : ["schedule", "planning", "result"].includes(step) ? "done" : ""}`}>3. Team</span>
        <span className={`wizard-step ${step === "schedule" ? "active" : ["planning", "result"].includes(step) ? "done" : ""}`}>4. Schedule</span>
        <span className={`wizard-step ${step === "planning" ? "active" : step === "result" ? "done" : ""}`}>5. Build</span>
        <span className={`wizard-step ${step === "result" ? "active" : ""}`}>6. Blueprint</span>
      </div>

      {step === "goal" && (
        <section className="panel wizard-panel">
          <h2>Define your task goal</h2>
          <p className="wizard-hint">Select a district (project) to add the task to, or create a new one.</p>

          <label className="question-field" style={{ marginBottom: "1rem" }}>
            <span>District</span>
            <select
              className="input"
              value={selectedDistrictId}
              onChange={(e) => setSelectedDistrictId(e.target.value)}
            >
              <option value="__new__">+ Create new district</option>
              {existingDistricts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title} ({d.taskCount ?? 0} tasks)
                </option>
              ))}
            </select>
          </label>

          <textarea
            className="wizard-textarea"
            rows={4}
            placeholder="e.g. Research the latest trends in quantum computing and write a report"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
          />
          {suggestions.length > 0 && (
            <div style={{ margin: "0.75rem 0", display: "grid", gap: "0.5rem" }}>
              <strong style={{ fontSize: "0.9rem" }}>Relevant prior outputs</strong>
              {suggestions.map((s) => (
                <button
                  key={`${s.sourceType}:${s.sourceId}`}
                  type="button"
                  className="btn-secondary"
                  style={{ textAlign: "left", whiteSpace: "normal" }}
                  onClick={() => insertSuggestionIntoGoal(s)}
                >
                  {s.title}: {s.preview.slice(0, 120)}
                </button>
              ))}
            </div>
          )}
          <button className="btn-primary" onClick={handleGoalSubmit} disabled={loading || !goal.trim()}>
            {loading ? "Analyzing..." : "Next \u2192"}
          </button>
        </section>
      )}

      {step === "questions" && (
        <section className="panel wizard-panel">
          <h2>Manager Questions</h2>
          <p className="wizard-hint">The Project Manager needs additional information to plan the district.</p>
          <div className="question-list">
            {questions.map((q) => (
              <label key={q.key} className="question-field">
                <span>{q.prompt}</span>
                {q.key === "priority" ? (
                  <select
                    value={answers[q.key] ?? "medium"}
                    onChange={(e) => handleAnswerChange(q.key, e.target.value)}
                  >
                    <option value="low">Low</option>
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                ) : (
                  <input
                    type="text"
                    placeholder={q.key === "deadline" ? "e.g. 2026-04-01" : "Enter value"}
                    value={answers[q.key] ?? ""}
                    onChange={(e) => handleAnswerChange(q.key, e.target.value)}
                  />
                )}
              </label>
            ))}
          </div>
          <div className="wizard-actions">
            <button className="btn-secondary" onClick={() => setStep("goal")}>&larr; Back</button>
            <button className="btn-primary" onClick={goToTeam}>Next: Bee Workers &rarr;</button>
          </div>
        </section>
      )}

      {step === "team" && (
        <section className="panel wizard-panel">
          <h2>Bee Worker Setup</h2>
          <p className="wizard-hint">Assign bee workers to build this district. Each bee handles a specific role.</p>

          {selectedDistrictId === "__new__" ? (
            <p className="wizard-hint" style={{ marginTop: "0.5rem" }}>
              When creating a new district, there is no previous district connected via Bridges yet. Pick an existing district in step 1 to show the upstream list here.
            </p>
          ) : (
            <div
              style={{
                marginBottom: "1rem",
                padding: "0.75rem 1rem",
                border: "1px solid var(--border, #d8dee6)",
                borderRadius: "0.5rem",
                background: "var(--bg-secondary, #f6f8fb)",
              }}
            >
              <div style={{ fontWeight: 600, marginBottom: "0.35rem" }}>Previous district connected via bridge</div>
              <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem", fontSize: "0.85rem" }}>
                  <span>Bee for Persona</span>
                  <select
                    className="input"
                    value={activeBeeIndex}
                    onChange={(e) => setActiveBeeIndex(Number(e.target.value))}
                  >
                    {bees.map((_, i) => (
                      <option key={i} value={i}>
                        Bee {i + 1}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p style={{ fontSize: "0.85rem", color: "var(--text-secondary, #5a6578)", margin: "0 0 0.5rem" }}>
                Press the task button below to insert <code>{"{{bridgeOut:taskId}}"}</code> into the selected Bee&apos;s Persona Prompt. You can also click the Persona field in the card to switch the target Bee.
              </p>
              {upstreamLoading && <p style={{ margin: 0, fontSize: "0.9rem" }}>Loading…</p>}
              {!upstreamLoading && upstreamOverview.length === 0 && (
                <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-secondary)" }}>
                  No upstream districts are reachable via one_way bridge. In the Bridges tab, create a bridge from a starting point to this district. Please check again after creating.
                </p>
              )}
              {!upstreamLoading &&
                upstreamOverview.map((dist) => (
                  <div
                    key={dist.districtId}
                    style={{
                      marginTop: "0.65rem",
                      padding: "0.5rem 0.65rem",
                      background: "var(--bg, #fff)",
                      borderRadius: "0.35rem",
                      border: "1px solid var(--border, #e2e8f0)",
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>{dist.districtTitle}</div>
                    <div style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.25rem" }}>
                      <span style={{ fontWeight: 600 }}>Bees</span>
                      {dist.bees.length === 0 ? (
                        <span> — (no registered bees)</span>
                      ) : (
                        <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.1rem" }}>
                          {dist.bees.map((b) => (
                            <li key={b.id}>
                              <code style={{ fontSize: "0.75rem" }}>{b.id}</code> · {b.name}{" "}
                              <span style={{ opacity: 0.85 }}>({b.role})</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div style={{ marginTop: "0.45rem" }}>
                      <span style={{ fontSize: "0.8rem", fontWeight: 600 }}>Reference previous task output</span>
                      {dist.tasks.length === 0 ? (
                        <span style={{ fontSize: "0.85rem", color: "var(--text-secondary)" }}> — no tasks</span>
                      ) : (
                        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem", marginTop: "0.35rem" }}>
                          {dist.tasks.map((t) => (
                            <button
                              key={t.taskId}
                              type="button"
                              className="btn-secondary btn-sm"
                              title={`${t.beeName || t.beeId} · ${t.taskId}`}
                              onClick={() => insertBridgeOutInPersona(activeBeeIndex, t.taskId)}
                            >
                              {t.title.length > 32 ? `${t.title.slice(0, 31)}…` : t.title}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
            </div>
          )}

          <div className="team-count-row">
            <label>Bee Workers:</label>
            <div className="bee-count-btns">
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  className={`bee-count-btn ${bees.length === n ? "active" : ""}`}
                  onClick={() => handleBeeCountChange(n)}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div className="team-cards">
            {bees.map((bee, i) => (
              <div key={bee.id} className="persona-card">
                <div className="persona-header">
                  <span className="persona-number">Bee {i + 1}</span>
                  <select
                    className="preset-select"
                    value=""
                    onChange={(e) => { if (e.target.value) applyPreset(i, Number(e.target.value)); }}
                  >
                    <option value="">Select Preset...</option>
                    {ROLE_PRESETS.map((p, pi) => (
                      <option key={pi} value={pi}>{p.name}</option>
                    ))}
                  </select>
                </div>

                <div className="persona-fields">
                  <label>
                    <span>Bee ID (unique)</span>
                    <input
                      value={bee.id}
                      readOnly
                      title="A unique ID assigned per plan/session"
                      style={{ fontSize: 12, fontFamily: "ui-monospace, monospace" }}
                    />
                  </label>
                  <label>
                    <span>Name</span>
                    <input value={bee.name} onChange={(e) => updateBee(i, { name: e.target.value })} />
                  </label>
                  <label>
                    <span>Role</span>
                    <input value={bee.role} onChange={(e) => updateBee(i, { role: e.target.value })} />
                  </label>
                  <label>
                    <span>Persona Prompt</span>
                    <textarea
                      ref={(el) => {
                        personaPromptRefs.current[i] = el;
                      }}
                      rows={2}
                      value={bee.systemPrompt}
                      placeholder={personaPromptPlaceholder(i)}
                      onFocus={() => setActiveBeeIndex(i)}
                      onChange={(e) => updateBee(i, { systemPrompt: e.target.value })}
                    />
                  </label>
                  <div className="persona-row">
                    <label>
                      <span>AI Provider</span>
                      <select
                        value={bee.providerId}
                        onChange={(e) => updateBee(i, { providerId: e.target.value, model: "default" })}
                      >
                        <option value="default">Default ({defaultProvider})</option>
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Model</span>
                      <select value={bee.model} onChange={(e) => updateBee(i, { model: e.target.value })}>
                        <option value="default">Default ({defaultModel})</option>
                        {getModelsForProvider(bee.providerId).map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label>
                    <span>Flower (Runtime)</span>
                    <select value={bee.flowerType} onChange={(e) => updateBee(i, { flowerType: e.target.value as "browser" | "code" })}>
                      <option value="browser">Browser Control (Chrome Extension)</option>
                      <option value="code">Code Generation (Local)</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}
          </div>

          <div className="wizard-actions">
            <button className="btn-secondary" onClick={() => setStep("questions")}>&larr; Back</button>
            <button className="btn-primary" onClick={() => setStep("schedule")} disabled={bees.length === 0}>
              Next: Schedule &rarr;
            </button>
          </div>
        </section>
      )}

      {step === "schedule" && (
        <section className="panel wizard-panel">
          <h2>Schedule Settings</h2>
          <p className="wizard-hint">Configure deadline, repeat execution, and retry count on failure.</p>

          <div className="schedule-form">
            <label className="schedule-field">
              <span>Deadline</span>
              <input
                type="datetime-local"
                value={schedule.deadline}
                onChange={(e) => setSchedule((s) => ({ ...s, deadline: e.target.value }))}
              />
              <small className="field-hint">Leave empty for no deadline</small>
            </label>

            <label className="schedule-field">
              <span>Repeat Type</span>
              <select
                value={schedule.repeatType}
                onChange={(e) => setSchedule((s) => ({ ...s, repeatType: e.target.value as ScheduleRepeat }))}
              >
                <option value="once">Run Once</option>
                <option value="hourly">Hourly Interval</option>
                <option value="daily">Daily at Specific Time</option>
              </select>
            </label>

            {schedule.repeatType === "hourly" && (
              <label className="schedule-field">
                <span>Interval (hours)</span>
                <div className="schedule-input-row">
                  <input
                    type="number"
                    min={1}
                    max={24}
                    value={schedule.intervalHours}
                    onChange={(e) => setSchedule((s) => ({ ...s, intervalHours: Number(e.target.value) }))}
                  />
                  <span className="schedule-unit">hours</span>
                </div>
              </label>
            )}

            {schedule.repeatType === "daily" && (
              <label className="schedule-field">
                <span>Daily Run Time</span>
                <div className="schedule-input-row">
                  <select
                    value={schedule.dailyAtHour}
                    onChange={(e) => setSchedule((s) => ({ ...s, dailyAtHour: Number(e.target.value) }))}
                  >
                    {Array.from({ length: 24 }, (_, h) => (
                      <option key={h} value={h}>{String(h).padStart(2, "0")}h</option>
                    ))}
                  </select>
                  <select
                    value={schedule.dailyAtMinute}
                    onChange={(e) => setSchedule((s) => ({ ...s, dailyAtMinute: Number(e.target.value) }))}
                  >
                    {[0, 15, 30, 45].map((m) => (
                      <option key={m} value={m}>{String(m).padStart(2, "0")}m</option>
                    ))}
                  </select>
                </div>
              </label>
            )}

            <label className="schedule-field">
              <span>Max Retries on Failure</span>
              <div className="schedule-input-row">
                <input
                  type="number"
                  min={0}
                  max={10}
                  value={schedule.maxRetries}
                  onChange={(e) => setSchedule((s) => ({ ...s, maxRetries: Number(e.target.value) }))}
                />
                <span className="schedule-unit">times</span>
              </div>
              <small className="field-hint">Set to 0 for no retries</small>
            </label>
          </div>

          <div className="wizard-actions">
            <button className="btn-secondary" onClick={() => setStep("team")}>&larr; Back</button>
            <button className="btn-primary" onClick={createPlan} disabled={loading}>
              {loading ? "Building..." : "Build City \u2192"}
            </button>
          </div>
        </section>
      )}

      {step === "planning" && (
        <section className="panel wizard-panel center-text">
          <div className="planning-spinner" />
          <h2>Building your city...</h2>
          <p className="wizard-hint">The Manager is laying out districts and assigning bee workers to tasks.</p>
        </section>
      )}

      {step === "result" && planResult && (
        <section className="panel wizard-panel">
          <h2>City Blueprint Ready</h2>
          <div className="result-header">
            <span className="result-badge">&#10003; {resultCityTitle}</span>
            <span className="result-meta">
              {planResult.runtime.providerId}/{planResult.runtime.model}
            </span>
          </div>

          <h3>Bee Workers ({planResult.managerPlan.bees?.length ?? 0})</h3>
          <div className="result-jobs">
            {(planResult.managerPlan.bees ?? []).map((bee) => (
              <div key={bee.id} className="result-job-card">
                <div className="result-job-top">
                  <strong>{bee.name}</strong>
                  <span className="approval-badge">{bee.role}</span>
                </div>
                <div className="result-job-meta">
                  <span>{bee.providerId}/{bee.model}</span>
                  <span>Flower: {bee.flowerType === "code" ? "Code Generation" : "Browser"}</span>
                </div>
              </div>
            ))}
          </div>

          <h3>Districts ({resultDistricts.length})</h3>
          <ul className="result-list">
            {resultDistricts.map((d) => (
              <li key={d.id}><span className="district-icon-sm">🏗️</span> <strong>{d.id}</strong> {d.title}</li>
            ))}
          </ul>

          <h3>Tasks ({resultTasks.length})</h3>
          <div className="result-jobs">
            {resultTasks.map((task) => (
              <div key={task.id} className="result-job-card">
                <div className="result-job-top">
                  <strong>{task.title}</strong>
                  {task.requiresApproval && <span className="approval-badge">Approval Required</span>}
                </div>
                <div className="result-job-meta">
                  {task.bee && <span>Bee: {task.bee}</span>}
                  {task.flower && <span>Flower: {task.flower}</span>}
                  {task.priority && <span className={`priority-tag ${task.priority}`}>{task.priority}</span>}
                  {task.districtId && <span className="district-badge">{task.districtId}</span>}
                </div>
              </div>
            ))}
          </div>

          {planResult.pendingBeeApprovals.length > 0 && (
            <p className="result-notice">
              {planResult.pendingBeeApprovals.length} task(s) pending approval.
            </p>
          )}

          <div className="wizard-actions">
            <Link href="/jobs" className="btn-primary">Go to Districts</Link>
            <Link href="/approvals" className="btn-secondary">Approvals</Link>
            <button className="btn-secondary" onClick={() => { setStep("goal"); setGoal(""); setPlanResult(null); setAnswers({}); setBees([]); }}>
              Build Another District
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
