/**
 * Shared chat pipeline for HTTP /api/chat and Discord Flower inbound messages.
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { chatWithTools, type LlmConfig, type LlmResponse } from "../browser/llm-client.js";
import { resolveOpenAiSecretToApiKey } from "../browser/openai-codex-token.js";
import type { PmSettingsStore } from "../settings/store.js";
import type { GraphStore } from "./graph-store.js";
import type { AiHistoryStore } from "./ai-history-store.js";
import {
  CHAT_ROUTING_SYSTEM_PROMPT,
  parseChatRouteJson,
  refineChatIntentFromUserMessage,
  selectContextBlocksForTopics,
  buildFullWorkspaceContext,
  buildChatAnswerSystemPrompt,
  type ChatRouteResult,
} from "./chat-route.js";
import {
  CHAT_ACTION_TOOLS,
  CHAT_ACTION_PROMPT_SEGMENT,
  DISCORD_INBOUND_CHAT_ACTION_APPEND,
} from "./chat-tools.js";

const MAX_TOOL_ROUNDS = 5;
const MAX_TOOL_ROUNDS_DISCORD_ACTIONS = 8;

/** When chat action tools are disabled (e.g. Discord inbound), tell the model not to invoke tools. */
const NO_CHAT_ACTION_PROMPT_SEGMENT =
  "You do NOT have any function tools in this session. Answer using only the context blocks below. " +
  "If the user asks to change workspace state, explain that actions are disabled from this channel and they should use the web Chat tab. " +
  "Do not invent system errors, approval failures, or pretend you attempted backend operations you cannot perform.";

export type RunChatMessageDeps = {
  pmSettings: PmSettingsStore;
  graphStore: GraphStore;
  buildRuntimeSnapshot: () => string;
  buildBridgesBlock: () => string;
  buildJobsBlock: () => string;
  executeChatTool: (name: string, args: Record<string, unknown>) => string;
  aiHistory: AiHistoryStore;
  log: (tag: string, detail: string) => void;
};

export type ChatHistoryItem = { role: "user" | "assistant"; content: string };

export type RunChatSuccess = {
  ok: true;
  reply: string;
  actions?: string[];
  actionDetails?: { name: string; ok: boolean; summary: string }[];
};

export type RunChatFailure = {
  ok: false;
  code: "no_profile" | "empty_message" | "llm_error";
  error: string;
};

export type RunChatResult = RunChatSuccess | RunChatFailure;

const MAX_HISTORY_TOTAL_CHARS = 60_000;

export function sanitizeChatHistory(raw: unknown): ChatCompletionMessageParam[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatCompletionMessageParam[] = [];
  for (const row of raw.slice(-24)) {
    if (!row || typeof row !== "object") continue;
    const role = (row as { role?: unknown }).role;
    const content = (row as { content?: unknown }).content;
    if (role !== "user" && role !== "assistant") continue;
    if (typeof content !== "string" || !content.trim()) continue;
    const trimmed = content.length > 12000 ? `${content.slice(0, 12000)}…` : content;
    out.push({ role, content: trimmed });
  }

  let totalChars = 0;
  for (let i = out.length - 1; i >= 0; i--) {
    const len = typeof out[i].content === "string" ? (out[i].content as string).length : 0;
    totalChars += len;
    if (totalChars > MAX_HISTORY_TOTAL_CHARS) {
      out.splice(0, i);
      break;
    }
  }

  return out;
}

function lastChatMessageIsTool(msgs: ChatCompletionMessageParam[]): boolean {
  const last = msgs[msgs.length - 1];
  return last?.role === "tool";
}

function recordChatHistoryError(
  store: AiHistoryStore,
  opts: {
    promptPreview: string;
    provider: string;
    model: string;
    durationMs: number;
    error: string;
    inputTokens?: number;
    outputTokens?: number;
  },
): void {
  const inputTokens = opts.inputTokens ?? 0;
  const outputTokens = opts.outputTokens ?? 0;
  store.record({
    id: `chat-${Date.now()}`,
    timestamp: new Date().toISOString(),
    provider: opts.provider,
    model: opts.model,
    action: "chat",
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs: opts.durationMs,
    status: "error",
    error: opts.error,
    promptPreview: opts.promptPreview.slice(0, 200),
    responsePreview: "",
  });
}

async function classifyChatQuery(
  userMessage: string,
  config: LlmConfig,
): Promise<{ route: ChatRouteResult; usage: LlmResponse["usage"] }> {
  const routeLlm = await chatWithTools(
    config,
    [
      { role: "system", content: CHAT_ROUTING_SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    [],
    { temperature: 0, maxTokens: 420 },
  );
  const parsed = parseChatRouteJson(routeLlm.content);
  const route = refineChatIntentFromUserMessage(userMessage, parsed);
  return { route, usage: routeLlm.usage };
}

export async function runChatMessage(params: {
  userMessage: string;
  imageUrls?: string[];
  history?: unknown;
  deps: RunChatMessageDeps;
  /** Default true. When false, no CHAT_ACTION_TOOLS loop (answer-only). */
  chatActionToolsEnabled?: boolean;
  /** When true, include runtime+bridges+graph+jobs regardless of router topics (e.g. Discord with tools on). */
  fullWorkspaceContext?: boolean;
  /** Discord Flower inbound: higher tool round limit + extra action guidance when tools are on. */
  discordInbound?: boolean;
}): Promise<RunChatResult> {
  const chatActionToolsEnabled = params.chatActionToolsEnabled !== false;
  const userMessage = String(params.userMessage ?? "").trim();
  if (!userMessage) {
    return { ok: false, code: "empty_message", error: "message is required" };
  }

  const profile = params.deps.pmSettings.getActiveProfile();
  if (!profile) {
    recordChatHistoryError(params.deps.aiHistory, {
      promptPreview: userMessage,
      provider: "(none)",
      model: "(none)",
      durationMs: 0,
      error: "no_profile: No active auth profile. Configure one in Settings.",
    });
    return {
      ok: false,
      code: "no_profile",
      error: "No active auth profile. Configure one in Settings.",
    };
  }

  const priorHistory = sanitizeChatHistory(params.history);

  const graphSummary = params.deps.graphStore.summarize();
  const contextParts = {
    runtime: params.deps.buildRuntimeSnapshot(),
    bridges: params.deps.buildBridgesBlock(),
    graph: `=== Project graph (districts / tasks / bees) ===\n${graphSummary}\n=== End graph ===`,
    jobs: params.deps.buildJobsBlock(),
  };

  const policy = params.deps.pmSettings.getModelPolicy();
  let apiKey = profile.secret;
  let codexOAuth = false;
  if (profile.providerId === "openai" && profile.secret.trim().startsWith("{")) {
    const resolved = await resolveOpenAiSecretToApiKey(profile.secret, (s) => {
      params.deps.pmSettings.updateProfileSecret(profile.id, s);
    });
    apiKey = resolved.apiKey;
    codexOAuth = resolved.codexOAuth;
  }
  const config: LlmConfig = {
    providerId: profile.providerId ?? "github-copilot",
    apiKey,
    model: policy.defaultModel ?? "gpt-4o",
    codexOAuth,
  };

  const startMs = Date.now();
  let overflowRetried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const { route, usage: routeUsage } = await classifyChatQuery(userMessage, config);
      params.deps.log(
        "CHAT",
        `route topics=${route.topics.join(",")} primary=${route.primary} locale=${route.responseLocale} needsBrowser=${route.needsLiveBrowser} needsWaggle=${route.needsWaggleSupervisor} ${route.reason ? `(${route.reason})` : ""}`,
      );

      let contextBlock = params.fullWorkspaceContext
        ? buildFullWorkspaceContext(contextParts)
        : selectContextBlocksForTopics(route.topics, contextParts);
      const MAX_CONTEXT_BLOCK = 40_000;
      if (contextBlock.length > MAX_CONTEXT_BLOCK) {
        contextBlock = contextBlock.slice(0, MAX_CONTEXT_BLOCK) + "\n\n[... workspace context truncated]";
      }

      let actionSegment = chatActionToolsEnabled ? CHAT_ACTION_PROMPT_SEGMENT : NO_CHAT_ACTION_PROMPT_SEGMENT;
      if (chatActionToolsEnabled && params.discordInbound) {
        actionSegment = `${CHAT_ACTION_PROMPT_SEGMENT}${DISCORD_INBOUND_CHAT_ACTION_APPEND}`;
      }
      const answerSystem = buildChatAnswerSystemPrompt(route, contextBlock, actionSegment);

      let imageDataUrls: string[] = [];
      if (params.imageUrls && params.imageUrls.length > 0) {
        imageDataUrls = await Promise.all(
          params.imageUrls.map(async (url) => {
            try {
              const resp = await fetch(url);
              if (!resp.ok) return url;
              const buf = Buffer.from(await resp.arrayBuffer());
              const ct = resp.headers.get("content-type") || "image/png";
              return `data:${ct};base64,${buf.toString("base64")}`;
            } catch {
              return url;
            }
          }),
        );
      }

      const userContent: ChatCompletionMessageParam["content"] =
        imageDataUrls.length > 0
          ? [
              { type: "text" as const, text: userMessage },
              ...imageDataUrls.map((dataUrl) => ({
                type: "image_url" as const,
                image_url: { url: dataUrl, detail: "auto" as const },
              })),
            ]
          : userMessage;

      const messages: ChatCompletionMessageParam[] = [
        { role: "system", content: answerSystem },
        ...priorHistory,
        { role: "user", content: userContent },
      ];

      let totalInputTokens = routeUsage?.promptTokens ?? 0;
      let totalOutputTokens = routeUsage?.completionTokens ?? 0;
      const executedActions: string[] = [];
      const actionDetails: { name: string; ok: boolean; summary: string }[] = [];

      const toolsForRound = chatActionToolsEnabled ? CHAT_ACTION_TOOLS : [];
      const maxToolRounds =
        chatActionToolsEnabled && params.discordInbound ? MAX_TOOL_ROUNDS_DISCORD_ACTIONS : MAX_TOOL_ROUNDS;

      const CHAT_TOOL_RESULT_CAP = 30_000;

      let finalContent = "";
      for (let round = 0; round < maxToolRounds; round++) {
        const result = await chatWithTools(config, messages, toolsForRound);
        totalInputTokens += result.usage?.promptTokens ?? 0;
        totalOutputTokens += result.usage?.completionTokens ?? 0;

        if (result.toolCalls.length === 0) {
          finalContent = result.content ?? "";
          break;
        }

        const assistantMsg: ChatCompletionMessageParam = {
          role: "assistant",
          content: result.content ?? null,
          tool_calls: result.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        };
        messages.push(assistantMsg);

        for (const tc of result.toolCalls) {
          params.deps.log("CHAT", `tool_call: ${tc.name}(${JSON.stringify(tc.args).slice(0, 200)})`);
          let toolResult: string;
          try {
            toolResult = params.deps.executeChatTool(tc.name, tc.args);
            executedActions.push(`${tc.name}: OK`);
          } catch (toolErr) {
            toolResult = `Error: ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
            executedActions.push(`${tc.name}: FAILED`);
          }
          if (toolResult.length > CHAT_TOOL_RESULT_CAP) {
            toolResult = toolResult.slice(0, CHAT_TOOL_RESULT_CAP) + `\n\n[... output truncated at ${CHAT_TOOL_RESULT_CAP} chars]`;
          }
          const ok = !toolResult.startsWith("Error:");
          actionDetails.push({ name: tc.name, ok, summary: toolResult.slice(0, 500) });
          messages.push({ role: "tool", tool_call_id: tc.id, content: toolResult });
        }
      }

      if (!finalContent.trim() && lastChatMessageIsTool(messages)) {
        const closing = await chatWithTools(config, messages, [], { maxTokens: 700, temperature: 0.2 });
        totalInputTokens += closing.usage?.promptTokens ?? 0;
        totalOutputTokens += closing.usage?.completionTokens ?? 0;
        const text = closing.content?.trim() ?? "";
        finalContent = text || "Tool round limit reached; some actions may be incomplete. Check the dashboard.";
      }

      if (!finalContent && executedActions.length > 0) {
        finalContent = `Actions executed: ${executedActions.join(", ")}`;
      }

      const latencyMs = Date.now() - startMs;
      params.deps.aiHistory.record({
        id: `chat-${Date.now()}`,
        timestamp: new Date().toISOString(),
        provider: config.providerId,
        model: config.model,
        action: "chat",
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        durationMs: latencyMs,
        status: "success",
        promptPreview: userMessage.slice(0, 200),
        responsePreview: finalContent.slice(0, 500),
        ...(executedActions.length > 0 ? { actions: executedActions } : {}),
        ...(actionDetails.length > 0 ? { actionDetails } : {}),
      });

      if (chatActionToolsEnabled && executedActions.length === 0) {
        const lower = finalContent.toLowerCase();
        const suspectNoTool =
          /error|fail(ed|ure)?|problem\s*(occurred|detected)|system\s*(issue|error)/.test(lower);
        if (suspectNoTool) {
          params.deps.log(
            "CHAT",
            `warn: tools enabled but none invoked; reply contains failure keywords — model may have fabricated an error`,
          );
        }
      }

      const out: RunChatSuccess = { ok: true, reply: finalContent };
      if (executedActions.length > 0) out.actions = executedActions;
      if (actionDetails.length > 0) out.actionDetails = actionDetails;
      return out;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      if (!overflowRetried && /token.*(count|limit)|exceeds.*limit|context.*length/i.test(msg)) {
        params.deps.log("CHAT", `Context overflow detected, trimming history and retrying...`);
        priorHistory.splice(0, Math.ceil(priorHistory.length / 2));
        overflowRetried = true;
        continue;
      }

      params.deps.log("CHAT", `error: ${msg}`);
      recordChatHistoryError(params.deps.aiHistory, {
        promptPreview: userMessage,
        provider: config.providerId,
        model: config.model,
        durationMs: Date.now() - startMs,
        error: msg,
      });
      return { ok: false, code: "llm_error", error: msg };
    }
  }

  return { ok: false, code: "llm_error", error: "Chat failed after overflow retry" };
}
