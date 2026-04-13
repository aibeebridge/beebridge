// beebridge Flower — CDP relay (chrome.debugger) + gateway WebSocket (metadata only)
// Automation uses DevTools Protocol via loopback relay; no command.execute on the gateway socket.

const DEFAULT_GW_URL = "ws://localhost:4321/ws";
const DEFAULT_RELAY_URL = "ws://127.0.0.1:4323";
const DEFAULT_GW_TOKEN = "dev-token";
const RECONNECT_MS = 3000;

let gwWs = null;
let relayWs = null;
let flowerId = "flower-" + Date.now();
/** @type {number|null} */
let attachedTabId = null;
let relayReconnectTimer = null;
let gwReconnectTimer = null;

function getSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["gwUrl", "gwToken", "relayWsUrl"], (result) => {
      resolve({
        gwUrl: result?.gwUrl || DEFAULT_GW_URL,
        gwToken: result?.gwToken || DEFAULT_GW_TOKEN,
        relayWsUrl: result?.relayWsUrl || DEFAULT_RELAY_URL,
      });
    });
  });
}

function sendGw(msg) {
  if (gwWs && gwWs.readyState === WebSocket.OPEN) {
    gwWs.send(JSON.stringify(msg));
  }
}

function sendRelay(msg) {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
}

function promisifyDebugger(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

async function enableDebuggerDomains(tabId) {
  await promisifyDebugger(tabId, "Page.enable", {});
  await promisifyDebugger(tabId, "Runtime.enable", {});
  await promisifyDebugger(tabId, "DOM.enable", {});
}

async function attachToTab(tabId) {
  if (attachedTabId != null && attachedTabId !== tabId) {
    try {
      chrome.debugger.detach({ tabId: attachedTabId });
    } catch {
      /* ignore */
    }
  }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, "1.3", () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
  attachedTabId = tabId;
  await enableDebuggerDomains(tabId);
  sendRelay(JSON.stringify({ type: "cdp.attached", tabId }));
  chrome.action.setBadgeText({ text: "ON" });
  chrome.action.setBadgeBackgroundColor({ color: "#148a42" });
  registerFlowerIfPossible();
}

function detachDebugger() {
  if (attachedTabId != null) {
    try {
      chrome.debugger.detach({ tabId: attachedTabId });
    } catch {
      /* ignore */
    }
  }
  attachedTabId = null;
  sendRelay(JSON.stringify({ type: "cdp.detached" }));
  chrome.action.setBadgeText({ text: "" });
  registerFlowerIfPossible();
}

function registerFlowerIfPossible() {
  if (gwWs && gwWs.readyState === WebSocket.OPEN && relayWs && relayWs.readyState === WebSocket.OPEN) {
    sendGw({
      type: "flower.register",
      flowerId,
      capabilities: ["cdp_relay"],
      cdpAttached: attachedTabId != null,
    });
  }
}

// ─── CDP event stream → relay ───
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== attachedTabId) return;
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify({ type: "cdp.event", method, params: params || {} }));
  }
});

chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId === attachedTabId) {
    attachedTabId = null;
    sendRelay(JSON.stringify({ type: "cdp.detached" }));
    chrome.action.setBadgeText({ text: "!" });
    chrome.action.setBadgeBackgroundColor({ color: "#c4a000" });
  }
});

// ─── Relay WebSocket (gateway CDP server) ───
function connectRelay() {
  if (relayReconnectTimer) {
    clearTimeout(relayReconnectTimer);
    relayReconnectTimer = null;
  }
  getSettings().then(({ relayWsUrl, gwToken }) => {
    const url = relayWsUrl.includes("?")
      ? `${relayWsUrl}&token=${encodeURIComponent(gwToken)}`
      : `${relayWsUrl}?token=${encodeURIComponent(gwToken)}`;
    try {
      relayWs = new WebSocket(url);
    } catch {
      scheduleRelayReconnect();
      return;
    }
    relayWs.onopen = () => {
      console.log("[beebridge Flower] CDP relay connected");
      if (attachedTabId != null) {
        sendRelay(JSON.stringify({ type: "cdp.attached", tabId: attachedTabId }));
      }
      registerFlowerIfPossible();
    };
    relayWs.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "cdp.send" && attachedTabId != null) {
        chrome.debugger.sendCommand({ tabId: attachedTabId }, msg.method, msg.params || {}, (result) => {
          const err = chrome.runtime.lastError;
          if (relayWs && relayWs.readyState === WebSocket.OPEN) {
            if (err) {
              relayWs.send(JSON.stringify({ type: "cdp.result", id: msg.id, error: err.message }));
            } else {
              relayWs.send(JSON.stringify({ type: "cdp.result", id: msg.id, result }));
            }
          }
        });
      }
    };
    relayWs.onclose = () => {
      console.log("[beebridge Flower] CDP relay disconnected");
      relayWs = null;
      scheduleRelayReconnect();
      registerFlowerIfPossible();
    };
    relayWs.onerror = () => {
      relayWs?.close();
    };
  });
}

function scheduleRelayReconnect() {
  relayReconnectTimer = setTimeout(connectRelay, RECONNECT_MS);
}

// ─── Gateway WebSocket (flower.register only) ───
function connectGateway() {
  if (gwReconnectTimer) {
    clearTimeout(gwReconnectTimer);
    gwReconnectTimer = null;
  }
  getSettings().then(({ gwUrl, gwToken }) => {
    const url = gwUrl + (gwUrl.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(gwToken);
    try {
      gwWs = new WebSocket(url);
    } catch {
      scheduleGwReconnect();
      return;
    }
    gwWs.onopen = () => {
      console.log("[beebridge Flower] Gateway WebSocket connected");
      registerFlowerIfPossible();
    };
    gwWs.onmessage = () => {
      /* flower.registered etc. — no command.execute */
    };
    gwWs.onclose = () => {
      console.log("[beebridge Flower] Gateway WebSocket disconnected");
      gwWs = null;
      scheduleGwReconnect();
    };
    gwWs.onerror = () => {
      gwWs?.close();
    };
  });
}

function scheduleGwReconnect() {
  gwReconnectTimer = setTimeout(connectGateway, RECONNECT_MS);
}

function initConnections() {
  connectRelay();
  connectGateway();
}

/**
 * Only http(s) tabs can use chrome.debugger. New Tab / chrome:// / about:blank must not reach attach()
 * or Chrome throws "Cannot access a chrome:// URL".
 */
function getAttachBlockReason(url) {
  if (url == null || typeof url !== "string" || url.trim() === "") {
    return "This tab has no URL yet. Load a https:// page, then attach again.";
  }
  const lower = url.trim().toLowerCase();
  if (lower.startsWith("chrome://newtab")) {
    return "This is the New Tab page (chrome://newtab). Open a real site: type e.g. wikipedia.org in the address bar, press Enter, then Attach again.";
  }
  if (
    lower === "about:blank" ||
    lower === "about:newtab" ||
    lower.startsWith("chrome://") ||
    lower.startsWith("chrome-extension://") ||
    lower.startsWith("edge://") ||
    lower.startsWith("devtools://") ||
    lower.startsWith("brave://") ||
    lower.startsWith("opera://")
  ) {
    return "DevTools attach works only on normal websites (http/https). Open a https:// page — not New Tab, Settings, or chrome://.";
  }
  try {
    const u = new URL(url);
    if (u.protocol === "http:" || u.protocol === "https:") return null;
    return `Cannot attach to ${u.protocol} (only http/https).`;
  } catch {
    return "Invalid tab URL. Open a https:// page and try again.";
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "ATTACH_CURRENT_TAB") {
    // Popup runs in its own window: currentWindow would be empty/wrong. Use last focused browser window.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, async (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) {
        sendResponse({
          ok: false,
          error:
            "No active tab in the last focused window. Focus a normal browser tab (https://), then open the popup and attach again.",
        });
        return;
      }
      const blockReason = getAttachBlockReason(tab.url);
      if (blockReason) {
        sendResponse({ ok: false, error: blockReason });
        return;
      }
      try {
        if (attachedTabId === tab.id) {
          detachDebugger();
          sendResponse({ ok: true, mode: "detached" });
          return;
        }
        await attachToTab(tab.id);
        sendResponse({ ok: true, mode: "attached", tabId: tab.id });
      } catch (e) {
        console.error("[beebridge Flower] attach failed", e);
        chrome.action.setBadgeText({ text: "!" });
        chrome.action.setBadgeBackgroundColor({ color: "#d2334f" });
        const msg = e instanceof Error ? e.message : String(e);
        sendResponse({
          ok: false,
          error:
            msg +
            " — If DevTools is already open on this tab, close it or use another tab. Restricted pages (chrome://, Web Store) cannot be attached.",
        });
      }
    });
    return true;
  }

  if (message.type === "GET_STATUS") {
    sendResponse({
      connected: gwWs?.readyState === WebSocket.OPEN,
      relayConnected: relayWs?.readyState === WebSocket.OPEN,
      cdpAttached: attachedTabId != null,
      flowerId,
      currentJobId: null,
    });
    return true;
  }

  if (message.type === "UPDATE_SETTINGS") {
    chrome.storage.local.set(
      {
        gwUrl: message.gwUrl,
        gwToken: message.gwToken,
        relayWsUrl: message.relayWsUrl,
      },
      () => {
        gwWs?.close();
        relayWs?.close();
        initConnections();
        sendResponse({ ok: true });
      },
    );
    return true;
  }

  if (message.type === "MANUAL_COMMAND" && message.command) {
    sendResponse({ ok: false, error: "MANUAL_COMMAND disabled; use DevTools attach + gateway tasks" });
    return true;
  }

  return false;
});

initConnections();
