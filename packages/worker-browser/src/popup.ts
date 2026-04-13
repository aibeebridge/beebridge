const gwUrlInput = document.getElementById("gwUrl") as HTMLInputElement;
const gwTokenInput = document.getElementById("gwToken") as HTMLInputElement;
const saveBtn = document.getElementById("saveBtn") as HTMLButtonElement;
const statusBadge = document.getElementById("statusBadge") as HTMLElement;
const statusDot = document.getElementById("statusDot") as HTMLElement;
const statusText = document.getElementById("statusText") as HTMLElement;
const infoDiv = document.getElementById("info") as HTMLElement;

function updateStatus(connected: boolean, flowerId?: string, currentJobId?: string | null) {
  statusBadge.className = `status ${connected ? "connected" : "disconnected"}`;
  statusDot.className = `dot ${connected ? "on" : "off"}`;
  statusText.textContent = connected ? "Connected" : "Disconnected";

  let html = "";
  if (flowerId) html += `<p>Flower ID: ${flowerId}</p>`;
  if (currentJobId) html += `<p>Current Job: ${currentJobId}</p>`;
  else if (connected) html += `<p>Idle — waiting for tasks</p>`;
  infoDiv.innerHTML = html;
}

chrome.storage?.local?.get(["gwUrl", "gwToken"], (result) => {
  gwUrlInput.value = (result?.gwUrl as string) || "ws://localhost:4321/ws";
  gwTokenInput.value = (result?.gwToken as string) || "dev-token";
});

chrome.runtime.sendMessage({ type: "GET_STATUS" }, (response) => {
  if (response) {
    updateStatus(response.connected, response.flowerId, response.currentJobId);
  }
});

saveBtn.addEventListener("click", () => {
  const gwUrl = gwUrlInput.value.trim();
  const gwToken = gwTokenInput.value.trim();
  chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", gwUrl, gwToken }, (response) => {
    if (response?.ok) {
      saveBtn.textContent = "Saved!";
      setTimeout(() => {
        saveBtn.textContent = "Save & Reconnect";
        chrome.runtime.sendMessage({ type: "GET_STATUS" }, (r) => {
          if (r) updateStatus(r.connected, r.flowerId, r.currentJobId);
        });
      }, 1500);
    }
  });
});

export {};
