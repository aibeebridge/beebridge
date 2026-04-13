// beebridge Flower — Popup Script

const gwUrlInput = document.getElementById("gwUrl");
const relayWsUrlInput = document.getElementById("relayWsUrl");
const gwTokenInput = document.getElementById("gwToken");
const saveBtn = document.getElementById("saveBtn");
const attachBtn = document.getElementById("attachBtn");
const statusBadge = document.getElementById("statusBadge");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const infoDiv = document.getElementById("info");

const gatewayWarnEl = document.getElementById("gatewayWarn");

function updateStatus(status) {
  const connected = status.connected;
  const relayOk = status.relayConnected;
  const cdpOk = status.cdpAttached;
  const ok = connected && relayOk && cdpOk;
  statusBadge.className = "status " + (ok ? "connected" : "disconnected");
  statusDot.className = "dot " + (ok ? "on" : "off");
  statusText.textContent = ok ? "Ready (CDP)" : relayOk && connected ? "Attach DevTools" : "Disconnected";

  if (!connected || !relayOk) {
    gatewayWarnEl.style.display = "block";
    gatewayWarnEl.innerHTML =
      "<strong>Gateway not reachable.</strong> Start the beebridge gateway on this PC first " +
      "(e.g. <code style=font-size:10px>npm run dev:gateway</code> in the repo, default port <strong>4321</strong>). " +
      "Relay uses <strong>PORT+2</strong> (often <strong>4323</strong>). Token must match <code>GATEWAY_TOKEN</code>. " +
      "Then click <strong>Save & Reconnect</strong>.";
  } else {
    gatewayWarnEl.style.display = "none";
  }

  let html = "";
  if (status.flowerId) html += "<p>Flower ID <strong>" + status.flowerId + "</strong></p>";
  html += "<p>Gateway WS <strong>" + (connected ? "ok" : "no") + "</strong></p>";
  html += "<p>CDP relay <strong>" + (relayOk ? "ok" : "no") + "</strong></p>";
  html += "<p>Debugger <strong>" + (cdpOk ? "attached" : "not attached") + "</strong></p>";
  if (status.currentJobId) html += "<p>Current Job <strong class='job-badge'>" + status.currentJobId + "</strong></p>";
  infoDiv.innerHTML = html;
}

chrome.storage.local.get(["gwUrl", "gwToken", "relayWsUrl"], (result) => {
  gwUrlInput.value = result?.gwUrl || "ws://localhost:4321/ws";
  relayWsUrlInput.value = result?.relayWsUrl || "ws://127.0.0.1:4323";
  gwTokenInput.value = result?.gwToken || "dev-token";
});

chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
  if (response) updateStatus(response);
});

attachBtn.addEventListener("click", () => {
  attachBtn.textContent = "Working...";
  attachBtn.disabled = true;
  chrome.runtime.sendMessage({ type: "ATTACH_CURRENT_TAB" }, (response) => {
    if (chrome.runtime.lastError) {
      alert(chrome.runtime.lastError.message);
    } else if (response && response.ok === false && response.error) {
      alert(response.error);
    }
    attachBtn.textContent = "Attach DevTools to this tab";
    attachBtn.disabled = false;
    chrome.runtime.sendMessage({ type: "GET_STATUS" }, (r) => {
      if (r) updateStatus(r);
    });
  });
});

saveBtn.addEventListener("click", () => {
  const gwUrl = gwUrlInput.value.trim();
  const gwToken = gwTokenInput.value.trim();
  const relayWsUrl = relayWsUrlInput.value.trim();

  saveBtn.textContent = "Connecting...";
  saveBtn.disabled = true;

  chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", gwUrl, gwToken, relayWsUrl }, (response) => {
    if (response?.ok) {
      saveBtn.textContent = "Saved!";
      setTimeout(() => {
        saveBtn.textContent = "Save & Reconnect";
        saveBtn.disabled = false;
        chrome.runtime.sendMessage({ type: "GET_STATUS" }, (r) => {
          if (r) updateStatus(r);
        });
      }, 1500);
    } else {
      saveBtn.textContent = "Save & Reconnect";
      saveBtn.disabled = false;
    }
  });
});

setInterval(() => {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (r) => {
    if (r) updateStatus(r);
  });
}, 3000);
