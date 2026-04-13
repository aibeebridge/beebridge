function runGptPrompt(prompt: string): { ok: boolean; detail: string } {
  const textarea = document.querySelector<HTMLTextAreaElement>("textarea");
  const contentEditable = document.querySelector<HTMLElement>("div[contenteditable='true'][id='prompt-textarea']");
  const input = textarea ?? contentEditable;
  if (!input) return { ok: false, detail: "gpt_input_not_found" };

  if (input instanceof HTMLTextAreaElement) {
    input.value = prompt;
  } else {
    input.textContent = prompt;
  }
  input.dispatchEvent(new Event("input", { bubbles: true }));

  setTimeout(() => {
    const button = document.querySelector<HTMLButtonElement>(
      "button[data-testid='send-button'], button[aria-label='Send prompt']"
    );
    if (button) button.click();
  }, 300);

  return { ok: true, detail: "gpt_prompt_submitted" };
}

function readGptResponse(): { ok: boolean; text: string; streaming: boolean } {
  const messages = document.querySelectorAll("[data-message-author-role='assistant']");
  if (messages.length === 0) {
    return { ok: false, text: "", streaming: false };
  }

  const lastMsg = messages[messages.length - 1];
  const markdown = lastMsg.querySelector(".markdown, .prose");
  const text = (markdown ?? lastMsg).textContent?.trim() ?? "";

  const isStreaming = !!document.querySelector(
    "button[aria-label='Stop generating'], .result-streaming, [data-is-streaming='true']"
  );

  return { ok: true, text, streaming: isStreaming };
}

function waitForGptResponse(timeoutMs: number): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const result = readGptResponse();
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
      sendResponse(runGptPrompt(String(message.prompt ?? "")));
      return true;
    }

    if (message.type === "beebridge_READ_RESPONSE") {
      const timeout = message.timeout ?? 30000;
      waitForGptResponse(timeout).then(sendResponse);
      return true;
    }

    return false;
  },
);

export {};
