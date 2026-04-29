# beebridge

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | Deutsch | [Français](README.fr.md) | [Español](README.es.md)

**Website**: <https://aibeebridge.pages.dev/>

**beebridge** ist ein Monorepo für einen AI-Planner- und Worker-Stack, der Aufgaben per **Browser-Automatisierung** (Flower / Chrome DevTools Protocol) erledigt. Das **gateway** orchestriert Jobs und CDP-Tools, die **web app** dient als Dashboard, die **CLI** verwaltet gateway/web-Prozesse, und die **Flower** MV3-Erweiterung verbindet `chrome.debugger` mit einem lokalen Loopback-Relay. Der optionale **Waggle mode** kombiniert ein Worker-Modell mit einem Supervisor-Kanal (AI-Tab im Browser oder API); siehe [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md).

## Vision

beebridge soll Menschen helfen, **echte Arbeitsziele mit AI zu erreichen**, statt nur offene Gespräche zu führen.

Dafür nutzt das System zwei ergänzende Ansätze. Erstens einen **Ontology-Graph-Ansatz**: Tasks, Districts und Bridges bilden einen expliziten Graphen aus Bedeutung und Beziehungen, sodass AI auf strukturiertem Wissen arbeitet, ohne alles immer neu erklären zu müssen. Das hält den **Token-Verbrauch minimal**. Zweitens einen **goal-proximate history approach**: Kontext und Erinnerung bleiben nah am aktuellen Ziel und zeigen vor allem das, was den Fortschritt wirklich unterstützt.

Darauf sitzt der **Waggle mode**: eine Möglichkeit, **mehrere AIs zu abonnieren und zu kombinieren** - lokale Modelle, Cloud-Anbieter und verschiedene Leistungsstufen - und sie im Gespräch zusammenarbeiten zu lassen. Dieser Dialog kann mehr hervorbringen, als ein einzelnes Modell allein liefern würde.

Innerhalb jeder Bridge wird Arbeit als **bees** dargestellt: kleine, sichtbare Agenten mit konkreten Rollen. Ein Ziel wächst organisch zu einem **hive** aus mehreren bee-förmigen Schritten, verbundenen Districts und Bridges, statt zu einem monolithischen Prompt.

## Architektur

Flower-Automatisierung verwendet durchgehend das **Chrome DevTools Protocol (CDP)**. Das gateway betreibt ein **Loopback WebSocket Relay** (standardmäßig `127.0.0.1:4323`, wenn `PORT=4321`). Die **beebridge Flower** MV3-Erweiterung hängt sich per `chrome.debugger` an einen Tab und leitet CDP-Requests/Responses weiter. High-level Flower-Kommandos (`navigate`, `snapshot`, `fill`, `ai_chat`, Waggle hooks usw.) werden im gateway über `Runtime.evaluate`, `Page.navigate` und verwandte CDP-Methoden umgesetzt.

```text
Gateway (Node)                    Extension (Flower)                 Chrome tab
  CDP relay WS  <--------------->  chrome.debugger.sendCommand  <-->  page
  + task loop        token            onEvent -> relay
  WebSocket /ws  (flower.register metadata only)
```

- **Gateway** (`apps/gateway`) - Express + WebSockets: jobs/history, chat routing, optionale Discord hooks, codegen/code-executor, CDP relay und browser agent loop inklusive Waggle.
- **Web UI** (`apps/web`) - Next.js: bridges, jobs, flowers UI, settings.
- **CLI** (`apps/cli`) - Nach **`npm run build:release`** kann in **`~/.beebridge`** mit **`npm link`** der Befehl **`beebridge`** auf den PATH gelegt werden. **`beebridge start --daemon`** startet gateway + web in production, **`--dev`** nutzt dev server.
- **Chrome extension** (`extension/`) - relay + debugger attach; im Popup **Attach DevTools to this tab** wählen, sodass das Badge **ON** zeigt.

## Dokumentation

| Guide | Topics |
|-------|--------|
| [`docs/guides/cli.md`](docs/guides/cli.md) | `npm link`, `beebridge start --daemon`, Umgebungsvariablen, daemon logs, Settings URL |
| [`docs/guides/web-settings.md`](docs/guides/web-settings.md) | Web Settings (`/settings`), Profiles, Model Policy, Workspace, Diagnostics |
| [`docs/guides/bridge-graph.md`](docs/guides/bridge-graph.md) | Districts & bridges, JSON export/import, pipeline run |
| [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) | Waggle supervisor/worker harness im Flower agent loop |

## Voraussetzungen

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Google Chrome** mit der aus diesem Repository geladenen beebridge Flower-Erweiterung

Details zu Abhängigkeiten stehen in [`INSTALL.md`](INSTALL.md).

## Installation

Der Ablauf entspricht **[`INSTALL.md`](INSTALL.md) - Quick Start**. Details zu Konfiguration, Umgebungsvariablen und Troubleshooting stehen dort.

```bash
git clone https://github.com/aibeebridge/beebridge.git
cd beebridge
npm install
npm run build:release
cd ~/.beebridge && npm link
beebridge start --daemon
```

Ohne `npm link` kann **`node ~/.beebridge/beebridge.mjs start --daemon`** verwendet werden. Nach einem Upgrade: **`beebridge servers restart --daemon`**. Für Entwicklung: **`beebridge start --daemon --dev`**. Die Chrome-Erweiterung aus **`~/.beebridge/extension`** laden.

## Ausführen

Empfohlen: **`beebridge start --daemon`** startet **gateway + web** in production im Hintergrund. Einzelne Dienste: **`beebridge gateway start --daemon`** oder **`beebridge web start --daemon`**. Mit **`--dev`** werden **`tsx`** / **`next dev`** genutzt.

### Gateway

```bash
cd ~/.beebridge
beebridge gateway start --daemon
# Default HTTP API: http://localhost:4321
```

### Web UI

```bash
cd ~/.beebridge
beebridge web start --daemon
# Default: http://localhost:3000
```

### CLI

| Command | Purpose |
|---------|---------|
| `start` | Startet gateway + web zusammen; `--daemon` läuft im Hintergrund. |
| `gateway start` / `restart` | Startet oder startet das gateway neu. |
| `web start` / `restart` | Startet oder startet web neu. |
| `servers restart` | Stoppt beide Ports und startet gateway + web neu. |
| `stop` | Sendet `SIGTERM` an Prozesse auf 4321 und 3000. |
| `gateway token` | Gibt den aktuellen gateway auth token aus. |
| `onboard` | Führt die erste PM auth / model Einrichtung aus. |
| `tui` | Startet die tastaturgesteuerte terminal UI. |

## Chrome-Erweiterung

1. `chrome://extensions/` öffnen, **Developer mode** aktivieren, **Load unpacked** wählen und `extension/` auswählen.
2. Im Popup **CDP relay URL** auf `ws://127.0.0.1:4323` setzen. Bei geändertem `PORT` `PORT+2` nutzen.
3. Den zu automatisierenden Tab öffnen, Erweiterungsicon anklicken und **Attach DevTools to this tab** wählen. Badge **ON** bedeutet verbunden.

## Umgebungsvariablen

| Variable | Default | Description |
|----------|---------|-------------|
| `beebridge_HOME` | _(auto)_ | Repo root für gestartete `npm run`-Kommandos; bevorzugt `~/.beebridge`, wenn dort ein vollständiger Build liegt. |
| `beebridge_GATEWAY_URL` | `http://localhost:4321` | Gateway HTTP base URL für CLI / TUI API-Aufrufe. |
| `beebridge_GATEWAY_TOKEN` | _(optional)_ | Bearer token; fällt auf `GATEWAY_TOKEN` oder `~/.beebridge/gateway-token` zurück. |
| `GATEWAY_TOKEN` | _(auto)_ | Wenn nicht gesetzt, wird ein token erzeugt und gespeichert. |
| `PORT` | `4321` | Gateway HTTP port |
| `BEEBRIDGE_CDP_RELAY_PORT` | `PORT + 2` | Loopback CDP relay port |
| `BEEBRIDGE_WEB_PORT` | `3000` | Web port für Links zur Next.js app |

## Projektstruktur

```text
beebridge/
├── apps/
│   ├── gateway/
│   ├── web/
│   └── cli/
├── extension/
├── packages/
├── docs/guides/
├── beebridge.mjs
└── package.json
```

## Unterstützte Flower-Kommandos

Unterstützt werden u.a. `navigate`, `click`, `type`, `read`, `scroll`, `wait`, `ai_chat`, `ai_read_response` und `screenshot`. Exakte Tool-Namen und Waggle-Regeln stehen im gateway agent loop und in [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md).

## Lizenz

[MIT](LICENSE)
