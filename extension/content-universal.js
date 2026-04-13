// beebridge Flower — Universal Content Script (all pages)

// ─── UID management ───

let _bbUidCounter = 0;

function assignUid(el) {
  if (!el.dataset.bbUid) {
    el.dataset.bbUid = String(++_bbUidCounter);
  }
  return el.dataset.bbUid;
}

function findByUid(uid) {
  return document.querySelector(`[data-bb-uid="${uid}"]`);
}

// ─── Snapshot builder ───

const INTERACTIVE_SELECTOR = [
  "a[href]", "button", "input", "textarea", "select",
  "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
  "[role=checkbox]", "[role=radio]", "[role=switch]", "[role=textbox]",
  "[contenteditable=true]", "[onclick]", "[tabindex]",
].join(",");

function isVisible(el) {
  if (el.offsetWidth === 0 && el.offsetHeight === 0) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

function labelFor(el) {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute("role") || "";
  const type = el.getAttribute("type") || "";
  const text = (el.textContent || "").trim().slice(0, 80);
  const placeholder = el.getAttribute("placeholder") || "";
  const ariaLabel = el.getAttribute("aria-label") || "";
  const title = el.getAttribute("title") || "";
  const value = el.value !== undefined ? String(el.value).slice(0, 40) : "";

  let desc = role || tag;
  if (type && tag === "input") desc = `input[type=${type}]`;

  const label = ariaLabel || title || text || placeholder;
  let line = desc;
  if (label) line += ` '${label}'`;
  if (value && !text) line += ` value='${value}'`;
  return line;
}

function buildSnapshot() {
  _bbUidCounter = 0;
  const lines = [];
  const title = document.title;
  const url = location.href;

  lines.push(`page: ${title}`);
  lines.push(`url: ${url}`);
  lines.push("---");

  const headings = document.querySelectorAll("h1, h2, h3");
  for (const h of headings) {
    if (!isVisible(h)) continue;
    const level = h.tagName.toLowerCase();
    const text = h.textContent.trim().slice(0, 120);
    if (text) lines.push(`[${level}] ${text}`);
  }

  if (headings.length > 0) lines.push("---");

  const elements = document.querySelectorAll(INTERACTIVE_SELECTOR);
  for (const el of elements) {
    if (!isVisible(el)) continue;
    const uid = assignUid(el);
    lines.push(`[${uid}] ${labelFor(el)}`);
  }

  const mainText = [];
  const contentAreas = document.querySelectorAll(
    "main, article, [role=main], .content, #content"
  );
  if (contentAreas.length > 0) {
    for (const area of contentAreas) {
      const text = area.innerText.trim().slice(0, 3000);
      if (text) mainText.push(text);
    }
  }

  if (mainText.length > 0) {
    lines.push("--- content ---");
    lines.push(mainText.join("\n").slice(0, 4000));
  }

  const snapshot = lines.join("\n").slice(0, 8000);
  return { ok: true, snapshot, url };
}

// ─── Element actions (uid-based + selector-based) ───

function resolveElement(message) {
  if (message.uid) return findByUid(message.uid);
  if (message.selector) return document.querySelector(message.selector);
  return null;
}

function clickElement(message) {
  const el = resolveElement(message);
  if (!el) return { ok: false, detail: "element not found" };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.click();
  return { ok: true, detail: "clicked uid=" + (message.uid || message.selector) };
}

function fillText(message) {
  const el = resolveElement(message);
  if (!el) return { ok: false, detail: "element not found" };
  el.scrollIntoView({ block: "center", behavior: "instant" });
  el.focus();

  if ("value" in el) {
    el.value = message.text || "";
  } else {
    el.textContent = message.text || "";
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, detail: "filled uid=" + (message.uid || message.selector) };
}

function readText(selector) {
  if (!selector) {
    return { ok: true, text: document.body.innerText.slice(0, 10000) };
  }
  const el = document.querySelector(selector);
  if (!el) return { ok: false, text: "element not found: " + selector };
  return { ok: true, text: el.innerText.slice(0, 10000) };
}

function scrollPage(direction) {
  const amount = direction === "up" ? -500 : 500;
  window.scrollBy({ top: amount, behavior: "smooth" });
  return { ok: true, detail: "scrolled " + direction };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {
    case "beebridge_SNAPSHOT":
      sendResponse(buildSnapshot());
      return true;
    case "beebridge_CLICK":
      sendResponse(clickElement(message));
      return true;
    case "beebridge_TYPE":
      sendResponse(fillText(message));
      return true;
    case "beebridge_READ":
      sendResponse(readText(message.selector));
      return true;
    case "beebridge_SCROLL":
      sendResponse(scrollPage(message.direction || "down"));
      return true;
    default:
      return false;
  }
});
