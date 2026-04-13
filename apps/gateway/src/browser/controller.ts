import type { BeePersona, BeeTask, ConversationEntry, WaggleConfig } from "@beebridge/core";
import type { AiHistoryEntry } from "../server/ai-history-store.js";
import type { InteractionChainStore, ChainEntry, ChainNode } from "../server/interaction-chain-store.js";
import type { PmSettingsStore } from "../settings/store.js";
import type { WebSocket as WsSocket } from "ws";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { chatWithTools, type ChatToolChoice, type LlmConfig } from "./llm-client.js";
import { resolveOpenAiSecretToApiKey } from "./openai-codex-token.js";
import { BROWSER_TOOLS, WAGGLE_ASK_TOOL } from "./browser-tools.js";
import { SnapshotCache } from "./snapshot-cache.js";
import { executeWaggle } from "./waggle.js";
import type { CdpRelayServer } from "./cdp-relay.js";
import { runFlowerCommand } from "./cdp-flower-commands.js";
import { applyBridgeOutPlaceholders } from "../server/bridge-execution.js";
import type { CodeTaskResult } from "../codegen/code-executor.js";

const MAX_AGENT_STEPS = 20;
const MAX_TOKEN_BUDGET = 200_000;
const MAX_CONSECUTIVE_FLOWER_FAILURES = 5;
const COMMAND_TIMEOUT_MS = 30_000;
const SNAPSHOT_AFTER_ACTIONS = new Set(["navigate", "click", "fill", "scroll"]);
const BROWSER_WORK_ACTIONS = new Set(["navigate", "click", "fill", "scroll", "snapshot", "read_text"]);

const LOG_CONTEXT_MAX = 2000;
const LOG_WAGGLE_ANSWER_MAX = 12_000;
const LOG_TOOL_PLAN_MAX = 2000;

function waggleChannelLabel(cfg: WaggleConfig | undefined): string {
  if (!cfg?.enabled) return "Waggle";
  if (cfg.mode === "browser") {
    const raw = cfg.browserTargetUrl || "https://chatgpt.com";
    try {
      return `Waggle · Browser · ${new URL(raw).hostname}`;
    } catch {
      return "Waggle · Browser";
    }
  }
  return `Waggle · API · ${cfg.apiProviderId || "openai"}/${cfg.apiModel || "gpt-4o"}`;
}

/** Exported for tests: task title/description contains a http(s) or www URL hint. */
export function taskTextHasNamedUrl(task: BeeTask): boolean {
  return /https?:\/\/|www\./i.test(`${task.title ?? ""}\n${task.description ?? ""}`);
}

function summarizeToolCalls(calls: { name: string; args: Record<string, unknown> }[]): string {
  const parts = calls.map((t) => {
    const a = t.args;
    if (t.name === "navigate" && typeof a.url === "string") {
      const u = a.url;
      return `navigate(${u.length > 80 ? `${u.slice(0, 80)}…` : u})`;
    }
    if (t.name === "fill" && typeof a.uid === "string") {
      const full = typeof a.text === "string" ? a.text : "";
      const tx = full.slice(0, 40);
      return `fill(uid=${a.uid}${tx ? `, "${tx}${full.length > 40 ? "…" : ""}"` : ""})`;
    }
    if (t.name === "click" && typeof a.uid === "string") return `click(uid=${a.uid})`;
    if (t.name === "scroll" && typeof a.direction === "string") return `scroll(${a.direction})`;
    if (t.name === "read_text") return "read_text";
    if (t.name === "snapshot") return "snapshot";
    if (t.name === "wait") return `wait(${typeof a.ms === "number" ? a.ms : "?"})`;
    if (t.name === "waggle_ask") return "waggle_ask";
    if (t.name === "done") return "done";
    return t.name;
  });
  let s = parts.join(" → ");
  if (s.length > LOG_TOOL_PLAN_MAX) s = s.slice(0, LOG_TOOL_PLAN_MAX) + "…";
  return s;
}

const snapshotCache = new SnapshotCache(5 * 60 * 1000);

export interface TaskContext {
  broadcastToWeb: (msg: Record<string, unknown>) => void;
  jobStore: {
    addEntry: (jobId: string, entry: ConversationEntry) => void;
    complete: (jobId: string, result: string) => void;
    fail: (jobId: string, error: string) => void;
    start: (jobId: string, beeId: string) => void;
  };
  aiHistory: {
    record: (entry: AiHistoryEntry) => void;
    recentWaggleForDistrict: (districtId: string, limit: number) => AiHistoryEntry[];
  };
  chainStore?: InteractionChainStore;
  log: (tag: string, detail: string) => void;
  getConnectedFlower: (preferredFlowerId?: string) => WsSocket | undefined;
  /** DevTools CDP relay (chrome.debugger extension). Primary browser automation path. Optional for non-browser executors. */
  getCdpRelay?: () => CdpRelayServer | null;
  pmSettings: PmSettingsStore;
}

export interface CommandResult {
  ok: boolean;
  action: string;
  data?: string;
  error?: string;
}

export interface FlowerCommand {
  action: string;
  url?: string;
  selector?: string;
  uid?: string;
  text?: string;
  ms?: number;
  direction?: string;
  provider?: string;
  prompt?: string;
  timeout?: number;
  /** When true, snapshot/fill/click/etc. target the pinned Waggle web-AI tab (not the task automation tab). */
  useWaggleTab?: boolean;
}

export function sendCommandToFlower(
  flower: WsSocket,
  cmd: FlowerCommand,
  timeoutMs = COMMAND_TIMEOUT_MS,
): Promise<CommandResult> {
  const cmdId = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve({ ok: false, action: cmd.action, error: "command timeout" });
    }, timeoutMs);

    function onMessage(raw: Buffer | string) {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.type === "command.result" && msg.cmdId === cmdId) {
        cleanup();
        resolve(msg.result as CommandResult);
      }
    }

    function cleanup() {
      clearTimeout(timer);
      flower.removeListener("message", onMessage);
    }

    flower.on("message", onMessage);
    try {
      flower.send(
        JSON.stringify({ type: "command.execute", cmdId, command: cmd }),
      );
    } catch (err) {
      cleanup();
      resolve({ ok: false, action: cmd.action, error: `send failed: ${err instanceof Error ? err.message : String(err)}` });
    }
  });
}

function formatDistrictWaggleDigest(entries: AiHistoryEntry[]): string {
  const ok = entries.filter((e) => e.status === "success");
  if (ok.length === 0) {
    return (
      "(No waggle exchanges recorded for this district yet. Use waggle_ask to query the shared higher-tier channel; answers accumulate here for other tasks in the same district.)"
    );
  }
  const chronological = [...ok].reverse();
  return chronological
    .map((e, i) => {
      const q = e.promptPreview;
      const a = e.responsePreview;
      return `### ${i + 1}\n**Q:** ${q}\n**A:** ${a}`;
    })
    .join("\n\n");
}

function buildSystemPrompt(
  persona: BeePersona | null | undefined,
  waggle?: WaggleConfig,
  districtWaggleDigest?: string,
  districtId?: string,
  responseLocale?: string,
): string {
  const locale = responseLocale?.trim();
  const localeBlock = locale
    ? [
        "",
        `User-visible output language: ${locale}. The done() summary and any user-facing text must use this language.`,
        "Do not ask the supervisor for generic 'how to analyze' workflows — use waggle_ask for concrete page data, validation, or next steps after you have real content.",
      ]
    : [];

  const base = [
    "You are a browser automation agent. You control a real browser to accomplish the user's task.",
    "You MUST use the provided tools to interact with the browser. After navigate or click, always take a snapshot to see the result.",
    "",
    "Workflow:",
    "1. Understand the user's request",
    "2. Navigate to the relevant website",
    "3. Take a snapshot to see the page",
    "4. Use click/fill to interact with elements (use the uid from the snapshot)",
    "5. Repeat steps 3-4 until the task is done",
    "6. Call 'done' with a summary of results",
    "",
    "Important rules:",
    "- Always take a snapshot after navigating or clicking to observe the result",
    "- Use element uids from the snapshot (e.g. uid='3') to click or fill",
    "- If an action fails, try a different approach",
    "- If the page hasn't loaded yet, use wait then snapshot again",
    "- Complete the task in as few steps as possible",
    ...localeBlock,
  ];

  if (persona) {
    base.push(
      "",
      `Role: ${persona.name} (${persona.role})`,
    );
    if (persona.systemPrompt) {
      base.push(persona.systemPrompt);
    }
  }

  if (waggle?.enabled && districtId && districtWaggleDigest !== undefined) {
    base.push(
      "",
      "DISTRICT WAGGLE POOL (shared across all bees and tasks in this district):",
      "This district uses one configured higher-tier channel. The exchanges below are from that channel",
      "(including prior tasks). Use this pool as shared memory and context.",
      "You still sync with that channel via waggle_ask during this run: the harness requires at least one successful waggle_ask before done, after you have performed browser work when the task involves the web.",
      "Whenever you need fresh guidance, call waggle_ask again with current URL, what you tried, and what you need decided.",
      "",
      districtWaggleDigest,
    );
  }

  if (waggle?.enabled) {
    const urlFirst =
      waggle.allowBrowserBeforeFirstWaggle !== false
        ? "If the task names a specific URL (http/https or www), you may navigate to it first, then snapshot/read_text, then use waggle_ask with what you collected — do not open with a generic 'how should I analyze' question."
        : "First step — call waggle_ask for an approach (include task title, description, upstream context, district objective).";
    base.push(
      "",
      "WAGGLE HARNESS — You are the executor (browser hands). The higher-tier channel (browser web AI or API) is your supervisor.",
      urlFirst,
      "",
      "Required workflow loop:",
      "1) OPEN / COLLECT: When a URL is in the task, use navigate → snapshot/read_text to load real page content when allowed above; otherwise start with waggle_ask for planning.",
      "2) SUPERVISOR: Use waggle_ask with concrete page facts (quotes, structure) — not generic methodology requests. When stuck or for validation, ask the supervisor with context.",
      "3) EXECUTE: Use browser tools (navigate, snapshot, read_text, click, fill) to gather data. You MUST perform real browser actions for web tasks.",
      "4) REPEAT collect / waggle_ask until the task goal is met.",
      "5) DONE: Call 'done' only after browser work and at least one successful waggle_ask when Waggle is enabled. The harness will reject 'done' if no browser tools were used.",
      "",
      "CRITICAL: waggle_ask alone is NOT enough. You must use browser tools to gather real data or perform real actions when the task involves the web.",
      "",
      waggle.autoDetect
        ? "Also use waggle_ask proactively before analytically heavy steps, not only after failures."
        : "Use waggle_ask for planning and unblocking; avoid extra proactive waggle unless the task clearly needs it.",
    );
    if (waggle.mode === "browser") {
      base.push(
        "",
        "BROWSER WAGGLE — configured web AI (e.g. ChatGPT in district settings):",
        "Use waggle_ask for synthesis and judgment after you have page content, or when you need deeper analysis of what you collected.",
        "Use navigate/snapshot/read_text on the open web when the task names a URL or you must verify a claim on a page.",
      );
    }
  }

  return base.join("\n");
}

async function resolveLlmConfig(ctx: TaskContext): Promise<LlmConfig> {
  const profile = ctx.pmSettings.getActiveProfile();
  const policy = ctx.pmSettings.getModelPolicy();

  if (!profile) {
    throw new Error(
      "No active auth profile. Configure an API key in Settings > Auth Profiles.",
    );
  }

  let apiKey = profile.secret;
  let codexOAuth = false;
  if (profile.providerId === "openai" && profile.secret.trim().startsWith("{")) {
    const resolved = await resolveOpenAiSecretToApiKey(profile.secret, (s) => {
      ctx.pmSettings.updateProfileSecret(profile.id, s);
    });
    apiKey = resolved.apiKey;
    codexOAuth = resolved.codexOAuth;
  }

  return {
    apiKey,
    model: policy.defaultModel,
    providerId: profile.providerId,
    codexOAuth,
  };
}

function toolCallToFlowerCommand(
  name: string,
  args: Record<string, unknown>,
): FlowerCommand | null {
  switch (name) {
    case "navigate":
      return { action: "navigate", url: args.url as string };
    case "click":
      return { action: "click", uid: args.uid as string };
    case "fill":
      return { action: "fill", uid: args.uid as string, text: args.text as string };
    case "snapshot":
      return { action: "snapshot" };
    case "scroll":
      return { action: "scroll", direction: (args.direction as string) || "down" };
    case "read_text":
      return { action: "read", selector: args.selector as string | undefined };
    case "wait":
      return { action: "wait", ms: (args.ms as number) || 1000 };
    default:
      return null;
  }
}

export async function executeTaskViaCdp(
  task: BeeTask,
  persona: BeePersona | null | undefined,
  ctx: TaskContext,
  waggleConfig?: WaggleConfig,
  bridgeContext?: string,
  bridgeOutMap?: Map<string, string>,
  abortSignal?: AbortSignal,
  llmConfigOverride?: Partial<LlmConfig>,
): Promise<CodeTaskResult> {
  const jobId = task.id;

  const relay = ctx.getCdpRelay?.();
  if (!relay?.isReady()) {
    ctx.log("QUEUE", `CDP relay not ready for task ${jobId}`);
    ctx.jobStore.fail(
      jobId,
      "Flower CDP relay not ready. Load the beebridge extension, ensure the CDP relay connects, then click the extension icon on a tab to attach the debugger.",
    );
    return { taskId: jobId, status: "failed", output: "cdp_relay_not_ready" };
  }

  let llmConfig: LlmConfig;
  try {
    llmConfig = await resolveLlmConfig(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.jobStore.fail(jobId, msg);
    return { taskId: jobId, status: "failed", output: msg };
  }

  if (llmConfigOverride?.model) {
    llmConfig = { ...llmConfig, model: llmConfigOverride.model };
  }

  const gatewaySource = "Gateway";
  const workerSource = `Worker LLM (${llmConfig.providerId}/${llmConfig.model})`;
  const flowerSource = `Flower · DevTools CDP${task.flower ? ` · ${task.flower}` : ""}`;
  const waggleSrc = waggleChannelLabel(waggleConfig);

  const sendProgress = (
    action: string,
    content: string,
    source?: string,
    role: "flower" | "system" = "flower",
  ) => {
    const entry: ConversationEntry = {
      role,
      action,
      content,
      timestamp: new Date().toISOString(),
      ...(source ? { source } : {}),
    };
    ctx.jobStore.addEntry(jobId, entry);
    ctx.broadcastToWeb({ type: "job.update", jobId, entry });
  };

  sendProgress("system", `Task received: ${task.title}`, gatewaySource, "system");
  ctx.log("AGENT", `starting agent loop for task ${jobId}, model=${llmConfig.model}`);

  const fullAgentTools = waggleConfig?.enabled
    ? [...BROWSER_TOOLS, WAGGLE_ASK_TOOL]
    : BROWSER_TOOLS;
  const waggleOnlyTools = [WAGGLE_ASK_TOOL];

  const taskDomain = extractDomain(task);
  const taskIntent = extractIntent(task.title, task.description);
  let cachedPattern: ChainEntry | null = null;
  let domainCatalog: ChainNode[] = [];

  if (ctx.chainStore) {
    domainCatalog = ctx.chainStore.lookupByDomain(taskDomain);
    if (domainCatalog.length > 0) {
      const exactMatch = domainCatalog.find((n) => n.key.intent === taskIntent);
      cachedPattern = exactMatch?.entries[0] ?? domainCatalog[0].entries[0] ?? null;
      ctx.log("CHAIN", `catalog for ${taskDomain}: ${domainCatalog.length} patterns, matched intent="${exactMatch?.key.intent ?? domainCatalog[0].key.intent}"`);
    }
  }

  let districtWaggleDigest: string | undefined;
  if (waggleConfig?.enabled && task.districtId) {
    const recent = ctx.aiHistory.recentWaggleForDistrict(task.districtId, 12);
    districtWaggleDigest = formatDistrictWaggleDigest(recent);
  }

  let systemPrompt = buildSystemPrompt(
    persona,
    waggleConfig,
    districtWaggleDigest,
    task.districtId,
    task.responseLocale,
  );
  if (domainCatalog.length > 0) {
    systemPrompt += `\n\nAVAILABLE PATTERNS for "${taskDomain}":`;
    for (const node of domainCatalog.slice(0, 5)) {
      const best = node.entries[0];
      const desc = node.description || node.key.intent;
      systemPrompt += `\n  [${node.key.intent}] ${desc} (score: ${best.score.toFixed(2)})`;
      systemPrompt += `\n    Steps: ${best.pattern.join(" -> ")}`;
    }
    systemPrompt += `\nIf a pattern matches your task, follow it. Otherwise, proceed normally.`;
  }

  if (waggleConfig?.enabled && waggleConfig.mode === "browser") {
    systemPrompt += `\n\nBROWSER WAGGLE OVERRIDE: If the task names a URL, open it first per WAGGLE HARNESS. Saved patterns may say "go to Google first" — ignore when they conflict with loading the user-specified URL.`;
  }

  if (bridgeContext?.trim()) {
    systemPrompt += `\n\n=== Upstream pipeline context (from earlier districts / tasks in this run) ===\n${bridgeContext.trim()}\n=== End upstream context ===`;
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task.description ? `${task.title}\n\n${task.description}` : task.title },
  ];

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const startTime = Date.now();
  let finalOutput = "";
  const toolCallSequence: { name: string; args: Record<string, unknown> }[] = [];
  let successfulWaggleAsks = 0;
  let consecutiveFlowerFailures = 0;

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    if (abortSignal?.aborted) {
      const msg = "Task aborted by parent.";
      recordHistory(ctx, jobId, task, llmConfig, startTime, totalPromptTokens, totalCompletionTokens, msg, "error");
      ctx.jobStore.fail(jobId, msg);
      return { taskId: jobId, status: "failed", output: msg, tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens } };
    }

    ctx.log("AGENT", `step ${step + 1}/${MAX_AGENT_STEPS}`);

    const allowBrowserFirst = waggleConfig?.allowBrowserBeforeFirstWaggle !== false;
    const hasNamedUrl = taskTextHasNamedUrl(task);
    const waggleGateActive = Boolean(
      waggleConfig?.enabled && successfulWaggleAsks === 0 && !(allowBrowserFirst && hasNamedUrl),
    );
    const activeTools = waggleGateActive ? waggleOnlyTools : fullAgentTools;
    const toolChoice: ChatToolChoice | undefined = waggleGateActive
      ? { type: "function", function: { name: "waggle_ask" } }
      : undefined;

    let llmResponse;
    try {
      sendProgress(
        "llm_call",
        waggleGateActive
          ? `LLM thinking... (step ${step + 1}, waggle sync — waggle_ask only)`
          : `LLM thinking... (step ${step + 1})`,
        workerSource,
      );
      llmResponse = await chatWithTools(llmConfig, messages, activeTools, { toolChoice, signal: abortSignal });
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError"
        || (err instanceof Error && err.name === "AbortError");
      if (isAbort) {
        const msg = "Browser task aborted by parent.";
        ctx.log("AGENT", msg);
        sendProgress("warning", msg, workerSource);
        recordHistory(ctx, jobId, task, llmConfig, startTime, totalPromptTokens, totalCompletionTokens, msg, "error");
        ctx.jobStore.fail(jobId, msg);
        return { taskId: jobId, status: "failed", output: msg, tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens } };
      }
      const msg = err instanceof Error ? err.message : String(err);
      ctx.log("AGENT", `LLM call failed: ${msg}`);
      sendProgress("error", `LLM error: ${msg}`, workerSource);
      recordHistory(ctx, jobId, task, llmConfig, startTime, totalPromptTokens, totalCompletionTokens, msg, "error");
      ctx.jobStore.fail(jobId, `LLM error: ${msg}`);
      return { taskId: jobId, status: "failed", output: msg, tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens } };
    }

    if (llmResponse.usage) {
      totalPromptTokens += llmResponse.usage.promptTokens;
      totalCompletionTokens += llmResponse.usage.completionTokens;

      if (totalPromptTokens + totalCompletionTokens > MAX_TOKEN_BUDGET) {
        const budgetMsg = `Token budget exceeded (${totalPromptTokens + totalCompletionTokens} > ${MAX_TOKEN_BUDGET}). Stopping agent loop.`;
        ctx.log("AGENT", budgetMsg);
        sendProgress("warning", budgetMsg, gatewaySource, "system");
        finalOutput = finalOutput || budgetMsg;
        recordHistory(ctx, jobId, task, llmConfig, startTime, totalPromptTokens, totalCompletionTokens, budgetMsg, "error");
        ctx.jobStore.fail(jobId, budgetMsg);
        return { taskId: jobId, status: "failed", output: budgetMsg, tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens } };
      }
    }

    if (llmResponse.toolCalls.length === 0) {
      if (waggleConfig?.enabled && successfulWaggleAsks === 0) {
        const allowBrowserFirst = waggleConfig.allowBrowserBeforeFirstWaggle !== false;
        const hasNamedUrl = taskTextHasNamedUrl(task);
        if (llmResponse.content) {
          messages.push({ role: "assistant", content: llmResponse.content });
        }
        if (allowBrowserFirst && hasNamedUrl) {
          sendProgress(
            "harness",
            "Waggle harness: model returned text without tools — require browser tools first for the URL, then waggle_ask with concrete page facts.",
            gatewaySource,
            "system",
          );
          messages.push({
            role: "user",
            content:
              "Waggle harness: The task names a URL. You must call browser tools (navigate, snapshot, read_text) — not plain text only. After you have real page content, call waggle_ask with that content if supervisor help is needed.",
          });
          continue;
        }
        sendProgress(
          "harness",
          "Waggle harness: model returned text without tools — requiring waggle_ask next (include task title, description, district objective in context).",
          gatewaySource,
          "system",
        );
        messages.push({
          role: "user",
          content:
            "Waggle harness: You must call the waggle_ask tool (not plain text). Ask the higher-tier channel how to approach this task and what steps to take. " +
            "Put the task title, full task description, and district objective in the context field.",
        });
        continue;
      }
      if (llmResponse.content) {
        messages.push({ role: "assistant", content: llmResponse.content });
      }
      finalOutput = llmResponse.content || "Task completed (no tool calls)";
      sendProgress("done", finalOutput, workerSource);
      break;
    }

    const assistantMsg: ChatCompletionMessageParam = {
      role: "assistant",
      content: llmResponse.content || null,
      tool_calls: llmResponse.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    };
    messages.push(assistantMsg);

    sendProgress("worker_tool_plan", summarizeToolCalls(llmResponse.toolCalls), workerSource);

    for (const tc of llmResponse.toolCalls) {
      ctx.log("AGENT", `tool_call: ${tc.name}(${JSON.stringify(tc.args)})`);
      toolCallSequence.push({ name: tc.name, args: tc.args });

      if (tc.name === "done") {
        if (waggleConfig?.enabled && successfulWaggleAsks === 0) {
          sendProgress(
            "warning",
            "done rejected: Waggle mode requires at least one successful waggle_ask before completing.",
            gatewaySource,
            "system",
          );
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content:
              "Cannot complete yet: Waggle mode requires at least one successful waggle_ask response before 'done'. " +
              "Call waggle_ask first to plan your approach or to get unstuck (include current page state, what you tried, and errors in context).",
          });
          continue;
        }

        const hasBrowserWork = toolCallSequence.some((t) => BROWSER_WORK_ACTIONS.has(t.name));
        if (waggleConfig?.enabled && !hasBrowserWork) {
          sendProgress(
            "warning",
            "done rejected: You received guidance from the supervisor but have not executed any browser actions yet. Follow the plan using browser tools first.",
            gatewaySource,
            "system",
          );
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content:
              "Cannot complete yet: You consulted the supervisor via waggle_ask but performed no browser work. " +
              "The supervisor's guidance must be executed using browser tools (navigate, snapshot, read_text, click, fill, etc.) to gather real data or perform actions. " +
              "Then report results back via waggle_ask if needed, and only call 'done' after actual browser work is complete.",
          });
          continue;
        }

        finalOutput = (tc.args.result as string) || "Task completed";
        sendProgress("done", finalOutput, workerSource);

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "Task marked as done.",
        });

        recordHistory(ctx, jobId, task, llmConfig, startTime, totalPromptTokens, totalCompletionTokens, finalOutput, "success");

        if (ctx.chainStore) {
          const totalTokens = totalPromptTokens + totalCompletionTokens;
          ctx.chainStore.record(
            { domain: taskDomain, intent: taskIntent },
            toolCallSequence.map((t) => t.name),
            toolCallSequence.map((t) => t.args),
            finalOutput,
            "success",
            totalTokens,
            Date.now() - startTime,
            jobId,
            task.title.slice(0, 100),
          );
          if (cachedPattern) {
            const saved = Math.max(cachedPattern.tokens - totalTokens, 0);
            ctx.chainStore.recordTokensSaved(saved);
          }
          ctx.log("CHAIN", `recorded pattern: ${toolCallSequence.length} steps for ${taskDomain}/${taskIntent}`);
        }

        ctx.jobStore.complete(jobId, finalOutput);
        return { taskId: jobId, status: "done", output: finalOutput, tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens } };
      }

      if (tc.name === "waggle_ask" && waggleConfig?.enabled) {
        let question = (tc.args.question as string) || "";
        let qContext = tc.args.context as string | undefined;

        if (bridgeOutMap && bridgeOutMap.size > 0) {
          question = applyBridgeOutPlaceholders(question, bridgeOutMap);
          if (qContext) qContext = applyBridgeOutPlaceholders(qContext, bridgeOutMap);
        }

        if (bridgeContext?.trim()) {
          const upstream = `=== Upstream pipeline context ===\n${bridgeContext.trim()}\n=== End upstream context ===`;
          qContext = qContext ? `${upstream}\n\n${qContext}` : upstream;
        }

        const askBody =
          `Question:\n${question}` +
          (qContext
            ? `\n\nContext:\n${qContext.length > LOG_CONTEXT_MAX ? `${qContext.slice(0, LOG_CONTEXT_MAX)}…` : qContext}`
            : "");
        sendProgress("waggle_ask", askBody, waggleSrc);

        const waggleResult = await executeWaggle(question, qContext, waggleConfig, relay, ctx, {
          jobId: task.id,
          districtId: task.districtId,
          responseLocale: task.responseLocale,
        });
        if (waggleResult.ok) {
          const head = `[${waggleResult.latencyMs}ms${waggleResult.fromCache ? " · API cache replay" : ""}]\n\n`;
          const ans = waggleResult.answer;
          const body =
            ans.length > LOG_WAGGLE_ANSWER_MAX ? `${ans.slice(0, LOG_WAGGLE_ANSWER_MAX)}…` : ans;
          sendProgress("waggle_answer", head + body, waggleSrc);
          successfulWaggleAsks += 1;
        } else {
          const err = waggleResult.answer;
          sendProgress(
            "waggle_error",
            err.length > 2000 ? `${err.slice(0, 2000)}…` : err,
            waggleSrc,
          );
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: waggleResult.answer.slice(0, 6000),
        });
        continue;
      }

      const flowerCmd = toolCallToFlowerCommand(tc.name, tc.args);
      if (!flowerCmd) {
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Unknown tool: ${tc.name}`,
        });
        continue;
      }

      sendProgress(tc.name, `Executing: ${tc.name} ${JSON.stringify(tc.args)}`, flowerSource);

      const timeoutForCmd =
        tc.name === "wait" ? ((tc.args.ms as number) || 1000) + 5000 : COMMAND_TIMEOUT_MS;
      const result = await runFlowerCommand(relay, flowerCmd, timeoutForCmd);

      if (!result.ok) {
        consecutiveFlowerFailures++;
        sendProgress(tc.name, `Failed: ${result.error}`, flowerSource);
        snapshotCache.clear();

        if (consecutiveFlowerFailures >= MAX_CONSECUTIVE_FLOWER_FAILURES) {
          const abortMsg = `CDP relay: ${consecutiveFlowerFailures} consecutive failures. Aborting agent loop.`;
          ctx.log("AGENT", abortMsg);
          sendProgress("error", abortMsg, gatewaySource, "system");
          recordHistory(ctx, jobId, task, llmConfig, startTime, totalPromptTokens, totalCompletionTokens, abortMsg, "error");
          ctx.jobStore.fail(jobId, abortMsg);
          return { taskId: jobId, status: "failed", output: abortMsg, tokenUsage: { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens } };
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Action '${tc.name}' failed: ${result.error}. Try a different approach.`,
        });
        continue;
      }

      consecutiveFlowerFailures = 0;
      let toolResult = result.data || "ok";

      if (tc.name === "snapshot") {
        toolResult = processSnapshot(result, ctx);
      } else if (SNAPSHOT_AFTER_ACTIONS.has(tc.name)) {
        sendProgress("snapshot", "Auto-snapshot after " + tc.name, flowerSource);
        const snapResult = await runFlowerCommand(relay, { action: "snapshot" }, COMMAND_TIMEOUT_MS);
        if (snapResult.ok) {
          const snapData = processSnapshot(snapResult, ctx);
          toolResult += "\n\n--- Page Snapshot ---\n" + snapData;
        }
      }

      {
        const okMsg =
          tc.name === "snapshot"
            ? `ok · snapshot payload ~${toolResult.length} chars (full text stays in worker context only)`
            : "ok";
        sendProgress(tc.name, okMsg, flowerSource);
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: toolResult.slice(0, 6000),
      });
    }
  }

  if (!finalOutput) {
    finalOutput = "Agent loop reached maximum steps without completing.";
    if (waggleConfig?.enabled && successfulWaggleAsks === 0) {
      finalOutput +=
        " Waggle mode: no successful waggle_ask was received; the collaboration requirement was not met.";
    }
    sendProgress("warning", finalOutput, gatewaySource, "system");
  }

  const waggleHarnessFailed = waggleConfig?.enabled === true && successfulWaggleAsks === 0;
  const historyStatus: "success" | "error" =
    finalOutput.includes("maximum") || waggleHarnessFailed ? "error" : "success";
  recordHistory(ctx, jobId, task, llmConfig, startTime, totalPromptTokens, totalCompletionTokens, finalOutput, historyStatus);

  const tokenUsage = { promptTokens: totalPromptTokens, completionTokens: totalCompletionTokens };

  const maxStepsExhausted = finalOutput.includes("maximum");
  if (waggleHarnessFailed || maxStepsExhausted) {
    ctx.jobStore.fail(jobId, finalOutput);
    return { taskId: jobId, status: "failed", output: finalOutput, tokenUsage };
  }

  ctx.jobStore.complete(jobId, finalOutput);
  return { taskId: jobId, status: "done", output: finalOutput, tokenUsage };
}

function processSnapshot(
  result: CommandResult,
  ctx: TaskContext,
): string {
  let parsed: { snapshot?: string; url?: string };
  try {
    parsed = JSON.parse(result.data || "{}");
  } catch {
    return result.data || "";
  }

  const snapshot = parsed.snapshot || result.data || "";
  const url = parsed.url || "";

  if (url) {
    const cached = snapshotCache.get(url);
    if (cached && !snapshotCache.hasChanged(url, snapshot)) {
      ctx.log("CACHE", `snapshot cache hit for ${url}`);
      return `[Cached - page unchanged] ${url}\n(Same as previous snapshot)`;
    }
    snapshotCache.put(url, snapshot);
    ctx.log("CACHE", `snapshot cached for ${url} (${snapshotCache.stats().size} entries)`);
  }

  return snapshot;
}

function extractIntent(title: string, description?: string): string {
  const text = `${title} ${description ?? ""}`.toLowerCase();
  if (text.match(/login|sign.?in|auth/)) return "login";
  if (text.match(/search|find|query/)) return "search";
  if (text.match(/fill|form|submit|register/)) return "fill_form";
  if (text.match(/read.?(data|info|content|page|text)|extract|scrape/)) return "read_data";
  if (text.match(/download|save|export/)) return "download";
  if (text.match(/click|navigate|go\s+to|open/)) return "navigate";
  return "general";
}

function extractDomain(task: BeeTask): string {
  const text = `${task.title} ${task.description ?? ""}`;
  const urlMatch = text.match(/https?:\/\/([^/\s]+)/);
  if (urlMatch) return urlMatch[1];
  return task.districtId ?? "general";
}

function recordHistory(
  ctx: TaskContext,
  jobId: string,
  task: BeeTask,
  llmConfig: LlmConfig,
  startTime: number,
  promptTokens: number,
  completionTokens: number,
  output: string,
  status: "success" | "error",
): void {
  const entry: AiHistoryEntry = {
    id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    provider: llmConfig.providerId,
    model: llmConfig.model,
    jobId,
    beeId: task.personaId || task.bee,
    action: "agent_loop",
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: promptTokens + completionTokens,
    durationMs: Date.now() - startTime,
    promptPreview: task.title.slice(0, 200),
    responsePreview: output.slice(0, 200),
    status,
  };
  ctx.aiHistory.record(entry);
  ctx.broadcastToWeb({ type: "ai.history.new", entry });
  ctx.log(
    "AI_HISTORY",
    `recorded: ${llmConfig.providerId}/${llmConfig.model} ${entry.durationMs}ms tokens=${entry.totalTokens} ${status}`,
  );
}
