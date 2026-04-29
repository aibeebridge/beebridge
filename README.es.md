# beebridge

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | Español

**Website**: <https://aibeebridge.pages.dev/>

**beebridge** es un monorepo para una pila de planificador y workers de AI que completa tareas mediante **automatización del navegador** (Flower / Chrome DevTools Protocol). El **gateway** orquesta jobs y herramientas CDP; la **web app** es el panel; la **CLI** gestiona procesos gateway/web; y la extensión MV3 **Flower** conecta `chrome.debugger` con un relay loopback local. El **Waggle mode** opcional combina un modelo worker con un canal supervisor (pestaña AI del navegador o API). Consulta [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md).

## Visión

beebridge existe para que las personas puedan **alcanzar objetivos de trabajo reales con AI**, no solo mantener conversaciones abiertas.

El sistema usa dos enfoques complementarios. Primero, un **enfoque de grafo de ontología**: tasks, districts y bridges forman un grafo explícito de significado y relaciones, de modo que la AI trabaja sobre conocimiento estructurado sin volver a explicar todo desde cero. Esto ayuda a **minimizar el uso de tokens**. Segundo, un **enfoque de historial cercano al objetivo**: el contexto y la memoria se mantienen cerca del objetivo actual y destacan lo que realmente ayuda a avanzar.

Encima está **Waggle mode**: una forma de **suscribirse y combinar varias AIs** - modelos locales, proveedores cloud y distintos niveles - para que colaboren en conversación. Ese intercambio puede producir más que un solo modelo por sí mismo.

Dentro de cada bridge, el trabajo se expresa como **bees**: agentes pequeños y visibles con roles concretos. Un objetivo crece de forma natural hasta convertirse en una **hive** con pasos tipo bee, districts y bridges conectados, en lugar de un prompt monolítico.

## Arquitectura

La automatización Flower usa **Chrome DevTools Protocol (CDP)** de extremo a extremo. El gateway ejecuta un **relay WebSocket loopback** (por defecto `127.0.0.1:4323` cuando `PORT=4321`). La extensión MV3 **beebridge Flower** se adjunta a una pestaña con `chrome.debugger` y reenvía solicitudes/respuestas CDP. Los comandos Flower de alto nivel (`navigate`, `snapshot`, `fill`, `ai_chat`, Waggle hooks, etc.) se implementan en el gateway con `Runtime.evaluate`, `Page.navigate` y métodos CDP relacionados.

```text
Gateway (Node)                    Extension (Flower)                 Chrome tab
  CDP relay WS  <--------------->  chrome.debugger.sendCommand  <-->  page
  + task loop        token            onEvent -> relay
  WebSocket /ws  (flower.register metadata only)
```

- **Gateway** (`apps/gateway`) - Express + WebSockets: jobs/history, chat routing, hooks Discord opcionales, codegen/code-executor, CDP relay y browser agent loop con Waggle.
- **Web UI** (`apps/web`) - Next.js: bridges, jobs, flowers UI, settings.
- **CLI** (`apps/cli`) - Tras **`npm run build:release`**, ejecuta **`npm link`** en **`~/.beebridge`** para usar **`beebridge`** desde el PATH. **`beebridge start --daemon`** inicia gateway + web en production; **`--dev`** usa dev servers.
- **Chrome extension** (`extension/`) - relay + debugger attach; en el popup usa **Attach DevTools to this tab** para que el badge muestre **ON**.

## Documentación

| Guide | Topics |
|-------|--------|
| [`docs/guides/cli.md`](docs/guides/cli.md) | `npm link`, `beebridge start --daemon`, variables de entorno, daemon logs, Settings URL |
| [`docs/guides/web-settings.md`](docs/guides/web-settings.md) | Web Settings (`/settings`), Profiles, Model Policy, Workspace, Diagnostics |
| [`docs/guides/bridge-graph.md`](docs/guides/bridge-graph.md) | Districts & bridges, JSON export/import, pipeline run |
| [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) | Waggle supervisor/worker harness en el Flower agent loop |

## Requisitos

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Google Chrome** con la extensión beebridge Flower cargada desde este repositorio

Notas completas de dependencias: [`INSTALL.md`](INSTALL.md).

## Instalación

El flujo es el mismo que **[`INSTALL.md`](INSTALL.md) - Quick Start**. Los detalles de configuración, entorno y troubleshooting están allí.

```bash
git clone https://github.com/aibeebridge/beebridge.git
cd beebridge
npm install
npm run build:release
cd ~/.beebridge && npm link
beebridge start --daemon
```

Sin `npm link`, usa **`node ~/.beebridge/beebridge.mjs start --daemon`**. Después de actualizar: **`beebridge servers restart --daemon`**. Para desarrollo: **`beebridge start --daemon --dev`**. Carga la extensión Chrome desde **`~/.beebridge/extension`**.

## Ejecución

Recomendado: **`beebridge start --daemon`** ejecuta **gateway + web** en production en segundo plano. Para un solo servicio usa **`beebridge gateway start --daemon`** o **`beebridge web start --daemon`**. Añade **`--dev`** para **`tsx`** / **`next dev`**.

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
| `start` | Inicia gateway + web juntos; `--daemon` ejecuta en segundo plano. |
| `gateway start` / `restart` | Inicia o reinicia el gateway. |
| `web start` / `restart` | Inicia o reinicia web. |
| `servers restart` | Detiene ambos puertos y reinicia gateway + web. |
| `stop` | Envía `SIGTERM` a procesos en 4321 y 3000. |
| `gateway token` | Imprime el gateway auth token actual. |
| `onboard` | Ejecuta la configuración inicial PM auth / model. |
| `tui` | Abre la terminal UI controlada por teclado. |

## Extensión Chrome

1. Abre `chrome://extensions/`, activa **Developer mode**, elige **Load unpacked** y selecciona `extension/`.
2. En el popup, configura **CDP relay URL** como `ws://127.0.0.1:4323`. Si cambiaste `PORT`, usa `PORT+2`.
3. Abre la pestaña a automatizar, pulsa el icono de la extensión y elige **Attach DevTools to this tab**. El badge **ON** indica conexión.

## Variables De Entorno

| Variable | Default | Description |
|----------|---------|-------------|
| `beebridge_HOME` | _(auto)_ | Repo root para comandos `npm run`; prefiere `~/.beebridge` si contiene un build completo. |
| `beebridge_GATEWAY_URL` | `http://localhost:4321` | Gateway HTTP base URL para llamadas CLI / TUI API. |
| `beebridge_GATEWAY_TOKEN` | _(optional)_ | Bearer token; fallback a `GATEWAY_TOKEN` o `~/.beebridge/gateway-token`. |
| `GATEWAY_TOKEN` | _(auto)_ | Si no existe, se genera y guarda un token. |
| `PORT` | `4321` | Gateway HTTP port |
| `BEEBRIDGE_CDP_RELAY_PORT` | `PORT + 2` | Loopback CDP relay port |
| `BEEBRIDGE_WEB_PORT` | `3000` | Web port para enlaces a la app Next.js |

## Estructura Del Proyecto

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

## Comandos Flower

Se admiten `navigate`, `click`, `type`, `read`, `scroll`, `wait`, `ai_chat`, `ai_read_response`, `screenshot` y otros. Los nombres exactos y las reglas Waggle están definidos en el gateway agent loop y en [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md).

## Licencia

[MIT](LICENSE)
