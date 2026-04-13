# Waggle Mode Setup Guide

## Overview

Waggle Mode is inspired by the bee waggle dance — a communication mechanism where bees share intelligence with each other. In beebridge, the **worker bee** (usually a cheaper task LLM) acts as **browser hands**, while a **higher-tier channel** (web AI via Chrome relay, or a premium model via API) acts as **supervisor**: the worker asks how to approach the task and what to do next, then executes in the browser.

This lets you run most steps on a fast, inexpensive model while routing planning and hard judgment to a stronger channel — without relying on the small model to “figure everything out” alone.

**Scope:** Waggle harnessing is implemented in the **gateway browser agent loop** (Flower CDP tasks). Other execution paths are out of scope unless documented separately.

### Fixed Waggle tab (Flower / Chrome relay)

Flower keeps **two** tabs:

1. **Task tab** — `navigate`, `snapshot`, `click`, `fill`, etc. for the worker (search, Wikipedia, internal tools). This tab is not hijacked to open ChatGPT for every `waggle_ask`.
2. **Pinned Waggle tab** — the district’s configured web AI URL. `ai_chat` / `ai_read_response` and (for generic sites) `waggle_ensure` + tools with `useWaggleTab` run only on this tab. The extension reuses the same tab across asks; if it is already on the right host, it avoids `tabs.update` so the page is not unnecessarily reloaded. After Waggle, Flower tries to **refocus the task tab** so you keep working in the same window.

## How It Works (harness)

The gateway does not leave collaboration to chance: when Waggle is enabled on a district, the agent loop **gates tools** and **completion**.

```
Task starts (Waggle ON)
  → Worker may call only waggle_ask until one succeeds (supervisor sync)
  → Browser tools + waggle_ask available
  → Worker uses navigate / snapshot / click / … per supervisor guidance
  → On failure or uncertainty: waggle_ask again
  → done allowed only after at least one successful waggle_ask this task
```

Routing for `waggle_ask`:

- **Browser mode** — Flower uses the **pinned Waggle tab** (see above): submits the question and reads the reply without swapping the task automation tab to that URL.
- **API mode** — Gateway calls the configured provider/model with the question (and optional context).

If the loop ends without a successful `waggle_ask`, the job is marked **failed** (harness requirement not met).

## Two Sub-modes

### Browser Mode

The bee navigates to a user-configured AI website (ChatGPT, Claude, Gemini, etc.) via the Chrome extension relay:

1. Opens the AI website in the browser
2. Types the question into the chat input
3. Waits for the AI to generate a response
4. Reads the response text
5. Returns the answer to the bee

**Advantages:**
- Essentially free — uses your existing AI subscriptions
- Access to the latest models without API keys
- Works with any AI chat website

**Requirements:**
- Chrome extension (Flower) must be installed and connected
- You must be logged into the target AI website in Chrome
- The AI website tab will be controlled during waggle operations

### API Mode

The bee sends a direct API call to a higher-tier LLM endpoint:

1. Constructs a request with the question and context
2. Sends it to the configured API endpoint
3. Receives and returns the response

**Advantages:**
- Faster than browser mode (no DOM interaction needed)
- More reliable (structured API response)
- Can run in parallel without browser interference

**Requirements:**
- A valid API key for the target provider
- Sufficient API credits/quota

## Setup Instructions

### Step 1: Create or Select a District

Districts are project-level containers in beebridge. Each district can have its own Waggle Mode configuration.

1. Go to **Districts** page
2. Create a new district or click **Edit** (✏️) on an existing one

### Step 2: Enable Waggle Mode

In the district edit form:

1. Check the **Waggle Mode** checkbox to enable it
2. Select the mode: **Browser** or **API**

### Step 3a: Configure Browser Mode

If you selected Browser mode:

1. Choose a preset AI website from the dropdown:
   - **ChatGPT** (`https://chatgpt.com`)
   - **Claude** (`https://claude.ai`)
   - **Gemini** (`https://gemini.google.com`)
   - Or enter a **Custom URL**
2. Make sure you are logged into the selected AI website in Chrome
3. Ensure the Chrome extension (Flower) is installed and connected

### Step 3b: Configure API Mode

If you selected API mode:

1. Select a **Provider** (OpenAI, Anthropic, Google, GitHub Copilot)
2. Enter the **Model** name (e.g., `gpt-4o`, `claude-3.5-sonnet`)
3. Enter an **API Key** (leave empty to reuse the active auth profile from Settings)

### Step 4: Auto-Detect Setting

The **Auto-detect when to waggle** option does **not** turn Waggle on or off. The harness **always** requires an initial successful `waggle_ask` and at least one before `done`.

When **auto-detect is enabled**, the system prompt also encourages **extra proactive** `waggle_ask` calls on analytically heavy steps (not only after failures). When **disabled**, extra proactive waggle is discouraged; mandatory planning/unblocking behavior still applies.

### Step 5: Save and Run Tasks

1. Click **Save** to store the waggle configuration
2. Create tasks within this district
3. When tasks are executed, the bee will have access to `waggle_ask`

## Cost Optimization Strategies

### Browser Mode (Near-Zero Cost)

- Use browser mode for non-time-critical tasks
- Log into a ChatGPT Plus / Claude Pro subscription for unlimited usage
- The bee reuses your existing subscription — no additional API costs

### API Mode (Selective Spending)

- Set your main task LLM to a cheap model (e.g., `gpt-4o-mini`)
- Configure waggle API to a premium model (e.g., `gpt-4o`, `claude-3.5-sonnet`)
- The bee only calls the expensive model when it truly needs help
- Typical cost reduction: 60-80% compared to running everything on the premium model

### Hybrid Strategy

1. Start with browser mode for development and testing
2. Switch to API mode for production workloads that need speed
3. Use auto-detect to let the AI decide when to escalate

## Troubleshooting

### Browser Mode Issues

| Problem | Solution |
|---------|----------|
| "Could not find input field" | The AI website may have changed its layout. Try refreshing the page or check if you're logged in. |
| "No response received" | The AI website may be slow. Check if the response is still generating. |
| "Navigate failed" | Ensure the Chrome extension is connected (check the Flowers page). |
| Wrong website opens | Verify the URL in the waggle configuration. |

### API Mode Issues

| Problem | Solution |
|---------|----------|
| "No API key configured" | Enter an API key in the waggle settings or configure an auth profile in Settings. |
| 401/403 errors | Check that your API key is valid and has the correct permissions. |
| Rate limit errors | Reduce task concurrency or switch to a different provider. |
| Model not found | Verify the model name matches the provider's available models. |

### General Issues

| Problem | Solution |
|---------|----------|
| Task failed with “no successful waggle_ask” | The worker never got a successful reply from the higher-tier channel (check Flower/API errors) or hit the step limit before succeeding. |
| Waggle not “triggering” on first step | With Waggle enabled, the first LLM step is restricted to `waggle_ask` only; if you see browser actions first, confirm the district save and gateway version. |
| Poor answers from waggle | Enrich the task description; the worker should pass title, description, and objective in `waggle_ask` context. |
| Slow task execution | Browser mode is inherently slower. Consider API mode for time-sensitive tasks. |

## Architecture Reference

Waggle Mode touches these components:

- **Shared types** (`packages/shared/src/index.ts`): `WaggleConfig`, `WaggleMode`
- **Browser tools** (`apps/gateway/src/browser/browser-tools.ts`): `waggle_ask` tool definition
- **Waggle executor** (`apps/gateway/src/browser/waggle.ts`): Browser and API execution logic (browser path uses pinned tab; no task-tab navigate bounce)
- **Flower extension** (`extension/background.js`): `relayAutomationTabId` (task) + `wagglePinnedTabId` (web AI), `waggle_ensure`, `useWaggleTab` on snapshot/fill/click
- **Controller** (`apps/gateway/src/browser/controller.ts`): Agent loop integration, tool gate, completion rules, optional `tool_choice` for the first waggle step
- **LLM client** (`apps/gateway/src/browser/llm-client.ts`): `chatWithTools` optional `toolChoice` for providers that support forced tool calls
- **Server** (`apps/gateway/src/server/index.ts`): District CRUD with waggle config
- **Web UI** (`apps/web/src/app/jobs/page.tsx`): District edit form with waggle settings
