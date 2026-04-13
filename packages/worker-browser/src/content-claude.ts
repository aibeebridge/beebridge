function runClaudePrompt(prompt: string): { ok: boolean; detail: string } {
  const input = document.querySelector<HTMLElement>(
    "div[contenteditable='true'], div.ProseMirror[contenteditable='true']"
  );
  if (!input) return { ok: false, detail: "claude_input_not_found" };

  input.textContent = prompt;
  input.dispatchEvent(new Event("input", { bubbles: true }));

  setTimeout(() => {
    const button = document.querySelector<HTMLButtonElement>(
      "button[aria-label='Send Message'], button[aria-label='Send message'], button.send-button"
    );
    if (button) button.click();
  }, 300);

  return { ok: true, detail: "claude_prompt_submitted" };
}

function readClaudeResponse(): { ok: boolean; text: string; streaming: boolean } {
  const messages = document.querySelectorAll("[data-is-streaming], .font-claude-message, .prose");
  if (messages.length === 0) {
    const allBlocks = document.querySelectorAll("div[class*='message'], div[class*='response']");
    if (allBlocks.length > 0) {
      const last = allBlocks[allBlocks.length - 1];
      return { ok: true, text: last.textContent?.trim() ?? "", streaming: false };
    }
    return { ok: false, text: "", streaming: false };
  }

  const lastMsg = messages[messages.length - 1];
  const text = lastMsg.textContent?.trim() ?? "";
  const isStreaming = lastMsg.getAttribute("data-is-streaming") === "true";

  return { ok: true, text, streaming: isStreaming };
}

function waitForClaudeResponse(timeoutMs: number): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const result = readClaudeResponse();
      if (result.ok && !result.streaming && result.text.length > 0) {
        resolve({ ok: true, text: result.text });
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve({ ok: result.ok, text: result.text || "timeout waiting for response" });
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

chrome.runtime.onMessage.addListener(
  (message: { type?: string; prompt?: string; timeout?: number }, _sender, sendResponse) => {
    if (message.type === "beebridge_RUN") {
      sendResponse(runClaudePrompt(String(message.prompt ?? "")));
      return true;
    }

    if (message.type === "beebridge_READ_RESPONSE") {
      const timeout = message.timeout ?? 30000;
      waitForClaudeResponse(timeout).then(sendResponse);
      return true;
    }

    return false;
  },
);

export {};
