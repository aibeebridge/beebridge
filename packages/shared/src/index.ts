export type BeePriority = "low" | "medium" | "high";
export type BeeTaskStatus = "waiting" | "assigned" | "working" | "review" | "done";
export type ProviderAuthMode = "api_key" | "oauth";

export interface ProviderCatalogItem {
  id: string;
  label: string;
  authModes: ProviderAuthMode[];
  models: string[];
}

export interface PmAuthProfile {
  id: string;
  providerId: string;
  mode: ProviderAuthMode;
  secret: string;
  label?: string;
  active: boolean;
  createdAt: string;
}

export interface PmModelPolicy {
  defaultProviderId: string;
  defaultModel: string;
  allowedModels: string[];
  fallbackModel?: string;
}

export interface BeeAssignmentPolicy {
  defaultFlowerType: "web";
  providerToBee: Record<string, string>;
}

export interface PmSandboxSettings {
  mode: "off" | "docker";
}

export interface PmSettings {
  authProfiles: PmAuthProfile[];
  modelPolicy: PmModelPolicy;
  beePolicy: BeeAssignmentPolicy;
  sandbox: PmSandboxSettings;
}

export type DistrictStatus = "planning" | "active" | "completed";

export type WaggleMode = "off" | "browser" | "api";

export interface WaggleConfig {
  enabled: boolean;
  /**
   * `browser`: same Flower Chrome relay as normal tasks (navigate, snapshot, etc.), plus consulting the configured web AI
   * (e.g. ChatGPT) via waggle — worker model can stay cheap while hard parts are answered by that site. Not headless fetch.
   * `api`: direct HTTP to a provider API for the higher-tier model.
   */
  mode: WaggleMode;
  browserTargetUrl?: string;
  browserInputSelector?: string;
  apiProviderId?: string;
  apiModel?: string;
  apiKey?: string;
  /**
   * If true: worker may also call waggle proactively on analytically heavy steps (on top of mandatory planning/unblocking).
   * If false: same mandatory waggle loop for plan + errors; fewer extra proactive waggle calls.
   */
  autoDetect: boolean;
  /**
   * When true (default if omitted): if the task names a URL, the first agent step may use browser tools before the first waggle_ask.
   * When false: legacy behavior — first step is waggle_ask only until one supervisor reply succeeds.
   */
  allowBrowserBeforeFirstWaggle?: boolean;
}

/** Saved node position on the Bridges graph canvas (SVG coordinates). */
export interface DistrictBridgeLayout {
  x: number;
  y: number;
}

/** Global Bridges tab: single entry district for pipeline execution (one_way order). */
export interface BridgeGraphMeta {
  startDistrictId: string | null;
}

export interface BeeDistrict {
  id: string;
  title: string;
  objective: string;
  status: DistrictStatus;
  cityId: string;
  waggle?: WaggleConfig;
  /** Bee personas shown for this district (roster); persisted with district */
  beeRosterIds?: string[];
  /** Bridges graph editor: persisted node position */
  bridgeLayout?: DistrictBridgeLayout;
  /**
   * When false, bridge pipeline does not inject automatic upstream district context ({{bridgeOut:}} still works).
   * When true/undefined, default upstream context is added.
   */
  useUpstreamBridgeContext?: boolean;
  /** Logical code project id resolved through the gateway project registry. */
  codeProjectId?: string;
  /** Shared project directory for code tasks in this district. Legacy-only; migrated lazily to codeProjectId. */
  codeProjectPath?: string;
}

export type CodeProjectSource = "auto" | "local" | "imported_workflow" | "legacy_path";
export type CodeProjectStatus = "ready" | "missing" | "archived";

export interface CodeProjectRecord {
  id: string;
  name: string;
  slug: string;
  path: string;
  source: CodeProjectSource;
  status: CodeProjectStatus;
  createdAt: string;
  updatedAt: string;
  externalProjectId?: string;
}

export interface ResolvedCodeProject {
  id: string;
  name: string;
  path: string;
  source: CodeProjectSource;
  status: CodeProjectStatus;
}

/** One saved bridge pipeline execution (persisted under workspace bridges/). */
export interface PipelineRunRecord {
  id: string;
  startedAt: string;
  finishedAt: string;
  startDistrictId: string;
  resolvedProjectId?: string;
  resolvedProjectPath?: string;
  projectSource?: CodeProjectSource;
  orderedTaskIds: string[];
  summary: string;
  districtResults: {
    districtId: string;
    districtTitle: string;
    tasks: { taskId: string; title: string; bee: string; status: string; output: string }[];
  }[];
  status: "completed" | "failed_partial";
  doneCount: number;
  failedCount: number;
}

export interface BeeTask {
  id: string;
  title: string;
  description?: string;
  districtId: string;
  cityId: string;
  bee: string;
  flower: string;
  assignee: string;
  dueDate: string;
  priority: BeePriority;
  requiresApproval: boolean;
  status: BeeTaskStatus;
  personaId?: string;
  schedule?: TaskSchedule;
  /** Task IDs this task depends on (intra-district DAG). Empty/undefined = no deps. */
  dependsOn?: string[];
  /** BCP-47 locale for user-visible task output (e.g. ko, en). Propagated to worker and Waggle supervisor prompts. */
  responseLocale?: string;
}

export type FlowerType = "browser" | "api" | "mcp" | "code";

export type FlowerConnectionType = "chrome_extension" | "api_endpoint" | "mcp_server" | "discord_bot";

export interface FlowerConfig {
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
  /** Discord bot token (stored on disk; never returned verbatim from GET). */
  discordBotToken?: string;
  /** Non-empty allowlist required for inbound messages; channel snowflake IDs. */
  discordChannelAllowlist?: string[];
  /** API response only: whether a token is configured. */
  discordBotTokenSet?: boolean;
  /**
   * When false, Discord inbound uses answer-only mode (no workspace chat action tools).
   * Omitted or true preserves legacy behavior (tools allowed).
   */
  discordChatToolsEnabled?: boolean;
  /** If non-empty, only these Discord user snowflake IDs may trigger replies (in allowlisted channels). */
  discordUserAllowlist?: string[];
  /** Min ms between handled messages per flower+channel; 0 disables. Omitted uses gateway default (~1200ms). */
  discordCooldownMs?: number;
  /** API response only: last Discord client/login error for this flower (not persisted). */
  discordLastError?: string;
  capabilities: string[];
  connected?: boolean;
  lastSeenAt?: string;
  createdAt: string;
}

export interface BeePersona {
  id: string;
  name: string;
  role: string;
  systemPrompt: string;
  providerId: string;
  model: string;
  flowerType: FlowerType;
  /** When set, this persona row belongs to a specific task (same district may have multiple task-scoped teams). */
  scopedTaskId?: string;
  /** Stable normalized mission fingerprint used to reuse similar bees in the same district. */
  intentSignature?: string;
  /** Parent bee id when this bee is derived as a follow-up child. */
  parentBeeId?: string;
  /** Simple lineage marker for routing/reuse (anchor|worker|child). */
  lineageKind?: "anchor" | "worker" | "child";
}

export interface CityPlan {
  id: string;
  title: string;
  districts: BeeDistrict[];
  tasks: BeeTask[];
  bees?: BeePersona[];
}

export interface TeamPlan {
  id: string;
  goal: string;
  bees: BeePersona[];
  districts: BeeDistrict[];
  tasks: BeeTask[];
}

export interface ConversationEntry {
  role: "bee" | "flower" | "system";
  action: string;
  content: string;
  timestamp: string;
  /**
   * Harness channel label, e.g. "Worker LLM (openai/gpt-4o-mini)",
   * "Waggle · Browser · chatgpt.com", "Flower · Chrome relay", "Gateway".
   */
  source?: string;
}

export interface TaskConversation {
  taskId: string;
  jobId: string;
  beeId: string;
  entries: ConversationEntry[];
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  /** Set when this snapshot is stored as a past run (workspace history). */
  sessionId?: string;
}

export type FlowerCommandAction =
  | "navigate"
  | "waggle_ensure"
  | "click"
  | "fill"
  | "type"
  | "read"
  | "snapshot"
  | "screenshot"
  | "wait"
  | "scroll"
  | "ai_chat"
  | "ai_read_response";

export interface FlowerCommand {
  action: FlowerCommandAction;
  url?: string;
  selector?: string;
  uid?: string;
  text?: string;
  description?: string;
  ms?: number;
  direction?: "up" | "down";
  provider?: "gpt" | "claude";
  prompt?: string;
  timeout?: number;
  /** Route snapshot/fill/click to the pinned Waggle tab (after waggle_ensure). */
  useWaggleTab?: boolean;
}

export type ScheduleRepeat = "once" | "hourly" | "daily" | "custom";

export interface TaskSchedule {
  deadline?: string;
  repeatType: ScheduleRepeat;
  intervalHours?: number;
  dailyAtHour?: number;
  dailyAtMinute?: number;
  cronExpression?: string;
  maxRetries: number;
  retryCount: number;
  lastRunAt?: string;
  nextRunAt?: string;
  enabled: boolean;
}

export type BridgeDirection = "one_way" | "two_way";
export type BridgeStatus = "active" | "inactive" | "pending";

export interface DistrictBridge {
  id: string;
  fromDistrictId: string;
  toDistrictId: string;
  label: string;
  description?: string;
  direction: BridgeDirection;
  status: BridgeStatus;
  dataFlow?: string[];
  createdAt: string;
}

// Legacy aliases for backward compatibility
export type BeeJobStatus = BeeTaskStatus;
export type BeeJob = BeeTask;
export type BeeMission = BeeDistrict;
export type HivePlan = CityPlan;
export type JobConversation = TaskConversation;
export type JobSchedule = TaskSchedule;
export type TaskPriority = BeePriority;
export type PlannedTask = BeeTask;
export type Story = BeeDistrict;
export interface SprintPlan {
  id: string;
  title: string;
  stories: BeeDistrict[];
  tasks: BeeTask[];
}

/**
 * New Bee persona id: `bee-` + random hex (no `bee-1` collisions across plans/sessions).
 * Uses `crypto.randomUUID` when available (browser + Node).
 */
export function newBeeId(): string {
  const hex =
    typeof globalThis.crypto !== "undefined" && typeof globalThis.crypto.randomUUID === "function"
      ? globalThis.crypto.randomUUID().replace(/-/g, "")
      : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
  return `bee-${hex.slice(0, 16)}`;
}
