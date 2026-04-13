import type { WaggleConfig } from "@beebridge/core";
import { createHash } from "node:crypto";
import { chatWithTools, type LlmConfig } from "./llm-client.js";
import type { TaskContext } from "./controller.js";
import type { AiHistoryEntry } from "../server/ai-history-store.js";
import type { FlowerCommand, CommandResult } from "./controller.js";
import type { CdpRelayServer } from "./cdp-relay.js";
import { runFlowerCommand } from "./cdp-flower-commands.js";

interface WaggleResult {
  ok: boolean;
  answer: string;
  mode: "browser" | "api";
  latencyMs: number;
  /** True when answer came from interaction-chain replay (no live Flower/ChatGPT round-trip). */
  fromCache?: boolean;
}

/** Ties waggle history to a task/district so the same district can share a waggle pool across bees. */
export type WaggleCallScope = { jobId?: string; districtId?: string; responseLocale?: string };

function isChatGptSiteHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "chatgpt.com" || h === "www.chatgpt.com" || h === "chat.openai.com" || h.endsWith(".openai.com");
}

function isClaudeSiteHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "claude.ai" || h === "www.claude.ai" || h.endsWith(".claude.ai");
}

// ─── Browser Mode (DevTools CDP via loopback relay + chrome.debugger) ───

function localeInstruction(responseLocale: string | undefined): string {
  const loc = responseLocale?.trim();
  if (!loc) return "";
  return `The end user's requested output language is "${loc}". Answer in that language for all user-visible analysis, conclusions, and instructions.\n\n`;
}

function buildFullPrompt(
  question: string,
  questionContext: string | undefined,
  responseLocale?: string,
): string {
  const head = localeInstruction(responseLocale);
  if (!questionContext?.trim()) return head + question;
  return `${head}Context:\n${questionContext.trim()}\n\nQuestion:\n${question}`;
}

async function waggleBrowser(
  question: string,
  questionContext: string | undefined,
  config: WaggleConfig,
  relay: CdpRelayServer,
  ctx: TaskContext,
  scope?: WaggleCallScope,
): Promise<WaggleResult> {
  const start = Date.now();
  const targetUrl = config.browserTargetUrl || "https://chatgpt.com";

  ctx.log("WAGGLE", `browser mode → ${targetUrl}`);

  // No chain replay cache here: browser waggle should open/use the configured web AI via Flower each time.

  try {
    const host = extractHostname(targetUrl);
    let cleaned: string;

    if (isChatGptSiteHost(host) || isClaudeSiteHost(host)) {
      const provider = isClaudeSiteHost(host) ? "claude" : "gpt";
      ctx.log(
        "WAGGLE",
        `Flower CDP path (${provider}): Runtime.evaluate + DOM (ChatGPT/Claude) then poll for reply`,
      );

      const fullPrompt = buildFullPrompt(question, questionContext, scope?.responseLocale);
      const chatCmd = await sendCmd(
        relay,
        { action: "ai_chat", provider, prompt: fullPrompt, url: targetUrl },
        90_000,
      );
      if (!chatCmd.ok) {
        throw new Error(chatCmd.error || "ai_chat failed");
      }
      let submitBody: { ok?: boolean; detail?: string } = {};
      try {
        submitBody = JSON.parse(chatCmd.data || "{}") as { ok?: boolean; detail?: string };
      } catch {
        /* ignore */
      }
      if (submitBody.ok === false) {
        throw new Error(String(submitBody.detail || "ai_chat did not submit prompt"));
      }

      const readCmd = await sendCmd(
        relay,
        { action: "ai_read_response", provider, timeout: 120_000, url: targetUrl },
        150_000,
      );
      if (!readCmd.ok) {
        throw new Error(readCmd.error || "ai_read_response failed");
      }
      const answer = String(readCmd.data ?? "").trim();
      if (!answer) throw new Error("No response text from AI website after submit");
      cleaned = answer.slice(0, 4000);
    } else {
      const ensure = await sendCmd(relay, { action: "waggle_ensure", url: targetUrl });
      if (!ensure.ok) throw new Error(ensure.error || "waggle_ensure failed");

      await sendCmd(relay, { action: "wait", ms: 2000 });

      const snap1 = await sendCmd(relay, { action: "snapshot", useWaggleTab: true });
      const snapshotText = parseSnapshotText(snap1);

      let cachedInputKeywords: string[] | null = null;
      let cachedSubmitKeywords: string[] | null = null;
      if (ctx.chainStore) {
        const siteHint = ctx.chainStore.lookup({ domain: extractHostname(targetUrl), intent: "site_structure" });
        if (siteHint) {
          ctx.log("CHAIN", `site structure cache hit for ${extractHostname(targetUrl)}`);
          try {
            const parsed = JSON.parse(siteHint.result);
            cachedInputKeywords = parsed.inputKeywords ?? null;
            cachedSubmitKeywords = parsed.submitKeywords ?? null;
          } catch { /* ignore */ }
        }
      }

      const inputUid = findInputUid(snapshotText, cachedInputKeywords);
      if (!inputUid) throw new Error("Could not find input field on AI website");

      const fillPrompt = buildFullPrompt(question, questionContext);
      const fillResult = await sendCmd(relay, {
        action: "fill",
        uid: inputUid,
        text: fillPrompt,
        useWaggleTab: true,
      });
      if (!fillResult.ok) throw new Error(`fill failed: ${fillResult.error}`);

      await sendCmd(relay, { action: "wait", ms: 1000 });

      const submitUid = findSubmitUid(snapshotText, cachedSubmitKeywords);
      if (submitUid) {
        await sendCmd(relay, { action: "click", uid: submitUid, useWaggleTab: true });
      } else {
        await sendCmd(relay, { action: "click", uid: inputUid, useWaggleTab: true });
        await sendCmd(relay, { action: "wait", ms: 500 });
      }

      let answer = "";
      let stableCount = 0;
      for (let attempt = 0; attempt < 15; attempt++) {
        await sendCmd(relay, { action: "wait", ms: 3000 });

        const pollSnap = await sendCmd(relay, { action: "snapshot", useWaggleTab: true });
        const pollContent = parseSnapshotContent(pollSnap);

        if (pollContent === answer) {
          stableCount++;
          if (stableCount >= 2 && answer.length > 100) break;
        } else {
          answer = pollContent;
          stableCount = 0;
        }
      }

      if (!answer) throw new Error("No response received from AI website");

      cleaned = answer.slice(0, 4000);

      if (ctx.chainStore) {
        const h = extractHostname(targetUrl);
        ctx.chainStore.record(
          { domain: h, intent: "site_structure" },
          ["waggle_ensure", "snapshot", "fill", "click", "wait", "snapshot"],
          [{ url: targetUrl }],
          JSON.stringify({
            inputKeywords: extractMatchedKeywords(snapshotText, inputUid),
            submitKeywords: extractMatchedKeywords(snapshotText, submitUid),
          }),
          "success",
          0,
          Date.now() - start,
          undefined,
          `Site structure for ${h}`,
        );
      }
    }

    ctx.log("WAGGLE", `browser response: ${cleaned.slice(0, 100)}...`);

    recordWaggleHistory(ctx, "waggle_browser", targetUrl, question, cleaned, Date.now() - start, 0, 0, "success", scope);

    if (ctx.chainStore) {
      const chainHost = extractHostname(targetUrl);
      const questionHash = hashQuestion(question);
      ctx.chainStore.record(
        { domain: chainHost, intent: questionHash },
        ["waggle_browser"],
        [{ question: question.slice(0, 200) }],
        cleaned,
        "success",
        0,
        Date.now() - start,
        undefined,
        `Waggle Q&A on ${chainHost}`,
      );
      ctx.log("CHAIN", `recorded waggle browser result for ${chainHost}`);
    }

    return { ok: true, answer: cleaned, mode: "browser", latencyMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log("WAGGLE", `browser error: ${msg}`);
    if (ctx.chainStore) {
      const host = extractHostname(targetUrl);
      ctx.chainStore.invalidate({ domain: host, intent: "site_structure" });
      ctx.log("CHAIN", `invalidated site_structure cache for ${host}`);
    }
    recordWaggleHistory(ctx, "waggle_browser", targetUrl, question, msg, Date.now() - start, 0, 0, "error", scope);
    return { ok: false, answer: `Waggle browser error: ${msg}`, mode: "browser", latencyMs: Date.now() - start };
  }
}

// ─── API Mode ───

async function waggleApi(
  question: string,
  questionContext: string | undefined,
  config: WaggleConfig,
  ctx: TaskContext,
  scope?: WaggleCallScope,
): Promise<WaggleResult> {
  const locLine = localeInstruction(scope?.responseLocale);
  const start = Date.now();
  const providerId = config.apiProviderId || "openai";
  const model = config.apiModel || "gpt-4o";
  ctx.log("WAGGLE", `api mode → ${providerId}/${model}`);

  if (ctx.chainStore) {
    const qHash = hashQuestion(question);
    const cached = ctx.chainStore.lookup({ domain: `${providerId}/${model}`, intent: qHash }, 0.8);
    if (cached) {
      ctx.log("CHAIN", `waggle API cache hit (score=${cached.score.toFixed(2)})`);
      const estimatedTokens = Math.round(question.length / 4 + cached.result.length / 4);
      ctx.chainStore.recordTokensSaved(estimatedTokens);
      recordWaggleHistory(ctx, "waggle_api_cached", `${providerId}/${model}`, question, cached.result, Date.now() - start, 0, 0, "success", scope);
      return {
        ok: true,
        answer: cached.result,
        mode: "api",
        latencyMs: Date.now() - start,
        fromCache: true,
      };
    }
  }

  try {
    const apiKey = config.apiKey || ctx.pmSettings.getActiveProfile()?.secret;
    if (!apiKey) throw new Error("No API key configured for waggle API mode");

    const llmConfig: LlmConfig = { apiKey, model, providerId };

    const systemPrompt =
      locLine +
      "You are the supervisor for a separate browser automation agent that follows your instructions literally. " +
      "Answer thoroughly and precisely with actionable, ordered steps (what URLs to open, what to look for, what to try if something fails). " +
      "Assume the executor is a smaller model: avoid vague advice; name specific sites or search queries when helpful.";

    const userContent = questionContext
      ? `Context:\n${questionContext}\n\nQuestion:\n${question}`
      : question;

    const result = await chatWithTools(
      llmConfig,
      [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      [],
    );

    const answer = result.content ?? "No response from higher-tier LLM";
    ctx.log("WAGGLE", `api response: ${answer.slice(0, 100)}...`);

    const inputTokens = result.usage?.promptTokens ?? 0;
    const outputTokens = result.usage?.completionTokens ?? 0;
    recordWaggleHistory(ctx, "waggle_api", `${providerId}/${model}`, question, answer, Date.now() - start, inputTokens, outputTokens, "success", scope);

    if (ctx.chainStore) {
      const qHash = hashQuestion(question);
      ctx.chainStore.record(
        { domain: `${providerId}/${model}`, intent: qHash },
        ["waggle_api"],
        [{ question: question.slice(0, 200) }],
        answer,
        "success",
        inputTokens + outputTokens,
        Date.now() - start,
        undefined,
        `Waggle API Q&A via ${providerId}/${model}`,
      );
      ctx.log("CHAIN", `recorded waggle API result for ${providerId}/${model}`);
    }

    return { ok: true, answer, mode: "api", latencyMs: Date.now() - start };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.log("WAGGLE", `api error: ${msg}`);
    recordWaggleHistory(ctx, "waggle_api", `${providerId}/${model}`, question, msg, Date.now() - start, 0, 0, "error", scope);
    return { ok: false, answer: `Waggle API error: ${msg}`, mode: "api", latencyMs: Date.now() - start };
  }
}

// ─── Router ───

export async function executeWaggle(
  question: string,
  questionContext: string | undefined,
  config: WaggleConfig,
  relay: CdpRelayServer | undefined,
  ctx: TaskContext,
  scope?: WaggleCallScope,
): Promise<WaggleResult> {
  if (config.mode === "browser") {
    if (!relay?.isReady()) {
      return {
        ok: false,
        answer:
          "Waggle browser mode requires the Flower CDP relay: extension connected and debugger attached to a tab (click the beebridge icon on the tab).",
        mode: "browser",
        latencyMs: 0,
      };
    }
    return waggleBrowser(question, questionContext, config, relay, ctx, scope);
  }
  return waggleApi(question, questionContext, config, ctx, scope);
}

// ─── Helpers ───

function sendCmd(relay: CdpRelayServer, cmd: FlowerCommand, timeoutMs = 30_000): Promise<CommandResult> {
  return runFlowerCommand(relay, cmd, timeoutMs);
}

function parseSnapshotText(result: CommandResult): string {
  try {
    const parsed = JSON.parse(result.data || "{}");
    return parsed.snapshot ?? result.data ?? "";
  } catch {
    return result.data ?? "";
  }
}

function parseSnapshotContent(result: CommandResult): string {
  const full = parseSnapshotText(result);
  const marker = "--- content ---";
  const idx = full.indexOf(marker);
  if (idx >= 0) {
    return full.slice(idx + marker.length).trim();
  }
  // Fallback: take everything after the last "---" separator
  const parts = full.split("---");
  if (parts.length > 1) {
    return parts[parts.length - 1].trim();
  }
  return full;
}

function findInputUid(snapshot: string, cachedKeywords?: string[] | null): string | null {
  const lines = snapshot.split("\n");

  if (cachedKeywords && cachedKeywords.length > 0) {
    for (const line of lines) {
      const m = line.match(/^\[(\d+)\]\s+/);
      if (!m) continue;
      const lower = line.toLowerCase();
      if (cachedKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
        return m[1];
      }
    }
  }

  const defaultKeywords = ["textarea", "contenteditable", "textbox", "prosemirror", "prompt", "message", "chat"];
  for (const line of lines) {
    const m = line.match(/^\[(\d+)\]\s+/);
    if (!m) continue;
    const lower = line.toLowerCase();
    if (defaultKeywords.some((kw) => lower.includes(kw))) {
      return m[1];
    }
  }
  let lastTextarea: string | null = null;
  let lastInput: string | null = null;
  for (const line of lines) {
    const m = line.match(/^\[(\d+)\]\s+/);
    if (!m) continue;
    const lower = line.toLowerCase();
    if (lower.includes("textarea")) lastTextarea = m[1];
    if (lower.includes("input[type=text]")) lastInput = m[1];
  }
  return lastTextarea ?? lastInput ?? null;
}

function findSubmitUid(snapshot: string, cachedKeywords?: string[] | null): string | null {
  const lines = snapshot.split("\n");

  if (cachedKeywords && cachedKeywords.length > 0) {
    for (const line of lines) {
      const m = line.match(/^\[(\d+)\]\s+/);
      if (!m) continue;
      const lower = line.toLowerCase();
      if (cachedKeywords.some((kw) => lower.includes(kw.toLowerCase()))) {
        return m[1];
      }
    }
  }

  for (const line of lines) {
    const m = line.match(/^\[(\d+)\]\s+/);
    if (!m) continue;
    const lower = line.toLowerCase();
    if (
      lower.includes("send") ||
      lower.includes("submit") ||
      lower.includes("arrow")
    ) {
      if (lower.includes("button") || lower.includes("[role=button]")) {
        return m[1];
      }
    }
  }
  return null;
}

function hashQuestion(question: string): string {
  return createHash("md5").update(question.trim().toLowerCase()).digest("hex").slice(0, 16);
}

function extractHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function extractMatchedKeywords(snapshot: string, uid: string | null): string[] {
  if (!uid) return [];
  const lines = snapshot.split("\n");
  for (const line of lines) {
    const m = line.match(/^\[(\d+)\]\s+(.*)$/);
    if (m && m[1] === uid) {
      return m[2]
        .toLowerCase()
        .split(/[\s'"=\[\]]+/)
        .filter((w) => w.length > 2);
    }
  }
  return [];
}

// Unified history recording for waggle calls
function recordWaggleHistory(
  ctx: TaskContext,
  action: string,
  target: string,
  question: string,
  response: string,
  durationMs: number,
  inputTokens: number,
  outputTokens: number,
  status: "success" | "error" = "success",
  scope?: WaggleCallScope,
): void {
  const previewCap = 500;
  const entry: AiHistoryEntry = {
    id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    provider: target,
    model: action === "waggle_browser" || action === "waggle_browser_cached" ? "browser-cdp" : target.split("/")[1] || "unknown",
    jobId: scope?.jobId,
    districtId: scope?.districtId,
    action,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    durationMs,
    promptPreview: question.slice(0, previewCap),
    responsePreview: response.slice(0, previewCap),
    status,
  };
  ctx.aiHistory.record(entry);
  ctx.broadcastToWeb({ type: "ai.history.new", entry });
  ctx.log("AI_HISTORY", `waggle recorded: ${action} ${durationMs}ms tokens=${entry.totalTokens} ${status}`);
}
