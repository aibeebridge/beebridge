# Installation Guide

## System Requirements

| Requirement | Version | Check Command |
|-------------|---------|---------------|
| Node.js | >= 18.x | `node --version` |
| npm | >= 9.x | `npm --version` |
| Google Chrome | latest | — |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/newbeebridge/BEEBRIDGE.git
cd BEEBRIDGE

# 2. Install all dependencies
npm install

# 3. Build (required before production gateway/web or CLI start)
npm run build
# Or minimal: build shared, core, gateway, web, and CLI as needed.

# 4. Start gateway server (production)
npm run start:gateway
# Development: npm run dev:gateway

# 5. Start web UI (in a new terminal)
npm run start:web
# Development: npm run dev:web
```

## Chrome Extension Setup

1. Open `chrome://extensions/` in Google Chrome
2. Enable **Developer mode** (top right toggle)
3. Click **Load unpacked**
4. Select the `extension/` folder from this repository
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
