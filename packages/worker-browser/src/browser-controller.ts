/** Task automation tab: worker browsing. */
let relayAutomationTabId: number | null = null;
/** Pinned Waggle web-AI tab; never merged into relayAutomationTabId. */
let wagglePinnedTabId: number | null = null;

chrome.tabs.onRemoved.addListener((tabId: number) => {
  if (tabId === relayAutomationTabId) relayAutomationTabId = null;
  if (tabId === wagglePinnedTabId) wagglePinnedTabId = null;
});

export interface FlowerCommand {
  action: string;
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
  useWaggleTab?: boolean;
}

export interface CommandResult {
  ok: boolean;
  action: string;
  data?: string;
  error?: string;
}

function parseUrlHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function hostMatchesTabUrl(tabUrl: string, targetUrl: string): boolean {
  const want = parseUrlHost(targetUrl);
  const have = parseUrlHost(tabUrl);
  if (!want || !have) return false;
  if (have === want) return true;
  if (have.endsWith("." + want)) return true;
  if (want.endsWith("." + have)) return true;
  return false;
}

async function ensureWaggleTab(targetUrl: string): Promise<number> {
  const url = targetUrl || "https://chatgpt.com";
  if (wagglePinnedTabId != null) {
    try {
      const t = await chrome.tabs.get(wagglePinnedTabId);
      const u = t.url || "";
      if (hostMatchesTabUrl(u, url)) {
        return wagglePinnedTabId;
      }
      await chrome.tabs.update(wagglePinnedTabId, { url, active: false });
      await waitForTabLoad(wagglePinnedTabId);
      await new Promise((r) => setTimeout(r, 1500));
      return wagglePinnedTabId;
    } catch {
      wagglePinnedTabId = null;
    }
  }
  const all = await chrome.tabs.query({});
  for (const tab of all) {
    if (!tab.id || !tab.url) continue;
    if (tab.id === relayAutomationTabId) continue;
    if (hostMatchesTabUrl(tab.url, url)) {
      wagglePinnedTabId = tab.id;
      return tab.id;
    }
  }
  const tab = await chrome.tabs.create({ url, active: false });
  wagglePinnedTabId = tab.id!;
  await waitForTabLoad(tab.id!);
  await new Promise((r) => setTimeout(r, 2000));
  return tab.id!;
}

async function refocusTaskTab(): Promise<void> {
  if (relayAutomationTabId == null) return;
  try {
    await chrome.tabs.get(relayAutomationTabId);
    await chrome.tabs.update(relayAutomationTabId, { active: true });
  } catch {
    /* ignore */
  }
}

async function getContentTargetTabId(cmd: FlowerCommand): Promise<number | undefined> {
  if (cmd.useWaggleTab) {
    if (wagglePinnedTabId == null) return undefined;
    try {
      await chrome.tabs.get(wagglePinnedTabId);
      return wagglePinnedTabId;
    } catch {
      return undefined;
    }
  }
  let tabId = relayAutomationTabId;
  if (tabId != null) {
    try {
      await chrome.tabs.get(tabId);
      return tabId;
    } catch {
      relayAutomationTabId = null;
    }
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id;
}

export async function executeCommand(cmd: FlowerCommand): Promise<CommandResult> {
  switch (cmd.action) {
    case "navigate":
      return handleNavigate(cmd.url ?? "about:blank");
    case "waggle_ensure":
      return handleWaggleEnsure(cmd.url ?? "https://chatgpt.com");
    case "click":
      return handleContentAction(
        "beebridge_CLICK",
        { selector: cmd.selector, uid: cmd.uid },
        cmd,
      );
    case "fill":
      return handleContentAction(
        "beebridge_TYPE",
        { uid: cmd.uid, selector: cmd.selector, text: cmd.text },
        cmd,
      );
    case "type":
      return handleContentAction(
        "beebridge_TYPE",
        { selector: cmd.selector, text: cmd.text },
        cmd,
      );
    case "read":
      return handleContentAction("beebridge_READ", { selector: cmd.selector }, cmd);
    case "snapshot":
      return handleSnapshot(cmd);
    case "scroll":
      return handleContentAction("beebridge_SCROLL", { direction: cmd.direction ?? "down" }, cmd);
    case "wait":
      return handleWait(cmd.ms ?? 1000);
    case "ai_chat":
      return handleAiChat(cmd.provider ?? "gpt", cmd.prompt ?? "", cmd.url);
    case "ai_read_response":
      return handleAiReadResponse(cmd.provider ?? "gpt", cmd.timeout, cmd.url);
    case "screenshot":
      return handleScreenshot();
    default:
      return { ok: false, action: cmd.action, error: `unknown action: ${cmd.action}` };
  }
}

async function handleWaggleEnsure(url: string): Promise<CommandResult> {
  try {
    await ensureWaggleTab(url);
    return { ok: true, action: "waggle_ensure", data: String(wagglePinnedTabId ?? "") };
  } catch (e) {
    return { ok: false, action: "waggle_ensure", error: String(e) };
  }
}

async function handleNavigate(url: string): Promise<CommandResult> {
  try {
    const targetUrl = url || "about:blank";
    let tabId = relayAutomationTabId;
    if (tabId != null) {
      try {
        await chrome.tabs.get(tabId);
      } catch {
        relayAutomationTabId = null;
        tabId = null;
      }
    }
    if (tabId != null) {
      await chrome.tabs.update(tabId, { url: targetUrl, active: true });
      await waitForTabLoad(tabId);
      return { ok: true, action: "navigate", data: targetUrl };
    }
    const tab = await chrome.tabs.create({ url: targetUrl, active: true });
    relayAutomationTabId = tab.id!;
    await waitForTabLoad(tab.id!);
    return { ok: true, action: "navigate", data: targetUrl };
  } catch (e) {
    return { ok: false, action: "navigate", error: String(e) };
  }
}

async function handleContentAction(
  type: string,
  payload: Record<string, unknown>,
  cmd: FlowerCommand,
): Promise<CommandResult> {
  try {
    const tabId = await getContentTargetTabId(cmd);
    if (!tabId) {
      return {
        ok: false,
        action: type,
        error: cmd.useWaggleTab ? "no waggle tab (call waggle_ensure first)" : "no active tab",
      };
    }

    const response = await sendMessageWithBootstrap(tabId, { type, ...payload });
    return { ok: true, action: type, data: typeof response === "string" ? response : JSON.stringify(response) };
  } catch (e) {
    return { ok: false, action: type, error: String(e) };
  }
}

async function handleSnapshot(cmd: FlowerCommand): Promise<CommandResult> {
  try {
    const tabId = await getContentTargetTabId(cmd);
    if (!tabId) {
      return {
        ok: false,
        action: "snapshot",
        error: cmd.useWaggleTab ? "no waggle tab (call waggle_ensure first)" : "no active tab",
      };
    }
    const response = await sendMessageWithBootstrap(tabId, { type: "beebridge_SNAPSHOT" });
    return { ok: true, action: "snapshot", data: JSON.stringify(response) };
  } catch (e) {
    return { ok: false, action: "snapshot", error: String(e) };
  }
}

async function handleWait(ms: number): Promise<CommandResult> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  return { ok: true, action: "wait", data: `${ms}ms` };
}

async function handleAiChat(
  provider: "gpt" | "claude",
  prompt: string,
  waggleUrl?: string,
): Promise<CommandResult> {
  try {
    const targetUrl =
      waggleUrl ?? (provider === "gpt" ? "https://chatgpt.com" : "https://claude.ai");
    const tabId = await ensureWaggleTab(targetUrl);

    const response = await sendMessageWithBootstrap(
      tabId,
      {
        type: "beebridge_RUN",
        prompt,
      },
      provider,
    );
    await refocusTaskTab();
    return { ok: true, action: "ai_chat", data: JSON.stringify(response) };
  } catch (e) {
    await refocusTaskTab();
    return { ok: false, action: "ai_chat", error: String(e) };
  }
}

async function handleAiReadResponse(
  provider: "gpt" | "claude",
  timeoutMs?: number,
  waggleUrl?: string,
): Promise<CommandResult> {
  try {
    const targetUrl =
      waggleUrl ?? (provider === "gpt" ? "https://chatgpt.com" : "https://claude.ai");
    const tabId = await ensureWaggleTab(targetUrl);

    const msg: Record<string, unknown> = { type: "beebridge_READ_RESPONSE", provider };
    if (timeoutMs) msg.timeout = timeoutMs;
    const response = await sendMessageWithBootstrap(tabId, msg, provider);
    await refocusTaskTab();
    return {
      ok: true,
      action: "ai_read_response",
      data: typeof response === "string" ? response : JSON.stringify(response),
    };
  } catch (e) {
    await refocusTaskTab();
    return { ok: false, action: "ai_read_response", error: String(e) };
  }
}

async function handleScreenshot(): Promise<CommandResult> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    return { ok: true, action: "screenshot", data: dataUrl };
  } catch (e) {
    return { ok: false, action: "screenshot", error: String(e) };
  }
}

function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, 15000);
  });
}

function isMissingReceiverError(err: unknown): boolean {
  const text = String(err ?? "");
  return text.includes("Receiving end does not exist") || text.includes("The message port closed before a response was received");
}

function scriptFilesForMessage(type: string, provider?: "gpt" | "claude"): string[] {
  if (type === "beebridge_RUN" || type === "beebridge_READ_RESPONSE") {
    return [provider === "claude" ? "dist/content-claude.js" : "dist/content-gpt.js"];
  }
  return ["dist/content-universal.js"];
}

async function injectScripts(tabId: number, files: string[]): Promise<void> {
  for (const file of files) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [file],
    });
  }
}

async function sendMessageWithBootstrap(
  tabId: number,
  message: Record<string, unknown>,
  provider?: "gpt" | "claude",
): Promise<unknown> {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (err) {
    if (!isMissingReceiverError(err)) throw err;
    await injectScripts(tabId, scriptFilesForMessage(String(message.type), provider));
    await new Promise((resolve) => setTimeout(resolve, 120));
    return await chrome.tabs.sendMessage(tabId, message);
  }
}

export {};
