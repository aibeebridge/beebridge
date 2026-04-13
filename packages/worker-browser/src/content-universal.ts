function clickElement(selector: string): { ok: boolean; detail: string } {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return { ok: false, detail: `element not found: ${selector}` };
  el.click();
  return { ok: true, detail: `clicked: ${selector}` };
}

function typeText(selector: string, text: string): { ok: boolean; detail: string } {
  const el = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!el) return { ok: false, detail: `element not found: ${selector}` };

  if ("value" in el) {
    el.value = text;
  } else {
    (el as HTMLElement).textContent = text;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, detail: `typed into: ${selector}` };
}

function readText(selector?: string): { ok: boolean; text: string } {
  if (!selector) {
    return { ok: true, text: document.body.innerText.slice(0, 10000) };
  }
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) return { ok: false, text: `element not found: ${selector}` };
  return { ok: true, text: el.innerText.slice(0, 10000) };
}

function scrollPage(direction: string): { ok: boolean; detail: string } {
  const amount = direction === "up" ? -500 : 500;
  window.scrollBy({ top: amount, behavior: "smooth" });
  return { ok: true, detail: `scrolled ${direction}` };
}

chrome.runtime.onMessage.addListener(
  (message: { type?: string; selector?: string; text?: string; direction?: string }, _sender, sendResponse) => {
    switch (message.type) {
      case "beebridge_CLICK":
        sendResponse(clickElement(message.selector ?? ""));
        return true;
      case "beebridge_TYPE":
        sendResponse(typeText(message.selector ?? "", message.text ?? ""));
        return true;
      case "beebridge_READ":
        sendResponse(readText(message.selector));
        return true;
      case "beebridge_SCROLL":
        sendResponse(scrollPage(message.direction ?? "down"));
        return true;
      default:
        return false;
    }
  },
);

export {};
