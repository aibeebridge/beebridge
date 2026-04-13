/**
 * Maps legacy Flower commands to CDP (via CdpRelayServer) — same CommandResult shape as extension path.
 */
import type { CommandResult, FlowerCommand } from "./controller.js";
import type { CdpRelayServer } from "./cdp-relay.js";

const SNAPSHOT_FN = `(function(){
  var INTERACTIVE_SELECTOR = ${JSON.stringify(
    [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[role=button]",
      "[role=link]",
      "[role=tab]",
      "[role=menuitem]",
      "[role=checkbox]",
      "[role=radio]",
      "[role=switch]",
      "[role=textbox]",
      "[contenteditable=true]",
      "[onclick]",
      "[tabindex]",
    ].join(","),
  )};
  var _bbUidCounter = 0;
  function assignUid(el) {
    if (!el.dataset.bbUid) { el.dataset.bbUid = String(++_bbUidCounter); }
    return el.dataset.bbUid;
  }
  function isVisible(el) {
    if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
    var style = getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }
  function labelFor(el) {
    var tag = el.tagName.toLowerCase();
    var role = el.getAttribute("role") || "";
    var type = el.getAttribute("type") || "";
    var text = (el.textContent || "").trim().slice(0, 80);
    var placeholder = el.getAttribute("placeholder") || "";
    var ariaLabel = el.getAttribute("aria-label") || "";
    var title = el.getAttribute("title") || "";
    var value = el.value !== undefined ? String(el.value).slice(0, 40) : "";
    var desc = role || tag;
    if (type && tag === "input") desc = "input[type=" + type + "]";
    var label = ariaLabel || title || text || placeholder;
    var line = desc;
    if (label) line += " '" + label + "'";
    if (value && !text) line += " value='" + value + "'";
    return line;
  }
  _bbUidCounter = 0;
  var lines = [];
  lines.push("page: " + document.title);
  lines.push("url: " + location.href);
  lines.push("---");
  var headings = document.querySelectorAll("h1, h2, h3");
  for (var i = 0; i < headings.length; i++) {
    var h = headings[i];
    if (!isVisible(h)) continue;
    var text = h.textContent.trim().slice(0, 120);
    if (text) lines.push("[" + h.tagName.toLowerCase() + "] " + text);
  }
  if (headings.length > 0) lines.push("---");
  var elements = document.querySelectorAll(INTERACTIVE_SELECTOR);
  for (var j = 0; j < elements.length; j++) {
    var el = elements[j];
    if (!isVisible(el)) continue;
    var uid = assignUid(el);
    lines.push("[" + uid + "] " + labelFor(el));
  }
  var mainText = [];
  var areas = document.querySelectorAll("main, article, [role=main], .content, #content");
  if (areas.length > 0) {
    for (var k = 0; k < areas.length; k++) {
      var t = areas[k].innerText.trim().slice(0, 3000);
      if (t) mainText.push(t);
    }
  }
  if (mainText.length > 0) {
    lines.push("--- content ---");
    lines.push(mainText.join(String.fromCharCode(10)).slice(0, 4000));
  }
  var snapshot = lines.join(String.fromCharCode(10)).slice(0, 8000);
  return JSON.stringify({ ok: true, snapshot: snapshot, url: location.href });
})()`;

/** Placeholder replaced with JSON.stringify(prompt) per call */
const GPT_RUN_TEMPLATE = `(async function(){
  var INPUT_SELECTORS = ["#prompt-textarea","div[contenteditable='true'][id='prompt-textarea']","textarea","div[contenteditable='true'][data-placeholder]"];
  var SEND_BUTTON_SELECTORS = ["button[data-testid='send-button']","button[data-testid='composer-send-button']","button[aria-label='Send prompt']","button[aria-label='Send']","button[aria-label*='Send']","button[title*='Send']","form button[type='submit']"];
  function findElement(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }
  function setNativeValue(el, value) {
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
      if (setter && setter.set) setter.set.call(el, value);
      else el.value = value;
    } else {
      el.focus();
      el.textContent = value;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  var prompt = __PROMPT__;
  var input = findElement(INPUT_SELECTORS);
  if (!input) return JSON.stringify({ ok: false, detail: "gpt_input_not_found" });
  setNativeValue(input, prompt);
  await new Promise(function(r) { setTimeout(r, 600); });
  var button = findElement(SEND_BUTTON_SELECTORS);
  if (button) { button.click(); return JSON.stringify({ ok: true, detail: "gpt_prompt_submitted" }); }
  input.focus();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
  input.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
  return JSON.stringify({ ok: true, detail: "gpt_prompt_enter_fallback" });
})()`;

const CLAUDE_RUN_TEMPLATE = `(async function(){
  var prompt = __PROMPT__;
  var input = document.querySelector("div[contenteditable='true'], div.ProseMirror[contenteditable='true']");
  if (!input) return JSON.stringify({ ok: false, detail: "claude_input_not_found" });
  input.textContent = prompt;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise(function(r) { setTimeout(r, 400); });
  var button = document.querySelector("button[aria-label='Send Message'], button[aria-label='Send message'], button.send-button");
  if (button) button.click();
  return JSON.stringify({ ok: true, detail: "claude_prompt_submitted" });
})()`;

const CLAUDE_READ_FN = `(function(){
  var messages = document.querySelectorAll("[data-is-streaming], .font-claude-message, .prose");
  if (messages.length === 0) {
    var allBlocks = document.querySelectorAll("div[class*='message'], div[class*='response']");
    if (allBlocks.length > 0) {
      var last = allBlocks[allBlocks.length - 1];
      return JSON.stringify({ ok: true, text: (last.textContent || "").trim(), streaming: false });
    }
    return JSON.stringify({ ok: false, text: "", streaming: false });
  }
  var lastMsg = messages[messages.length - 1];
  var text = (lastMsg.textContent || "").trim();
  var isStreaming = lastMsg.getAttribute("data-is-streaming") === "true";
  return JSON.stringify({ ok: true, text: text, streaming: isStreaming });
})()`;

const GPT_READ_FN = `(function(){
  var ASSISTANT_MSG_SELECTORS = ["[data-message-author-role='assistant']","[data-testid^='conversation-turn-'] [data-role='assistant']","div.agent-turn"];
  var STREAMING_SELECTORS = [".result-streaming","[data-is-streaming='true']","button[aria-label='Stop generating']","button[data-testid='stop-button']"];
  function findAllElements(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var els = document.querySelectorAll(selectors[i]);
      if (els.length > 0) return els;
    }
    return [];
  }
  var messages = findAllElements(ASSISTANT_MSG_SELECTORS);
  if (messages.length === 0) return JSON.stringify({ ok: false, text: "", streaming: false });
  var lastMsg = messages[messages.length - 1];
  var markdown = lastMsg.querySelector(".markdown, .prose, .whitespace-pre-wrap");
  var text = (markdown || lastMsg).textContent.trim() || "";
  var isStreaming = false;
  for (var s = 0; s < STREAMING_SELECTORS.length; s++) {
    if (document.querySelector(STREAMING_SELECTORS[s])) { isStreaming = true; break; }
  }
  return JSON.stringify({ ok: true, text: text, streaming: isStreaming });
})()`;

async function evalReturn(
  relay: CdpRelayServer,
  expression: string,
  timeoutMs = 60_000,
): Promise<string> {
  const raw = (await relay.sendCommand(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
    },
    timeoutMs,
  )) as Record<string, unknown>;
  /** CDP Runtime.evaluate returns { result: { type, value } } from chrome.debugger.sendCommand */
  const inner = raw?.result as { value?: unknown; result?: { value?: unknown } } | undefined;
  let val: unknown =
    inner && typeof inner === "object" && "value" in inner ? inner.value : undefined;
  if (val === undefined && inner?.result && typeof inner.result === "object" && "value" in inner.result) {
    val = inner.result.value;
  }
  if (typeof val === "string") return val;
  if (val != null) return String(val);
  return "";
}

function escapeForEval(s: string): string {
  return JSON.stringify(s);
}

export async function runFlowerCommand(
  relay: CdpRelayServer,
  cmd: FlowerCommand,
  timeoutMs = 30_000,
): Promise<CommandResult> {
  const action = cmd.action;
  try {
    switch (action) {
      case "navigate": {
        const url = cmd.url || "about:blank";
        await relay.sendCommand("Page.navigate", { url }, timeoutMs);
        try {
          await relay.waitForLoadEvent(Math.min(timeoutMs, 45_000));
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
        return { ok: true, action: "navigate", data: url };
      }
      case "waggle_ensure": {
        const url = cmd.url || "https://chatgpt.com";
        await relay.sendCommand("Page.navigate", { url }, timeoutMs);
        try {
          await relay.waitForLoadEvent(Math.min(timeoutMs, 45_000));
        } catch {
          await new Promise((r) => setTimeout(r, 2500));
        }
        return { ok: true, action: "waggle_ensure", data: url };
      }
      case "wait": {
        const ms = cmd.ms ?? 1000;
        await new Promise((r) => setTimeout(r, ms));
        return { ok: true, action: "wait", data: `${ms}ms` };
      }
      case "snapshot": {
        const json = await evalReturn(relay, SNAPSHOT_FN, timeoutMs);
        return { ok: true, action: "snapshot", data: json };
      }
      case "click": {
        const uid = cmd.uid;
        if (!uid) return { ok: false, action: "click", error: "missing uid" };
        const expr = `(function(){
          var el = document.querySelector('[data-bb-uid="${uid}"]');
          if (!el) return JSON.stringify({ ok: false, detail: "element not found" });
          el.scrollIntoView({ block: "center", behavior: "instant" });
          el.click();
          return JSON.stringify({ ok: true, detail: "clicked" });
        })()`;
        const json = await evalReturn(relay, expr, timeoutMs);
        try {
          const p = JSON.parse(json);
          if (p.ok === false) return { ok: false, action: "click", error: p.detail || "click failed" };
        } catch {
          /* ok */
        }
        return { ok: true, action: "click", data: json };
      }
      case "fill": {
        const uid = cmd.uid;
        const text = cmd.text ?? "";
        if (!uid) return { ok: false, action: "fill", error: "missing uid" };
        const textLit = escapeForEval(text);
        const expr = `(function(){
          var el = document.querySelector('[data-bb-uid="${uid}"]');
          if (!el) return JSON.stringify({ ok: false, detail: "element not found" });
          el.scrollIntoView({ block: "center", behavior: "instant" });
          el.focus();
          var v = ${textLit};
          if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
            var setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value");
            if (setter && setter.set) setter.set.call(el, v); else el.value = v;
          } else { el.textContent = v; }
          el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: v }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return JSON.stringify({ ok: true });
        })()`;
        const json = await evalReturn(relay, expr, timeoutMs);
        try {
          const p = JSON.parse(json);
          if (p.ok === false) return { ok: false, action: "fill", error: p.detail || "fill failed" };
        } catch {
          /* ok */
        }
        return { ok: true, action: "fill", data: json };
      }
      case "type":
        return runFlowerCommand(relay, { ...cmd, action: "fill" }, timeoutMs);
      case "scroll": {
        const dir = cmd.direction === "up" ? "up" : "down";
        const expr = `(function(){ window.scrollBy(0, ${dir === "down" ? 800 : -800}); return "ok"; })()`;
        await evalReturn(relay, expr, timeoutMs);
        return { ok: true, action: "scroll", data: dir };
      }
      case "read": {
        const sel = cmd.selector;
        const expr = sel
          ? `(function(){
            var el = document.querySelector(${JSON.stringify(sel)});
            return el ? el.innerText : document.body.innerText;
          })()`
          : `(function(){ return document.body ? document.body.innerText : ""; })()`;
        const text = await evalReturn(relay, expr, timeoutMs);
        return { ok: true, action: "read", data: text };
      }
      case "screenshot": {
        const r = (await relay.sendCommand("Page.captureScreenshot", { format: "png" }, timeoutMs)) as {
          data?: string;
        };
        const data = r?.data;
        if (!data) return { ok: false, action: "screenshot", error: "no image data" };
        return { ok: true, action: "screenshot", data: `data:image/png;base64,${data}` };
      }
      case "ai_chat": {
        const prompt = cmd.prompt ?? "";
        if (cmd.url) {
          await relay.sendCommand("Page.navigate", { url: cmd.url }, timeoutMs);
          try {
            await relay.waitForLoadEvent(Math.min(timeoutMs, 45_000));
          } catch {
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
        const expr =
          cmd.provider === "claude"
            ? CLAUDE_RUN_TEMPLATE.replace("__PROMPT__", escapeForEval(prompt))
            : GPT_RUN_TEMPLATE.replace("__PROMPT__", escapeForEval(prompt));
        const json = await evalReturn(relay, expr, Math.max(timeoutMs, 90_000));
        try {
          const p = JSON.parse(json);
          if (p.ok === false) return { ok: false, action: "ai_chat", error: String(p.detail || "failed") };
          return { ok: true, action: "ai_chat", data: json };
        } catch {
          return { ok: true, action: "ai_chat", data: json };
        }
      }
      case "ai_read_response": {
        const maxWait = cmd.timeout ?? 120_000;
        const deadline = Date.now() + maxWait;
        let lastText = "";
        const readFn = cmd.provider === "claude" ? CLAUDE_READ_FN : GPT_READ_FN;
        while (Date.now() < deadline) {
          const json = await evalReturn(relay, readFn, 8000);
          try {
            const p = JSON.parse(json) as { ok?: boolean; text?: string; streaming?: boolean };
            if (p.ok && !p.streaming && p.text && p.text.length > 0) {
              return { ok: true, action: "ai_read_response", data: p.text };
            }
            if (p.text && p.text.length > lastText.length) lastText = p.text;
          } catch {
            /* continue polling */
          }
          await new Promise((r) => setTimeout(r, 500));
        }
        if (lastText.length > 0) {
          return { ok: true, action: "ai_read_response", data: lastText };
        }
        return { ok: false, action: "ai_read_response", error: "timeout waiting for assistant response" };
      }
      default:
        return { ok: false, action, error: `unknown action: ${action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, action, error: msg };
  }
}
