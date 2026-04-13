// beebridge Flower — ChatGPT Content Script

const INPUT_SELECTORS = [
  "#prompt-textarea",
  "div[contenteditable='true'][id='prompt-textarea']",
  "textarea",
  "div[contenteditable='true'][data-placeholder]",
];

const SEND_BUTTON_SELECTORS = [
  "button[data-testid='send-button']",
  "button[data-testid='composer-send-button']",
  "button[aria-label='Send prompt']",
  "button[aria-label='Send']",
  "button[aria-label*='Send']",
  "button[title*='Send']",
  "form button[type='submit']",
];

const ASSISTANT_MSG_SELECTORS = [
  "[data-message-author-role='assistant']",
  "[data-testid^='conversation-turn-'] [data-role='assistant']",
  "div.agent-turn",
];

const STREAMING_SELECTORS = [
  ".result-streaming",
  "[data-is-streaming='true']",
  "button[aria-label='Stop generating']",
  "button[data-testid='stop-button']",
];

function findElement(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function findAllElements(selectors) {
  for (const sel of selectors) {
    const els = document.querySelectorAll(sel);
    if (els.length > 0) return els;
  }
  return [];
}

function setNativeValue(el, value) {
  if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(el), "value"
    )?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
  } else {
    el.focus();
    el.textContent = value;
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function runGptPrompt(prompt) {
  return new Promise((resolve) => {
    const input = findElement(INPUT_SELECTORS);
    if (!input) {
      resolve({ ok: false, detail: "gpt_input_not_found" });
      return;
    }

    setNativeValue(input, prompt);

    setTimeout(() => {
      const button = findElement(SEND_BUTTON_SELECTORS);
      if (button) {
        button.click();
        resolve({ ok: true, detail: "gpt_prompt_submitted" });
        return;
      }
      input.focus();
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }),
      );
      input.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }),
      );
      resolve({ ok: true, detail: "gpt_prompt_enter_fallback" });
    }, 600);
  });
}

function readGptResponse() {
  const messages = findAllElements(ASSISTANT_MSG_SELECTORS);
  if (messages.length === 0) return { ok: false, text: "", streaming: false };

  const lastMsg = messages[messages.length - 1];
  const markdown = lastMsg.querySelector(".markdown, .prose, .whitespace-pre-wrap");
  const text = (markdown || lastMsg).textContent?.trim() || "";

  const isStreaming = STREAMING_SELECTORS.some((sel) => !!document.querySelector(sel));

  return { ok: true, text, streaming: isStreaming };
}

function waitForGptResponse(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const check = () => {
      const result = readGptResponse();
      if (result.ok && !result.streaming && result.text.length > 0) {
        resolve({ ok: true, text: result.text });
        return;
      }
      if (Date.now() - start > timeoutMs) {
        resolve({
          ok: result.ok,
          text: result.text || "timeout waiting for response",
          timedOut: true,
        });
        return;
      }
      setTimeout(check, 500);
    };
    check();
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "beebridge_RUN") {
    runGptPrompt(String(message.prompt || "")).then(sendResponse);
    return true;
  }

  if (message.type === "beebridge_READ_RESPONSE") {
    const timeout = message.timeout || 60000;
    waitForGptResponse(timeout).then(sendResponse);
    return true;
  }

  return false;
});
