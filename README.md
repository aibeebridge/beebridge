# beebridge

**beebridge** is a monorepo for an AI planner and worker stack that completes tasks through **browser automation** (Flower / Chrome DevTools Protocol). The **gateway** orchestrates jobs and CDP tools; the **web app** is the dashboard; the **CLI** can manage gateway/web processes; the **Flower** MV3 extension bridges `chrome.debugger` to a loopback relay. Optional **Waggle mode** pairs a worker model with a supervisor channel (browser AI tab or API) -- see [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md).

## Vision

beebridge exists so that people can **achieve real work objectives through AI**, not just have open-ended conversations.

To get there efficiently, the system takes two complementary approaches. First, an **ontology-graph approach**: tasks, districts, and bridges form an explicit graph of meaning and relationships, so the AI operates on structured knowledge rather than re-explaining everything from scratch. This keeps **token usage to a minimum**. Second, a **goal-proximate history approach**: context and memory are curated to stay close to the objective at hand, surfacing what actually advances the goal instead of accumulating irrelevant noise.

On top of that sits **Waggle mode**: a way to **subscribe to and combine multiple AIs** -- local models, cloud providers, different tiers -- and let them collaborate **in conversation**. The back-and-forth dialogue draws out **more than any single model could deliver on its own**, pushing past the inherent limits of whichever baseline you started with. The feel is deliberately **human-like**: people are not omniscient either, yet we still reach our goals by picking up tools, switching models, asking again, and iterating -- and that is exactly the loop beebridge replicates.

Inside each bridge, work is embodied as **bees** -- small, visible agents with concrete roles. A single objective grows organically into a **hive**: many bee-shaped steps, linked districts, and bridges, rather than one monolithic prompt. The bee metaphor is not decorative -- it shapes how tasks are created, assigned, and connected.

The larger ambition is a **network**. As people use beebridge they produce workflows -- graphs, exports, patterns -- that they can **share with each other**. Over time, those shared workflows knit together into a **broad AI-powered technology network**: an interconnected mesh of practice that no single team could build alone. That collective growth -- from individual hives to a shared ecosystem -- is the direction beebridge is meant to evolve toward.

## Architecture

Flower automation uses the **Chrome DevTools Protocol (CDP)** end-to-end: the gateway runs a **loopback WebSocket relay** (default `127.0.0.1:4323` when `PORT=4321`), and the **beebridge Flower** MV3 extension attaches `chrome.debugger` to a tab and forwards CDP requests/responses. High-level Flower commands (`navigate`, `snapshot`, `fill`, `ai_chat`, Waggle hooks, etc.) are implemented in the gateway with `Runtime.evaluate`, `Page.navigate`, and related CDP methods -- not via `tabs.sendMessage` content scripts.

```
Gateway (Node)                    Extension (Flower)                 Chrome tab
  CDP relay WS  <--------------->  chrome.debugger.sendCommand  <-->  page
  + task loop        token            onEvent -> relay
  WebSocket /ws  (flower.register metadata only)
```

- **Gateway** (`apps/gateway`) -- Express + WebSockets: jobs/history, chat routing, optional Discord hooks, codegen/code-executor paths, CDP relay and browser agent loop (including Waggle).
- **Web UI** (`apps/web`) -- Next.js: bridges, jobs, flowers UI, settings.
- **CLI** (`apps/cli`) -- Invoked via repo-root `beebridge.mjs` after `npm run build:cli` (see [Running](#running)).
- **Chrome extension** (`extension/`) -- Relay + debugger attach; use the popup **Attach DevTools to this tab** so the badge shows **ON**.

## Documentation

| Guide | Topics |
|-------|--------|
| [`docs/guides/cli.md`](docs/guides/cli.md) | **CLI** commands, `beebridge_HOME` / `beebridge_GATEWAY_*`, daemon logs, `manager setup` -> Settings URL |
| [`docs/guides/web-settings.md`](docs/guides/web-settings.md) | **Web Settings** (`/settings`): Connection, Profiles, Model Policy, Workspace, Diagnostics; gateway APIs |
| [`docs/guides/bridge-graph.md`](docs/guides/bridge-graph.md) | Districts & bridges, JSON **export/import** (`beebridge.bridge-settings.v1`), **pipeline run** along one-way bridges, upstream tasks / `{{bridgeOut:...}}` |
| [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) | Waggle supervisor/worker harness in the Flower agent loop |

## Requirements

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Google Chrome** with the beebridge Flower extension loaded from this repo

Full dependency notes: [`INSTALL.md`](INSTALL.md).

## Installation

```bash
git clone https://github.com/newaibridge/beebridge.git
cd beebridge

npm install

# Required before first gateway/web run
npm run build --workspace=packages/shared
npm run build --workspace=packages/core
npm run build --workspace=@beebridge/gateway

# Optional: global-style CLI entry at repo root (`node beebridge.mjs ...`)
npm run build:cli
```

## Running

### Gateway (API + WebSocket + CDP relay)

```bash
GATEWAY_TOKEN=dev-token npm run dev:gateway
# Default HTTP API: http://localhost:4321  (not the Next.js UI)
```

### Web UI

```bash
npm run dev:web
# Default: http://localhost:3000
```

### CLI (after `npm run build:cli`)

```bash
node beebridge.mjs gateway start
node beebridge.mjs web start
# Daemon variants: see root package.json (`gateway:start:daemon`, `web:start:daemon`, etc.)
```

### Chrome extension

1. Open `chrome://extensions/` -> enable **Developer mode** -> **Load unpacked** -> select the `extension/` folder.
2. Set **CDP relay URL** in the popup to `ws://127.0.0.1:4323` (or `PORT+2` if you changed `PORT`).
3. Open the tab to automate -> extension icon -> **Attach DevTools to this tab** (badge **ON**).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_TOKEN` | `dev-token` | Auth token for gateway API, main WebSocket, and CDP relay |
| `PORT` | `4321` | Gateway HTTP port |
| `BEEBRIDGE_CDP_RELAY_PORT` | `PORT + 2` | Loopback CDP relay (e.g. `4323` when `PORT=4321`) |
| `BEEBRIDGE_WEB_PORT` | `3000` | Shown in gateway "API-only" help page for linking to the Next.js app |
| `GITHUB_CLIENT_ID` | -- | GitHub OAuth app client ID (e.g. Copilot-related flows) |
| `BEEBRIDGE_GITHUB_CLIENT_ID` | -- | Alias for `GITHUB_CLIENT_ID` |
| `AIBRIDGE_GITHUB_CLIENT_ID` | -- | Legacy alias for older configs |
| `OPENAI_CODEX_CLIENT_ID` / `OPENAI_CODEX_REDIRECT_URI` | see code | Optional OpenAI Codex OAuth overrides |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1` | Set to `0` to skip TLS verification (**dev only**) |

More options (`.env` examples, CORS, auth mode): [`INSTALL.md`](INSTALL.md).

## Project structure

```
beebridge/
├── apps/
│   ├── gateway/          # @beebridge/gateway -- Express, WS, CDP relay, browser/waggle, chat, codegen
│   │   └── src/
│   │       ├── server/   # API, stores, Discord flower manager, chat routing
│   │       ├── browser/  # CDP relay, Flower commands, waggle, LLM client
│   │       ├── codegen/  # Code executor, project/subtask/process managers
│   │       ├── auth/
│   │       └── settings/
│   ├── web/              # @beebridge/web -- Next.js dashboard
│   └── cli/              # @beebridge/cli -- process helpers via beebridge.mjs
├── extension/            # MV3 Flower -- relay + chrome.debugger
├── packages/
│   ├── shared/           # @beebridge/shared -- shared types
│   └── core/             # @beebridge/core -- planner, approval gate, queue
├── docs/guides/          # e.g. Waggle mode
├── beebridge.mjs         # Root CLI loader (requires built CLI)
└── package.json          # Workspaces + scripts
```

## Supported Flower commands (high level)

| Command | Description |
|---------|-------------|
| `navigate` | Open a URL |
| `click` | Click an element by selector |
| `type` | Type into an input |
| `read` | Read visible text |
| `scroll` | Scroll the page |
| `wait` | Wait for a duration |
| `ai_chat` / `ai_read_response` | Chat UI automation (often Waggle tab) |
| `screenshot` | Visible viewport capture |

Exact tool names and Waggle harness rules are defined in the gateway agent loop; see [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) for supervisor/worker behavior.

## Settings persistence

Auth profiles and model policies are stored under `.beebridge-data/` (e.g. `pm-settings.json`). This path is gitignored.

## License

[MIT](LICENSE)
