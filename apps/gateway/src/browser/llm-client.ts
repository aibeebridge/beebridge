import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions.mjs";
import type {
  FunctionTool as ResponsesFunctionTool,
  ResponseInputItem,
  Response as ResponsesResponse,
} from "openai/resources/responses/responses.mjs";
import { randomUUID } from "node:crypto";

const PROVIDER_BASE_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  xai: "https://api.x.ai/v1",
  openrouter: "https://openrouter.ai/api/v1",
  "github-copilot": "https://api.githubcopilot.com",
};

export interface LlmConfig {
  apiKey: string;
  model: string;
  providerId: string;
  baseUrl?: string;
  contextLimit?: number;
  /** When true, use chatgpt.com/backend-api + Responses API (covered by ChatGPT subscription). */
  codexOAuth?: boolean;
}

const DEFAULT_CONTEXT_LIMITS: Record<string, number> = {
  "gpt-4o": 128_000,
  "gpt-4o-mini": 128_000,
  "gpt-4.1-mini": 128_000,
  "gpt-4.1": 1_000_000,
  "claude-sonnet-4-20250514": 200_000,
  "claude-haiku-3.5": 200_000,
};

const PROVIDER_CONTEXT_OVERRIDES: Record<string, number> = {
  "github-copilot": 64_000,
};

export function resolveContextLimit(config: LlmConfig): number {
  if (config.contextLimit) return config.contextLimit;
  const providerCap = PROVIDER_CONTEXT_OVERRIDES[config.providerId];
  if (providerCap) return providerCap;
  return DEFAULT_CONTEXT_LIMITS[config.model] ?? 128_000;
}

export function estimateMessageTokens(messages: ChatCompletionMessageParam[]): number {
  let chars = 0;
  for (const m of messages) {
    chars += 4;
    if (typeof m.content === "string") { chars += m.content.length; }
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if ("text" in p) chars += (p as { text: string }).text.length;
        if ("image_url" in p) chars += 1000;
      }
    }
  }
  return Math.ceil(chars / 3.5);
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LlmResponse {
  content: string | null;
  toolCalls: ToolCall[];
  finishReason: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}

// ─── GitHub Copilot token exchange ───

let copilotTokenCache: { token: string; expiresAt: number } | null = null;

async function getCopilotToken(githubToken: string): Promise<string> {
  if (copilotTokenCache && Date.now() / 1000 < copilotTokenCache.expiresAt - 60) {
    return copilotTokenCache.token;
  }

  const resp = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: {
      Authorization: `token ${githubToken}`,
      "User-Agent": "beebridge/0.1.0",
    },
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(
      `Copilot token exchange failed (${resp.status}): ${body}. ` +
      "Make sure your GitHub account has an active Copilot license.",
    );
  }

  const data = (await resp.json()) as { token: string; expires_at: number };
  copilotTokenCache = { token: data.token, expiresAt: data.expires_at };
  return data.token;
}

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

const CODEX_BROWSER_HEADERS: Record<string, string> = {
  "Origin": "https://chatgpt.com",
  "Referer": "https://chatgpt.com/",
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
};

async function resolveConfig(config: LlmConfig): Promise<{ apiKey: string; baseURL: string; headers?: Record<string, string> }> {
  if (config.providerId === "github-copilot") {
    const copilotToken = await getCopilotToken(config.apiKey);
    return {
      apiKey: copilotToken,
      baseURL: PROVIDER_BASE_URLS["github-copilot"],
      headers: {
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "vscode/1.96.0",
      },
    };
  }

  if (config.codexOAuth) {
    return {
      apiKey: config.apiKey,
      baseURL: config.baseUrl || CODEX_BASE_URL,
      headers: CODEX_BROWSER_HEADERS,
    };
  }

  return {
    apiKey: config.apiKey,
    baseURL: config.baseUrl || PROVIDER_BASE_URLS[config.providerId] || PROVIDER_BASE_URLS.openai,
    headers: config.providerId === "anthropic"
      ? { "anthropic-version": "2023-06-01" }
      : undefined,
  };
}

export type ChatToolChoice = ChatCompletionToolChoiceOption;

const DEFAULT_LLM_TIMEOUT_MS = 120_000;

// ─── Responses API (Codex OAuth → chatgpt.com/backend-api) ───

function chatToolToResponsesTool(ct: ChatCompletionTool): ResponsesFunctionTool | null {
  if (!("function" in ct) || ct.type !== "function") return null;
  const fn = ct.function;
  return {
    type: "function",
    name: fn.name,
    description: fn.description ?? undefined,
    parameters: (fn.parameters as Record<string, unknown>) ?? null,
    strict: fn.strict ?? null,
  };
}

function messagesToResponsesInput(messages: ChatCompletionMessageParam[]): {
  instructions: string | undefined;
  input: ResponseInputItem[];
} {
  let instructions: string | undefined;
  const input: ResponseInputItem[] = [];

  for (const m of messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : "";
      instructions = instructions ? `${instructions}\n\n${text}` : text;
      continue;
    }
    if (m.role === "user") {
      const text = typeof m.content === "string"
        ? m.content
        : Array.isArray(m.content)
          ? m.content
              .filter((p): p is { type: "text"; text: string } => "text" in p)
              .map((p) => p.text)
              .join("\n")
          : "";
      input.push({ role: "user", content: text } as ResponseInputItem);
      continue;
    }
    if (m.role === "assistant") {
      const text = typeof m.content === "string" ? m.content : "";
      if (text) {
        input.push({ role: "assistant", content: text } as ResponseInputItem);
      }
      const tc = (m as { tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls;
      if (tc) {
        for (const call of tc) {
          if (!call.function.name) continue;
          input.push({
            type: "function_call",
            call_id: call.id,
            name: call.function.name,
            arguments: call.function.arguments,
          } as ResponseInputItem);
        }
      }
      continue;
    }
    if (m.role === "tool") {
      const toolMsg = m as { role: "tool"; tool_call_id: string; content: string };
      input.push({
        type: "function_call_output",
        call_id: toolMsg.tool_call_id,
        output: typeof toolMsg.content === "string" ? toolMsg.content : JSON.stringify(toolMsg.content),
      } as ResponseInputItem);
    }
  }
  return { instructions, input };
}

function parseResponsesOutput(response: ResponsesResponse): LlmResponse {
  let content: string | null = null;
  const toolCalls: ToolCall[] = [];

  for (const item of response.output) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") {
          content = content ? `${content}\n${part.text}` : part.text;
        }
      }
    } else if (item.type === "function_call") {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(item.arguments || "{}");
      } catch {
        /* malformed */
      }
      toolCalls.push({ id: item.call_id, name: item.name, args });
    }
  }

  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";
  const usage = response.usage
    ? {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      }
    : undefined;

  return { content, toolCalls, finishReason, usage };
}

function parseSSEEvents(raw: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  let currentEvent = "";
  let currentData: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
    } else if (line.startsWith("data: ")) {
      currentData.push(line.slice(6));
    } else if (line === "" && currentEvent) {
      events.push({ event: currentEvent, data: currentData.join("\n") });
      currentEvent = "";
      currentData = [];
    }
  }
  if (currentEvent && currentData.length > 0) {
    events.push({ event: currentEvent, data: currentData.join("\n") });
  }
  return events;
}

async function chatWithToolsViaResponses(
  config: LlmConfig,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  options?: { temperature?: number; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<LlmResponse> {
  const resolved = await resolveConfig(config);
  const { instructions, input } = messagesToResponsesInput(messages);
  const responsesTools = tools.length > 0
    ? tools.map(chatToolToResponsesTool).filter((t): t is ResponsesFunctionTool => t !== null)
    : undefined;

  const body: Record<string, unknown> = {
    model: config.model,
    input,
    stream: true,
    store: false,
    ...(instructions ? { instructions } : {}),
    ...(responsesTools && responsesTools.length > 0 ? { tools: responsesTools } : {}),
  };

  const url = `${resolved.baseURL}/responses`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "Authorization": `Bearer ${resolved.apiKey}`,
    "OAI-Device-Id": randomUUID(),
    ...(resolved.headers ?? {}),
  };

  const controller = new AbortController();
  const timeout = options?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeout);
  if (options?.signal) {
    options.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Codex Responses API error: ${res.status} ${errText || "(no body)"}`);
    }

    const sseRaw = await res.text();
    const events = parseSSEEvents(sseRaw);

    const completed = events.find((e) => e.event === "response.completed");
    if (completed) {
      let parsed: unknown;
      try { parsed = JSON.parse(completed.data); } catch {
        /* fall through to delta accumulation */
        parsed = null;
      }
      if (parsed) {
        const obj = parsed as Record<string, unknown>;
        const responseObj = (obj.response ?? obj) as ResponsesResponse;
        if (responseObj.output && responseObj.output.length > 0) {
          return parseResponsesOutput(responseObj);
        }
      }
    }

    let content: string | null = null;
    const toolCalls: ToolCall[] = [];
    const functionMeta = new Map<string, { callId: string; name: string }>();
    const functionArgs = new Map<string, { callId: string; name: string; chunks: string[] }>();

    for (const ev of events) {
      if (ev.event === "response.output_item.added" || ev.event === "response.output_item.done") {
        try {
          const d = JSON.parse(ev.data) as { item?: { id?: string; call_id?: string; name?: string; type?: string } };
          const item = d.item;
          if (item?.type === "function_call" && item.name) {
            const id = item.id ?? item.call_id ?? "";
            functionMeta.set(id, { callId: item.call_id ?? id, name: item.name });
          }
        } catch { /* ignore */ }
      } else if (ev.event === "response.output_text.delta") {
        const d = JSON.parse(ev.data) as { delta?: string };
        if (d.delta) content = (content ?? "") + d.delta;
      } else if (ev.event === "response.function_call_arguments.delta") {
        const d = JSON.parse(ev.data) as { item_id?: string; call_id?: string; name?: string; delta?: string };
        const id = d.item_id ?? d.call_id ?? "";
        if (!functionArgs.has(id)) {
          const meta = functionMeta.get(id);
          functionArgs.set(id, { callId: d.call_id ?? meta?.callId ?? id, name: d.name ?? meta?.name ?? "", chunks: [] });
        }
        if (d.delta) functionArgs.get(id)!.chunks.push(d.delta);
      } else if (ev.event === "response.function_call_arguments.done") {
        const d = JSON.parse(ev.data) as { item_id?: string; call_id?: string; name?: string; arguments?: string };
        const id = d.item_id ?? d.call_id ?? "";
        const existing = functionArgs.get(id);
        const meta = functionMeta.get(id);
        const name = d.name ?? existing?.name ?? meta?.name ?? "";
        const rawArgs = d.arguments ?? existing?.chunks.join("") ?? "{}";
        let args: Record<string, unknown> = {};
        try { args = JSON.parse(rawArgs); } catch { /* malformed */ }
        toolCalls.push({ id: d.call_id ?? meta?.callId ?? id, name, args });
        functionArgs.delete(id);
      }
    }

    for (const [id, fn] of functionArgs) {
      const meta = functionMeta.get(id);
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(fn.chunks.join("")); } catch { /* malformed */ }
      toolCalls.push({ id: fn.callId, name: fn.name || meta?.name || "", args });
    }

    return {
      content,
      toolCalls,
      finishReason: toolCalls.length > 0 ? "tool_calls" : "stop",
      usage: undefined,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ─── Main entry point ───

export async function chatWithTools(
  config: LlmConfig,
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  options?: { toolChoice?: ChatToolChoice; temperature?: number; maxTokens?: number; timeoutMs?: number; signal?: AbortSignal },
): Promise<LlmResponse> {
  if (config.codexOAuth) {
    return chatWithToolsViaResponses(config, messages, tools, options);
  }

  const resolved = await resolveConfig(config);

  const client = new OpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    defaultHeaders: resolved.headers,
    timeout: options?.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS,
  });

  const hasTools = tools.length > 0;
  const toolChoice: ChatCompletionToolChoiceOption | undefined = hasTools
    ? (options?.toolChoice ?? ("auto" as const))
    : undefined;
  const response = await client.chat.completions.create(
    {
      model: config.model,
      messages,
      ...(hasTools ? { tools, tool_choice: toolChoice } : {}),
      temperature: options?.temperature ?? 0.2,
      ...(options?.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
    },
    { signal: options?.signal as AbortSignal | undefined },
  );

  const choice = response.choices[0];
  if (!choice) throw new Error("LLM returned no choices");

  const toolCalls: ToolCall[] = (choice.message.tool_calls || [])
    .filter((tc): tc is typeof tc & { type: "function"; function: { name: string; arguments: string } } =>
      tc.type === "function" && "function" in tc,
    )
    .map((tc) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments || "{}"); }
      catch { /* malformed tool args from LLM — use empty */ }
      return { id: tc.id, name: tc.function.name, args };
    });

  return {
    content: choice.message.content,
    toolCalls,
    finishReason: choice.finish_reason || "stop",
    usage: response.usage
      ? {
          promptTokens: response.usage.prompt_tokens,
          completionTokens: response.usage.completion_tokens,
          totalTokens: response.usage.total_tokens,
        }
      : undefined,
  };
}
