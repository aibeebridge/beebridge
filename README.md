# beebridge

English | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md)

**Website**: <https://aibeebridge.pages.dev/>

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
- **CLI** (`apps/cli`) -- After **`npm run build:release`**, use **`npm link`** in **`~/.beebridge`** to run **`beebridge`** on your PATH (see [CLI](#cli)). Top-level **`beebridge start --daemon`** starts gateway + web in production; **`--dev`** switches to dev servers. Also **`stop`**, **`servers restart`**, **`gateway token`**, onboarding, TUI ([`docs/guides/cli.md`](docs/guides/cli.md)).
- **Chrome extension** (`extension/`) -- Relay + debugger attach; use the popup **Attach DevTools to this tab** so the badge shows **ON**.

## Documentation

| Guide | Topics |
|-------|--------|
| [`docs/guides/cli.md`](docs/guides/cli.md) | **`npm link`**, **`beebridge start --daemon`**, `beebridge_HOME` / `beebridge_GATEWAY_*`, daemon logs, `manager setup` -> Settings URL |
| [`docs/guides/web-settings.md`](docs/guides/web-settings.md) | **Web Settings** (`/settings`): Connection, Profiles, Model Policy, Workspace, Diagnostics; gateway APIs |
| [`docs/guides/bridge-graph.md`](docs/guides/bridge-graph.md) | Districts & bridges, JSON **export/import** (`beebridge.bridge-settings.v1`), **pipeline run** along one-way bridges, upstream tasks / `{{bridgeOut:...}}` |
| [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) | Waggle supervisor/worker harness in the Flower agent loop |

## Requirements

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Google Chrome** with the beebridge Flower extension loaded from this repo

Full dependency notes: [`INSTALL.md`](INSTALL.md).

## Installation

Same flow as **[`INSTALL.md`](INSTALL.md) — Quick Start** (details, env, and troubleshooting live there).

Clone anywhere. **`npm run build:release`** (same as **`npm run build`**) compiles everything **and** syncs into **`~/.beebridge`** (see [`scripts/install-home.mjs`](scripts/install-home.mjs); uses **`rsync`** on macOS/Linux). **`gateway-token`** and **`config.json`** under **`~/.beebridge`** are not overwritten by that sync.

```bash
# 1. Clone (example path)
git clone https://github.com/aibeebridge/beebridge.git
cd beebridge

# 2. Install dependencies
npm install

# 3. Production build + install into ~/.beebridge
npm run build:release

# 4. npm link (once) — then you can type `beebridge` instead of `node beebridge.mjs`
cd ~/.beebridge && npm link

# 5. Start gateway + web (production) in the background — one command
beebridge start --daemon
# Same without PATH: node ~/.beebridge/beebridge.mjs start --daemon
# Single service: beebridge gateway start --daemon  /  beebridge web start --daemon
# After upgrade: beebridge servers restart --daemon
# Dev servers: beebridge start --daemon --dev

```

After step 3, the launcher prefers **`~/.beebridge`** when that build exists (override with **`beebridge_HOME`**). Load the Chrome extension from **`~/.beebridge/extension`**.

Use **`npm run build:libs`** for a faster package-only rebuild when developing with **`--dev`** (does not run **`install:home`**). Refresh **`~/.beebridge`** with **`npm run install:home`** or **`npm run build:release`**. More: [`docs/guides/deployment.md`](docs/guides/deployment.md), [`docs/guides/cli.md`](docs/guides/cli.md).

## Running

**Preferred:** with **`npm link`** (see [Installation](#installation)), use **`beebridge start --daemon`** to run **gateway + web** in production in the background. **`beebridge gateway start --daemon`** / **`beebridge web start --daemon`** start one side only. Add **`--dev`** for **`tsx`** / **`next dev`**.

Without **`npm link`**, run **`node ~/.beebridge/beebridge.mjs …`** (or **`node beebridge.mjs`** from the install directory).

**Same behavior via npm:** **`npm run start:gateway`** / **`npm run start:web`** (production) or **`npm run start:daemon`** (= **`beebridge start --daemon`**).

### Gateway (API + WebSocket + CDP relay)

```bash
cd ~/.beebridge
beebridge gateway start --daemon
# Foreground: beebridge gateway start
# npm: npm run start:gateway
# Default HTTP API: http://localhost:4321  (not the Next.js UI)
```

### Web UI

```bash
cd ~/.beebridge
beebridge web start --daemon
# Foreground: beebridge web start
# npm: npm run start:web
# Default: http://localhost:3000
```

### CLI

Requires a built CLI (**`npm run build:release`** includes it). After **`npm link`** in **`~/.beebridge`**, run **`beebridge …`**; otherwise **`node beebridge.mjs …`**. Full reference: [`docs/guides/cli.md`](docs/guides/cli.md).

| Command | Purpose |
|---------|---------|
| **`start`** | Start **gateway + web** together; **`--daemon`** runs both in background (production unless **`--dev`**) |
| `gateway start` \| `restart` | Production gateway (`start:gateway`). **`--dev`** → `dev:gateway`. **`--daemon`** → background; logs under `.beebridge-daemon/gateway-<port>.log` |
| `web start` \| `restart` | Production web (`start:web`). **`--dev`** → `dev:web`. **`--daemon`**, **`--open`** (open `/dashboard`) |
| `servers restart` | Stop both ports, then start gateway + web (**`--daemon`** required) |
| `sandbox list` \| `remove` \| `kill` \| `cleanup` | Inspect and clean Beebridge Docker sandbox containers through the gateway |
| `web settings`, `manager setup` | Open **Settings** in the browser; **`--dev`** optional |
| `stop` | **`SIGTERM`** anything listening on **4321** (gateway) and **3000** (web); override with **`--gateway-port`** / **`--web-port`** |
| `gateway token` | Print the current gateway auth token (same file as `~/.beebridge/gateway-token` when auto-generated) |
| `onboard` | First-time PM auth / model setup |
| _(no args)_ or `tui` | Keyboard-driven terminal UI |

Convenience npm scripts in the root `package.json` mirror these (e.g. `start:daemon`, `gateway:start:daemon`, `web:start:daemon`).

```bash
beebridge start --daemon
beebridge gateway start --daemon
beebridge web start --daemon
beebridge servers restart --daemon
beebridge stop
# Or: node ~/.beebridge/beebridge.mjs …   Add --dev for development servers.
```

### Chrome extension

1. Open `chrome://extensions/` -> enable **Developer mode** -> **Load unpacked** -> select the `extension/` folder.
2. Set **CDP relay URL** in the popup to `ws://127.0.0.1:4323` (or `PORT+2` if you changed `PORT`).
3. Open the tab to automate -> extension icon -> **Attach DevTools to this tab** (badge **ON**).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `beebridge_HOME` | _(auto)_ | Repo root for spawned `npm run` commands ([`repo-root.ts`](apps/cli/src/repo-root.ts)). If unset, [`beebridge.mjs`](beebridge.mjs) uses **`~/.beebridge`** when it contains a full built tree; otherwise the directory of the `beebridge.mjs` you executed. |
| `beebridge_GATEWAY_URL` | `http://localhost:4321` | Gateway HTTP base URL for CLI / TUI API calls. |
| `beebridge_GATEWAY_TOKEN` | _(optional)_ | Bearer token; falls back to `GATEWAY_TOKEN` or `~/.beebridge/gateway-token`. |
| `GATEWAY_TOKEN` | _(auto)_ | If unset, a token is generated (OpenClaw-style 48-char hex) and saved under `~/.beebridge/gateway-token`. Set this to override. |
| `PORT` | `4321` | Gateway HTTP port |
| `BEEBRIDGE_CDP_RELAY_PORT` | `PORT + 2` | Loopback CDP relay (e.g. `4323` when `PORT=4321`) |
| `BEEBRIDGE_WEB_PORT` | `3000` | Shown in gateway "API-only" help page for linking to the Next.js app |
| `GITHUB_CLIENT_ID` | -- | GitHub OAuth app client ID (e.g. Copilot-related flows) |
| `BEEBRIDGE_GITHUB_CLIENT_ID` | -- | Alias for `GITHUB_CLIENT_ID` |
| `AIBRIDGE_GITHUB_CLIENT_ID` | -- | Legacy alias for older configs |
| `OPENAI_CODEX_CLIENT_ID` / `OPENAI_CODEX_REDIRECT_URI` | see code | Optional OpenAI Codex OAuth overrides |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1` | Set to `0` to skip TLS verification (**dev only**) |

The Next.js app resolves the gateway token on the server (shared persistence and an internal API route) when `NEXT_PUBLIC_GATEWAY_TOKEN` is not set, so the dashboard usually works without manual copy-paste after the first gateway start. Use **`beebridge gateway token`** if you need the value in the terminal.

More options (`.env` examples, CORS, auth mode): [`INSTALL.md`](INSTALL.md).

### Code sandbox

Code Flower `run_command` calls can run inside Docker instead of directly on the gateway host:

```bash
BEEBRIDGE_SANDBOX_MODE=docker beebridge gateway start
```

Defaults are intentionally restrictive: image `node:22-bookworm-slim`, `--network none`, read-only container root, writable code-project mount at `/project`, project-scoped persistent containers, and tmpfs for `/tmp`, `/var/tmp`, and `/run`. Use `BEEBRIDGE_SANDBOX_NETWORK=bridge` only when tasks need dependency downloads. Optional knobs: `BEEBRIDGE_SANDBOX_SCOPE=task`, `BEEBRIDGE_SANDBOX_IMAGE`, `BEEBRIDGE_SANDBOX_MEMORY`, `BEEBRIDGE_SANDBOX_CPUS`, `BEEBRIDGE_SANDBOX_PIDS_LIMIT`, `BEEBRIDGE_SANDBOX_READ_ONLY_ROOT=0`.

Manage sandbox containers with `beebridge sandbox list`, `beebridge sandbox remove <container-or-session>`, `beebridge sandbox kill <session-id>`, and `beebridge sandbox cleanup`. Cleanup removes task/background containers by default; pass `--include-project` to remove persistent project-scope containers too.

## Project structure

```
beebridge/
├── apps/
│   ├── gateway/          # @beebridge/gateway -- Express, WS, CDP relay, browser/waggle, chat, codegen
│   │   └── src/
│   │       ├── server/   # API, stores, Discord flower manager, chat routing
│   │       ├── browser/  # CDP relay, Flower commands, waggle, LLM client
│   │       ├── codegen/  # Code executor, code-project/subtask/process managers
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
