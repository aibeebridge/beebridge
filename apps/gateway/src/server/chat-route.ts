/**
 * Phase 1: Classify user query by topic (routing) + locale / browser / Waggle intent
 * Phase 2: Include only topic-relevant context in the answer prompt
 */

export const CHAT_TOPIC_IDS = [
  "flower",
  "pm_settings",
  "workspace",
  "bridges",
  "graph",
  "jobs",
  "general",
] as const;

export type ChatTopicId = (typeof CHAT_TOPIC_IDS)[number];

export type ChatRouteResult = {
  topics: ChatTopicId[];
  primary: ChatTopicId;
  reason: string;
  /** BCP-47-style primary language for user-visible replies (e.g. ko, en, ja). */
  responseLocale: string;
  /** User needs live browser automation (open URLs, interact with real pages). */
  needsLiveBrowser: boolean;
  /** User benefits from Waggle supervisor (higher-tier model / web AI), not only unattended browsing. */
  needsWaggleSupervisor: boolean;
};

const VALID_TOPICS = new Set<string>(CHAT_TOPIC_IDS);

export const CHAT_ROUTING_SYSTEM_PROMPT = `You are a strict query router for the beebridge app. Your ONLY job is to classify the user's message.

Output a single JSON object. No markdown fences, no commentary.

Schema:
{"topics":["<id>",...],"primary":"<id>","reason":"<short English or Korean why>","responseLocale":"<bcp47>","needsLiveBrowser":<bool>,"needsWaggleSupervisor":<bool>}

Topic ids (pick one or more; order by relevance):
- flower — Beebridge Flower: Chrome extension, WebSocket to gateway, CDP/chrome.debugger relay, browser automation, extension attach
- pm_settings — default AI model, provider, auth profiles, API login, model selection
- workspace — workspace folder path, data directory, workspace configuration
- bridges — District bridges (district ↔ district links in the app), data flow between districts, "district bridge" (NOT Flower)
- graph — project graph: districts, tasks, bees, dependencies in the graph (general tasks and districts)
- jobs — job queue, approvals, pending tasks, execution queue, approval queue
- general — greeting, unclear, or needs broad context from multiple areas

Intent fields:
- responseLocale: Primary language the user is writing in, as a short BCP-47 tag (e.g. "ko", "en", "ja"). If mixed or unclear, use "und".
- needsLiveBrowser: true if the user needs to open or interact with real websites (URLs, "open this page", "read this blog", login, forms, live data from the web). false for pure chat, pasted text only, or local/repo work without visiting a site.
- needsWaggleSupervisor: true if the task benefits from a higher-tier supervisor (complex multi-step reasoning, deep analysis, comparing sources) IN ADDITION to browser tools. false for simple "open URL and summarize/extract" where automation alone is enough.

Rules:
- If the user mixes topics (e.g. Flower + bridges), include both in "topics".
- "primary" is the single best main focus.
- Do NOT answer the user's question; only classify.`;

const INTENT_FALLBACK: Pick<
  ChatRouteResult,
  "responseLocale" | "needsLiveBrowser" | "needsWaggleSupervisor"
> = {
  responseLocale: "und",
  needsLiveBrowser: false,
  needsWaggleSupervisor: false,
};

function normalizeLocaleTag(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t) return undefined;
  const lower = t.toLowerCase();
  if (lower === "und" || /^[a-z]{2,3}(-[a-z0-9]+)*$/i.test(t)) return lower.split("_").join("-").slice(0, 16);
  return undefined;
}

/** When router returns und or missing locale, infer from message text. */
export function refineResponseLocaleFromUserMessage(
  userMessage: string,
  responseLocale: string,
): string {
  const trimmed = userMessage.trim();
  if (responseLocale && responseLocale !== "und") {
    return responseLocale.split("-")[0].toLowerCase();
  }
  if (/[\uAC00-\uD7AF]/.test(trimmed)) return "ko";
  if (/[\u3040-\u30ff\u31f0-\u31ff]/.test(trimmed)) return "ja";
  if (/[\u4e00-\u9fff]/.test(trimmed)) return "zh";
  if (trimmed.length > 0) return "en";
  return "en";
}

export function parseChatRouteJson(raw: string | null): ChatRouteResult {
  const fallback: ChatRouteResult = {
    topics: ["general"],
    primary: "general",
    reason: "parse_fallback",
    ...INTENT_FALLBACK,
    responseLocale: "und",
  };
  if (!raw?.trim()) return fallback;
  let text = raw.trim();
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)```$/m);
  if (fence) text = fence[1].trim();
  try {
    const o = JSON.parse(text) as {
      topics?: unknown;
      primary?: unknown;
      reason?: unknown;
      responseLocale?: unknown;
      needsLiveBrowser?: unknown;
      needsWaggleSupervisor?: unknown;
    };
    const topicsRaw = Array.isArray(o.topics) ? o.topics : [];
    const topics = topicsRaw
      .filter((t): t is string => typeof t === "string" && VALID_TOPICS.has(t))
      .filter((t, i, a) => a.indexOf(t) === i) as ChatTopicId[];
    if (topics.length === 0) return fallback;
    const primary =
      typeof o.primary === "string" && VALID_TOPICS.has(o.primary)
        ? (o.primary as ChatTopicId)
        : topics[0];
    const reason = typeof o.reason === "string" ? o.reason : "";

    const loc = normalizeLocaleTag(o.responseLocale) ?? "und";
    const needsLiveBrowser = o.needsLiveBrowser === true;
    const needsWaggleSupervisor = o.needsWaggleSupervisor === true;

    return {
      topics,
      primary,
      reason,
      responseLocale: loc,
      needsLiveBrowser,
      needsWaggleSupervisor,
    };
  } catch {
    return fallback;
  }
}

/**
 * Apply heuristic locale refinement and keep intent flags consistent with router output.
 */
export function refineChatIntentFromUserMessage(userMessage: string, route: ChatRouteResult): ChatRouteResult {
  return {
    ...route,
    responseLocale: refineResponseLocaleFromUserMessage(userMessage, route.responseLocale),
  };
}

export type ContextParts = {
  runtime: string;
  bridges: string;
  graph: string;
  jobs: string;
};

/** Same blocks as router topic `general`: full workspace snapshot for tool-heavy channels (e.g. Discord). */
export function buildFullWorkspaceContext(parts: ContextParts): string {
  return [parts.runtime, parts.bridges, parts.graph, parts.jobs].join("\n\n");
}

/** Concatenate only the context blocks needed for each topic. Include all if topic is general. */
export function selectContextBlocksForTopics(topics: ChatTopicId[], parts: ContextParts): string {
  const set = new Set(topics);
  if (set.has("general")) {
    return buildFullWorkspaceContext(parts);
  }
  const out: string[] = [];
  if (set.has("flower") || set.has("pm_settings") || set.has("workspace")) {
    out.push(parts.runtime);
  }
  if (set.has("bridges")) out.push(parts.bridges);
  if (set.has("graph")) out.push(parts.graph);
  if (set.has("jobs")) out.push(parts.jobs);
  if (out.length === 0) {
    out.push(parts.runtime, parts.graph);
  }
  return out.join("\n\n");
}

export function buildChatAnswerSystemPrompt(
  route: ChatRouteResult,
  contextBlock: string,
  actionPromptSegment?: string,
): string {
  const topicHints: Record<ChatTopicId, string> = {
    flower: "Flower = browser extension / WebSocket / CDP relay — NOT a graph node.",
    pm_settings: "Model & auth — from runtime snapshot only.",
    workspace: "Workspace path — from runtime snapshot.",
    bridges: "District bridges = links between districts — NOT Flower integration.",
    graph: "Districts, tasks, bees — from graph summary.",
    jobs: "Approvals & task counts — from jobs block.",
    general: "Use all provided context blocks as needed.",
  };

  const hints = route.topics.map((t) => `- ${t}: ${topicHints[t]}`).join("\n");

  const actionBlock = actionPromptSegment
    ? `\n${actionPromptSegment}\n`
    : "";

  const intentBlock = `
Intent (from router — you MUST follow this when choosing tools and languages):
- responseLocale: ${route.responseLocale} — all user-visible text (replies and setup_plan missions/titles when you write for the user) MUST be in this language unless the user explicitly asks for another language.
- needsLiveBrowser: ${route.needsLiveBrowser} — when calling setup_plan, set each bee's needsBrowser to true only if live web access matches this (or the user explicitly requires browsing).
- needsWaggleSupervisor: ${route.needsWaggleSupervisor} — when calling setup_plan, set waggleMode to "browser" only if this is true or the user explicitly wants supervisor / Waggle; otherwise use waggleMode "off". Set each bee's needsWaggle to true only when enabling Waggle browser mode for that bee.
`;

  return `You are the beebridge assistant.

Routing (you MUST respect this scope):
- classified topics: ${route.topics.join(", ")}
- primary: ${route.primary}
- router note: ${route.reason || "(none)"}
${intentBlock}
Topic hints:
${hints}
${actionBlock}
Answer using ONLY the context below (and tool results if any). Do not invent gateway state. For Flower questions, never claim "no data" because the graph is empty — Flower status is in the runtime block when included.

Context:
${contextBlock}

Respond in the same language as responseLocale above. Be concise.`;
}
