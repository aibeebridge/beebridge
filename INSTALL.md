# Installation Guide

## System Requirements

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Node.js | >= 18.x | `node --version` |
| npm | >= 9.x | `npm --version` |
| Google Chrome | latest | — |

## Quick Start

**Public site:** <https://aibeebridge.pages.dev/>

Clone **anywhere** you like for development. **`npm run build:release`** (same as **`npm run build`**) compiles everything **and** syncs the tree into **`~/.beebridge`**, which is the default runtime install (see [`scripts/install-home.mjs`](scripts/install-home.mjs); uses **`rsync`** on macOS/Linux). Files such as **`gateway-token`** and **`config.json`** under `~/.beebridge` are **not** overwritten by that sync.

```bash
# 1. Clone (example path)
git clone https://github.com/aibeebridge/beebridge.git
cd beebridge

# 2. Install dependencies
npm install

# 3. Production build + install into ~/.beebridge
npm run build:release

# 4. (Optional, recommended) Put `beebridge` on your PATH — then use short commands below
cd ~/.beebridge
npm link

# 5. Start gateway + web in production (compiled gateway + next start). Easiest: both at once in the background
beebridge start --daemon
# Or without npm link: node ~/.beebridge/beebridge.mjs start --daemon

# One service at a time (also production unless you add --dev):
#   beebridge gateway start --daemon
#   beebridge web start --daemon

# Restart after a code update (stops ports, then starts both): beebridge servers restart --daemon
# Development (tsx / next dev): beebridge start --daemon --dev
```

Use **`npm run build:cli`** only when you iterate on the CLI alone; run **`npm run install:home`** afterward to refresh **`~/.beebridge`**, or run **`npm run build:release`** again. Full CLI reference: [`docs/guides/cli.md`](docs/guides/cli.md) and [README.md](README.md#cli).

The root [`beebridge.mjs`](beebridge.mjs) loads the built CLI from **`~/.beebridge`** when that install exists (override with **`beebridge_HOME`**). Unlink the global command with **`npm unlink -g beebridge`** when needed.

## Chrome Extension Setup

1. Open `chrome://extensions/` in Google Chrome
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the **`extension`** folder — after a release build, use **`~/.beebridge/extension`** (or the same folder inside your git clone)
5. Click the extension icon to verify connection status

## Environment Variables

Create a `.env` file in the project root (optional):

```env
# Optional — if omitted, token is generated and stored in ~/.beebridge/gateway-token
# GATEWAY_TOKEN=your-secret
GITHUB_CLIENT_ID=your-github-oauth-app-client-id
# Optional aliases (same value):
# BEEBRIDGE_GITHUB_CLIENT_ID=your-github-oauth-app-client-id
# AIBRIDGE_GITHUB_CLIENT_ID=your-github-oauth-app-client-id
PORT=4321
NODE_TLS_REJECT_UNAUTHORIZED=0
```

Or pass them inline when starting the gateway:

```bash
GITHUB_CLIENT_ID=your-id npm run start:gateway
# Optional: GATEWAY_TOKEN=... to override ~/.beebridge/gateway-token
```

## Dependency Overview

### Gateway (`apps/gateway`)
- express ^4.21 — HTTP server
- ws ^8.18 — WebSocket server
- zod ^3.24 — Schema validation
- @modelcontextprotocol/sdk ^1.28 — MCP protocol client
- tsx ^4.19 — TypeScript execution (dev)

### Web UI (`apps/web`)
- next ^15.3 — React framework
- react ^19.1 — UI library
- react-dom ^19.1 — DOM renderer

### Shared Packages
- @beebridge/shared — Type definitions
- @beebridge/core — Planner, approval gate, execution queue

### Chrome Extension (`extension/`)
- No external dependencies (vanilla JavaScript, Chrome Extension MV3 APIs)

## Troubleshooting

### `EADDRINUSE: address already in use :::4321`
```bash
lsof -ti :4321 | xargs kill -9
```

### `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`
```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 npm run start:gateway
```

### Extension not connecting
- Check that the gateway is running on `ws://localhost:4321/ws`
- Open the extension popup and verify the Gateway URL and Token
- Reload the extension at `chrome://extensions/`
