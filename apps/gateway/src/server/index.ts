import express from "express";

import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { AuthRateLimit } from "../auth/rate-limit.js";
import { resolveWsAuthContext } from "../auth/ws-auth-context.js";
import { type GatewayAuthConfig, authorizeSecret } from "../auth/modes.js";
import {
  buildIntakeQuestions,
  createHiveFromPlan,
  createCityPlanFromBrief,
  buildExecutionWaves,
  ApprovalGate,
  AuditLog,
  ExecutionQueue,
  type QueueExtras,
  type PmRuntimeContext,
  type BeeTask,
  type BeeDistrict,
  type BeePersona,
  type DistrictStatus,
  type TeamPlan,
  type FlowerType,
  type ConversationEntry,
  type TaskSchedule,
  type FlowerConfig,
  type FlowerConnectionType,
  type DistrictBridge,
  type BridgeGraphMeta,
  type PipelineRunRecord,
  type ResolvedCodeProject,
  type PmAuthProfile,
  type TaskConversation,
  newBeeId,
} from "@beebridge/core";
import type { WebSocket as WsSocket } from "ws";
import { providerCatalog } from "../settings/providers.js";
import { PmSettingsStore } from "../settings/store.js";
import { JobStore } from "./job-store.js";
import { AiHistoryStore, type AiHistoryEntry } from "./ai-history-store.js";
import { UNASSIGNED_DISTRICT_ID, WorkspaceStore } from "./workspace-store.js";
import {
  applyBridgeOutPlaceholders,
  buildBridgeContextForTask,
  buildOutputByTaskIdForBridgeOut,
  collectPipelineTasks,
  orderTasksForBridgeRun,
  reachableDistrictsFromStart,
  upstreamDistrictsOneWay,
  type CompletedTaskInfo,
} from "./bridge-execution.js";
import { GraphStore } from "./graph-store.js";
import { executeTaskViaCdp } from "../browser/controller.js";
import { executeCodeTask } from "../codegen/code-executor.js";
import { ProjectManager } from "../codegen/project-manager.js";
import { cleanupAllProcessManagers } from "../codegen/process-manager.js";
import {
  cleanupSandboxContainers,
  killSandboxSession,
  listSandboxContainers,
  removeSandboxContainer,
  sandboxStatus,
  setSandboxModeProvider,
} from "../codegen/sandbox.js";
import { CdpRelayServer } from "../browser/cdp-relay.js";
import { InteractionChainStore } from "./interaction-chain-store.js";
import { WorkspaceConfig } from "./workspace-config.js";
import { FlowerConfigStore } from "./flower-config-store.js";
import { runChatTool, type ChatActionDeps } from "./chat-action-executors.js";
import { runChatMessage, type RunChatMessageDeps } from "./chat-request.js";
import { DiscordFlowerManager } from "./discord-flower-manager.js";
import {
  buildCodexAuthorizeUrl,
  exchangeCodexAuthorizationCode,
  generateOauthState,
  generatePkce,
  serializeCodexBundle,
} from "./openai-codex-oauth.js";
import {
  BEEGATEWAY_TOKEN_FILE,
  persistGatewayTokenFileIfChanged,
} from "@beebridge/shared/gateway-token-file";

const app = express();
app.use(express.json());

type AsyncHandler = (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>;
function asyncHandler(fn: AsyncHandler): express.RequestHandler {
  return (req, res, next) => { fn(req, res, next).catch(next); };
}

const ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean);

app.use((_req, res, next) => {
  const origin = ALLOWED_ORIGINS?.length ? (ALLOWED_ORIGINS.includes(_req.headers.origin ?? "") ? _req.headers.origin! : ALLOWED_ORIGINS[0]) : "*";
  res.header("Access-Control-Allow-Origin", origin);
  res.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

function log(tag: string, detail: string): void {
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  console.log(`[${ts}] [${tag}] ${detail}`);
}

/** Set `BEEBRIDGE_GATEWAY_PERF_LOG=1` for phase timings, slow HTTP, and WS message rate hints. */
const GATEWAY_PERF_LOG =
  process.env.BEEBRIDGE_GATEWAY_PERF_LOG === "1" || process.env.BEEBRIDGE_GATEWAY_PERF_LOG === "true";

const gatewayPerfBootT0 = performance.now();

function perfLog(phase: string, detail?: string): void {
  if (!GATEWAY_PERF_LOG) return;
  const ts = new Date().toLocaleTimeString("en-US", { hour12: false });
  const sinceBoot = (performance.now() - gatewayPerfBootT0).toFixed(1);
  const extra = detail ? ` ${detail}` : "";
  console.log(`[${ts}] [PERF] ${phase}${extra} (boot +${sinceBoot}ms)`);
}

let perfWsMsgInWindow = 0;
let perfWsWindowStart = Date.now();

if (GATEWAY_PERF_LOG) perfLog("boot", "BEEBRIDGE_GATEWAY_PERF_LOG enabled");

/** Task deletion debug — grep for `TASK_DELETE` in terminal */
function logTaskDelete(detail: string, meta?: Record<string, unknown>): void {
  const suffix = meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  log("TASK_DELETE", `${detail}${suffix}`);
}

async function postFormJson(url: string, form: URLSearchParams): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Accept": "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) throw new Error(`POST ${url} failed: ${res.status}`);
  return res.json();
}

app.use((req, res, next) => {
  const reqStarted = performance.now();
  log("REQ", `${req.method} ${req.path}`);
  if (GATEWAY_PERF_LOG) {
    res.on("finish", () => {
      const ms = performance.now() - reqStarted;
      if (ms >= 400) {
        perfLog("SLOW_HTTP", `${req.method} ${req.path} ${ms.toFixed(0)}ms status=${res.statusCode}`);
      }
    });
  }
  next();
});

app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "OPTIONS") {
    next();
    return;
  }
  res.on("finish", () => {
    if (res.statusCode < 500) {
      debouncedPersist();
    }
  });
  next();
});

const PORT = Number(process.env.PORT ?? 4321);
/** Loopback CDP relay for chrome.debugger extension (default: gateway port + 2). */
const CDP_RELAY_PORT = Number(process.env.BEEBRIDGE_CDP_RELAY_PORT ?? PORT + 2);

const authMode = (process.env.GATEWAY_AUTH_MODE as GatewayAuthConfig["mode"]) ?? "token";
let authToken = process.env.GATEWAY_TOKEN?.trim() || undefined;
const authPassword = process.env.GATEWAY_PASSWORD?.trim() || undefined;

if (authMode === "token" && !authToken) {
  authToken = randomBytes(24).toString("hex");
  log(
    "AUTH",
    `Generated a new gateway token for this startup and saved it to ${BEEGATEWAY_TOKEN_FILE}. Set GATEWAY_TOKEN to keep a fixed token.`,
  );
} else if (authMode === "none" && !authToken && !authPassword) {
  authToken = randomBytes(24).toString("hex");
  log(
    "AUTH",
    `GATEWAY_AUTH_MODE is none; generated a new startup secret for CDP relay and saved it to ${BEEGATEWAY_TOKEN_FILE}.`,
  );
}

const authConfig: GatewayAuthConfig = {
  mode: authMode,
  token: authToken,
  password: authPassword,
};

if (authMode === "token" && typeof authToken === "string" && authToken.length > 0) {
  if (persistGatewayTokenFileIfChanged(authToken)) {
    log("AUTH", `Updated ${BEEGATEWAY_TOKEN_FILE} so web UI and CLI read the same token as this gateway.`);
  }
}

if (authMode === "password" && !authConfig.password) {
  console.error("[FATAL] GATEWAY_AUTH_MODE is password but GATEWAY_PASSWORD is not set.");
  process.exit(1);
}

const cdpRelaySecret = authConfig.token ?? authConfig.password;
if (!cdpRelaySecret) {
  console.error(
    "[FATAL] No secret for CDP relay (set GATEWAY_TOKEN, or GATEWAY_PASSWORD when mode=password).",
  );
  process.exit(1);
}

const cdpRelay = new CdpRelayServer(cdpRelaySecret);

const limiter = new AuthRateLimit();
const approvalGate = new ApprovalGate();
const auditLog = new AuditLog();

const wsConfig = new WorkspaceConfig();
const dataRoot = wsConfig.dataRoot;
const stateRoot = wsConfig.stateRoot;
const projectManager = new ProjectManager(wsConfig.codeProjectsRoot, stateRoot);
log("WORKSPACE", `path=${wsConfig.workspacePath} dataRoot=${dataRoot} stateRoot=${stateRoot} codeProjects=${wsConfig.codeProjectsRoot}`);

const pmSettings = new PmSettingsStore(providerCatalog, dataRoot);
setSandboxModeProvider(() => pmSettings.getSandboxSettings().mode);
const jobStore = new JobStore();
const aiHistory = new AiHistoryStore(dataRoot);

const taskSchedules = new Map<string, TaskSchedule>();
const allTasks = new Map<string, BeeTask>();
const allDistricts = new Map<string, BeeDistrict>();
const districtBridges = new Map<string, DistrictBridge>();
const INTERNAL_SCHEDULER_ENABLED = process.env.BEEBRIDGE_DISABLE_INTERNAL_SCHEDULER !== "1";
const SCHEDULER_POLL_MS = Number(process.env.BEEBRIDGE_SCHEDULER_POLL_MS ?? 30_000);
const SCHEDULER_RETRY_DELAY_MS = Number(process.env.BEEBRIDGE_SCHEDULER_RETRY_DELAY_MS ?? 5 * 60_000);
const SCHEDULER_STAGGER_SEC = Number(process.env.BEEBRIDGE_SCHEDULER_STAGGER_SEC ?? 300);
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerTickRunning = false;
if (GATEWAY_PERF_LOG) perfLog("phase: GraphStore ctor start");
const _tGraphStore = performance.now();
const graphStore = new GraphStore(stateRoot);
if (GATEWAY_PERF_LOG) perfLog("phase: GraphStore ctor", `done in ${(performance.now() - _tGraphStore).toFixed(1)}ms`);
const _tChainStore = performance.now();
const chainStore = new InteractionChainStore(stateRoot);
if (GATEWAY_PERF_LOG) perfLog("phase: InteractionChainStore ctor", `done in ${(performance.now() - _tChainStore).toFixed(1)}ms`);

const flowerConfigStore = new FlowerConfigStore(dataRoot);
const discordFlowerManagerRef: { current: DiscordFlowerManager | null } = { current: null };

function scheduleDiscordFlowerSync(): void {
  void discordFlowerManagerRef.current?.sync().catch((e) => log("DISCORD", `sync: ${String(e)}`));
}

if (flowerConfigStore.size === 0) {
  flowerConfigStore.set("chrome-extension", {
    id: "chrome-extension",
    name: "BEEBRIDGE Browser Worker",
    type: "chrome_extension",
    enabled: true,
    description: "Browser automation via Chrome extension. Controls AI web services like ChatGPT, Claude, and general web pages.",
    capabilities: ["navigate", "click", "type", "read", "ai_chat", "ai_read_response", "screenshot", "scroll", "wait"],
    createdAt: new Date().toISOString(),
  });
}

const connectedFlowers = new Map<string, WsSocket>();
const webClients = new Set<WsSocket>();
const pendingJobs = new Map<string, { resolve: (v: { taskId: string; status: "done" | "failed"; output: string }) => void }>();

function getConnectedFlower(preferredFlowerId?: string): WsSocket | undefined {
  if (preferredFlowerId) {
    const exact = connectedFlowers.get(preferredFlowerId);
    if (exact && exact.readyState === 1) return exact;

    for (const [flowerId, ws] of connectedFlowers) {
      if (ws.readyState !== 1) continue;
      if (flowerId.includes(preferredFlowerId) || preferredFlowerId.includes(flowerId)) {
        return ws;
      }
    }
  }

  for (const [, ws] of connectedFlowers) {
    if (ws.readyState === 1) return ws;
  }
  return undefined;
}

function broadcastToWeb(msg: Record<string, unknown>) {
  const payload = JSON.stringify(msg);
  for (const client of webClients) {
    if (client.readyState === 1) client.send(payload);
  }
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedPersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistWorkspace();
  }, 500);
}

jobStore.onChange((jobId, conv) => {
  broadcastToWeb({ type: "job.update", jobId, status: conv.status, conversation: conv });
  debouncedPersist();
  if (conv.status === "done" || conv.status === "failed") {
    const task = allTasks.get(jobId);
    const lastEntry = conv.entries?.[conv.entries.length - 1];
    const summary = task ? `**${task.title}**\n${lastEntry?.content ?? ""}` : undefined;
    void discordFlowerManagerRef.current?.notifyTaskComplete(jobId, conv.status, summary);
  }
});

const queue = new ExecutionQueue(async (task: BeeTask, extras?: QueueExtras) => {
  const persona = latestTeamPlan?.bees?.find((b) => b.id === task.personaId);
  jobStore.start(task.id, task.personaId ?? task.bee);

  const district = task.districtId ? allDistricts.get(task.districtId) : undefined;
  const waggleConfig = district?.waggle;

  const isCodeTask = persona?.flowerType === "code" || (!persona && typeof task.flower === "string" && task.flower.endsWith("-code"));
  log("QUEUE", `executing task ${task.id} via ${isCodeTask ? "code" : "agent"} loop${waggleConfig?.enabled ? ` (waggle: ${waggleConfig.mode})` : ""}${!persona ? " (persona missing — using task.flower fallback)" : ""}`);
  const runTitle = extras?.resolvedTitle ?? task.title;
  const runDescription = extras?.resolvedDescription ?? task.description;
  const taskForRun =
    extras && (extras.resolvedTitle !== undefined || extras.resolvedDescription !== undefined)
      ? { ...task, title: runTitle, description: runDescription }
      : task;

  const taskCtx = {
    broadcastToWeb,
    jobStore,
    aiHistory,
    chainStore,
    log,
    getConnectedFlower,
    getCdpRelay: () => cdpRelay,
    pmSettings,
  };

  if (isCodeTask) {
    let resolvedProjectId = extras?.resolvedProjectId;
    let sharedProjectPath = extras?.resolvedProjectPath;
    if (!sharedProjectPath && district) {
      const resolvedProject = projectManager.resolveProjectForDistrict(district);
      resolvedProjectId = resolvedProject.id;
      sharedProjectPath = resolvedProject.path;
      persistWorkspace();
    }
    return executeCodeTask(taskForRun, persona ?? null, taskCtx, projectManager, waggleConfig, extras?.bridgeContext, extras?.bridgeOutMap, 0, sharedProjectPath, resolvedProjectId);
  }

  return executeTaskViaCdp(taskForRun, persona ?? null, taskCtx, waggleConfig, extras?.bridgeContext, extras?.bridgeOutMap);
});

type DeviceSession = {
  providerId: string;
  userCode: string;
  expiresAt: number;
  label?: string;
  deviceCode?: string;
  clientId?: string;
  pollInterval?: number;
  /** OpenAI Codex PKCE: user pastes the redirect URL back manually */
  codexVerifier?: string;
  codexState?: string;
};
const oauthDeviceSessions = new Map<string, DeviceSession>();
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of oauthDeviceSessions) {
    if (now > s.expiresAt) oauthDeviceSessions.delete(id);
  }
}, 5 * 60_000);
const GITHUB_COPILOT_CLIENT_ID_DEFAULT = "Iv1.b507a08c87ecfe98";
let latestTeamPlan: TeamPlan | null = null;
let bridgeGraphMeta: BridgeGraphMeta = { startDistrictId: null };
const workspaceStore = new WorkspaceStore(stateRoot);

function persistWorkspace(): void {
  // Single source of truth for job ids is allTasks. Team plan file can drift (partial deletes, old bugs);
  // if we save stale latestTeamPlan.tasks, reload + UI can disagree with /api/jobs.
  if (latestTeamPlan) {
    const before = latestTeamPlan.tasks.length;
    latestTeamPlan.tasks = latestTeamPlan.tasks.filter((t) => allTasks.has(t.id));
    const dropped = before - latestTeamPlan.tasks.length;
    if (dropped > 0) {
      log("STATE", `persistWorkspace: dropped ${dropped} team-plan task row(s) not in allTasks`);
      logTaskDelete("persistWorkspace:synced teamPlan.tasks to allTasks", { dropped, remaining: latestTeamPlan.tasks.length });
    }
  }
  workspaceStore.save({
    latestTeamPlan,
    districts: [...allDistricts.values()],
    tasks: [...allTasks.values()],
    schedules: Object.fromEntries([...taskSchedules.entries()]),
    bridges: [...districtBridges.values()],
    bridgeGraphMeta,
    conversations: jobStore.listAll(),
    conversationArchives: jobStore.exportArchives(),
    auditEvents: auditLog.snapshot(),
  });
}

function syncGraph(): void {
  // graph.json is loaded before workspace state; rebuild from canonical maps so deleted tasks/districts
  // cannot leave orphan nodes (e.g. after manual data wipe or partial deletes).
  graphStore.clear();
  for (const d of allDistricts.values()) {
    graphStore.addNode("district", d.id, d.title, { objective: d.objective, status: d.status, cityId: d.cityId });
  }
  for (const t of allTasks.values()) {
    graphStore.addNode("task", t.id, t.title, { districtId: t.districtId, bee: t.bee, status: t.status, priority: t.priority });
    if (t.districtId) graphStore.addEdge("contains", t.districtId, t.id);
    if (t.personaId || t.bee) graphStore.addEdge("assigned_to", t.id, t.personaId || t.bee);
  }
  for (const b of districtBridges.values()) {
    graphStore.addEdge("bridge", b.fromDistrictId, b.toDistrictId, b.label, { direction: b.direction, status: b.status });
  }
  if (latestTeamPlan?.bees) {
    for (const bee of latestTeamPlan.bees) {
      graphStore.addNode("bee", bee.id, bee.name, { role: bee.role, providerId: bee.providerId, model: bee.model });
    }
  }
}

{
  if (GATEWAY_PERF_LOG) perfLog("phase: workspaceStore.load start");
  const _tWsLoad = performance.now();
  const restored = workspaceStore.load();
  if (GATEWAY_PERF_LOG) perfLog("phase: workspaceStore.load", `done in ${(performance.now() - _tWsLoad).toFixed(1)}ms`);
  const _tRestore = performance.now();
  latestTeamPlan = restored.latestTeamPlan;
  bridgeGraphMeta = restored.bridgeGraphMeta ?? { startDistrictId: null };
  for (const district of restored.districts) {
    allDistricts.set(district.id, district);
  }
  for (const task of restored.tasks) {
    allTasks.set(task.id, task);
  }
  for (const [taskId, sched] of Object.entries(restored.schedules)) {
    taskSchedules.set(taskId, sched);
    const task = allTasks.get(taskId);
    if (task) task.schedule = sched;
  }
  for (const bridge of restored.bridges) {
    districtBridges.set(bridge.id, bridge);
  }
  jobStore.replaceAll(restored.conversations);
  jobStore.replaceArchives(restored.conversationArchives);
  auditLog.replaceAll(restored.auditEvents);
  if (GATEWAY_PERF_LOG) perfLog("phase: restore maps + jobStore + auditLog.replaceAll", `done in ${(performance.now() - _tRestore).toFixed(1)}ms`);
  const _tOrphan = performance.now();
  const orphanRemoved = reconcileOrphanTasks();
  let planTrimmed = 0;
  if (latestTeamPlan) {
    const before = latestTeamPlan.tasks.length;
    latestTeamPlan.tasks = latestTeamPlan.tasks.filter((t) => allTasks.has(t.id));
    planTrimmed = before - latestTeamPlan.tasks.length;
    if (planTrimmed > 0) {
      log("STATE", `trimmed ${planTrimmed} stale team-plan task row(s)`);
    }
  }
  if (latestTeamPlan) {
    const knownBeeIds = new Set(latestTeamPlan.bees.map((b) => b.id));
    let syntheticCount = 0;
    for (const task of allTasks.values()) {
      const pid = task.personaId ?? task.bee;
      if (!pid || knownBeeIds.has(pid)) continue;
      const isCode = typeof task.flower === "string" && task.flower.endsWith("-code");
      const ft: "code" | "browser" = isCode ? "code" : "browser";
      const runtime = resolveRuntimeContext();
      latestTeamPlan.bees.push({
        id: pid,
        name: task.title?.split("—").pop()?.trim() ?? `Bee ${pid.slice(-8)}`,
        role: isCode ? "coder" : "researcher",
        systemPrompt: task.description ?? "",
        providerId: runtime.providerId,
        model: runtime.model,
        flowerType: ft,
        scopedTaskId: task.id,
      });
      knownBeeIds.add(pid);
      syntheticCount++;
    }
    if (syntheticCount > 0) {
      log("STATE", `synthesized ${syntheticCount} persona(s) from tasks missing in team-plan`);
    }
  }

  if (GATEWAY_PERF_LOG) perfLog("phase: reconcileOrphan + teamPlan trim/synth", `done in ${(performance.now() - _tOrphan).toFixed(1)}ms`);
  const _tSyncGraph = performance.now();
  syncGraph();
  if (GATEWAY_PERF_LOG) perfLog("phase: syncGraph", `done in ${(performance.now() - _tSyncGraph).toFixed(1)}ms`);
  if (orphanRemoved > 0 || planTrimmed > 0) {
    persistWorkspace();
    if (orphanRemoved > 0) {
      log("STATE", `removed ${orphanRemoved} orphan task(s) (district no longer exists)`);
    }
  }
  const _tAuditScan = performance.now();
  const approvedFromAudit = new Set<string>();
  for (const ev of auditLog.list()) {
    if (ev.type === "bee.job.approved" && ev.payload && typeof ev.payload === "object" && "jobId" in ev.payload) {
      approvedFromAudit.add(String((ev.payload as { jobId: string }).jobId));
    }
  }
  approvalGate.reseedRestoredTasks(allTasks.values(), approvedFromAudit);
  if (GATEWAY_PERF_LOG) perfLog("phase: audit scan + approvalGate.reseedRestoredTasks", `done in ${(performance.now() - _tAuditScan).toFixed(1)}ms`);
  log(
    "STATE",
    `workspace loaded: ${allDistricts.size} districts, ${allTasks.size} tasks, ${districtBridges.size} bridges, ${restored.auditEvents.length} audit events, approvals pending=${approvalGate.listPending().length} approved=${approvalGate.listApproved().length}`,
  );
}

function resolveRuntimeContext(): PmRuntimeContext {
  const policy = pmSettings.getModelPolicy();
  const bee = pmSettings.get().beePolicy.providerToBee[policy.defaultProviderId] ?? "worker-bee-default";
  return {
    providerId: policy.defaultProviderId,
    model: policy.defaultModel,
    bee,
    flower: `${policy.defaultProviderId}-web`,
  };
}

function randomUserCode(): string {
  const part = () => Math.random().toString(36).slice(2, 6).toUpperCase();
  return `${part()}-${part()}`;
}

function deviceVerificationUri(providerId: string): string {
  if (providerId === "github-copilot") return "https://github.com/login/device";
  if (providerId === "google") return "https://aistudio.google.com/apikey";
  if (providerId === "anthropic") return "https://console.anthropic.com/settings/keys";
  /** OpenAI has no device-code OAuth in Beebridge; user creates an API key and pastes it back in the web UI. */
  if (providerId === "openai") return "https://platform.openai.com/api-keys";
  if (providerId === "xai") return "https://console.x.ai/";
  if (providerId === "openrouter") return "https://openrouter.ai/settings/keys";
  return "https://example.com/device";
}

function requestSecret(req: express.Request): string | undefined {
  const auth = req.headers.authorization;
  if (!auth) return undefined;
  return auth.startsWith("Bearer ") ? auth.slice(7) : auth;
}

function authStatusForSecret(supplied: string | undefined) {
  const authenticated = authorizeSecret(authConfig, supplied);
  return {
    authRequired: authConfig.mode !== "none",
    authenticated,
    authMode: authConfig.mode,
    ...(authConfig.mode !== "none" ? { tokenValid: authenticated } : {}),
  };
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return "<redacted>";
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const id = `${req.ip}:${req.path}`;
  if (!limiter.consume(id)) {
    log("AUTH", `rate limited: ${req.ip} on ${req.method} ${req.path}`);
    res.status(429).json({ error: "too_many_attempts" });
    return;
  }

  if (!authorizeSecret(authConfig, requestSecret(req))) {
    log("AUTH", `unauthorized: ${req.ip} on ${req.method} ${req.path}`);
    res.status(401).json({ error: "unauthorized" });
    return;
  }

  next();
}

function normalizeBeeFromPlanBody(b: unknown, runtime: PmRuntimeContext, idx: number): BeePersona {
  const o = b as Record<string, unknown>;
  const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : newBeeId();
  const ft = o.flowerType === "api" || o.flowerType === "browser" || o.flowerType === "code" ? o.flowerType : "browser";
  const scopedTaskId =
    typeof o.scopedTaskId === "string" && o.scopedTaskId.trim() ? o.scopedTaskId.trim() : undefined;
  const intentSignature =
    typeof o.intentSignature === "string" && o.intentSignature.trim() ? o.intentSignature.trim() : undefined;
  const parentBeeId =
    typeof o.parentBeeId === "string" && o.parentBeeId.trim() ? o.parentBeeId.trim() : undefined;
  const lineageKindRaw =
    typeof o.lineageKind === "string" && o.lineageKind.trim() ? o.lineageKind.trim() : undefined;
  const lineageKind =
    lineageKindRaw === "anchor" || lineageKindRaw === "worker" || lineageKindRaw === "child"
      ? lineageKindRaw
      : undefined;
  return {
    id,
    name: String(o.name ?? `Bee ${idx + 1}`),
    role: String(o.role ?? "worker"),
    systemPrompt: String(o.systemPrompt ?? ""),
    providerId: String(o.providerId ?? runtime.providerId),
    model: String(o.model ?? ""),
    flowerType: ft as FlowerType,
    ...(scopedTaskId ? { scopedTaskId } : {}),
    ...(intentSignature ? { intentSignature } : {}),
    ...(parentBeeId ? { parentBeeId } : {}),
    ...(lineageKind ? { lineageKind } : {}),
  };
}

/** Gateway is API-only; browsers opening :4321 see this instead of Express “Cannot GET /”. */
app.get("/", (_req, res) => {
  const webPort = process.env.BEEBRIDGE_WEB_PORT ?? "3000";
  res.type("html").send(`<!DOCTYPE html>
<html lang="ko"><head><meta charset="utf-8"/><title>Beebridge Gateway</title>
<style>body{font-family:system-ui,sans-serif;max-width:36rem;margin:2rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a}
code{background:#f4f4f5;padding:0.15rem 0.35rem;border-radius:4px}
a{color:#2563eb}</style></head><body>
<h1>Beebridge Gateway</h1>
<p>This address (<code>${PORT}</code>) is the <strong>API / WebSocket server</strong>. There is no web UI here.</p>
<p>Start the Next app and visit <a href="http://localhost:${webPort}">http://localhost:${webPort}</a> for the dashboard.</p>
<p>Health check: <a href="/health"><code>/health</code></a></p>
</body></html>`);
});

app.get("/health", (req, res) => {
  const supplied = requestSecret(req);
  res.json({
    status: "ok",
    reachable: true,
    ...authStatusForSecret(supplied),
  });
});

app.post("/api/intake", requireAuth, (req, res) => {
  const goal = String(req.body.goal ?? "");
  const answers = req.body.answers ?? {};
  const questions = buildIntakeQuestions(goal, answers);
  log("INTAKE", `goal="${goal}" → ${questions.length} questions`);
  res.json({ jobGoal: goal, managerQuestions: questions });
});

app.post("/api/plan", requireAuth, (req, res, next) => {
  try {
    const goal = String(req.body.goal ?? "");
    const beeCount = req.body.beeCount ? Number(req.body.beeCount) : undefined;
    const beeRoles = Array.isArray(req.body.beeRoles) ? req.body.beeRoles.map(String) : undefined;
    const beesRaw = Array.isArray(req.body.bees) ? (req.body.bees as unknown[]) : undefined;
    const targetDistrictId = req.body.districtId ? String(req.body.districtId) : undefined;

    const brief = {
      goal,
      deadline: req.body.deadline,
      priority: req.body.priority,
      constraints: req.body.constraints ?? [],
      beeCount,
      beeRoles,
    };

    const runtime = resolveRuntimeContext();
    const managerPlan = createCityPlanFromBrief(brief, runtime);

    // Must not assign bees: [] — that would clear the plan bees and the merge would keep only old latestTeamPlan bees.
    if (beesRaw !== undefined && beesRaw.length > 0) {
      managerPlan.bees = beesRaw.map((row, i) => normalizeBeeFromPlanBody(row, runtime, i));
      for (let i = 0; i < managerPlan.tasks.length && i < managerPlan.bees.length; i++) {
        const bee = managerPlan.bees[i];
        managerPlan.tasks[i].personaId = bee.id;
        managerPlan.tasks[i].bee = bee.id;
        managerPlan.tasks[i].flower = bee.flowerType === "code"
          ? `${bee.providerId ?? runtime.providerId}-code`
          : `${bee.providerId ?? runtime.providerId}-browser`;
      }
    } else if (beesRaw !== undefined && beesRaw.length === 0) {
      log("PLAN", "ignored empty bees[] in request — using planner-generated bees");
    }

    // If a target district is specified, reassign all tasks to that district
    if (targetDistrictId && allDistricts.has(targetDistrictId)) {
      const existingDistrict = allDistricts.get(targetDistrictId)!;
      managerPlan.districts = [existingDistrict];
      for (const task of managerPlan.tasks) {
        task.districtId = targetDistrictId;
        task.cityId = existingDistrict.cityId;
      }
    }

    const city = createHiveFromPlan(managerPlan);

    // Merge new districts into existing collection instead of replacing
    for (const district of city.districts) {
      allDistricts.set(district.id, district);
    }

    // Update latestTeamPlan with merged districts
    const mergedDistricts = [...allDistricts.values()];
    // Upsert bees by id: new plan must overwrite same bee id (otherwise a prior bee-1 systemPrompt
    // would stick forever when creating another plan with the same bee ids).
    const beeById = new Map((latestTeamPlan?.bees ?? []).map((b) => [b.id, b]));
    for (const bee of managerPlan.bees) {
      beeById.set(bee.id, bee);
    }
    const mergedBees = [...beeById.values()];
    latestTeamPlan = { id: city.id, goal, bees: mergedBees, districts: mergedDistricts, tasks: [...allTasks.values(), ...city.tasks] };

    // Finalize task ids before approvalGate.register: planner uses task-${bee.id} so duplicates
    // (same bee / merged plans) collide in pending Map; registering before id rotation also left stale keys.
    const idsAssignedInThisPlan = new Set<string>();
    for (const task of city.tasks) {
      while (allTasks.has(task.id) || idsAssignedInThisPlan.has(task.id) || approvalGate.isTracked(task.id)) {
        task.id = `task-${randomUUID().slice(0, 10)}`;
      }
      idsAssignedInThisPlan.add(task.id);
      allTasks.set(task.id, task);
      if (req.body.schedule) {
        const sched: TaskSchedule = {
          deadline: req.body.schedule.deadline ?? undefined,
          repeatType: req.body.schedule.repeatType ?? "once",
          intervalHours: req.body.schedule.intervalHours ?? undefined,
          dailyAtHour: req.body.schedule.dailyAtHour ?? undefined,
          dailyAtMinute: req.body.schedule.dailyAtMinute ?? undefined,
          cronExpression: req.body.schedule.cronExpression ?? undefined,
          maxRetries: req.body.schedule.maxRetries ?? 3,
          retryCount: 0,
          enabled: true,
        };
        taskSchedules.set(task.id, sched);
        task.schedule = sched;
        refreshScheduleNextRun(task.id, sched, Date.now());
      } else {
        const defaultSched: TaskSchedule = { repeatType: "once", maxRetries: 3, retryCount: 0, enabled: true };
        taskSchedules.set(task.id, defaultSched);
        task.schedule = defaultSched;
        refreshScheduleNextRun(task.id, defaultSched, Date.now());
      }
    }

    // One bee row per new task in this plan — scope to final task id so the same district can keep separate teams.
    if (latestTeamPlan) {
      for (let i = 0; i < city.tasks.length && i < managerPlan.bees.length; i++) {
        const task = city.tasks[i];
        const beeId = managerPlan.bees[i].id;
        const bi = latestTeamPlan.bees.findIndex((b) => b.id === beeId);
        if (bi >= 0) {
          latestTeamPlan.bees[bi] = { ...latestTeamPlan.bees[bi], scopedTaskId: task.id };
        }
      }
    }

    for (const task of city.tasks) {
      if (approvalGate.needsApproval(task)) {
        approvalGate.register(task);
      }
    }

    syncGraph();
    persistWorkspace();
    broadcastToWeb({ type: "districts.updated" });
    auditLog.record({
      type: "city.plan.created",
      payload: { goal, taskCount: city.tasks.length, districtCount: city.districts.length, beeCount: managerPlan.bees.length, provider: runtime.providerId, model: runtime.model },
    });
    log("PLAN", `goal="${goal}" → ${city.tasks.length} tasks, ${city.districts.length} districts, ${managerPlan.bees.length} bees (${runtime.providerId}/${runtime.model})`);
    log("PLAN", `pending approvals: ${approvalGate.listPending().length}`);

    const managerPlanCompat = { ...managerPlan, missions: managerPlan.districts, jobs: managerPlan.tasks };
    const hiveCompat = { ...city, missions: city.districts, jobs: city.tasks };
    res.json({ managerPlan: managerPlanCompat, hive: hiveCompat, city, runtime, pendingBeeApprovals: approvalGate.listPending() });
  } catch (err) {
    next(err instanceof Error ? err : new Error(String(err)));
  }
});

type RunQueueOptions = {
  /** audit payload `source` (default: approval-style queue). */
  auditSource?: "approval" | "bridge-pipeline" | "chat-setup_plan" | "scheduler";
  /** Persist one row to bridges/pipeline-runs.json after run. */
  savePipelineHistory?: { startDistrictId: string };
};

/** `queue.run` extras: upstream bridge context + {{bridgeOut:taskId}} resolved from same-run output and persisted job transcripts. */
function buildQueueExtrasForBridgeTask(task: BeeTask, completed: CompletedTaskInfo[]): QueueExtras {
  const d = String(task.districtId ?? "").trim() || UNASSIGNED_DISTRICT_ID;
  const outputByTaskId = buildOutputByTaskIdForBridgeOut(
    completed,
    task.title,
    task.description ?? "",
    (id) => jobStore.get(id),
  );

  const district = task.districtId ? allDistricts.get(task.districtId) : undefined;
  const skipAutoUpstream = district?.useUpstreamBridgeContext === false;
  const upstream = skipAutoUpstream
    ? new Set<string>()
    : upstreamDistrictsOneWay(d, districtBridges.values());

  const districtTitleFn = (id: string) => allDistricts.get(id)?.title ?? id;
  const ctx = buildBridgeContextForTask(
    task,
    UNASSIGNED_DISTRICT_ID,
    upstream,
    completed,
    districtTitleFn,
  );
  const resolvedTitle = applyBridgeOutPlaceholders(task.title, outputByTaskId);
  const resolvedDescription = applyBridgeOutPlaceholders(task.description ?? "", outputByTaskId);
  return {
    bridgeContext: ctx.trim() || undefined,
    resolvedTitle,
    resolvedDescription,
    bridgeOutMap: outputByTaskId.size > 0 ? outputByTaskId : undefined,
  };
}

function isCodeTaskLike(task: BeeTask): boolean {
  const persona = latestTeamPlan?.bees?.find((b) => b.id === task.personaId);
  return persona?.flowerType === "code" || (!persona && typeof task.flower === "string" && task.flower.endsWith("-code"));
}

function resolvePipelineProject(ordered: BeeTask[], startDistrictId?: string): ResolvedCodeProject | undefined {
  const codeTasks = ordered.filter(isCodeTaskLike);
  const firstCodeTask = codeTasks[0];
  if (!firstCodeTask) return undefined;
  const codeDistricts = codeTasks
    .map((task) => allDistricts.get(String(task.districtId ?? "").trim()))
    .filter((district): district is BeeDistrict => Boolean(district));
  const explicitProjectIds = new Set(codeDistricts.map((district) => district.codeProjectId).filter(Boolean));
  if (explicitProjectIds.size > 1) {
    return undefined;
  }
  if (explicitProjectIds.size === 1) {
    const projectId = [...explicitProjectIds][0];
    const district = codeDistricts.find((candidate) => candidate.codeProjectId === projectId);
    if (!district) return undefined;
    const resolved = projectManager.resolveProjectForDistrict(district);
    persistWorkspace();
    return resolved;
  }
  const preferredDistrictId =
    startDistrictId && allDistricts.has(startDistrictId)
      ? startDistrictId
      : String(firstCodeTask.districtId ?? "").trim();
  const district = preferredDistrictId ? allDistricts.get(preferredDistrictId) : undefined;
  if (!district) return undefined;
  const resolved = projectManager.resolveProjectForDistrict(district);
  persistWorkspace();
  return resolved;
}

let queueRunning = false;

function parseIsoMs(value?: string): number | undefined {
  if (!value || typeof value !== "string") return undefined;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : undefined;
}

function toIsoOrUndefined(ms?: number): string | undefined {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

function hashStable(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash;
}

function resolveStaggerWindowMs(taskId: string): number {
  const baseSec = Math.max(0, Math.floor(SCHEDULER_STAGGER_SEC));
  if (baseSec <= 0) return 0;
  const baseMs = baseSec * 1000;
  const priority = allTasks.get(taskId)?.priority ?? "medium";
  if (priority === "high") {
    return Math.max(5_000, Math.floor(baseMs * 0.35));
  }
  if (priority === "low") {
    return Math.max(5_000, Math.floor(baseMs * 1.5));
  }
  return baseMs;
}

function applyStaggerMs(taskId: string, baseMs: number): number {
  const windowMs = resolveStaggerWindowMs(taskId);
  if (windowMs <= 0) return baseMs;
  const offsetMs = hashStable(taskId) % windowMs;
  return baseMs + offsetMs;
}

function isScheduleConfigured(sched: TaskSchedule): boolean {
  if (!sched.enabled) return false;
  if (sched.repeatType === "once") {
    return parseIsoMs(sched.deadline ?? sched.nextRunAt) !== undefined;
  }
  if (sched.repeatType === "hourly") {
    return typeof sched.intervalHours === "number" && Number.isFinite(sched.intervalHours) && sched.intervalHours > 0;
  }
  if (sched.repeatType === "daily") {
    return (
      typeof sched.dailyAtHour === "number" &&
      Number.isFinite(sched.dailyAtHour) &&
      typeof sched.dailyAtMinute === "number" &&
      Number.isFinite(sched.dailyAtMinute)
    );
  }
  if (sched.repeatType === "custom") {
    return typeof sched.cronExpression === "string" && sched.cronExpression.trim().length > 0;
  }
  return false;
}

function matchesCronField(field: string, value: number, min: number, max: number): boolean {
  const trimmed = field.trim();
  if (!trimmed) return false;
  if (trimmed === "*") return true;

  const tokens = trimmed.split(",").map((t) => t.trim()).filter(Boolean);
  if (tokens.length === 0) return false;

  for (const token of tokens) {
    const [rangeRaw, stepRaw] = token.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isFinite(step) || step <= 0) continue;

    let rangeStart = min;
    let rangeEnd = max;
    const range = rangeRaw?.trim() ?? "*";

    if (range !== "*") {
      if (range.includes("-")) {
        const [startRaw, endRaw] = range.split("-");
        const start = Number(startRaw);
        const end = Number(endRaw);
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        rangeStart = clampInt(start, min, max);
        rangeEnd = clampInt(end, min, max);
      } else {
        const single = Number(range);
        if (!Number.isFinite(single)) continue;
        rangeStart = clampInt(single, min, max);
        rangeEnd = rangeStart;
      }
    }

    if (rangeStart > rangeEnd) continue;
    const normalizedValue = value === 0 && max === 7 ? 7 : value;
    for (let cur = rangeStart; cur <= rangeEnd; cur += step) {
      if (cur === value || cur === normalizedValue) {
        return true;
      }
    }
  }

  return false;
}

function cronMatches(expression: string, at: Date): boolean {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minExpr, hourExpr, dayExpr, monthExpr, weekExpr] = parts;
  const minute = at.getMinutes();
  const hour = at.getHours();
  const day = at.getDate();
  const month = at.getMonth() + 1;
  const weekday = at.getDay();

  if (!matchesCronField(minExpr, minute, 0, 59)) return false;
  if (!matchesCronField(hourExpr, hour, 0, 23)) return false;
  if (!matchesCronField(monthExpr, month, 1, 12)) return false;

  const dayWildcard = dayExpr.trim() === "*";
  const weekWildcard = weekExpr.trim() === "*";
  const dayMatch = matchesCronField(dayExpr, day, 1, 31);
  const weekMatch = matchesCronField(weekExpr, weekday, 0, 7);
  const dateMatch = !dayWildcard && !weekWildcard ? (dayMatch || weekMatch) : (dayMatch && weekMatch);

  return dateMatch;
}

function nextCronRunAtMs(expression: string, fromMs: number): number | undefined {
  const base = Math.floor(fromMs / 60_000) * 60_000;
  let cursor = base + 60_000;
  const maxChecks = 400 * 24 * 60;
  for (let i = 0; i < maxChecks; i += 1) {
    if (cronMatches(expression, new Date(cursor))) {
      return cursor;
    }
    cursor += 60_000;
  }
  return undefined;
}

function computeNextScheduleRunAtMs(sched: TaskSchedule, fromMs: number, afterRun: boolean): number | undefined {
  if (!sched.enabled) return undefined;

  if (sched.repeatType === "once") {
    if (afterRun) return undefined;
    return parseIsoMs(sched.deadline ?? sched.nextRunAt);
  }

  if (sched.repeatType === "hourly") {
    const interval = clampInt(Number(sched.intervalHours ?? 1), 1, 24 * 365);
    return fromMs + interval * 60 * 60_000;
  }

  if (sched.repeatType === "daily") {
    const hour = clampInt(Number(sched.dailyAtHour ?? 9), 0, 23);
    const minute = clampInt(Number(sched.dailyAtMinute ?? 0), 0, 59);
    const dt = new Date(fromMs);
    dt.setSeconds(0, 0);
    dt.setHours(hour, minute, 0, 0);
    if (dt.getTime() <= fromMs) dt.setDate(dt.getDate() + 1);
    return dt.getTime();
  }

  if (sched.repeatType === "custom") {
    if (!sched.cronExpression?.trim()) return undefined;
    return nextCronRunAtMs(sched.cronExpression, fromMs);
  }

  return undefined;
}

function computeNextScheduledAtWithPolicy(
  taskId: string,
  sched: TaskSchedule,
  fromMs: number,
  afterRun: boolean,
): number | undefined {
  const base = computeNextScheduleRunAtMs(sched, fromMs, afterRun);
  if (base === undefined) return undefined;
  if (sched.repeatType === "once") return base;
  return applyStaggerMs(taskId, base);
}

function refreshScheduleNextRun(taskId: string, sched: TaskSchedule, nowMs: number): boolean {
  let changed = false;
  if (!isScheduleConfigured(sched)) {
    if (sched.nextRunAt !== undefined) {
      sched.nextRunAt = undefined;
      changed = true;
    }
    const task = allTasks.get(taskId);
    if (task) task.schedule = sched;
    return changed;
  }

  if (sched.repeatType === "once" && parseIsoMs(sched.lastRunAt) !== undefined) {
    if (sched.enabled) {
      sched.enabled = false;
      changed = true;
    }
    if (sched.nextRunAt !== undefined) {
      sched.nextRunAt = undefined;
      changed = true;
    }
    const task = allTasks.get(taskId);
    if (task) task.schedule = sched;
    return changed;
  }

  const existingNext = parseIsoMs(sched.nextRunAt);
  if (existingNext !== undefined && existingNext < nowMs) {
    if (sched.repeatType === "once") {
      if (sched.enabled) {
        sched.enabled = false;
        changed = true;
      }
      if (sched.nextRunAt !== undefined) {
        sched.nextRunAt = undefined;
        changed = true;
      }
    } else {
      const computedFuture = computeNextScheduledAtWithPolicy(taskId, sched, nowMs, true);
      const futureIso = toIsoOrUndefined(computedFuture);
      if (sched.nextRunAt !== futureIso) {
        sched.nextRunAt = futureIso;
        changed = true;
      }
    }
  } else if (existingNext === undefined) {
    const computed = computeNextScheduledAtWithPolicy(taskId, sched, nowMs, false);
    const nextIso = toIsoOrUndefined(computed);
    if (sched.nextRunAt !== nextIso) {
      sched.nextRunAt = nextIso;
      changed = true;
    }
  }

  const task = allTasks.get(taskId);
  if (task) task.schedule = sched;
  return changed;
}

async function runInternalSchedulerTick(): Promise<void> {
  if (!INTERNAL_SCHEDULER_ENABLED || schedulerTickRunning) return;
  schedulerTickRunning = true;
  try {
    const nowMs = Date.now();
    let changed = false;
    const dueTasks: BeeTask[] = [];

    for (const [taskId, sched] of taskSchedules.entries()) {
      if (refreshScheduleNextRun(taskId, sched, nowMs)) {
        changed = true;
      }
      if (!isScheduleConfigured(sched)) continue;
      const nextMs = parseIsoMs(sched.nextRunAt);
      if (nextMs === undefined || nextMs > nowMs) continue;
      const task = allTasks.get(taskId);
      if (!task) continue;
      const conv = jobStore.get(taskId);
      if (conv?.status === "running") continue;
      dueTasks.push(task);
    }

    if (changed) persistWorkspace();
    if (dueTasks.length === 0) return;
    if (queueRunning) {
      log("SCHEDULE", `tick skipped: queue busy (${dueTasks.length} due task(s))`);
      return;
    }

    dueTasks.sort((a, b) => {
      const aMs = parseIsoMs(taskSchedules.get(a.id)?.nextRunAt) ?? 0;
      const bMs = parseIsoMs(taskSchedules.get(b.id)?.nextRunAt) ?? 0;
      return aMs - bMs;
    });

    log("SCHEDULE", `running ${dueTasks.length} due task(s)`);

    queueRunning = true;
    const noopRes = {
      statusCode: 200,
      status(this: { statusCode: number }, code: number) {
        this.statusCode = code;
        return this;
      },
      json(_body: unknown) {
        /* no HTTP response for scheduler run */
      },
    } as express.Response;

    try {
      await runApprovedJobsInner(noopRes, dueTasks, { auditSource: "scheduler" });
    } finally {
      queueRunning = false;
    }

    const finishedMs = Date.now();
    const finishedIso = new Date(finishedMs).toISOString();
    let postRunChanged = false;

    for (const task of dueTasks) {
      const sched = taskSchedules.get(task.id);
      if (!sched) continue;
      if (!isScheduleConfigured(sched)) continue;

      const conv = jobStore.get(task.id);
      const ok = conv?.status === "done";
      sched.lastRunAt = finishedIso;

      if (ok) {
        sched.retryCount = 0;
        const nextMs = computeNextScheduledAtWithPolicy(task.id, sched, finishedMs, true);
        const nextIso = toIsoOrUndefined(nextMs);
        if (sched.repeatType === "once") {
          sched.enabled = false;
          sched.nextRunAt = undefined;
        } else {
          sched.nextRunAt = nextIso;
        }
      } else {
        const maxRetries = Math.max(0, Math.floor(sched.maxRetries ?? 0));
        const attempt = Math.max(0, Math.floor(sched.retryCount ?? 0)) + 1;
        if (attempt <= maxRetries) {
          sched.retryCount = attempt;
          sched.nextRunAt = toIsoOrUndefined(finishedMs + Math.max(1_000, SCHEDULER_RETRY_DELAY_MS));
        } else {
          sched.retryCount = 0;
          if (sched.repeatType === "once") {
            sched.enabled = false;
            sched.nextRunAt = undefined;
          } else {
            const nextMs = computeNextScheduledAtWithPolicy(task.id, sched, finishedMs, true);
            sched.nextRunAt = toIsoOrUndefined(nextMs);
          }
        }
      }

      const mappedTask = allTasks.get(task.id);
      if (mappedTask) mappedTask.schedule = sched;
      postRunChanged = true;
    }

    if (postRunChanged) persistWorkspace();
  } catch (e) {
    log("SCHEDULE", `tick failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    schedulerTickRunning = false;
  }
}

function startInternalScheduler(): void {
  if (!INTERNAL_SCHEDULER_ENABLED) {
    log("SCHEDULE", "internal scheduler disabled via BEEBRIDGE_DISABLE_INTERNAL_SCHEDULER=1");
    return;
  }
  if (schedulerTimer) return;
  const pollMs = Math.max(1_000, Number.isFinite(SCHEDULER_POLL_MS) ? SCHEDULER_POLL_MS : 30_000);
  schedulerTimer = setInterval(() => {
    void runInternalSchedulerTick();
  }, pollMs);
  const staggerSec = Math.max(0, Number.isFinite(SCHEDULER_STAGGER_SEC) ? Math.floor(SCHEDULER_STAGGER_SEC) : 0);
  log("SCHEDULE", `internal scheduler started (poll=${pollMs}ms, stagger=${staggerSec}s)`);
  void runInternalSchedulerTick();
}

function stopInternalScheduler(): void {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}

/** Enqueue and run approved jobs (all / single / district·bee scope). Also handles bridge pipelines. */
async function runApprovedJobsAndRespond(
  res: express.Response,
  tasks: BeeTask[],
  opts?: RunQueueOptions,
): Promise<void> {
  if (queueRunning) {
    res.status(409).json({ error: "queue_already_running", message: "A queue run is already in progress. Please wait for it to finish." });
    return;
  }
  queueRunning = true;

  try {
    await runApprovedJobsInner(res, tasks, opts);
  } finally {
    queueRunning = false;
  }
}

async function runApprovedJobsInner(
  res: express.Response,
  tasks: BeeTask[],
  opts?: RunQueueOptions,
): Promise<void> {
  const runStartedAt = new Date().toISOString();

  if (tasks.length === 0) {
    const emptyMsg =
      opts?.auditSource === "bridge-pipeline"
        ? "No executable tasks in reachable districts (all tasks already completed)."
        : "No approved jobs to run.";
    res.json({ beeRuns: [], summary: emptyMsg, districtResults: [] });
    return;
  }

  const { ordered, usedBridgeOrder, warning: orderWarning } = orderTasksForBridgeRun(
    tasks,
    districtBridges.values(),
    bridgeGraphMeta.startDistrictId,
    UNASSIGNED_DISTRICT_ID,
  );
  if (orderWarning) log("QUEUE", orderWarning);
  if (usedBridgeOrder) {
    log("QUEUE", `bridge order: ${ordered.map((t) => t.districtId).join(" → ")}`);
  }
  const pipelineProject =
    opts?.auditSource === "bridge-pipeline" || opts?.savePipelineHistory
      ? resolvePipelineProject(ordered, opts?.savePipelineHistory?.startDistrictId ?? bridgeGraphMeta.startDistrictId ?? undefined)
      : undefined;

  const completed: CompletedTaskInfo[] = [];

  log("QUEUE", `executing ${ordered.length} job(s)...`);
  broadcastToWeb({
    type: "queue.run.start",
    total: ordered.length,
    startDistrictId: bridgeGraphMeta.startDistrictId,
  });
  const results = await queue.run(ordered, {
    beforeEach: (task) => {
      const d = String(task.districtId ?? "").trim() || UNASSIGNED_DISTRICT_ID;
      broadcastToWeb({
        type: "queue.task.running",
        districtId: d,
        taskId: task.id,
        taskTitle: task.title,
      });
    },
    getExtras: (task) => ({
      ...buildQueueExtrasForBridgeTask(task, completed),
      ...(pipelineProject && isCodeTaskLike(task)
        ? {
            resolvedProjectId: pipelineProject.id,
            resolvedProjectPath: pipelineProject.path,
            projectSource: pipelineProject.source,
          }
        : {}),
    }),
    afterEach: (task, r) => {
      completed.push({
        districtId: String(task.districtId ?? "").trim() || UNASSIGNED_DISTRICT_ID,
        taskId: r.taskId,
        title: task.title,
        output: r.output,
      });
    },
  });
  broadcastToWeb({ type: "queue.task.running", districtId: null, taskId: null, taskTitle: null });
  log("QUEUE", `done — ${results.length} results`);

  const districtResults = new Map<
    string,
    { districtId: string; districtTitle: string; tasks: { taskId: string; title: string; bee: string; status: string; output: string }[] }
  >();
  for (const r of results) {
    const task = allTasks.get(r.taskId);
    const districtId = task?.districtId ?? "unassigned";
    const district = allDistricts.get(districtId);
    if (!districtResults.has(districtId)) {
      districtResults.set(districtId, {
        districtId,
        districtTitle: district?.title ?? districtId,
        tasks: [],
      });
    }
    districtResults.get(districtId)!.tasks.push({
      taskId: r.taskId,
      title: task?.title ?? r.taskId,
      bee: task?.bee ?? "",
      status: r.status,
      output: r.output,
    });
  }

  const summaryLines: string[] = [];
  summaryLines.push(`=== Execution Report ===`);
  if (orderWarning) summaryLines.push(`Warning: ${orderWarning}`);
  summaryLines.push(`Total: ${results.length} tasks executed`);
  summaryLines.push(`Done: ${results.filter((r) => r.status === "done").length}, Failed: ${results.filter((r) => r.status === "failed").length}`);
  summaryLines.push("");

  for (const [, group] of districtResults) {
    const done = group.tasks.filter((t) => t.status === "done").length;
    summaryLines.push(`[${group.districtTitle}] ${done}/${group.tasks.length} completed`);
    for (const t of group.tasks) {
      const icon = t.status === "done" ? "✓" : "✗";
      summaryLines.push(`  ${icon} ${t.title} (${t.bee})`);
      if (t.output) summaryLines.push(`    → ${t.output.slice(0, 200)}`);
    }
    summaryLines.push("");
  }

  const summary = summaryLines.join("\n");
  const doneCount = results.filter((r) => r.status === "done").length;
  const failedCount = results.filter((r) => r.status === "failed").length;
  auditLog.record({
    type: "bee.queue.executed",
    payload: {
      count: ordered.length,
      doneCount,
      failedCount,
      taskIds: ordered.map((t) => t.id),
      source: opts?.auditSource ?? "approval",
    },
  });

  if (opts?.savePipelineHistory) {
    const rec: PipelineRunRecord = {
      id: `pipeline-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      startedAt: runStartedAt,
      finishedAt: new Date().toISOString(),
      startDistrictId: opts.savePipelineHistory.startDistrictId,
      ...(pipelineProject
        ? {
            resolvedProjectId: pipelineProject.id,
            resolvedProjectPath: pipelineProject.path,
            projectSource: pipelineProject.source,
          }
        : {}),
      orderedTaskIds: ordered.map((t) => t.id),
      summary,
      districtResults: [...districtResults.values()],
      status: failedCount > 0 ? "failed_partial" : "completed",
      doneCount,
      failedCount,
    };
    workspaceStore.appendPipelineRun(rec);
  }

  broadcastToWeb({
    type: "queue.complete",
    summary,
    districtResults: [...districtResults.values()],
    doneCount,
    failedCount,
  });

  res.json({ beeRuns: results, summary, districtResults: [...districtResults.values()] });
}

/** Chat `setup_plan`: run tasks that skip human approval without an HTTP client. */
function scheduleAutoRunFromChat(tasks: BeeTask[]): void {
  if (tasks.length === 0) return;
  setImmediate(() => {
    void (async () => {
      if (queueRunning) {
        log(
          "QUEUE",
          `auto-run from chat skipped (${tasks.length} task(s)): queue already running — approve/run manually when idle`,
        );
        return;
      }
      queueRunning = true;
      const noopRes = {
        statusCode: 200,
        status(this: { statusCode: number }, code: number) {
          this.statusCode = code;
          return this;
        },
        json(_body: unknown) {
          /* no HTTP response for background run */
        },
      } as express.Response;
      try {
        await runApprovedJobsInner(noopRes, tasks, { auditSource: "chat-setup_plan" });
      } catch (e) {
        log("QUEUE", `auto-run from chat failed: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        queueRunning = false;
      }
    })();
  });
}

/** Run a single approved job (not the full queue). */
app.post("/api/queue/run/:taskId", requireAuth, asyncHandler(async (req, res) => {
  const taskId = req.params.taskId;
  const task = approvalGate.listApproved().find((t) => t.id === taskId);
  if (!task) {
    res.status(404).json({ error: "task_not_in_approved_queue" });
    return;
  }
  await runApprovedJobsAndRespond(res, [task]);
}));

/** Run only jobs matching a specific district or bee from the approved queue. */
app.post("/api/queue/run-scope", requireAuth, asyncHandler(async (req, res) => {
  const scope = String(req.body.scope ?? "");
  const id = String(req.body.id ?? "").trim();
  if (!id || (scope !== "bee" && scope !== "district")) {
    res.status(400).json({ error: "scope must be 'bee' or 'district', id is required" });
    return;
  }

  const approvedList = approvalGate.listApproved();
  let toRun: typeof approvedList;
  if (scope === "district") {
    if (id === "__unassigned__") {
      toRun = approvedList.filter((t) => !String(t.districtId ?? "").trim());
    } else {
      toRun = approvedList.filter((t) => t.districtId === id);
    }
  } else if (id === "__unknown__") {
    toRun = approvedList.filter((t) => !String(t.personaId ?? "").trim() && !String(t.bee ?? "").trim());
  } else {
    toRun = approvedList.filter((t) => t.bee === id || (t.personaId !== undefined && t.personaId === id));
  }

  await runApprovedJobsAndRespond(res, toRun);
}));

/** Run all approved jobs at once (default behavior). */
app.post("/api/queue/run", requireAuth, asyncHandler(async (_req, res) => {
  await runApprovedJobsAndRespond(res, approvalGate.listApproved());
}));

app.get("/api/approvals", requireAuth, (_req, res) => {
  res.json({ pendingBeeApprovals: approvalGate.listPending(), approvedBeeJobs: approvalGate.listApproved() });
});

/** Approve all pending jobs for one district or one bee (personaId or bee field). */
app.post("/api/approvals/bulk", requireAuth, (req, res) => {
  const scope = String(req.body.scope ?? "");
  const id = String(req.body.id ?? "").trim();
  if (!id || (scope !== "bee" && scope !== "district")) {
    res.status(400).json({ error: "scope must be 'bee' or 'district', id is required" });
    return;
  }

  const pending = approvalGate.listPending();
  let toApprove: typeof pending;
  if (scope === "district") {
    if (id === "__unassigned__") {
      toApprove = pending.filter((t) => !String(t.districtId ?? "").trim());
    } else {
      toApprove = pending.filter((t) => t.districtId === id);
    }
  } else if (id === "__unknown__") {
    toApprove = pending.filter((t) => !String(t.personaId ?? "").trim() && !String(t.bee ?? "").trim());
  } else {
    toApprove = pending.filter((t) => t.bee === id || (t.personaId !== undefined && t.personaId === id));
  }

  const approved: BeeTask[] = [];
  for (const t of toApprove) {
    const a = approvalGate.approve(t.id);
    if (a) {
      approved.push(a);
      auditLog.record({
        type: "bee.job.approved",
        payload: { jobId: t.id, bulkScope: scope, bulkId: id },
      });
    }
  }
  log("APPROVE", `bulk ${scope}=${id} → ${approved.length} job(s)`);
  res.json({ approvedBeeJobs: approved, count: approved.length });
});

/** Approved → pending (restart: must be re-approved before running). */
function postBulkApprovalRestartToPending(req: express.Request, res: express.Response): void {
  const scope = String(req.body.scope ?? "");
  const id = String(req.body.id ?? "").trim();
  if (!id || (scope !== "bee" && scope !== "district")) {
    res.status(400).json({ error: "scope must be 'bee' or 'district', id is required" });
    return;
  }

  const approvedList = approvalGate.listApproved();
  let toRevoke: typeof approvedList;
  if (scope === "district") {
    if (id === "__unassigned__") {
      toRevoke = approvedList.filter((t) => !String(t.districtId ?? "").trim());
    } else {
      toRevoke = approvedList.filter((t) => t.districtId === id);
    }
  } else if (id === "__unknown__") {
    toRevoke = approvedList.filter((t) => !String(t.personaId ?? "").trim() && !String(t.bee ?? "").trim());
  } else {
    toRevoke = approvedList.filter((t) => t.bee === id || (t.personaId !== undefined && t.personaId === id));
  }

  const revoked: BeeTask[] = [];
  for (const t of toRevoke) {
    const u = approvalGate.unapprove(t.id);
    if (u) {
      revoked.push(u);
      auditLog.record({
        type: "bee.job.restart_pending",
        payload: { jobId: t.id, bulkScope: scope, bulkId: id },
      });
    }
  }
  log("APPROVE", `bulk restart→pending ${scope}=${id} → ${revoked.length} job(s)`);
  res.json({ pendingBeeJobs: revoked, count: revoked.length });
}

/** @deprecated use /bulk-restart */
app.post("/api/approvals/bulk-revoke", requireAuth, postBulkApprovalRestartToPending);
app.post("/api/approvals/bulk-restart", requireAuth, postBulkApprovalRestartToPending);

function postApprovalRestartToPending(req: express.Request, res: express.Response): void {
  const taskId = req.params.taskId;
  const task = approvalGate.unapprove(taskId);
  if (!task) {
    res.status(404).json({ error: "job_not_in_approved_queue" });
    return;
  }
  auditLog.record({ type: "bee.job.restart_pending", payload: { jobId: taskId } });
  log("APPROVE", `job "${taskId}" restart → pending`);
  res.json({ pendingBeeJob: task });
}

/** @deprecated use /restart */
app.post("/api/approvals/:taskId/revoke", requireAuth, postApprovalRestartToPending);
app.post("/api/approvals/:taskId/restart", requireAuth, postApprovalRestartToPending);

app.post("/api/approvals/:taskId/approve", requireAuth, (req, res) => {
  const taskId = req.params.taskId;
  const approved = approvalGate.approve(taskId);
  if (!approved) {
    res.status(404).json({ error: "job_not_found" });
    return;
  }
  auditLog.record({ type: "bee.job.approved", payload: { jobId: taskId } });
  log("APPROVE", `job "${taskId}" approved`);
  res.json({ approvedBeeJob: approved });
});

app.get("/api/audit", requireAuth, (req, res) => {
  const events = auditLog.list();
  const raw = req.query.limit;
  let limit = 0;
  if (raw !== undefined) {
    const n = Number(Array.isArray(raw) ? raw[0] : raw);
    if (Number.isFinite(n) && n > 0) limit = Math.min(Math.floor(n), 10000);
  }
  /** auditLog.list() is newest-first; keep the most recent `limit` entries. */
  const slice = limit > 0 ? events.slice(0, limit) : events;
  log("AUDIT", `returning ${slice.length} events${limit ? ` (limit ${limit})` : ""}`);
  res.json({ hiveEvents: slice });
});

app.get("/api/flowers", requireAuth, (_req, res) => {
  const settings = pmSettings.get();
  const policy = settings.modelPolicy;
  const mappedBee = settings.beePolicy.providerToBee[policy.defaultProviderId] ?? "worker-bee-default";
  res.json({
    flowers: [
      {
        id: `${policy.defaultProviderId}-web`,
        providerId: policy.defaultProviderId,
        model: policy.defaultModel,
        type: "web",
        connected: true,
        bee: mappedBee,
      },
      { id: "manager-console", type: "system", connected: true, bee: "manager-bee" },
    ],
  });
});

app.get("/api/settings/providers", requireAuth, (_req, res) => {
  log("SETTINGS", `providers list → ${pmSettings.getCatalog().length} providers`);
  res.json({ providers: pmSettings.getCatalog() });
});

app.get("/api/settings/pm", requireAuth, (_req, res) => {
  const policy = pmSettings.getModelPolicy();
  log("SETTINGS", `PM config → provider=${policy.defaultProviderId} model=${policy.defaultModel}, ${pmSettings.listProfiles().length} auth profiles`);
  res.json({
    providers: pmSettings.getCatalog(),
    modelPolicy: policy,
    authProfiles: pmSettings.listProfiles(),
    activeProfile: pmSettings.getActiveProfile()?.id ?? null,
    beePolicy: pmSettings.get().beePolicy,
    sandbox: pmSettings.getSandboxSettings(),
  });
});

app.post("/api/settings/auth/device/start", requireAuth, asyncHandler(async (req, res) => {
  const providerId = String(req.body.providerId ?? "");
  const label = req.body.label ? String(req.body.label) : undefined;
  const provider = pmSettings.getCatalog().find((item) => item.id === providerId);
  if (!provider) {
    res.status(404).json({ error: "provider_not_found" });
    return;
  }
  if (!provider.authModes.includes("oauth")) {
    res.status(400).json({ error: "oauth_not_supported_for_provider" });
    return;
  }

  if (providerId === "openai") {
    const sessionId = randomUUID();
    const expiresIn = 15 * 60;
    const { verifier, challenge } = generatePkce();
    const state = generateOauthState();
    const authUrl = buildCodexAuthorizeUrl({ codeChallenge: challenge, state });

    oauthDeviceSessions.set(sessionId, {
      providerId,
      userCode: "REDIRECT",
      label,
      expiresAt: Date.now() + expiresIn * 1000,
      codexVerifier: verifier,
      codexState: state,
    });

    auditLog.record({
      type: "pm.auth.device.start",
      payload: { providerId, sessionId, verificationUri: authUrl },
    });
    log("AUTH", `OpenAI Codex OAuth started (manual redirect): sessionId=${sessionId}`);
    res.status(201).json({
      sessionId,
      providerId,
      verificationUri: authUrl,
      userCode: "REDIRECT",
      expiresIn,
      autoPolling: false,
    });
    return;
  }

  if (providerId === "github-copilot") {
    const clientId =
      process.env.GITHUB_CLIENT_ID ??
      process.env.BEEBRIDGE_GITHUB_CLIENT_ID ??
      process.env.AIBRIDGE_GITHUB_CLIENT_ID ??
      GITHUB_COPILOT_CLIENT_ID_DEFAULT;

    try {
      const form = new URLSearchParams({
        client_id: clientId,
        scope: "read:user",
      });

      let ghData: {
        device_code: string;
        user_code: string;
        verification_uri: string;
        expires_in: number;
        interval: number;
      };
      try {
        const ghRes = await fetch("https://github.com/login/device/code", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        });
        if (!ghRes.ok) {
          const errBody = await ghRes.text();
          log("AUTH", `GitHub device/code failed: ${ghRes.status} ${errBody}`);
          res.status(502).json({ error: "github_device_flow_failed", message: `GitHub API error (${ghRes.status})` });
          return;
        }
        ghData = (await ghRes.json()) as typeof ghData;
      } catch (fetchErr) {
        log("AUTH", `GitHub device/code fetch failed (${fetchErr}), retrying`);
        ghData = (await postFormJson("https://github.com/login/device/code", form)) as typeof ghData;
      }

      const sessionId = randomUUID();
      oauthDeviceSessions.set(sessionId, {
        providerId,
        userCode: ghData.user_code,
        deviceCode: ghData.device_code,
        clientId,
        pollInterval: ghData.interval ?? 5,
        label,
        expiresAt: Date.now() + ghData.expires_in * 1000,
      });

      auditLog.record({
        type: "pm.auth.device.start",
        payload: { providerId, sessionId, verificationUri: ghData.verification_uri },
      });
      log("AUTH", `GitHub device flow started: code=${ghData.user_code} uri=${ghData.verification_uri}`);
      res.status(201).json({
        sessionId,
        providerId,
        verificationUri: ghData.verification_uri,
        userCode: ghData.user_code,
        expiresIn: ghData.expires_in,
        autoPolling: true,
      });
    } catch (err) {
      log("AUTH", `GitHub device flow error: ${err}`);
      res.status(502).json({ error: "github_device_flow_failed", message: "Could not reach GitHub API." });
    }
    return;
  }

  const sessionId = randomUUID();
  const userCode = randomUserCode();
  const expiresIn = 15 * 60;
  oauthDeviceSessions.set(sessionId, {
    providerId,
    userCode,
    label,
    expiresAt: Date.now() + expiresIn * 1000,
  });

  const verificationUri = deviceVerificationUri(providerId);
  auditLog.record({
    type: "pm.auth.device.start",
    payload: { providerId, sessionId, verificationUri },
  });
  log("AUTH", `device flow started: provider=${providerId} code=${userCode} uri=${verificationUri}`);
  res.status(201).json({
    sessionId,
    providerId,
    verificationUri,
    userCode,
    expiresIn,
    autoPolling: false,
  });
}));

app.post("/api/settings/auth/device/complete", requireAuth, asyncHandler(async (req, res) => {
  const sessionId = String(req.body.sessionId ?? "");
  const authCode = String(req.body.authCode ?? "");
  const oauthToken = String(req.body.oauthToken ?? "");
  const session = oauthDeviceSessions.get(sessionId);
  if (!session) {
    res.status(404).json({ error: "device_session_not_found" });
    return;
  }
  if (Date.now() > session.expiresAt) {
    oauthDeviceSessions.delete(sessionId);
    res.status(410).json({ error: "device_session_expired" });
    return;
  }

  if (session.codexVerifier && session.codexState) {
    const redirectUrl = String(req.body.redirectUrl ?? req.body.authCode ?? "").trim();
    if (!redirectUrl) {
      res.status(400).json({
        error: "missing_redirect_url",
        message: "Please paste the redirect URL from after login.",
      });
      return;
    }

    let code: string;
    try {
      const u = new URL(redirectUrl);
      const urlState = u.searchParams.get("state");
      if (urlState && urlState !== session.codexState) {
        oauthDeviceSessions.delete(sessionId);
        res.status(400).json({ error: "state_mismatch", message: "OAuth state does not match. Please try again." });
        return;
      }
      const urlError = u.searchParams.get("error");
      if (urlError) {
        const desc = u.searchParams.get("error_description") || urlError;
        oauthDeviceSessions.delete(sessionId);
        res.status(400).json({ error: "oauth_error", message: desc });
        return;
      }
      const c = u.searchParams.get("code");
      if (!c) {
        res.status(400).json({
          error: "no_code_in_url",
          message: "Could not find the code parameter in the URL. Please paste the full redirect URL.",
        });
        return;
      }
      code = c;
    } catch {
      res.status(400).json({
        error: "invalid_url",
        message: "Invalid URL format. Please copy the full URL from your browser's address bar.",
      });
      return;
    }

    try {
      const tokens = await exchangeCodexAuthorizationCode(code, session.codexVerifier);
      const secret = serializeCodexBundle(tokens);
      const profile = pmSettings.addProfile({
        providerId: session.providerId,
        mode: "oauth",
        secret,
        label: session.label,
      });
      oauthDeviceSessions.delete(sessionId);
      auditLog.record({
        type: "pm.auth.device.complete",
        payload: { providerId: session.providerId, profileId: profile.id },
      });
      log("AUTH", `OpenAI Codex OAuth complete: profileId=${profile.id}`);
      res.status(201).json({ profile });
    } catch (err) {
      oauthDeviceSessions.delete(sessionId);
      log("AUTH", `OpenAI Codex token exchange error: ${err}`);
      res.status(502).json({
        error: "codex_token_exchange_failed",
        message: err instanceof Error ? err.message : "Token exchange failed. Please try again.",
      });
    }
    return;
  }

  if (session.deviceCode && session.clientId) {
    try {
      const form = new URLSearchParams({
        client_id: session.clientId,
        device_code: session.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });

      let tokenData: {
        access_token?: string;
        token_type?: string;
        scope?: string;
        error?: string;
        error_description?: string;
      };
      try {
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: form,
        });
        tokenData = (await tokenRes.json()) as typeof tokenData;
      } catch (fetchErr) {
        log("AUTH", `GitHub token exchange fetch failed (${fetchErr}), retrying`);
        tokenData = (await postFormJson("https://github.com/login/oauth/access_token", form)) as typeof tokenData;
      }

      if (tokenData.error === "authorization_pending") {
        res.status(202).json({ status: "pending", message: "Waiting for authorization on GitHub..." });
        return;
      }
      if (tokenData.error === "slow_down") {
        res.status(202).json({ status: "pending", message: "Polling too fast, slowing down..." });
        return;
      }
      if (tokenData.error) {
        oauthDeviceSessions.delete(sessionId);
        res.status(400).json({ error: tokenData.error, message: tokenData.error_description });
        return;
      }
      if (!tokenData.access_token) {
        res.status(502).json({ error: "no_access_token", message: "GitHub did not return an access token." });
        return;
      }

      const profile = pmSettings.addProfile({
        providerId: session.providerId,
        mode: "oauth",
        secret: tokenData.access_token,
        label: session.label,
      });
      oauthDeviceSessions.delete(sessionId);
      auditLog.record({
        type: "pm.auth.device.complete",
        payload: { providerId: session.providerId, profileId: profile.id },
      });
      log("AUTH", `GitHub device flow complete: profileId=${profile.id}`);
      res.status(201).json({ profile });
    } catch (err) {
      log("AUTH", `GitHub token exchange error: ${err}`);
      res.status(502).json({ error: "github_token_exchange_failed", message: "Could not reach GitHub API." });
    }
    return;
  }

  const secret = oauthToken || authCode;
  if (!secret.trim()) {
    res.status(400).json({ error: "missing_oauth_token_or_code" });
    return;
  }

  const profile = pmSettings.addProfile({
    providerId: session.providerId,
    mode: "oauth",
    secret,
    label: session.label,
  });
  oauthDeviceSessions.delete(sessionId);
  auditLog.record({
    type: "pm.auth.device.complete",
    payload: { providerId: session.providerId, profileId: profile.id },
  });
  log("AUTH", `device flow complete: provider=${session.providerId} profileId=${profile.id}`);
  res.status(201).json({ profile });
}));

app.post("/api/settings/auth/profiles", requireAuth, (req, res) => {
  const providerId = String(req.body.providerId ?? "");
  const mode = String(req.body.mode ?? "");
  const secret = String(req.body.secret ?? "");
  const label = req.body.label ? String(req.body.label) : undefined;

  if (!providerId || (mode !== "api_key" && mode !== "oauth") || !secret) {
    res.status(400).json({ error: "invalid_profile_payload" });
    return;
  }

  const provider = pmSettings.getCatalog().find((item) => item.id === providerId);
  if (!provider) {
    res.status(404).json({ error: "provider_not_found" });
    return;
  }
  if (!provider.authModes.includes(mode)) {
    res.status(400).json({ error: "unsupported_auth_mode_for_provider" });
    return;
  }

  const created = pmSettings.addProfile({ providerId, mode, secret, label });
  auditLog.record({ type: "pm.auth.profile.created", payload: { profileId: created.id, providerId, mode } });
  log("AUTH", `profile created: provider=${providerId} mode=${mode} id=${created.id}`);
  res.status(201).json({ profile: created });
});

app.patch("/api/settings/auth/profiles/:profileId/activate", requireAuth, (req, res) => {
  const profileId = req.params.profileId;
  const activated = pmSettings.activateProfile(profileId);
  if (!activated) {
    res.status(404).json({ error: "profile_not_found" });
    return;
  }
  auditLog.record({ type: "pm.auth.profile.activated", payload: { profileId } });
  log("AUTH", `profile activated: id=${profileId}`);
  res.json({ profile: activated });
});

app.delete("/api/settings/auth/profiles/:profileId", requireAuth, (req, res) => {
  const profileId = req.params.profileId;
  const removed = pmSettings.removeProfile(profileId);
  if (!removed) {
    res.status(404).json({ error: "profile_not_found" });
    return;
  }
  auditLog.record({ type: "pm.auth.profile.removed", payload: { profileId } });
  log("AUTH", `profile removed: id=${profileId}`);
  res.status(204).send();
});

app.delete("/api/settings/auth/profiles", requireAuth, (_req, res) => {
  const removedCount = pmSettings.clearProfiles();
  oauthDeviceSessions.clear();
  auditLog.record({ type: "pm.auth.profiles.reset", payload: { removedCount } });
  log("AUTH", `all profiles reset: removed=${removedCount}`);
  res.json({ removedCount });
});

app.put("/api/settings/model-policy", requireAuth, (req, res) => {
  const defaultProviderId = req.body.defaultProviderId ? String(req.body.defaultProviderId) : undefined;
  const defaultModel = req.body.defaultModel ? String(req.body.defaultModel) : undefined;
  const fallbackModel = req.body.fallbackModel ? String(req.body.fallbackModel) : undefined;
  const allowedModels = Array.isArray(req.body.allowedModels)
    ? req.body.allowedModels.map((item: unknown) => String(item))
    : undefined;

  const providerId = defaultProviderId ?? pmSettings.getModelPolicy().defaultProviderId;
  const provider = pmSettings.getCatalog().find((item) => item.id === providerId);
  if (!provider) {
    res.status(404).json({ error: "provider_not_found" });
    return;
  }

  if (defaultModel && !provider.models.includes(defaultModel)) {
    res.status(400).json({ error: "model_not_supported_by_provider" });
    return;
  }

  const updated = pmSettings.setModelPolicy({
    defaultProviderId,
    defaultModel,
    fallbackModel,
    allowedModels,
  });

  auditLog.record({
    type: "pm.model.policy.updated",
    payload: {
      providerId: updated.defaultProviderId,
      model: updated.defaultModel,
      allowCount: updated.allowedModels.length,
    },
  });
  log("MODEL", `policy updated: provider=${updated.defaultProviderId} model=${updated.defaultModel} allowed=${updated.allowedModels.length}`);
  res.json({ modelPolicy: updated });
});

app.put("/api/settings/sandbox", requireAuth, (req, res) => {
  const mode = String(req.body?.mode ?? "").trim().toLowerCase();
  if (mode !== "off" && mode !== "docker") {
    res.status(400).json({ error: "mode must be off or docker" });
    return;
  }
  const sandbox = pmSettings.setSandboxMode(mode);
  auditLog.record({
    type: "pm.sandbox.mode.updated",
    payload: { mode: sandbox.mode },
  });
  log("SANDBOX", `mode updated: ${sandbox.mode}`);
  res.json({ sandbox });
});

app.get("/api/sandbox/containers", requireAuth, (_req, res) => {
  try {
    res.json({ containers: listSandboxContainers() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

app.post("/api/sandbox/remove", requireAuth, (req, res) => {
  const target = String(req.body?.target ?? "").trim();
  if (!target) {
    res.status(400).json({ error: "target is required" });
    return;
  }
  const result = removeSandboxContainer(target);
  res.status(result.removed ? 200 : 404).json(result);
});

app.post("/api/sandbox/kill", requireAuth, (req, res) => {
  const sessionId = String(req.body?.sessionId ?? "").trim();
  if (!sessionId) {
    res.status(400).json({ error: "sessionId is required" });
    return;
  }
  const result = killSandboxSession(sessionId);
  res.status(result.killed ? 200 : 404).json(result);
});

app.post("/api/sandbox/cleanup", requireAuth, (req, res) => {
  const includeProject = req.body?.includeProject === true;
  try {
    const result = cleanupSandboxContainers({ includeProject });
    res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: message });
  }
});

type FailureKind =
  | "auth"
  | "flower_offline"
  | "cdp_unavailable"
  | "timeout"
  | "model_error"
  | "tool_error"
  | "unknown";

function classifyFailureText(text: string): FailureKind {
  const s = text.toLowerCase();
  if (/unauthorized|401|403|auth|token|credential|api key/.test(s)) return "auth";
  if (/flower.*(offline|not connected)|no connected flower|websocket.*reject/.test(s)) return "flower_offline";
  if (/cdp relay|debugger|devtools|chrome relay|not attached/.test(s)) return "cdp_unavailable";
  if (/timeout|timed out|abort/.test(s)) return "timeout";
  if (/model|llm|openai|anthropic|gemini|provider/.test(s)) return "model_error";
  if (/tool|command|selector|click|fill|navigate|snapshot/.test(s)) return "tool_error";
  return "unknown";
}

function classifyJobFailure(taskId: string): { kind: FailureKind; message: string } {
  const conv = jobStore.get(taskId);
  const message = conv?.entries.slice().reverse().find((e) => e.action === "error")?.content ?? "";
  return { kind: classifyFailureText(message), message };
}

async function rerunTaskAndRespond(
  res: express.Response,
  task: BeeTask,
  mode: "retry" | "resume",
  sched?: TaskSchedule,
): Promise<void> {
  const taskId = task.id;
  log(mode === "retry" ? "RETRY" : "RESUME", `${mode === "retry" ? "restarting" : "resuming"} task ${taskId}`);
  auditLog.record({
    type: mode === "retry" ? "bee.task.retried" : "bee.task.resumed",
    payload: { taskId, retryCount: sched?.retryCount ?? 0, reset: mode === "retry" },
  });

  broadcastToWeb({ type: "queue.run.start", total: 1, startDistrictId: bridgeGraphMeta.startDistrictId });
  const completedRetry: CompletedTaskInfo[] = [];
  const result = await queue.run([task], {
    beforeEach: (t) => {
      const d = String(t.districtId ?? "").trim() || UNASSIGNED_DISTRICT_ID;
      broadcastToWeb({
        type: "queue.task.running",
        districtId: d,
        taskId: t.id,
        taskTitle: t.title,
      });
    },
    getExtras: (t) => buildQueueExtrasForBridgeTask(t, completedRetry),
    afterEach: (t, r) => {
      completedRetry.push({
        districtId: String(t.districtId ?? "").trim() || UNASSIGNED_DISTRICT_ID,
        taskId: r.taskId,
        title: t.title,
        output: r.output,
      });
    },
  });
  broadcastToWeb({ type: "queue.task.running", districtId: null, taskId: null, taskTitle: null });
  res.json({
    [mode === "retry" ? "retried" : "resumed"]: true,
    taskId,
    retryCount: sched?.retryCount ?? 0,
    result,
    reset: mode === "retry",
  });
}

// ─── Retry failed task ───
app.post("/api/jobs/:jobId/retry", requireAuth, asyncHandler(async (req, res) => {
  const taskId = req.params.jobId;
  const conv = jobStore.get(taskId);
  if (!conv || conv.status !== "failed") {
    res.status(400).json({ error: conv ? "task_not_failed" : "task_not_found", failure: classifyJobFailure(taskId) });
    return;
  }

  const task = allTasks.get(taskId);
  if (!task) {
    res.status(404).json({ error: "task_data_not_found" });
    return;
  }

  const sched = taskSchedules.get(taskId);
  if (sched) {
    // Manual restart means "start over": clear accumulated failure/retry count.
    sched.retryCount = 0;
    sched.lastRunAt = new Date().toISOString();
  }

  jobStore.reset(taskId);
  await rerunTaskAndRespond(res, task, "retry", sched);
}));

app.post("/api/jobs/:jobId/resume", requireAuth, asyncHandler(async (req, res) => {
  const taskId = req.params.jobId;
  const conv = jobStore.get(taskId);
  if (!conv || conv.status !== "failed") {
    res.status(conv ? 409 : 404).json({ error: conv ? "task_not_failed" : "task_not_found", failure: classifyJobFailure(taskId) });
    return;
  }

  const task = allTasks.get(taskId);
  if (!task) {
    res.status(404).json({ error: "task_data_not_found", failure: classifyJobFailure(taskId) });
    return;
  }

  const sched = taskSchedules.get(taskId);
  if (sched) {
    sched.lastRunAt = new Date().toISOString();
  }
  await rerunTaskAndRespond(res, task, "resume", sched);
}));

// ─── Task update ───
app.put("/api/jobs/:jobId", requireAuth, (req, res) => {
  const taskId = req.params.jobId;
  const task = allTasks.get(taskId);
  if (!task) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }

  if (req.body.title !== undefined) task.title = String(req.body.title);
  if (req.body.description !== undefined) task.description = String(req.body.description);
  if (req.body.bee !== undefined) task.bee = String(req.body.bee);
  if (req.body.flower !== undefined) task.flower = String(req.body.flower);
  if (req.body.priority !== undefined) task.priority = req.body.priority;
  if (req.body.requiresApproval !== undefined) task.requiresApproval = Boolean(req.body.requiresApproval);
  if (req.body.personaId !== undefined) {
    const v = req.body.personaId;
    task.personaId = v ? String(v) : undefined;
  }
  if (req.body.dependsOn !== undefined) {
    task.dependsOn = Array.isArray(req.body.dependsOn)
      ? req.body.dependsOn.map(String).filter((id: string) => id && allTasks.has(id))
      : undefined;
  }

  if (latestTeamPlan) {
    const planTask = latestTeamPlan.tasks.find((t) => t.id === taskId);
    if (planTask) {
      if (req.body.title !== undefined) planTask.title = task.title;
      if (req.body.description !== undefined) planTask.description = task.description;
      if (req.body.bee !== undefined) planTask.bee = task.bee;
      if (req.body.flower !== undefined) planTask.flower = task.flower;
      if (req.body.priority !== undefined) planTask.priority = task.priority;
      if (req.body.personaId !== undefined) planTask.personaId = task.personaId;
    }
  }

  persistWorkspace();
  log("TASK", `updated task ${taskId}: title="${task.title}" bee=${task.bee} priority=${task.priority}`);
  auditLog.record({ type: "bee.task.updated", payload: { taskId, title: task.title, bee: task.bee, priority: task.priority } });
  res.json({ task });
});

/** Remove a task from memory stores (no persist). Used by single-task delete and district cascade. */
function purgeTaskById(taskId: string): void {
  allTasks.delete(taskId);
  taskSchedules.delete(taskId);
  approvalGate.forget(taskId);
  jobStore.purgeTaskConversations(taskId);
  graphStore.removeNode(taskId);
  if (latestTeamPlan) {
    latestTeamPlan.tasks = latestTeamPlan.tasks.filter((t) => t.id !== taskId);
  }
}

/**
 * Drop tasks whose districtId points at a district that no longer exists (disk drift, old bugs, or partial deletes).
 * Without this, the UI shows them under "Unassigned" while job count stays > 0.
 */
function reconcileOrphanTasks(): number {
  const toRemove: string[] = [];
  for (const t of allTasks.values()) {
    const did = t.districtId?.trim();
    if (!did) continue;
    if (did === UNASSIGNED_DISTRICT_ID) continue;
    if (!allDistricts.has(did)) toRemove.push(t.id);
  }
  for (const id of toRemove) {
    purgeTaskById(id);
    auditLog.record({
      type: "bee.task.deleted",
      payload: { taskId: id, reason: "orphan_district" },
    });
  }
  return toRemove.length;
}

function deleteJobById(taskId: string): { ok: true } | { error: string; status: number } {
  const inAllTasks = allTasks.has(taskId);
  const inPending = approvalGate.listPending().some((t) => t.id === taskId);
  const inApproved = approvalGate.listApproved().some((t) => t.id === taskId);
  const inTeamPlan = latestTeamPlan?.tasks.some((t) => t.id === taskId) ?? false;
  const exists = inAllTasks || approvalGate.isTracked(taskId) || inTeamPlan;

  logTaskDelete("deleteJobById:start", {
    taskId,
    inAllTasks,
    inPending,
    inApproved,
    isTracked: approvalGate.isTracked(taskId),
    inTeamPlan,
    exists,
    allTasksSize: allTasks.size,
  });

  // Idempotent: double-click / race / already removed → 200 so the UI does not show a red error.
  if (!exists) {
    logTaskDelete("deleteJobById:idempotent (already gone)", { taskId });
    return { ok: true };
  }
  purgeTaskById(taskId);
  persistWorkspace();
  broadcastToWeb({ type: "districts.updated" });
  auditLog.record({ type: "bee.task.deleted", payload: { taskId } });
  log("TASK", `deleted task ${taskId}`);
  logTaskDelete("deleteJobById:done", {
    taskId,
    remainingAllTasks: allTasks.size,
    pendingCount: approvalGate.listPending().length,
    approvedCount: approvalGate.listApproved().length,
  });
  return { ok: true };
}

app.delete("/api/jobs/:jobId", requireAuth, (req, res) => {
  const taskId = req.params.jobId;
  logTaskDelete("HTTP DELETE /api/jobs/:jobId", { taskId, path: req.path, originalUrl: req.originalUrl });
  const result = deleteJobById(taskId);
  if ("error" in result) {
    logTaskDelete("HTTP DELETE response", { taskId, error: result.error, status: result.status });
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

/** POST alias (some proxies strip DELETE; same auth as DELETE). */
app.post("/api/jobs/:jobId/delete", requireAuth, (req, res) => {
  const taskId = req.params.jobId;
  logTaskDelete("HTTP POST /api/jobs/:id/delete", { taskId, path: req.path, originalUrl: req.originalUrl });
  const result = deleteJobById(taskId);
  if ("error" in result) {
    logTaskDelete("HTTP POST delete response", { taskId, error: result.error, status: result.status });
    res.status(result.status).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

// ─── Task schedule CRUD ───
app.get("/api/jobs/:jobId/schedule", requireAuth, (req, res) => {
  const sched = taskSchedules.get(req.params.jobId);
  if (!sched) {
    res.status(404).json({ error: "schedule_not_found" });
    return;
  }
  res.json({ schedule: sched });
});

app.put("/api/jobs/:jobId/schedule", requireAuth, (req, res) => {
  const taskId = req.params.jobId;
  const existing = taskSchedules.get(taskId);
  if (!existing) {
    res.status(404).json({ error: "schedule_not_found" });
    return;
  }

  const updated: TaskSchedule = {
    ...existing,
    deadline: req.body.deadline ?? existing.deadline,
    repeatType: req.body.repeatType ?? existing.repeatType,
    intervalHours: req.body.intervalHours ?? existing.intervalHours,
    dailyAtHour: req.body.dailyAtHour ?? existing.dailyAtHour,
    dailyAtMinute: req.body.dailyAtMinute ?? existing.dailyAtMinute,
    cronExpression: req.body.cronExpression ?? existing.cronExpression,
    maxRetries: req.body.maxRetries ?? existing.maxRetries,
    enabled: req.body.enabled ?? existing.enabled,
  };
  taskSchedules.set(taskId, updated);
  refreshScheduleNextRun(taskId, updated, Date.now());

  const task = allTasks.get(taskId);
  if (task) task.schedule = updated;

  persistWorkspace();

  log("SCHEDULE", `updated schedule for task ${taskId}: repeat=${updated.repeatType} maxRetries=${updated.maxRetries}`);
  auditLog.record({ type: "bee.task.schedule.updated", payload: { taskId, repeatType: updated.repeatType, maxRetries: updated.maxRetries } });
  res.json({ schedule: updated });
});

// ─── All tasks with schedules ───
app.get("/api/jobs", requireAuth, (_req, res) => {
  const tasks = [...allTasks.values()].map((t) => ({
    ...t,
    schedule: taskSchedules.get(t.id) ?? null,
    conversation: jobStore.get(t.id) ?? null,
  }));
  res.json({ jobs: tasks, tasks });
});

app.get("/api/jobs/:jobId/conversation", requireAuth, (req, res) => {
  const jobId = req.params.jobId;
  // Pending / approved-queue tasks are not in allTasks yet but appear in the UI (and Next may prefetch /jobs/:id).
  const taskKnown =
    allTasks.has(jobId) ||
    approvalGate.isTracked(jobId) ||
    (latestTeamPlan?.tasks.some((t) => t.id === jobId) ?? false);
  if (!taskKnown) {
    res.status(404).json({ error: "task_not_found" });
    return;
  }
  const conv = jobStore.get(jobId);
  const history = jobStore.listHistory(jobId);
  if (conv) {
    log("JOB", `conversation for ${jobId}: ${conv.entries.length} entries, status=${conv.status}, history=${history.length}`);
  }
  res.json({ conversation: conv ?? null, history });
});

app.get("/api/jobs/conversations", requireAuth, (_req, res) => {
  const all = jobStore.listAll();
  log("JOB", `listing all conversations: ${all.length}`);
  res.json({ conversations: all });
});

function wordsForSuggestion(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9가-힣\s-]/g, " ")
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2),
  );
}

function lastUsefulConversationText(conv: ConversationEntry[]): string {
  return conv.slice().reverse().find((e) => e.action === "done" || e.role === "flower" || e.role === "system")?.content ?? "";
}

app.get("/api/context/suggestions", requireAuth, (req, res) => {
  const districtId = typeof req.query.districtId === "string" ? req.query.districtId.trim() : "";
  const taskId = typeof req.query.taskId === "string" ? req.query.taskId.trim() : "";
  const limitRaw = Number(req.query.limit ?? 8);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(20, Math.floor(limitRaw))) : 8;
  const seedTask = taskId ? allTasks.get(taskId) : undefined;
  const seedWords = wordsForSuggestion(`${seedTask?.title ?? ""} ${seedTask?.description ?? ""}`);
  const upstream = districtId && allDistricts.has(districtId) ? upstreamDistrictsOneWay(districtId, districtBridges.values()) : new Set<string>();

  const suggestions: {
    sourceType: "conversation" | "pipeline";
    sourceId: string;
    taskId?: string;
    districtId?: string;
    title: string;
    preview: string;
    score: number;
    createdAt: string;
  }[] = [];

  const addConversation = (conv: TaskConversation, archived = false) => {
    if (conv.status !== "done" || conv.taskId === taskId) return;
    const task = allTasks.get(conv.taskId);
    const output = lastUsefulConversationText(conv.entries).trim();
    if (!output) return;
    let score = archived ? 5 : 10;
    if (districtId && task?.districtId === districtId) score += 50;
    if (task?.districtId && upstream.has(task.districtId)) score += 35;
    const taskWords = wordsForSuggestion(`${task?.title ?? ""} ${task?.description ?? ""}`);
    for (const w of seedWords) if (taskWords.has(w)) score += 3;
    suggestions.push({
      sourceType: "conversation",
      sourceId: conv.sessionId ?? conv.jobId,
      taskId: conv.taskId,
      districtId: task?.districtId,
      title: task?.title ?? conv.taskId,
      preview: output.slice(0, 500),
      score,
      createdAt: conv.finishedAt ?? conv.startedAt,
    });
  };

  for (const conv of jobStore.listAll()) addConversation(conv);
  for (const task of allTasks.values()) {
    for (const conv of jobStore.listHistory(task.id)) addConversation(conv, true);
  }

  for (const run of workspaceStore.loadPipelineRuns()) {
    let score = run.startDistrictId === districtId ? 45 : 12;
    if (upstream.has(run.startDistrictId)) score += 25;
    const title = `Pipeline ${run.startDistrictId}`;
    suggestions.push({
      sourceType: "pipeline",
      sourceId: run.id,
      districtId: run.startDistrictId,
      title,
      preview: run.summary.slice(0, 500),
      score,
      createdAt: run.finishedAt,
    });
  }

  suggestions.sort((a, b) => b.score - a.score || b.createdAt.localeCompare(a.createdAt));
  res.json({ suggestions: suggestions.slice(0, limit) });
});

app.get("/api/team", requireAuth, (_req, res) => {
  res.json({ teamPlan: latestTeamPlan });
});

// ─── Workspace Config ───

app.get("/api/settings/workspace", requireAuth, (_req, res) => {
  res.json(wsConfig.info());
});

app.get("/api/projects", requireAuth, (_req, res) => {
  const projects = projectManager.listProjects();
  res.json({ projects, count: projects.length });
});

app.post("/api/projects", requireAuth, (req, res) => {
  const title = String(req.body?.title ?? req.body?.name ?? "").trim();
  if (!title) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const district: BeeDistrict = {
    id: `district-project-${randomUUID().slice(0, 8)}`,
    title,
    objective: "",
    status: "active",
    cityId: latestTeamPlan?.id ?? "",
  };
  const project = projectManager.resolveProjectForDistrict(district);
  res.json({ project });
});

app.post("/api/projects/resolve", requireAuth, (req, res) => {
  const districtId = String(req.body?.districtId ?? "").trim();
  if (!districtId || !allDistricts.has(districtId)) {
    res.status(400).json({ error: "unknown_district" });
    return;
  }
  const district = allDistricts.get(districtId)!;
  const project = projectManager.resolveProjectForDistrict(district);
  persistWorkspace();
  res.json({ project, district });
});

app.put("/api/settings/workspace", requireAuth, (req, res) => {
  const newPath = String(req.body.workspacePath ?? "").trim();
  if (!newPath) { res.status(400).json({ error: "workspacePath is required" }); return; }
  try {
    wsConfig.setWorkspacePath(newPath);
    log("WORKSPACE", `path changed to ${wsConfig.workspacePath}`);
    res.json(wsConfig.info());
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(400).json({ error: msg });
  }
});

function flowerJsonForClient(f: FlowerConfig, discordLastError?: string): Record<string, unknown> {
  const row: Record<string, unknown> = { ...f };
  if (f.type === "discord_bot") {
    delete row.discordBotToken;
    delete row.discordLastError;
    row.discordBotTokenSet = Boolean(f.discordBotToken?.trim());
    if (discordLastError) row.discordLastError = discordLastError;
  }
  return row;
}

function parseDiscordCooldownMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.floor(n);
}

type BridgeSettingsImportPayload = {
  format: "beebridge.bridge-settings.v1";
  startDistrictId: string | null;
  districts: Array<{
    district: Record<string, unknown>;
    bees: Array<Record<string, unknown>>;
    tasks: Array<Record<string, unknown>>;
  }>;
  bridges: Array<Record<string, unknown>>;
};

type BridgeTemplatePayload = Omit<BridgeSettingsImportPayload, "format"> & {
  format: "beebridge.bridge-template.v1";
  templateName?: string;
  templateDescription?: string;
};

function parseBridgeSettingsImportPayload(raw: unknown): BridgeSettingsImportPayload {
  if (!raw || typeof raw !== "object") {
    throw new Error("payload must be an object");
  }
  const rec = raw as Record<string, unknown>;
  if (rec.format !== "beebridge.bridge-settings.v1" && rec.format !== "beebridge.bridge-template.v1") {
    throw new Error("unsupported format");
  }
  const districts = Array.isArray(rec.districts) ? rec.districts : [];
  const bridges = Array.isArray(rec.bridges) ? rec.bridges : [];
  return {
    format: "beebridge.bridge-settings.v1",
    startDistrictId:
      rec.startDistrictId == null ? null : String(rec.startDistrictId),
    districts: districts
      .filter((d): d is Record<string, unknown> => Boolean(d && typeof d === "object"))
      .map((d) => ({
        district:
          d.district && typeof d.district === "object"
            ? (d.district as Record<string, unknown>)
            : {},
        bees: Array.isArray(d.bees)
          ? d.bees.filter((b): b is Record<string, unknown> => Boolean(b && typeof b === "object"))
          : [],
        tasks: Array.isArray(d.tasks)
          ? d.tasks.filter((t): t is Record<string, unknown> => Boolean(t && typeof t === "object"))
          : [],
      })),
    bridges: bridges.filter((b): b is Record<string, unknown> => Boolean(b && typeof b === "object")),
  };
}

function sanitizeTemplatePayload(raw: unknown): BridgeTemplatePayload {
  const parsed = parseBridgeSettingsImportPayload(raw);
  const clone = JSON.parse(JSON.stringify(parsed)) as BridgeTemplatePayload;
  clone.format = "beebridge.bridge-template.v1";
  for (const row of clone.districts) {
    delete (row.district as { codeProjectPath?: unknown }).codeProjectPath;
    const waggle = row.district.waggle as Record<string, unknown> | undefined;
    if (waggle && typeof waggle === "object") delete waggle.apiKey;
    for (const task of row.tasks) {
      task.status = "waiting";
      if (task.schedule && typeof task.schedule === "object") {
        (task.schedule as Record<string, unknown>).retryCount = 0;
        delete (task.schedule as Record<string, unknown>).lastRunAt;
        delete (task.schedule as Record<string, unknown>).nextRunAt;
      }
    }
  }
  return clone;
}

function remapTemplatePayloadForApply(raw: unknown): BridgeSettingsImportPayload {
  const parsed = parseBridgeSettingsImportPayload(raw);
  const districtMap = new Map<string, string>();
  const beeMap = new Map<string, string>();
  const taskMap = new Map<string, string>();
  const cityId = latestTeamPlan?.id || `city-${randomUUID().slice(0, 8)}`;

  for (const row of parsed.districts) {
    const oldId = typeof row.district.id === "string" ? row.district.id : "";
    if (oldId) districtMap.set(oldId, `district-${randomUUID().slice(0, 8)}`);
    for (const b of row.bees) {
      const oldBeeId = typeof b.id === "string" ? b.id : "";
      if (oldBeeId) beeMap.set(oldBeeId, newBeeId());
    }
    for (const t of row.tasks) {
      const oldTaskId = typeof t.id === "string" ? t.id : "";
      if (oldTaskId) taskMap.set(oldTaskId, `task-${randomUUID().slice(0, 8)}`);
    }
  }

  const districts = parsed.districts.map((row) => {
    const oldDistrictId = String(row.district.id ?? "");
    const districtId = districtMap.get(oldDistrictId) ?? `district-${randomUUID().slice(0, 8)}`;
    const bees = row.bees.map((b) => {
      const oldBeeId = String(b.id ?? "");
      const next: Record<string, unknown> = { ...b, id: beeMap.get(oldBeeId) ?? newBeeId() };
      if (typeof next.scopedTaskId === "string") next.scopedTaskId = taskMap.get(next.scopedTaskId) ?? next.scopedTaskId;
      if (typeof next.parentBeeId === "string") next.parentBeeId = beeMap.get(next.parentBeeId) ?? next.parentBeeId;
      return next;
    });
    const tasks = row.tasks.map((t) => {
      const oldTaskId = String(t.id ?? "");
      const personaId = typeof t.personaId === "string" ? beeMap.get(t.personaId) ?? t.personaId : undefined;
      const bee = typeof t.bee === "string" ? beeMap.get(t.bee) ?? t.bee : t.bee;
      const schedule: Record<string, unknown> | undefined =
        t.schedule && typeof t.schedule === "object" ? { ...(t.schedule as Record<string, unknown>), retryCount: 0 } : undefined;
      if (schedule) {
        delete schedule.lastRunAt;
        delete schedule.nextRunAt;
      }
      return {
        ...t,
        id: taskMap.get(oldTaskId) ?? `task-${randomUUID().slice(0, 8)}`,
        districtId,
        cityId,
        bee,
        personaId,
        status: "waiting",
        dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String).map((id) => taskMap.get(id)).filter(Boolean) : undefined,
        schedule,
      };
    });
    return {
      district: {
        ...row.district,
        id: districtId,
        cityId,
        title: `${String(row.district.title ?? "District")} copy`,
        beeRosterIds: Array.isArray(row.district.beeRosterIds)
          ? row.district.beeRosterIds.map(String).map((id) => beeMap.get(id)).filter(Boolean)
          : undefined,
      },
      bees,
      tasks,
    };
  });

  const bridges = parsed.bridges.map((b) => ({
    ...b,
    id: `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fromDistrictId: districtMap.get(String(b.fromDistrictId ?? "")) ?? "",
    toDistrictId: districtMap.get(String(b.toDistrictId ?? "")) ?? "",
    createdAt: new Date().toISOString(),
  }));

  return {
    format: "beebridge.bridge-settings.v1",
    startDistrictId: parsed.startDistrictId ? districtMap.get(parsed.startDistrictId) ?? null : null,
    districts,
    bridges,
  };
}

function normalizeImportedDistrict(
  raw: Record<string, unknown>,
  fallbackCityId: string,
): BeeDistrict | null {
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  if (!id) return null;
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id;
  const statusRaw = typeof raw.status === "string" ? raw.status : "active";
  const status: DistrictStatus =
    statusRaw === "planning" || statusRaw === "completed" ? statusRaw : "active";
  const district: BeeDistrict = {
    id,
    title,
    objective: typeof raw.objective === "string" ? raw.objective : "",
    status,
    cityId:
      typeof raw.cityId === "string" && raw.cityId.trim()
        ? raw.cityId.trim()
        : fallbackCityId,
  };
  if (raw.waggle && typeof raw.waggle === "object") district.waggle = raw.waggle as BeeDistrict["waggle"];
  if (Array.isArray(raw.beeRosterIds)) district.beeRosterIds = raw.beeRosterIds.map(String);
  if (
    raw.bridgeLayout &&
    typeof raw.bridgeLayout === "object" &&
    Number.isFinite((raw.bridgeLayout as { x?: unknown }).x) &&
    Number.isFinite((raw.bridgeLayout as { y?: unknown }).y)
  ) {
    district.bridgeLayout = {
      x: Number((raw.bridgeLayout as { x: unknown }).x),
      y: Number((raw.bridgeLayout as { y: unknown }).y),
    };
  }
  if (raw.useUpstreamBridgeContext !== undefined) {
    district.useUpstreamBridgeContext = Boolean(raw.useUpstreamBridgeContext);
  }
  if (typeof raw.codeProjectId === "string" && raw.codeProjectId.trim()) {
    const hintedProject = projectManager.importProjectHint(raw.codeProjectId.trim(), title);
    district.codeProjectId = hintedProject.id;
  }
  return district;
}

function normalizeImportedBee(raw: Record<string, unknown>): BeePersona | null {
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  if (!id) return null;
  const flowerTypeRaw = typeof raw.flowerType === "string" ? raw.flowerType : "browser";
  const flowerType: FlowerType =
    flowerTypeRaw === "api" || flowerTypeRaw === "mcp" || flowerTypeRaw === "code"
      ? flowerTypeRaw
      : "browser";
  return {
    id,
    name: typeof raw.name === "string" ? raw.name : id,
    role: typeof raw.role === "string" ? raw.role : "worker",
    systemPrompt: typeof raw.systemPrompt === "string" ? raw.systemPrompt : "",
    providerId: typeof raw.providerId === "string" && raw.providerId.trim() ? raw.providerId.trim() : "openai",
    model: typeof raw.model === "string" ? raw.model : "",
    flowerType,
    ...(typeof raw.scopedTaskId === "string" && raw.scopedTaskId.trim()
      ? { scopedTaskId: raw.scopedTaskId.trim() }
      : {}),
    ...(typeof raw.intentSignature === "string" && raw.intentSignature.trim()
      ? { intentSignature: raw.intentSignature.trim() }
      : {}),
    ...(typeof raw.parentBeeId === "string" && raw.parentBeeId.trim()
      ? { parentBeeId: raw.parentBeeId.trim() }
      : {}),
    ...(raw.lineageKind === "anchor" || raw.lineageKind === "worker" || raw.lineageKind === "child"
      ? { lineageKind: raw.lineageKind }
      : {}),
  };
}

function normalizeImportedTask(
  raw: Record<string, unknown>,
  districtId: string,
  fallbackCityId: string,
): BeeTask | null {
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : "";
  if (!id) return null;
  const priorityRaw = typeof raw.priority === "string" ? raw.priority : "medium";
  const priority = priorityRaw === "low" || priorityRaw === "high" ? priorityRaw : "medium";
  const statusRaw = typeof raw.status === "string" ? raw.status : "waiting";
  const status =
    statusRaw === "assigned" ||
    statusRaw === "working" ||
    statusRaw === "review" ||
    statusRaw === "done"
      ? statusRaw
      : "waiting";

  const task: BeeTask = {
    id,
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : id,
    ...(raw.description == null ? {} : { description: String(raw.description) }),
    districtId,
    cityId:
      typeof raw.cityId === "string" && raw.cityId.trim() ? raw.cityId.trim() : fallbackCityId,
    bee: typeof raw.bee === "string" && raw.bee.trim() ? raw.bee.trim() : `bee-${randomUUID().slice(0, 8)}`,
    flower: typeof raw.flower === "string" && raw.flower.trim() ? raw.flower.trim() : "openai-web",
    assignee: typeof raw.assignee === "string" ? raw.assignee : "",
    dueDate: typeof raw.dueDate === "string" ? raw.dueDate : "",
    priority,
    requiresApproval: Boolean(raw.requiresApproval),
    status,
    ...(typeof raw.personaId === "string" && raw.personaId.trim() ? { personaId: raw.personaId.trim() } : {}),
    ...(Array.isArray(raw.dependsOn)
      ? { dependsOn: raw.dependsOn.map(String).filter((x) => x.trim().length > 0) }
      : {}),
  };
  if (raw.schedule && typeof raw.schedule === "object") {
    task.schedule = raw.schedule as TaskSchedule;
  }
  return task;
}

function normalizeImportedBridge(
  raw: Record<string, unknown>,
): DistrictBridge | null {
  const fromDistrictId =
    typeof raw.fromDistrictId === "string" && raw.fromDistrictId.trim() ? raw.fromDistrictId.trim() : "";
  const toDistrictId =
    typeof raw.toDistrictId === "string" && raw.toDistrictId.trim() ? raw.toDistrictId.trim() : "";
  if (!fromDistrictId || !toDistrictId || fromDistrictId === toDistrictId) return null;
  const id =
    typeof raw.id === "string" && raw.id.trim()
      ? raw.id.trim()
      : `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const directionRaw = typeof raw.direction === "string" ? raw.direction : "one_way";
  const statusRaw = typeof raw.status === "string" ? raw.status : "active";
  return {
    id,
    fromDistrictId,
    toDistrictId,
    label:
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim()
        : `${fromDistrictId.slice(0, 12)} → ${toDistrictId.slice(0, 12)}`,
    ...(raw.description == null ? {} : { description: String(raw.description) }),
    direction: directionRaw === "two_way" ? "two_way" : "one_way",
    status: statusRaw === "inactive" || statusRaw === "pending" ? statusRaw : "active",
    ...(Array.isArray(raw.dataFlow) ? { dataFlow: raw.dataFlow.map(String).filter(Boolean) } : {}),
    createdAt:
      typeof raw.createdAt === "string" && raw.createdAt.trim()
        ? raw.createdAt.trim()
        : new Date().toISOString(),
  };
}

function applyBridgeSettingsPayload(payload: BridgeSettingsImportPayload) {
  if (!latestTeamPlan) {
    latestTeamPlan = {
      id: `city-${randomUUID().slice(0, 8)}`,
      goal: "",
      bees: [],
      districts: [...allDistricts.values()],
      tasks: [...allTasks.values()],
    };
  }

  const cityIdFallback = latestTeamPlan.id || `city-${randomUUID().slice(0, 8)}`;
  const importedDistrictIds = new Set<string>();
  const importedTaskIds = new Set<string>();
  const importedBeeIds = new Set<string>();
  let importedBridgeCount = 0;

  for (const row of payload.districts) {
    const district = normalizeImportedDistrict(row.district, cityIdFallback);
    if (!district) continue;
    importedDistrictIds.add(district.id);
    allDistricts.set(district.id, district);

    const bees: BeePersona[] = [];
    for (const bRow of row.bees) {
      const bee = normalizeImportedBee(bRow);
      if (!bee) continue;
      bees.push(bee);
      importedBeeIds.add(bee.id);
    }

    const tasks: BeeTask[] = [];
    for (const tRow of row.tasks) {
      const task = normalizeImportedTask(tRow, district.id, district.cityId || cityIdFallback);
      if (!task) continue;
      tasks.push(task);
      importedTaskIds.add(task.id);
      allTasks.set(task.id, task);
      if (task.schedule && typeof task.schedule === "object") {
        taskSchedules.set(task.id, task.schedule as TaskSchedule);
      } else {
        taskSchedules.delete(task.id);
      }
      if (task.requiresApproval && task.status !== "done") {
        approvalGate.register(task);
      } else {
        approvalGate.forget(task.id);
      }
    }

    const beeById = new Map((latestTeamPlan.bees ?? []).map((b) => [b.id, b] as const));
    for (const b of bees) beeById.set(b.id, b);
    latestTeamPlan.bees = [...beeById.values()];

    const taskById = new Map((latestTeamPlan.tasks ?? []).map((t) => [t.id, t] as const));
    for (const t of tasks) taskById.set(t.id, t);
    latestTeamPlan.tasks = [...taskById.values()];
  }

  for (const taskId of importedTaskIds) {
    const task = allTasks.get(taskId);
    if (!task) continue;
    task.dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn.map(String).filter((id) => id && allTasks.has(id))
      : undefined;
  }

  for (const bRow of payload.bridges) {
    const bridge = normalizeImportedBridge(bRow);
    if (!bridge) continue;
    if (!allDistricts.has(bridge.fromDistrictId) || !allDistricts.has(bridge.toDistrictId)) continue;
    districtBridges.set(bridge.id, bridge);
    importedBridgeCount++;
  }

  for (const districtId of importedDistrictIds) {
    const district = allDistricts.get(districtId);
    if (!district) continue;
    district.beeRosterIds = recomputeDistrictBeeRosterIds(districtId);
    allDistricts.set(districtId, district);
  }

  const districtById = new Map((latestTeamPlan.districts ?? []).map((d) => [d.id, d] as const));
  for (const d of allDistricts.values()) districtById.set(d.id, d);
  latestTeamPlan.districts = [...districtById.values()];

  if (payload.startDistrictId && allDistricts.has(payload.startDistrictId)) {
    bridgeGraphMeta = { startDistrictId: payload.startDistrictId };
  }

  syncGraph();
  persistWorkspace();
  broadcastToWeb({ type: "districts.updated" });
  broadcastToWeb({ type: "bridge-graph.updated", startDistrictId: bridgeGraphMeta.startDistrictId });

  return {
    districts: importedDistrictIds.size,
    bees: importedBeeIds.size,
    tasks: importedTaskIds.size,
    bridges: importedBridgeCount,
    startDistrictId: bridgeGraphMeta.startDistrictId,
    districtIds: [...importedDistrictIds],
    taskIds: [...importedTaskIds],
    beeIds: [...importedBeeIds],
  };
}

// ─── Flower Config CRUD ───
app.get("/api/settings/flowers", requireAuth, (_req, res) => {
  const liveFlowerIds = [...connectedFlowers.keys()];
  const discordMgr = discordFlowerManagerRef.current;
  const configs = flowerConfigStore.getAll().map((f) => {
    const isConnected =
      f.type === "chrome_extension"
        ? liveFlowerIds.length > 0
        : f.type === "discord_bot"
          ? (discordMgr?.isFlowerConnected(f.id) ?? false)
          : false;
    const row: Record<string, unknown> = {
      ...f,
      connected: isConnected,
      lastSeenAt: isConnected ? new Date().toISOString() : f.lastSeenAt,
    };
    if (f.type === "discord_bot") {
      delete row.discordBotToken;
      delete row.discordLastError;
      row.discordBotTokenSet = Boolean(f.discordBotToken?.trim());
      const err = discordMgr?.getLastError(f.id);
      if (err) row.discordLastError = err;
    }
    return row;
  });
  log("FLOWER", `listing ${configs.length} flower configs`);
  res.json({ flowers: configs, connectedCount: [...connectedFlowers.values()].filter((ws) => ws.readyState === 1).length });
});

app.post("/api/settings/flowers", requireAuth, (req, res) => {
  const name = String(req.body.name ?? "").trim();
  const type = String(req.body.type ?? "chrome_extension") as FlowerConnectionType;
  if (!name) { res.status(400).json({ error: "name_required" }); return; }

  const id = `flower-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const discordChannelAllowlist = Array.isArray(req.body.discordChannelAllowlist)
    ? req.body.discordChannelAllowlist.map(String)
    : undefined;
  const discordBotTokenRaw = req.body.discordBotToken != null ? String(req.body.discordBotToken).trim() : "";
  const config: FlowerConfig = {
    id,
    name,
    type,
    enabled: true,
    description: req.body.description ? String(req.body.description) : undefined,
    apiEndpoint: req.body.apiEndpoint ? String(req.body.apiEndpoint) : undefined,
    apiKey: req.body.apiKey ? String(req.body.apiKey) : undefined,
    mcpCommand: req.body.mcpCommand ? String(req.body.mcpCommand) : undefined,
    mcpArgs: Array.isArray(req.body.mcpArgs) ? req.body.mcpArgs.map(String) : undefined,
    mcpEnv: req.body.mcpEnv && typeof req.body.mcpEnv === "object" ? req.body.mcpEnv : undefined,
    ...(type === "discord_bot"
      ? {
          discordBotToken: discordBotTokenRaw || undefined,
          discordChannelAllowlist,
          discordChatToolsEnabled:
            req.body.discordChatToolsEnabled !== undefined ? Boolean(req.body.discordChatToolsEnabled) : true,
          discordUserAllowlist: Array.isArray(req.body.discordUserAllowlist)
            ? req.body.discordUserAllowlist.map(String)
            : undefined,
          discordCooldownMs: parseDiscordCooldownMs(req.body.discordCooldownMs),
        }
      : {}),
    capabilities: Array.isArray(req.body.capabilities) ? req.body.capabilities.map(String) : [],
    createdAt: new Date().toISOString(),
  };
  flowerConfigStore.set(id, config);
  scheduleDiscordFlowerSync();
  auditLog.record({ type: "flower.config.created", payload: { id, name, flowerType: type } });
  log("FLOWER", `config created: ${id} (${name}, type=${type})`);
  res.status(201).json({
    flower: flowerJsonForClient(config, discordFlowerManagerRef.current?.getLastError(id)),
  });
});

app.put("/api/settings/flowers/:flowerId", requireAuth, (req, res) => {
  const existing = flowerConfigStore.get(req.params.flowerId);
  if (!existing) { res.status(404).json({ error: "flower_not_found" }); return; }

  let discordBotToken = existing.discordBotToken;
  if (req.body.discordBotToken !== undefined) {
    const t = String(req.body.discordBotToken).trim();
    discordBotToken = t ? t : existing.discordBotToken;
  }
  const updated: FlowerConfig = {
    ...existing,
    name: req.body.name ? String(req.body.name) : existing.name,
    type: req.body.type ? String(req.body.type) as FlowerConnectionType : existing.type,
    enabled: req.body.enabled !== undefined ? Boolean(req.body.enabled) : existing.enabled,
    description: req.body.description !== undefined ? String(req.body.description) : existing.description,
    apiEndpoint: req.body.apiEndpoint !== undefined ? String(req.body.apiEndpoint) : existing.apiEndpoint,
    apiKey: req.body.apiKey !== undefined ? String(req.body.apiKey) : existing.apiKey,
    mcpCommand: req.body.mcpCommand !== undefined ? String(req.body.mcpCommand) : existing.mcpCommand,
    mcpArgs: Array.isArray(req.body.mcpArgs) ? req.body.mcpArgs.map(String) : existing.mcpArgs,
    mcpEnv: req.body.mcpEnv !== undefined ? req.body.mcpEnv : existing.mcpEnv,
    discordBotToken,
    discordChannelAllowlist: Array.isArray(req.body.discordChannelAllowlist)
      ? req.body.discordChannelAllowlist.map(String)
      : existing.discordChannelAllowlist,
    discordChatToolsEnabled:
      req.body.discordChatToolsEnabled !== undefined
        ? Boolean(req.body.discordChatToolsEnabled)
        : existing.discordChatToolsEnabled,
    discordUserAllowlist: Array.isArray(req.body.discordUserAllowlist)
      ? req.body.discordUserAllowlist.map(String)
      : existing.discordUserAllowlist,
    discordCooldownMs:
      req.body.discordCooldownMs !== undefined
        ? parseDiscordCooldownMs(req.body.discordCooldownMs)
        : existing.discordCooldownMs,
    capabilities: Array.isArray(req.body.capabilities) ? req.body.capabilities.map(String) : existing.capabilities,
  };
  delete (updated as { discordLastError?: string }).discordLastError;
  flowerConfigStore.set(req.params.flowerId, updated);
  scheduleDiscordFlowerSync();
  auditLog.record({ type: "flower.config.updated", payload: { id: req.params.flowerId, enabled: updated.enabled } });
  log("FLOWER", `config updated: ${req.params.flowerId} enabled=${updated.enabled}`);
  res.json({
    flower: flowerJsonForClient(updated, discordFlowerManagerRef.current?.getLastError(req.params.flowerId)),
  });
});

app.delete("/api/settings/flowers/:flowerId", requireAuth, (req, res) => {
  const existing = flowerConfigStore.get(req.params.flowerId);
  if (!existing) { res.status(404).json({ error: "flower_not_found" }); return; }
  flowerConfigStore.delete(req.params.flowerId);
  scheduleDiscordFlowerSync();
  auditLog.record({ type: "flower.config.deleted", payload: { id: req.params.flowerId, name: existing.name } });
  log("FLOWER", `config deleted: ${req.params.flowerId}`);
  res.status(204).send();
});

app.patch("/api/settings/flowers/:flowerId/toggle", requireAuth, (req, res) => {
  const existing = flowerConfigStore.get(req.params.flowerId);
  if (!existing) { res.status(404).json({ error: "flower_not_found" }); return; }
  existing.enabled = !existing.enabled;
  flowerConfigStore.set(req.params.flowerId, existing);
  scheduleDiscordFlowerSync();
  auditLog.record({ type: "flower.config.toggled", payload: { id: req.params.flowerId, enabled: existing.enabled } });
  log("FLOWER", `config toggled: ${req.params.flowerId} → enabled=${existing.enabled}`);
  res.json({
    flower: flowerJsonForClient(existing, discordFlowerManagerRef.current?.getLastError(req.params.flowerId)),
  });
});

app.get("/api/flowers/connected", requireAuth, (_req, res) => {
  const flowers = [...connectedFlowers.keys()].map((id) => ({
    id,
    connected: connectedFlowers.get(id)?.readyState === 1,
  }));
  res.json({ flowers, count: flowers.length });
});

app.get("/api/diagnostics/runtime", requireAuth, (req, res) => {
  const discordMgr = discordFlowerManagerRef.current;
  const configuredFlowers = flowerConfigStore.getAll().map((f) => {
    const connected =
      f.type === "chrome_extension"
        ? [...connectedFlowers.values()].some((ws) => ws.readyState === 1)
        : f.type === "discord_bot"
          ? (discordMgr?.isFlowerConnected(f.id) ?? false)
          : false;
    return {
      id: f.id,
      name: f.name,
      type: f.type,
      enabled: f.enabled,
      connected,
      lastError: f.type === "discord_bot" ? discordMgr?.getLastError(f.id) : undefined,
    };
  });
  const activeJobs = jobStore.listAll().filter((c) => c.status === "running");
  res.json({
    gateway: {
      status: "ok",
      port: PORT,
      cdpRelayPort: CDP_RELAY_PORT,
      ...authStatusForSecret(requestSecret(req)),
    },
    flowers: {
      connectedCount: configuredFlowers.filter((f) => f.connected).length,
      configured: configuredFlowers,
      liveWebSocketIds: [...connectedFlowers.keys()],
    },
    cdpRelay: {
      connected: cdpRelay.isExtensionConnected(),
      attachedTabId: cdpRelay.getAttachedTabId(),
    },
    sandbox: {
      ...sandboxStatus(),
      containerCount: (() => {
        try {
          return listSandboxContainers().length;
        } catch {
          return null;
        }
      })(),
    },
    discord: {
      summary: discordMgr?.getRuntimeSummary() ?? "discord_flower_bots_ready: 0",
    },
    jobs: {
      activeCount: activeJobs.length,
      active: activeJobs.map((c) => ({ taskId: c.taskId, beeId: c.beeId, startedAt: c.startedAt })),
      pendingApprovals: approvalGate.listPending().length,
    },
  });
});

// ─── District Bridges ───
app.get("/api/bridges", requireAuth, (_req, res) => {
  const bridges = [...districtBridges.values()];
  log("BRIDGE", `listing ${bridges.length} bridges`);
  res.json({ bridges });
});

app.post("/api/bridges", requireAuth, (req, res) => {
  const fromDistrictId = String(req.body.fromDistrictId ?? "").trim();
  const toDistrictId = String(req.body.toDistrictId ?? "").trim();
  const label = String(req.body.label ?? "").trim();
  if (!fromDistrictId || !toDistrictId || !label) {
    res.status(400).json({ error: "fromDistrictId, toDistrictId, and label are required" });
    return;
  }

  const id = `bridge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const bridge: DistrictBridge = {
    id,
    fromDistrictId,
    toDistrictId,
    label,
    description: req.body.description ? String(req.body.description) : undefined,
    direction: req.body.direction === "two_way" ? "two_way" : "one_way",
    status: "active",
    dataFlow: Array.isArray(req.body.dataFlow) ? req.body.dataFlow.map(String) : undefined,
    createdAt: new Date().toISOString(),
  };
  districtBridges.set(id, bridge);
  syncGraph();
  auditLog.record({ type: "bridge.created", payload: { id, fromDistrictId, toDistrictId, label } });
  log("BRIDGE", `created: ${id} (${fromDistrictId} → ${toDistrictId})`);
  res.status(201).json({ bridge });
});

app.put("/api/bridges/:bridgeId", requireAuth, (req, res) => {
  const existing = districtBridges.get(req.params.bridgeId);
  if (!existing) { res.status(404).json({ error: "bridge_not_found" }); return; }

  const updated: DistrictBridge = {
    ...existing,
    label: req.body.label ? String(req.body.label) : existing.label,
    description: req.body.description !== undefined ? String(req.body.description) : existing.description,
    direction: req.body.direction ?? existing.direction,
    status: req.body.status ?? existing.status,
    dataFlow: Array.isArray(req.body.dataFlow) ? req.body.dataFlow.map(String) : existing.dataFlow,
  };
  districtBridges.set(req.params.bridgeId, updated);
  syncGraph();
  log("BRIDGE", `updated: ${req.params.bridgeId}`);
  res.json({ bridge: updated });
});

app.delete("/api/bridges/:bridgeId", requireAuth, (req, res) => {
  const existing = districtBridges.get(req.params.bridgeId);
  if (!existing) { res.status(404).json({ error: "bridge_not_found" }); return; }
  districtBridges.delete(req.params.bridgeId);
  syncGraph();
  auditLog.record({ type: "bridge.deleted", payload: { id: req.params.bridgeId } });
  log("BRIDGE", `deleted: ${req.params.bridgeId}`);
  res.status(204).send();
});

app.get("/api/bridge-graph", requireAuth, (_req, res) => {
  res.json({
    startDistrictId: bridgeGraphMeta.startDistrictId,
    bridges: [...districtBridges.values()],
    districts: [...allDistricts.values()].map((d) => ({
      id: d.id,
      title: d.title,
      bridgeLayout: d.bridgeLayout,
    })),
  });
});

app.get("/api/bridge-templates", requireAuth, (_req, res) => {
  const templates = workspaceStore.loadBridgeTemplates().map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    districtCount:
      t.payload && typeof t.payload === "object" && Array.isArray((t.payload as { districts?: unknown }).districts)
        ? ((t.payload as { districts: unknown[] }).districts.length)
        : 0,
    bridgeCount:
      t.payload && typeof t.payload === "object" && Array.isArray((t.payload as { bridges?: unknown }).bridges)
        ? ((t.payload as { bridges: unknown[] }).bridges.length)
        : 0,
  }));
  res.json({ templates });
});

app.post("/api/bridge-templates", requireAuth, (req, res) => {
  let payload: BridgeTemplatePayload;
  try {
    payload = sanitizeTemplatePayload(req.body?.payload ?? req.body);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "invalid_payload" });
    return;
  }
  const now = new Date().toISOString();
  const name = String(req.body?.name ?? payload.templateName ?? "Bridge template").trim() || "Bridge template";
  const descriptionRaw = req.body?.description ?? payload.templateDescription;
  const template = {
    id: `template-${randomUUID().slice(0, 12)}`,
    name,
    description: descriptionRaw == null ? undefined : String(descriptionRaw),
    createdAt: now,
    updatedAt: now,
    payload,
  };
  const templates = workspaceStore.loadBridgeTemplates();
  templates.unshift(template);
  workspaceStore.saveBridgeTemplates(templates.slice(0, 100));
  auditLog.record({ type: "bridge.template.saved", payload: { id: template.id, name } });
  res.status(201).json({ template: { ...template, payload: undefined } });
});

app.post("/api/bridge-templates/:templateId/apply", requireAuth, (req, res) => {
  const template = workspaceStore.loadBridgeTemplates().find((t) => t.id === req.params.templateId);
  if (!template) {
    res.status(404).json({ error: "template_not_found" });
    return;
  }
  let payload: BridgeSettingsImportPayload;
  try {
    payload = remapTemplatePayloadForApply(template.payload);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "invalid_template" });
    return;
  }
  const summary = applyBridgeSettingsPayload(payload);
  auditLog.record({ type: "bridge.template.applied", payload: { id: template.id, name: template.name, summary } });
  res.json({
    ok: true,
    summary,
    districtIds: summary.districtIds,
    taskIds: summary.taskIds,
    bridgeIds: payload.bridges.map((b) => String(b.id ?? "")).filter(Boolean),
  });
});

app.post("/api/bridge-graph/import", requireAuth, (req, res) => {
  let payload: BridgeSettingsImportPayload;
  try {
    payload = parseBridgeSettingsImportPayload(req.body?.payload ?? req.body);
  } catch (e) {
    res.status(400).json({ error: e instanceof Error ? e.message : "invalid_payload" });
    return;
  }

  if (!latestTeamPlan) {
    latestTeamPlan = {
      id: `city-${randomUUID().slice(0, 8)}`,
      goal: "",
      bees: [],
      districts: [...allDistricts.values()],
      tasks: [...allTasks.values()],
    };
  }

  const cityIdFallback = latestTeamPlan.id || `city-${randomUUID().slice(0, 8)}`;
  const importedDistrictIds = new Set<string>();
  const importedTaskIds = new Set<string>();
  const importedBeeIds = new Set<string>();
  let importedBridgeCount = 0;

  for (const row of payload.districts) {
    const district = normalizeImportedDistrict(row.district, cityIdFallback);
    if (!district) continue;
    importedDistrictIds.add(district.id);
    allDistricts.set(district.id, district);

    const bees: BeePersona[] = [];
    for (const bRow of row.bees) {
      const bee = normalizeImportedBee(bRow);
      if (!bee) continue;
      bees.push(bee);
      importedBeeIds.add(bee.id);
    }

    const tasks: BeeTask[] = [];
    for (const tRow of row.tasks) {
      const task = normalizeImportedTask(tRow, district.id, district.cityId || cityIdFallback);
      if (!task) continue;
      tasks.push(task);
      importedTaskIds.add(task.id);
      allTasks.set(task.id, task);
      if (task.schedule && typeof task.schedule === "object") {
        taskSchedules.set(task.id, task.schedule as TaskSchedule);
      } else {
        taskSchedules.delete(task.id);
      }
      if (task.requiresApproval && task.status !== "done") {
        approvalGate.register(task);
      } else {
        approvalGate.forget(task.id);
      }
    }

    const beeById = new Map((latestTeamPlan.bees ?? []).map((b) => [b.id, b] as const));
    for (const b of bees) beeById.set(b.id, b);
    latestTeamPlan.bees = [...beeById.values()];

    const taskById = new Map((latestTeamPlan.tasks ?? []).map((t) => [t.id, t] as const));
    for (const t of tasks) taskById.set(t.id, t);
    latestTeamPlan.tasks = [...taskById.values()];
  }

  // Filter imported task deps after all upserts (drop dangling IDs).
  for (const taskId of importedTaskIds) {
    const task = allTasks.get(taskId);
    if (!task) continue;
    task.dependsOn = Array.isArray(task.dependsOn)
      ? task.dependsOn.map(String).filter((id) => id && allTasks.has(id))
      : undefined;
  }

  // Upsert imported bridges that point to known districts.
  for (const bRow of payload.bridges) {
    const bridge = normalizeImportedBridge(bRow);
    if (!bridge) continue;
    if (!allDistricts.has(bridge.fromDistrictId) || !allDistricts.has(bridge.toDistrictId)) continue;
    districtBridges.set(bridge.id, bridge);
    importedBridgeCount++;
  }

  // Keep district roster IDs in sync with imported bees/tasks.
  for (const districtId of importedDistrictIds) {
    const district = allDistricts.get(districtId);
    if (!district) continue;
    district.beeRosterIds = recomputeDistrictBeeRosterIds(districtId);
    allDistricts.set(districtId, district);
  }

  const districtById = new Map((latestTeamPlan.districts ?? []).map((d) => [d.id, d] as const));
  for (const d of allDistricts.values()) districtById.set(d.id, d);
  latestTeamPlan.districts = [...districtById.values()];

  if (payload.startDistrictId && allDistricts.has(payload.startDistrictId)) {
    bridgeGraphMeta = { startDistrictId: payload.startDistrictId };
  }

  syncGraph();
  persistWorkspace();
  broadcastToWeb({ type: "districts.updated" });
  broadcastToWeb({ type: "bridge-graph.updated", startDistrictId: bridgeGraphMeta.startDistrictId });
  log(
    "BRIDGE",
    `imported settings: districts=${importedDistrictIds.size}, bees=${importedBeeIds.size}, tasks=${importedTaskIds.size}, bridges=${importedBridgeCount}`,
  );
  res.json({
    ok: true,
    summary: {
      districts: importedDistrictIds.size,
      bees: importedBeeIds.size,
      tasks: importedTaskIds.size,
      bridges: importedBridgeCount,
      startDistrictId: bridgeGraphMeta.startDistrictId,
    },
  });
});

app.put("/api/bridge-graph/start", requireAuth, (req, res) => {
  const raw = req.body?.districtId;
  if (raw === null || raw === undefined || raw === "") {
    bridgeGraphMeta = { startDistrictId: null };
  } else {
    const id = String(raw).trim();
    if (!allDistricts.has(id)) {
      res.status(400).json({ error: "unknown_district" });
      return;
    }
    bridgeGraphMeta = { startDistrictId: id };
  }
  persistWorkspace();
  broadcastToWeb({ type: "bridge-graph.updated", startDistrictId: bridgeGraphMeta.startDistrictId });
  log("BRIDGE", `start district set to ${bridgeGraphMeta.startDistrictId ?? "none"}`);
  res.json({ bridgeGraphMeta });
});

/** Set this district as bridge pipeline start and run all tasks in reachable one_way districts (not done), bridge ordering + upstream context. */
app.post("/api/bridge-graph/run", requireAuth, asyncHandler(async (req, res) => {
  const raw = req.body?.districtId;
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    res.status(400).json({ error: "districtId is required" });
    return;
  }
  const id = String(raw).trim();
  if (!allDistricts.has(id)) {
    res.status(400).json({ error: "unknown_district" });
    return;
  }
  bridgeGraphMeta = { startDistrictId: id };
  persistWorkspace();
  broadcastToWeb({ type: "bridge-graph.updated", startDistrictId: bridgeGraphMeta.startDistrictId });
  const reachable = reachableDistrictsFromStart(id, districtBridges.values());
  const pipelineTasks = collectPipelineTasks(allTasks.values(), reachable, UNASSIGNED_DISTRICT_ID);
  log(
    "BRIDGE",
    `run pipeline from district ${id}: ${pipelineTasks.length} task(s) in reachable graph (one_way, not done)`,
  );
  await runApprovedJobsAndRespond(res, pipelineTasks, {
    auditSource: "bridge-pipeline",
    savePipelineHistory: { startDistrictId: id },
  });
}));

/** Persisted bridge pipeline runs (newest first). */
app.get("/api/bridge-pipeline/history", requireAuth, (_req, res) => {
  res.json({ runs: workspaceStore.loadPipelineRuns() });
});

app.get("/api/bridge-pipeline/history/:runId", requireAuth, (req, res) => {
  const runs = workspaceStore.loadPipelineRuns();
  const found = runs.find((r) => r.id === req.params.runId);
  if (!found) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ run: found });
});

/**
 * Tasks in upstream districts (one_way reverse from `districtId`) for {{bridgeOut:taskId}} insertion in the editor.
 */
app.get("/api/bridge-graph/upstream-tasks", requireAuth, (req, res) => {
  const raw = req.query.districtId;
  if (typeof raw !== "string" || !raw.trim()) {
    res.status(400).json({ error: "districtId is required" });
    return;
  }
  const districtId = raw.trim();
  if (!allDistricts.has(districtId)) {
    res.status(400).json({ error: "unknown_district" });
    return;
  }
  const upstream = upstreamDistrictsOneWay(districtId, districtBridges.values());
  const beeById = new Map((latestTeamPlan?.bees ?? []).map((b) => [b.id, b] as const));
  const items: {
    taskId: string;
    title: string;
    districtId: string;
    districtTitle: string;
    beeId: string;
    beeName: string;
  }[] = [];
  for (const t of allTasks.values()) {
    const d = String(t.districtId ?? "").trim() || UNASSIGNED_DISTRICT_ID;
    if (!upstream.has(d)) continue;
    const pid = String(t.personaId ?? t.bee ?? "").trim();
    const bee = pid ? beeById.get(pid) : undefined;
    items.push({
      taskId: t.id,
      title: t.title,
      districtId: d,
      districtTitle: allDistricts.get(d)?.title ?? d,
      beeId: pid,
      beeName: bee?.name ? `${bee.name}` : pid,
    });
  }
  items.sort((a, b) => a.districtId.localeCompare(b.districtId) || a.title.localeCompare(b.title) || a.taskId.localeCompare(b.taskId));
  res.json({ tasks: items });
});

/**
 * Upstream districts (one_way reverse) with bees + tasks per district — for new-task wizard / persona references.
 */
app.get("/api/bridge-graph/upstream-overview", requireAuth, (req, res) => {
  const raw = req.query.districtId;
  if (typeof raw !== "string" || !raw.trim()) {
    res.status(400).json({ error: "districtId is required" });
    return;
  }
  const districtId = raw.trim();
  if (!allDistricts.has(districtId)) {
    res.status(400).json({ error: "unknown_district" });
    return;
  }
  const upstream = upstreamDistrictsOneWay(districtId, districtBridges.values());
  const beeById = new Map((latestTeamPlan?.bees ?? []).map((b) => [b.id, b] as const));
  const sortedIds = [...upstream].sort((a, b) => a.localeCompare(b));

  const districts = sortedIds.map((did) => {
    const dmeta = allDistricts.get(did);
    const bees = districtBeesForApi(did).map((b) => ({
      id: b.id,
      name: b.name,
      role: b.role,
    }));
    const tasks: { taskId: string; title: string; beeId: string; beeName: string }[] = [];
    for (const t of allTasks.values()) {
      const td = String(t.districtId ?? "").trim() || UNASSIGNED_DISTRICT_ID;
      if (td !== did) continue;
      const pid = String(t.personaId ?? t.bee ?? "").trim();
      const bee = pid ? beeById.get(pid) : undefined;
      tasks.push({
        taskId: t.id,
        title: t.title,
        beeId: pid,
        beeName: bee?.name ?? pid,
      });
    }
    tasks.sort((a, b) => a.title.localeCompare(b.title) || a.taskId.localeCompare(b.taskId));
    return {
      districtId: did,
      districtTitle: dmeta?.title ?? did,
      bees,
      tasks,
    };
  });

  res.json({ districts });
});

app.get("/api/districts", requireAuth, (_req, res) => {
  const knownIds = new Set(allDistricts.keys());
  function effectiveDistrictId(task: BeeTask): string {
    const tid = task.districtId?.trim();
    if (tid && knownIds.has(tid)) return tid;
    return UNASSIGNED_DISTRICT_ID;
  }

  const counts = new Map<string, { taskCount: number; beeCount: number }>();
  for (const d of allDistricts.values()) {
    counts.set(d.id, { taskCount: 0, beeCount: 0 });
  }
  for (const task of allTasks.values()) {
    const eid = effectiveDistrictId(task);
    if (!counts.has(eid)) counts.set(eid, { taskCount: 0, beeCount: 0 });
    const slot = counts.get(eid)!;
    slot.taskCount++;
    if (task.personaId || task.bee) slot.beeCount++;
  }

  const result = [...allDistricts.values()].map((d) => {
    const c = counts.get(d.id) ?? { taskCount: 0, beeCount: 0 };
    return {
      id: d.id,
      title: d.title,
      objective: d.objective,
      taskCount: c.taskCount,
      status: d.status,
      beeCount: c.beeCount,
      cityId: d.cityId,
      waggle: d.waggle,
      bridgeLayout: d.bridgeLayout,
      useUpstreamBridgeContext: d.useUpstreamBridgeContext,
    };
  });

  if (!allDistricts.has(UNASSIGNED_DISTRICT_ID)) {
    const u = counts.get(UNASSIGNED_DISTRICT_ID);
    if (u && u.taskCount > 0) {
      result.push({
        id: UNASSIGNED_DISTRICT_ID,
        title: "Unassigned Tasks",
        objective: "",
        taskCount: u.taskCount,
        status: "active",
        beeCount: u.beeCount,
        cityId: latestTeamPlan?.id ?? "",
        waggle: undefined,
        bridgeLayout: undefined,
        useUpstreamBridgeContext: undefined,
      });
    }
  }

  res.json({ districts: result });
});

// ─── District CRUD ───

function recomputeDistrictBeeRosterIds(districtId: string): string[] {
  const ids = new Set<string>();
  const district = allDistricts.get(districtId);
  for (const id of district?.beeRosterIds ?? []) ids.add(id);
  for (const t of allTasks.values()) {
    if (t.districtId !== districtId) continue;
    const pid = t.personaId || t.bee;
    if (pid) ids.add(pid);
  }
  for (const b of latestTeamPlan?.bees ?? []) {
    if (!b.scopedTaskId) continue;
    const t = allTasks.get(b.scopedTaskId);
    if (t?.districtId === districtId) ids.add(b.id);
  }
  return [...ids];
}

function districtBeesForApi(districtId: string, forTaskId?: string): BeePersona[] {
  const district = allDistricts.get(districtId);
  if (!district) return [];
  const byId = new Map((latestTeamPlan?.bees ?? []).map((b) => [b.id, b]));

  if (forTaskId) {
    const task = allTasks.get(forTaskId);
    if (!task || task.districtId !== districtId) return [];
    const ordered: BeePersona[] = [];
    const seen = new Set<string>();
    for (const b of latestTeamPlan?.bees ?? []) {
      if (b.scopedTaskId === forTaskId && byId.has(b.id) && !seen.has(b.id)) {
        ordered.push(b);
        seen.add(b.id);
      }
    }
    const pid = task.personaId || task.bee;
    if (pid && !seen.has(pid)) {
      const b = byId.get(pid);
      // Always surface this task's persona row; stale scopedTaskId on the bee must not hide it (chat/setup_plan bees often omit scopedTaskId).
      if (b) {
        ordered.push(b);
        seen.add(pid);
      }
    }
    return ordered;
  }

  const ordered: BeePersona[] = [];
  const seen = new Set<string>();
  for (const id of district.beeRosterIds ?? []) {
    const b = byId.get(id);
    if (b) {
      ordered.push(b);
      seen.add(id);
    }
  }
  for (const t of allTasks.values()) {
    if (t.districtId !== districtId) continue;
    const pid = t.personaId || t.bee;
    if (pid && !seen.has(pid)) {
      const b = byId.get(pid);
      if (b) {
        ordered.push(b);
        seen.add(pid);
      }
    }
  }
  for (const b of latestTeamPlan?.bees ?? []) {
    if (!b.scopedTaskId) continue;
    const t = allTasks.get(b.scopedTaskId);
    if (t?.districtId === districtId && !seen.has(b.id)) {
      ordered.push(b);
      seen.add(b.id);
    }
  }
  return ordered;
}

app.post("/api/districts", requireAuth, (req, res) => {
  const title = String(req.body.title ?? "New District");
  const objective = String(req.body.objective ?? "");
  const id = `district-${randomUUID().slice(0, 8)}`;
  const cityId = latestTeamPlan?.id ?? `city-${randomUUID().slice(0, 8)}`;
  const waggle = req.body.waggle ?? undefined;
  const useUpstreamBridgeContext =
    req.body.useUpstreamBridgeContext === undefined ? undefined : Boolean(req.body.useUpstreamBridgeContext);
  const district: BeeDistrict = {
    id,
    cityId,
    status: "active",
    title,
    objective,
    waggle,
    ...(useUpstreamBridgeContext !== undefined ? { useUpstreamBridgeContext } : {}),
  };
  allDistricts.set(id, district);
  graphStore.addNode("district", id, title, { objective, status: "active", cityId });
  persistWorkspace();
  broadcastToWeb({ type: "districts.updated" });
  log("DISTRICT", `created district ${id}: "${title}"`);
  res.status(201).json({ district });
});

app.get("/api/districts/:districtId", requireAuth, (req, res) => {
  const district = allDistricts.get(req.params.districtId);
  if (!district) return res.status(404).json({ error: "District not found" });
  const tasks = [...allTasks.values()].filter((t) => t.districtId === district.id);
  const bridges = [...districtBridges.values()].filter((b) => b.fromDistrictId === district.id || b.toDistrictId === district.id);
  const graphNode = graphStore.getNode(district.id);
  const neighborNodes = graphStore.neighbors(district.id);

  const taskResults = tasks.map((t) => {
    const conv = jobStore.get(t.id);
    const lastEntry = conv?.entries.filter((e) => e.action === "done" || e.action === "error").pop();
    return {
      taskId: t.id,
      title: t.title,
      bee: t.bee,
      status: conv?.status ?? t.status,
      output: lastEntry?.content ?? null,
      finishedAt: conv?.finishedAt ?? null,
    };
  });

  const doneCount = taskResults.filter((r) => r.status === "done").length;
  const failedCount = taskResults.filter((r) => r.status === "failed").length;

  const taskIdQ = req.query.taskId;
  const forTask =
    typeof taskIdQ === "string" && taskIdQ.trim() ? taskIdQ.trim() : undefined;

  res.json({
    district,
    bees: districtBeesForApi(district.id, forTask),
    tasks,
    taskResults,
    summary: { total: tasks.length, done: doneCount, failed: failedCount, pending: tasks.length - doneCount - failedCount },
    bridges,
    graph: { node: graphNode, neighbors: neighborNodes },
  });
});

app.put("/api/districts/:districtId/bees", requireAuth, (req, res) => {
  const districtId = req.params.districtId;
  const district = allDistricts.get(districtId);
  if (!district) {
    res.status(404).json({ error: "District not found" });
    return;
  }
  const raw = req.body.bees;
  if (!Array.isArray(raw)) {
    res.status(400).json({ error: "bees must be an array" });
    return;
  }

  const taskIdRaw = req.body.taskId;
  const scopedTaskId =
    typeof taskIdRaw === "string" && taskIdRaw.trim() ? taskIdRaw.trim() : undefined;

  const normalizePersona = (b: unknown, idx: number, scope?: string): BeePersona => {
    const o = b as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id.trim() ? o.id.trim() : `bee-${randomUUID().slice(0, 8)}`;
    const ft = o.flowerType === "api" || o.flowerType === "browser" || o.flowerType === "code" ? o.flowerType : "browser";
    const st =
      typeof o.scopedTaskId === "string" && o.scopedTaskId.trim()
        ? o.scopedTaskId.trim()
        : scope;
    const intentSignature =
      typeof o.intentSignature === "string" && o.intentSignature.trim() ? o.intentSignature.trim() : undefined;
    const parentBeeId =
      typeof o.parentBeeId === "string" && o.parentBeeId.trim() ? o.parentBeeId.trim() : undefined;
    const lineageKindRaw =
      typeof o.lineageKind === "string" && o.lineageKind.trim() ? o.lineageKind.trim() : undefined;
    const lineageKind =
      lineageKindRaw === "anchor" || lineageKindRaw === "worker" || lineageKindRaw === "child"
        ? lineageKindRaw
        : undefined;
    return {
      id,
      name: String(o.name ?? `Bee ${idx + 1}`),
      role: String(o.role ?? "worker"),
      systemPrompt: String(o.systemPrompt ?? ""),
      providerId: String(o.providerId ?? "openai"),
      model: String(o.model ?? ""),
      flowerType: ft as FlowerType,
      ...(st ? { scopedTaskId: st } : {}),
      ...(intentSignature ? { intentSignature } : {}),
      ...(parentBeeId ? { parentBeeId } : {}),
      ...(lineageKind ? { lineageKind } : {}),
    };
  };

  if (!latestTeamPlan) {
    latestTeamPlan = {
      id: district.cityId,
      goal: "",
      bees: [],
      districts: [...allDistricts.values()],
      tasks: [...allTasks.values()],
    };
  }

  let incoming: BeePersona[];
  if (scopedTaskId) {
    const task = allTasks.get(scopedTaskId);
    if (!task || task.districtId !== districtId) {
      res.status(400).json({ error: "Invalid taskId for this district" });
      return;
    }
    const pid = task.personaId || task.bee;
    const prevBees = (latestTeamPlan.bees ?? []).filter((b) => {
      if (b.scopedTaskId === scopedTaskId) return false;
      if (!b.scopedTaskId && pid && b.id === pid) return false;
      return true;
    });
    incoming = raw.map((row, i) => normalizePersona(row, i, scopedTaskId));
    const merged = new Map(prevBees.map((b) => [b.id, b]));
    for (const b of incoming) merged.set(b.id, b);
    latestTeamPlan.bees = [...merged.values()];
    if (incoming.length > 0) {
      task.personaId = incoming[0].id;
      task.bee = incoming[0].id;
      allTasks.set(scopedTaskId, task);
    }
  } else {
    incoming = raw.map((row, i) => normalizePersona(row, i));
    const merged = new Map((latestTeamPlan.bees ?? []).map((b) => [b.id, b]));
    for (const b of incoming) merged.set(b.id, b);
    latestTeamPlan.bees = [...merged.values()];
  }

  district.beeRosterIds = recomputeDistrictBeeRosterIds(districtId);
  allDistricts.set(districtId, district);
  const dIdx = latestTeamPlan.districts.findIndex((d) => d.id === districtId);
  if (dIdx >= 0) latestTeamPlan.districts[dIdx] = district;
  else latestTeamPlan.districts = [...latestTeamPlan.districts, district];

  persistWorkspace();
  broadcastToWeb({ type: "districts.updated" });
  log(
    "DISTRICT",
    scopedTaskId
      ? `updated bees for district ${districtId} task ${scopedTaskId}: ${incoming.length} bees`
      : `updated bee roster for ${districtId}: ${incoming.length} bees`,
  );
  auditLog.record({
    type: "district.bees.updated",
    payload: { districtId, beeCount: incoming.length, taskId: scopedTaskId },
  });
  res.json({ bees: districtBeesForApi(districtId, scopedTaskId) });
});

app.put("/api/districts/:districtId", requireAuth, (req, res) => {
  const district = allDistricts.get(req.params.districtId);
  if (!district) return res.status(404).json({ error: "District not found" });
  if (req.body.title !== undefined) district.title = String(req.body.title);
  if (req.body.objective !== undefined) district.objective = String(req.body.objective);
  if (req.body.status !== undefined) district.status = String(req.body.status) as DistrictStatus;
  if (req.body.waggle !== undefined) district.waggle = req.body.waggle;
  if (req.body.bridgeLayout !== undefined) {
    const bl = req.body.bridgeLayout;
    if (bl === null) {
      delete district.bridgeLayout;
    } else if (
      typeof bl === "object" &&
      bl !== null &&
      typeof bl.x === "number" &&
      Number.isFinite(bl.x) &&
      typeof bl.y === "number" &&
      Number.isFinite(bl.y)
    ) {
      district.bridgeLayout = { x: bl.x, y: bl.y };
    }
  }
  if (req.body.useUpstreamBridgeContext !== undefined) {
    if (req.body.useUpstreamBridgeContext === null) {
      delete district.useUpstreamBridgeContext;
    } else {
      district.useUpstreamBridgeContext = Boolean(req.body.useUpstreamBridgeContext);
    }
  }
  allDistricts.set(district.id, district);
  graphStore.updateNode(district.id, { label: district.title, data: { objective: district.objective, status: district.status } });
  if (latestTeamPlan) {
    const idx = latestTeamPlan.districts.findIndex((d) => d.id === district.id);
    if (idx >= 0) latestTeamPlan.districts[idx] = district;
  }
  persistWorkspace();
  broadcastToWeb({ type: "districts.updated" });
  log("DISTRICT", `updated district ${district.id}: "${district.title}"`);
  res.json({ district });
});

app.put("/api/districts/:districtId/task-graph", requireAuth, (req, res) => {
  const districtId = req.params.districtId;
  if (!allDistricts.has(districtId)) return res.status(404).json({ error: "District not found" });

  const edges: Array<{ from: string; to: string }> = Array.isArray(req.body.edges) ? req.body.edges : [];

  const districtTaskIds = new Set<string>();
  for (const t of allTasks.values()) {
    if (t.districtId === districtId) districtTaskIds.add(t.id);
  }

  for (const e of edges) {
    if (!districtTaskIds.has(String(e.from)) || !districtTaskIds.has(String(e.to))) {
      return res.status(400).json({ error: "edge_invalid", message: `Edge ${e.from} → ${e.to} references task(s) outside this district.` });
    }
  }

  const depMap = new Map<string, string[]>();
  for (const e of edges) {
    const to = String(e.to);
    const list = depMap.get(to) ?? [];
    list.push(String(e.from));
    depMap.set(to, list);
  }

  for (const id of districtTaskIds) {
    const task = allTasks.get(id);
    if (!task) continue;
    const deps = depMap.get(id);
    task.dependsOn = deps && deps.length > 0 ? deps : undefined;
  }

  const districtTasks = [...allTasks.values()].filter((t) => t.districtId === districtId);
  const waves = buildExecutionWaves(districtTasks);
  if (!waves) {
    for (const id of districtTaskIds) {
      const task = allTasks.get(id);
      if (task) task.dependsOn = undefined;
    }
    return res.status(400).json({ error: "cycle_detected", message: "The task graph contains a cycle." });
  }

  persistWorkspace();
  broadcastToWeb({ type: "districts.updated" });
  log("DISTRICT", `updated task graph for district ${districtId}: ${edges.length} edges, ${waves.length} waves`);
  auditLog.record({ type: "bee.task-graph.updated", payload: { districtId, edgeCount: edges.length } });
  res.json({ edges, waves: waves.map((w) => w.map((t) => t.id)) });
});

app.delete("/api/districts/:districtId", requireAuth, (req, res) => {
  const districtId = req.params.districtId;
  if (!allDistricts.has(districtId)) return res.status(404).json({ error: "District not found" });

  const taskIds = new Set<string>();
  for (const t of allTasks.values()) {
    if (t.districtId === districtId) taskIds.add(t.id);
  }
  for (const t of approvalGate.listPending()) {
    if (t.districtId === districtId) taskIds.add(t.id);
  }
  for (const t of approvalGate.listApproved()) {
    if (t.districtId === districtId) taskIds.add(t.id);
  }
  for (const taskId of taskIds) {
    purgeTaskById(taskId);
    auditLog.record({ type: "bee.task.deleted", payload: { taskId, reason: "district_deleted", districtId } });
  }

  allDistricts.delete(districtId);
  graphStore.removeNode(districtId);
  for (const [id, bridge] of districtBridges.entries()) {
    if (bridge.fromDistrictId === districtId || bridge.toDistrictId === districtId) districtBridges.delete(id);
  }
  if (latestTeamPlan) {
    latestTeamPlan.districts = latestTeamPlan.districts.filter((d) => d.id !== districtId);
  }
  persistWorkspace();
  broadcastToWeb({ type: "districts.updated" });
  auditLog.record({ type: "district.deleted", payload: { districtId, removedTaskCount: taskIds.size } });
  log("DISTRICT", `deleted district ${districtId} and ${taskIds.size} task(s)`);
  res.json({ ok: true, removedTaskIds: [...taskIds] });
});

// ─── Graph API ───

app.get("/api/graph", requireAuth, (_req, res) => {
  res.json(graphStore.toJSON());
});

app.get("/api/graph/summary", requireAuth, (_req, res) => {
  res.json({ summary: graphStore.summarize() });
});

/** Injected into /api/chat so the model can answer Flower, relay, and settings questions factually. */
function buildChatRuntimeContextForPrompt(): string {
  const lines: string[] = [];

  const liveIds = [...connectedFlowers.keys()];
  const openSockets = liveIds.filter((id) => connectedFlowers.get(id)?.readyState === 1);
  const configs = flowerConfigStore.getAll();
  const anyChromeFlowerWsOpen = openSockets.length > 0;
  const cdpExt = cdpRelay.isExtensionConnected();

  const chromeRows = configs.filter((f) => f.type === "chrome_extension");
  const enabledChrome = chromeRows.filter((f) => f.enabled);
  const liveChrome = enabledChrome.length > 0 && anyChromeFlowerWsOpen;

  lines.push(
    "=== Runtime & integration status (authoritative for Flower, CDP relay, workspace, PM settings) ===",
  );
  lines.push(
    "FLOWER_QUICK_ANSWER (use this for questions like «Flower connected?», «extension connected?» — NOT from graph):",
  );
  lines.push(
    `  gateway_flower_websocket_open: ${openSockets.length} session(s) open → ${openSockets.length > 0 ? "YES" : "NO"}`,
  );
  lines.push(
    `  chrome_extension_flower_live (enabled config + open WS): ${liveChrome ? "YES" : "NO"}`,
  );
  lines.push(`  cdp_relay_extension_attached: ${cdpExt ? "YES" : "NO"}`);
  lines.push(
    `  hint: Gateway Flower WS ${openSockets.length > 0 ? "open" : "none"}, CDP relay ${cdpExt ? "extension attached" : "extension not attached"}`,
  );
  lines.push("");

  lines.push(`Gateway HTTP port: ${PORT}`);
  try {
    lines.push(`Workspace path: ${wsConfig.workspacePath}`);
  } catch {
    lines.push("Workspace path: (unavailable)");
  }
  const sandbox = sandboxStatus();
  lines.push(
    `Code sandbox: ${sandbox.enabled ? `docker image=${sandbox.image} network=${sandbox.network} readOnlyRoot=${sandbox.readOnlyRoot}` : "off"}`,
  );

  const policy = pmSettings.getModelPolicy();
  const active = pmSettings.getActiveProfile();
  const profiles = pmSettings.listProfiles();
  lines.push(
    `Default model policy: provider=${policy.defaultProviderId ?? "-"}, model=${policy.defaultModel ?? "-"}`,
  );
  if (active) {
    lines.push(
      `Active auth profile: id=${active.id}, provider=${active.providerId}, mode=${active.mode}`,
    );
  } else {
    lines.push("Active auth profile: none");
  }
  lines.push(`Stored auth profiles (count): ${profiles.length}`);

  lines.push(
    `Flower WebSocket sessions on gateway: ${openSockets.length} open / ${liveIds.length} tracked`,
  );
  for (const id of liveIds) {
    const ws = connectedFlowers.get(id);
    lines.push(`  - ${id}: ${ws?.readyState === 1 ? "OPEN" : "closed"}`);
  }

  lines.push(`Flower config rows: ${configs.length}`);
  const discordMgr = discordFlowerManagerRef.current;
  for (const f of configs) {
    const live =
      f.enabled && f.type === "chrome_extension"
        ? anyChromeFlowerWsOpen
        : f.enabled && f.type === "discord_bot"
          ? (discordMgr?.isFlowerConnected(f.id) ?? false)
          : false;
    lines.push(
      `  - ${f.id}: "${f.name}" type=${f.type} enabled=${f.enabled} appearsLiveConnected=${live}`,
    );
  }

  lines.push(
    `CDP relay (chrome.debugger ↔ gateway): ws 127.0.0.1:${CDP_RELAY_PORT} extensionAttached=${cdpRelay.isExtensionConnected()} attachedTabId=${cdpRelay.getAttachedTabId() ?? "none"}`,
  );

  lines.push(`Pending bee job approvals: ${approvalGate.listPending().length}`);
  lines.push(discordFlowerManagerRef.current?.getRuntimeSummary() ?? "discord_flower_bots_ready: 0");
  lines.push("=== End runtime snapshot ===");

  return lines.join("\n");
}

function buildBridgesContextForPrompt(): string {
  const bridges = [...districtBridges.values()];
  const lines = ["=== District bridges (district ↔ district; NOT Flower/WebSocket) ==="];
  if (bridges.length === 0) {
    lines.push("(none configured)");
  } else {
    for (const b of bridges) {
      lines.push(
        `- ${b.id}: "${b.label}" | ${b.fromDistrictId} → ${b.toDistrictId} | status=${b.status} direction=${b.direction}`,
      );
    }
  }
  lines.push("=== End district bridges ===");
  return lines.join("\n");
}

function buildJobsApprovalsContextForPrompt(): string {
  const pending = approvalGate.listPending();
  const lines = [
    "=== Jobs & approvals ===",
    `Total tasks (allTasks): ${allTasks.size}`,
    `Pending bee approvals: ${pending.length}`,
  ];
  for (const t of pending.slice(0, 25)) {
    lines.push(
      `  - ${t.id}: ${String(t.title ?? "").slice(0, 120)} status=${t.status}`,
    );
  }
  if (pending.length > 25) lines.push(`  ... +${pending.length - 25} more`);
  lines.push("=== End jobs ===");
  return lines.join("\n");
}

// ─── Chat action tool wiring ───

function chatActionDeps(): ChatActionDeps {
  return {
    resolveRuntimeContext,
    getLatestTeamPlan: () => latestTeamPlan,
    setLatestTeamPlan: (p) => {
      latestTeamPlan = p;
    },
    getBridgeGraphMeta: () => bridgeGraphMeta,
    setBridgeGraphMeta: (m) => {
      bridgeGraphMeta = m;
    },
    allDistricts,
    allTasks,
    districtBridges,
    taskSchedules,
    approvalGate,
    syncGraph,
    persistWorkspace,
    broadcastToWeb,
    auditLog,
    log,
    runAutoApprovedChatTasks: scheduleAutoRunFromChat,
  };
}

function executeChatTool(name: string, args: Record<string, unknown>): string {
  return runChatTool(name, args, chatActionDeps());
}

const runChatMessageDeps: RunChatMessageDeps = {
  pmSettings,
  graphStore,
  buildRuntimeSnapshot: buildChatRuntimeContextForPrompt,
  buildBridgesBlock: buildBridgesContextForPrompt,
  buildJobsBlock: buildJobsApprovalsContextForPrompt,
  executeChatTool,
  aiHistory,
  log,
};

// ─── Chat API ───

app.post("/api/chat", requireAuth, asyncHandler(async (req, res) => {
  const result = await runChatMessage({
    userMessage: String(req.body.message ?? ""),
    history: req.body.history,
    deps: runChatMessageDeps,
  });
  if (!result.ok) {
    if (result.code === "empty_message") return res.status(400).json({ error: result.error });
    if (result.code === "no_profile") return res.status(400).json({ error: result.error });
    return res.status(500).json({ error: result.error });
  }
  res.json({
    reply: result.reply,
    ...(result.actions && result.actions.length > 0 ? { actions: result.actions } : {}),
    ...(result.actionDetails && result.actionDetails.length > 0 ? { actionDetails: result.actionDetails } : {}),
  });
}));

// ─── Chain Store ───
app.get("/api/chain/stats", requireAuth, (_req, res) => {
  const stats = chainStore.stats();
  log("CHAIN", `stats: ${stats.totalNodes} nodes, ${stats.totalEntries} entries, hitRate=${(stats.hitRate * 100).toFixed(1)}%, tokensSaved=${stats.tokensSaved}`);
  res.json(stats);
});

app.get("/api/chain", requireAuth, (_req, res) => {
  const nodes = chainStore.allNodes();
  log("CHAIN", `listing ${nodes.length} chain nodes`);
  res.json({ nodes });
});

app.delete("/api/chain", requireAuth, (_req, res) => {
  chainStore.clear();
  log("CHAIN", "chain store cleared");
  res.json({ ok: true });
});

app.get("/api/chain/domains", requireAuth, (_req, res) => {
  const nodes = chainStore.allNodes();
  const domainMap = new Map<string, { domain: string; intents: { intent: string; description: string; entryCount: number; bestScore: number; bestPattern: string[] }[] }>();
  for (const node of nodes) {
    if (node.entries.length === 0) continue;
    let group = domainMap.get(node.key.domain);
    if (!group) {
      group = { domain: node.key.domain, intents: [] };
      domainMap.set(node.key.domain, group);
    }
    group.intents.push({
      intent: node.key.intent,
      description: node.description,
      entryCount: node.entries.length,
      bestScore: node.entries[0].score,
      bestPattern: node.entries[0].pattern,
    });
  }
  for (const group of domainMap.values()) {
    group.intents.sort((a, b) => b.bestScore - a.bestScore);
  }
  log("CHAIN", `domains: ${domainMap.size} domains`);
  res.json({ domains: [...domainMap.values()] });
});

app.delete("/api/chain/:domain", requireAuth, (req, res) => {
  const domain = req.params.domain;
  chainStore.invalidateDomain(domain);
  log("CHAIN", `invalidated all chains for domain: ${domain}`);
  res.json({ ok: true, domain });
});

// ─── AI History ───
app.get("/api/ai-history", requireAuth, (_req, res) => {
  const entries = aiHistory.list();
  const stats = aiHistory.stats();
  log("AI_HISTORY", `returning ${entries.length} entries, ${stats.totalTokens} total tokens`);
  res.json({ entries, stats });
});

app.post("/api/ai-history", requireAuth, (req, res) => {
  const entry: AiHistoryEntry = {
    id: req.body.id ?? `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: req.body.timestamp ?? new Date().toISOString(),
    provider: String(req.body.provider ?? "unknown"),
    model: String(req.body.model ?? "unknown"),
    jobId: req.body.jobId ? String(req.body.jobId) : undefined,
    beeId: req.body.beeId ? String(req.body.beeId) : undefined,
    action: String(req.body.action ?? "chat"),
    inputTokens: Number(req.body.inputTokens ?? 0),
    outputTokens: Number(req.body.outputTokens ?? 0),
    totalTokens: Number(req.body.totalTokens ?? (Number(req.body.inputTokens ?? 0) + Number(req.body.outputTokens ?? 0))),
    durationMs: Number(req.body.durationMs ?? 0),
    promptPreview: String(req.body.promptPreview ?? "").slice(0, 200),
    responsePreview: String(req.body.responsePreview ?? "").slice(0, 200),
    status: req.body.status === "error" ? "error" : "success",
    error: req.body.error ? String(req.body.error) : undefined,
  };
  aiHistory.record(entry);
  broadcastToWeb({ type: "ai.history.new", entry });
  log("AI_HISTORY", `recorded: ${entry.provider}/${entry.model} ${entry.inputTokens}+${entry.outputTokens} tokens ${entry.durationMs}ms`);
  res.status(201).json({ entry });
});

/** Set after `listen` / `WebSocketServer` construction so restart can close them. */
let gatewayHttpServer: import("node:http").Server | undefined;
let gatewayWss: InstanceType<typeof WebSocketServer> | undefined;

app.post("/api/admin/restart", requireAuth, (_req, res) => {
  log("SERVER", "restart requested via API — persisting and exiting");
  try {
    persistWorkspace();
  } catch {
    // best-effort; still try to exit
  }
  chainStore.flush();
  aiHistory.flush();
  res.status(202).json({
    ok: true,
    message:
      "Gateway process is stopping. If you use beebridge gateway start, npm run start:gateway, or a process manager with restart, start it again when it does not come back automatically.",
  });
  setImmediate(() => {
    cdpRelay.stop();
    const wss = gatewayWss;
    const srv = gatewayHttpServer;
    if (wss && srv) {
      wss.close(() => {
        srv.close(() => {
          process.exit(0);
        });
      });
    } else {
      process.exit(0);
    }
  });
});

app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const stack = err.stack?.split("\n").slice(0, 8).join("\n") ?? "";
  log("ERROR", `${req.method} ${req.path} → ${err.message}${stack ? `\n${stack}` : ""}`);
  res.status(500).json({ error: "internal_server_error" });
});

if (GATEWAY_PERF_LOG) perfLog("phase: creating DiscordFlowerManager + sync()");
const _tDiscordSync = performance.now();
discordFlowerManagerRef.current = new DiscordFlowerManager({
  getConfigs: () => flowerConfigStore.getAll(),
  chatDeps: runChatMessageDeps,
  log,
});
void discordFlowerManagerRef.current
  .sync()
  .then(() => {
    if (GATEWAY_PERF_LOG) perfLog("phase: DiscordFlowerManager.sync", `done in ${(performance.now() - _tDiscordSync).toFixed(1)}ms`);
  })
  .catch((e) => log("DISCORD", `initial sync: ${String(e)}`));

if (GATEWAY_PERF_LOG) perfLog("phase: app.listen", "scheduling HTTP bind…");
const _tListen = performance.now();
const server = app.listen(PORT, () => {
  if (GATEWAY_PERF_LOG) perfLog("phase: app.listen callback", `port bound after ${(performance.now() - _tListen).toFixed(1)}ms from listen()`);
  log("SERVER", `beebridge gateway listening on :${PORT}`);
  log("SERVER", `auth mode: ${authConfig.mode}`);
  if (authConfig.mode === "token" && authConfig.token) {
    log("SERVER", `gateway token: ${maskSecret(authConfig.token)}`);
    log("SERVER", `  file: ${BEEGATEWAY_TOKEN_FILE}`);
    log("SERVER", `  paste this into the Chrome extension popup and Settings → Connection if needed.`);
  }
  const _tCdp = performance.now();
  cdpRelay.start(CDP_RELAY_PORT);
  if (GATEWAY_PERF_LOG) perfLog("phase: cdpRelay.start", `done in ${(performance.now() - _tCdp).toFixed(1)}ms`);
  log(
    "SERVER",
    `CDP relay (Flower DevTools) on 127.0.0.1:${CDP_RELAY_PORT}`,
  );
  startInternalScheduler();
});
gatewayHttpServer = server;

const wss = new WebSocketServer({ server, path: "/ws" });
gatewayWss = wss;
wss.on("connection", (socket, req) => {
  const context = resolveWsAuthContext(req, authConfig);
  if (!context.authenticated) {
    log("WS", `connection rejected: ${context.reason} from=${req.socket.remoteAddress ?? "?"} url=${req.url ?? "?"}`);
    socket.send(JSON.stringify({ type: "error", reason: "unauthorized" }));
    socket.close();
    return;
  }

  let clientType: "flower" | "web" | "unknown" = "unknown";
  let registeredFlowerId: string | null = null;

  log("WS", `client connected: ${context.clientId}`);
  if (GATEWAY_PERF_LOG) perfLog("WS_CONNECT", `${context.clientId} from ${req.socket.remoteAddress ?? "?"}`);
  socket.send(JSON.stringify({ type: "ready", clientId: context.clientId }));

  socket.on("message", (raw) => {
    if (GATEWAY_PERF_LOG) {
      perfWsMsgInWindow += 1;
      const now = Date.now();
      if (now - perfWsWindowStart >= 10_000) {
        if (perfWsMsgInWindow >= 120) {
          perfLog(
            "WS_MSG_RATE",
            `${perfWsMsgInWindow} inbound /ws messages in ${now - perfWsWindowStart}ms — possible Flower or web client reconnect storm`,
          );
        }
        perfWsMsgInWindow = 0;
        perfWsWindowStart = now;
      }
    }
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const msgType = String(msg.type ?? "");
    log("WS", `[${clientType}:${context.clientId}] ${msgType}`);

    if (msgType === "flower.register") {
      clientType = "flower";
      registeredFlowerId = String(msg.flowerId ?? context.clientId);
      const prevFlower = connectedFlowers.get(registeredFlowerId);
      if (prevFlower && prevFlower !== socket && prevFlower.readyState === 1) {
        prevFlower.close(1000, "replaced by new registration");
      }
      connectedFlowers.set(registeredFlowerId, socket as unknown as WsSocket);
      log("WS", `flower registered: ${registeredFlowerId}`);
      socket.send(JSON.stringify({ type: "flower.registered", flowerId: registeredFlowerId }));
      broadcastToWeb({ type: "flower.connected", flowerId: registeredFlowerId });
      return;
    }

    if (msgType === "web.register") {
      clientType = "web";
      webClients.add(socket as unknown as WsSocket);
      log("WS", `web client registered: ${context.clientId}`);
      socket.send(JSON.stringify({
        type: "web.registered",
        connectedFlowers: [...connectedFlowers.keys()],
        activeJobs: jobStore.listAll().filter((c) => c.status === "running").map((c) => c.jobId),
      }));
      return;
    }

    if (msgType === "task.progress") {
      const jobId = String(msg.jobId ?? "");
      const entry = msg.entry as ConversationEntry | undefined;
      if (jobId && entry) {
        jobStore.addEntry(jobId, entry);
      }
      if (msg.aiUsage && typeof msg.aiUsage === "object") {
        const u = msg.aiUsage as Record<string, unknown>;
        const historyEntry = {
          id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: new Date().toISOString(),
          provider: String(u.provider ?? "unknown"),
          model: String(u.model ?? "unknown"),
          jobId,
          beeId: String(msg.beeId ?? ""),
          action: String(u.action ?? "chat"),
          inputTokens: Number(u.inputTokens ?? 0),
          outputTokens: Number(u.outputTokens ?? 0),
          totalTokens: Number(u.inputTokens ?? 0) + Number(u.outputTokens ?? 0),
          durationMs: Number(u.durationMs ?? 0),
          promptPreview: String(u.promptPreview ?? "").slice(0, 200),
          responsePreview: String(u.responsePreview ?? "").slice(0, 200),
          status: (u.error ? "error" : "success") as "error" | "success",
          error: u.error ? String(u.error) : undefined,
        };
        aiHistory.record(historyEntry);
        log("AI_HISTORY", `recorded from flower: ${historyEntry.provider}/${historyEntry.model} ${historyEntry.durationMs}ms ${historyEntry.status}`);
        broadcastToWeb({ type: "ai.history.new", entry: historyEntry });
      }
      return;
    }

    if (msgType === "task.done") {
      const jobId = String(msg.jobId ?? "");
      const result = String(msg.result ?? "");
      log("WS", `task done: ${jobId}`);
      jobStore.complete(jobId, result);
      auditLog.record({ type: "bee.job.done", payload: { jobId, resultLength: result.length } });
      const pending = pendingJobs.get(jobId);
      if (pending) {
        pendingJobs.delete(jobId);
        pending.resolve({ taskId: jobId, status: "done", output: result });
      }
      persistWorkspace();
      return;
    }

    if (msgType === "task.failed") {
      const jobId = String(msg.jobId ?? "");
      const error = String(msg.error ?? "unknown");
      log("WS", `task failed: ${jobId} — ${error}`);
      jobStore.fail(jobId, error);
      auditLog.record({ type: "bee.job.failed", payload: { jobId, error } });
      const pending = pendingJobs.get(jobId);
      if (pending) {
        pendingJobs.delete(jobId);
        pending.resolve({ taskId: jobId, status: "failed", output: error });
      }
      persistWorkspace();
      return;
    }
  });

  socket.on("close", () => {
    log("WS", `client disconnected: ${context.clientId} (${clientType})`);
    if (clientType === "flower" && registeredFlowerId) {
      connectedFlowers.delete(registeredFlowerId);
      broadcastToWeb({ type: "flower.disconnected", flowerId: registeredFlowerId });
    }
    if (clientType === "web") {
      webClients.delete(socket as unknown as WsSocket);
    }
  });
});

function gracefulShutdown() {
  if (GATEWAY_PERF_LOG) perfLog("shutdown", "SIGTERM/SIGINT — gracefulShutdown");
  log("SERVER", "shutting down, flushing stores...");
  const killed = cleanupAllProcessManagers();
  if (killed > 0) log("SERVER", `killed ${killed} background child process(es)`);
  try {
    const cleaned = cleanupSandboxContainers({ includeProject: false });
    if (cleaned.removed.length > 0) log("SERVER", `removed ${cleaned.removed.length} task sandbox container(s)`);
    for (const err of cleaned.errors) log("SERVER", `sandbox cleanup failed: ${err}`);
  } catch (e) {
    log("SERVER", `sandbox cleanup failed: ${e}`);
  }
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  stopInternalScheduler();
  try { persistWorkspace(); } catch (e) { log("SERVER", `persistWorkspace failed: ${e}`); }
  try { graphStore.flushSync(); } catch (e) { log("SERVER", `graphStore.flushSync failed: ${e}`); }
  cdpRelay.stop();
  chainStore.flush();
  aiHistory.flush();
  process.exit(0);
}
process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);
