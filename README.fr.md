# beebridge

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | [中文](README.zh.md) | [Deutsch](README.de.md) | Français | [Español](README.es.md)

**Website**: <https://aibeebridge.pages.dev/>

**beebridge** est un monorepo pour une pile de planification et d'exécution AI qui accomplit des tâches via **l'automatisation du navigateur** (Flower / Chrome DevTools Protocol). Le **gateway** orchestre les jobs et les outils CDP, la **web app** sert de tableau de bord, la **CLI** gère les processus gateway/web, et l'extension MV3 **Flower** relie `chrome.debugger` à un relais loopback local. Le **Waggle mode** optionnel associe un modèle worker à un canal supervisor (onglet AI dans le navigateur ou API). Voir [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md).

## Vision

beebridge existe pour aider les personnes à **atteindre de vrais objectifs de travail avec l'AI**, et pas seulement à tenir des conversations ouvertes.

Le système combine deux approches. D'abord, une **approche par graphe d'ontologie** : tasks, districts et bridges forment un graphe explicite de sens et de relations, afin que l'AI travaille sur une connaissance structurée sans tout réexpliquer à chaque fois. Cela aide à **réduire l'usage des tokens**. Ensuite, une **approche d'historique proche de l'objectif** : le contexte et la mémoire restent centrés sur l'objectif courant et font remonter ce qui aide réellement à avancer.

Au-dessus se trouve **Waggle mode** : une façon de **s'abonner à plusieurs AIs et de les combiner** - modèles locaux, fournisseurs cloud, niveaux différents - puis de les laisser collaborer en conversation. Ces échanges peuvent produire plus qu'un modèle isolé.

Dans chaque bridge, le travail est incarné par des **bees** : de petits agents visibles avec des rôles concrets. Un objectif devient naturellement une **hive** faite de plusieurs étapes, districts et bridges reliés, plutôt qu'un prompt monolithique.

## Architecture

L'automatisation Flower utilise **Chrome DevTools Protocol (CDP)** de bout en bout. Le gateway exécute un **relais WebSocket loopback** (par défaut `127.0.0.1:4323` quand `PORT=4321`). L'extension MV3 **beebridge Flower** attache `chrome.debugger` à un onglet et relaie les requêtes/réponses CDP. Les commandes Flower de haut niveau (`navigate`, `snapshot`, `fill`, `ai_chat`, Waggle hooks, etc.) sont implémentées dans le gateway avec `Runtime.evaluate`, `Page.navigate` et des méthodes CDP associées.

```text
Gateway (Node)                    Extension (Flower)                 Chrome tab
  CDP relay WS  <--------------->  chrome.debugger.sendCommand  <-->  page
  + task loop        token            onEvent -> relay
  WebSocket /ws  (flower.register metadata only)
```

- **Gateway** (`apps/gateway`) - Express + WebSockets : jobs/history, chat routing, hooks Discord optionnels, codegen/code-executor, CDP relay et browser agent loop avec Waggle.
- **Web UI** (`apps/web`) - Next.js : bridges, jobs, flowers UI, settings.
- **CLI** (`apps/cli`) - Après **`npm run build:release`**, exécutez **`npm link`** dans **`~/.beebridge`** pour utiliser **`beebridge`** dans le PATH. **`beebridge start --daemon`** lance gateway + web en production ; **`--dev`** utilise les dev servers.
- **Chrome extension** (`extension/`) - relay + debugger attach ; dans le popup, **Attach DevTools to this tab** doit afficher le badge **ON**.

## Documentation

| Guide | Topics |
|-------|--------|
| [`docs/guides/cli.md`](docs/guides/cli.md) | `npm link`, `beebridge start --daemon`, variables d'environnement, daemon logs, Settings URL |
| [`docs/guides/web-settings.md`](docs/guides/web-settings.md) | Web Settings (`/settings`), Profiles, Model Policy, Workspace, Diagnostics |
| [`docs/guides/bridge-graph.md`](docs/guides/bridge-graph.md) | Districts & bridges, JSON export/import, pipeline run |
| [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) | Waggle supervisor/worker harness dans la boucle agent Flower |

## Prérequis

- **Node.js** >= 18.x
- **npm** >= 9.x
- **Google Chrome** avec l'extension beebridge Flower chargée depuis ce dépôt

Voir [`INSTALL.md`](INSTALL.md) pour les dépendances complètes.

## Installation

Le flux est le même que **[`INSTALL.md`](INSTALL.md) - Quick Start**. Les détails de configuration, variables d'environnement et dépannage s'y trouvent.

```bash
git clone https://github.com/aibeebridge/beebridge.git
cd beebridge
npm install
npm run build:release
cd ~/.beebridge && npm link
beebridge start --daemon
```

Sans `npm link`, utilisez **`node ~/.beebridge/beebridge.mjs start --daemon`**. Après une mise à niveau : **`beebridge servers restart --daemon`**. Pour le développement : **`beebridge start --daemon --dev`**. Chargez l'extension Chrome depuis **`~/.beebridge/extension`**.

## Exécution

Méthode recommandée : **`beebridge start --daemon`** lance **gateway + web** en production en arrière-plan. Pour un seul service : **`beebridge gateway start --daemon`** ou **`beebridge web start --daemon`**. Ajoutez **`--dev`** pour utiliser **`tsx`** / **`next dev`**.

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
| `start` | Lance gateway + web ensemble ; `--daemon` exécute en arrière-plan. |
| `gateway start` / `restart` | Lance ou redémarre le gateway. |
| `web start` / `restart` | Lance ou redémarre le web. |
| `servers restart` | Arrête les deux ports puis relance gateway + web. |
| `stop` | Envoie `SIGTERM` aux processus sur 4321 et 3000. |
| `gateway token` | Affiche le gateway auth token courant. |
| `onboard` | Lance la configuration initiale PM auth / model. |
| `tui` | Ouvre l'interface terminal pilotée au clavier. |

## Extension Chrome

1. Ouvrez `chrome://extensions/`, activez **Developer mode**, choisissez **Load unpacked**, puis sélectionnez `extension/`.
2. Dans le popup, définissez **CDP relay URL** sur `ws://127.0.0.1:4323`. Si `PORT` a changé, utilisez `PORT+2`.
3. Ouvrez l'onglet à automatiser, cliquez l'icône de l'extension, puis **Attach DevTools to this tab**. Le badge **ON** indique la connexion.

## Variables D'environnement

| Variable | Default | Description |
|----------|---------|-------------|
| `beebridge_HOME` | _(auto)_ | Repo root pour les commandes `npm run` lancées ; préfère `~/.beebridge` si un build complet existe. |
| `beebridge_GATEWAY_URL` | `http://localhost:4321` | Gateway HTTP base URL pour les appels CLI / TUI API. |
| `beebridge_GATEWAY_TOKEN` | _(optional)_ | Bearer token ; fallback vers `GATEWAY_TOKEN` ou `~/.beebridge/gateway-token`. |
| `GATEWAY_TOKEN` | _(auto)_ | Si absent, un token est généré et stocké. |
| `PORT` | `4321` | Gateway HTTP port |
| `BEEBRIDGE_CDP_RELAY_PORT` | `PORT + 2` | Loopback CDP relay port |
| `BEEBRIDGE_WEB_PORT` | `3000` | Web port pour les liens vers l'app Next.js |

## Structure Du Projet

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

## Commandes Flower

Les commandes prises en charge incluent `navigate`, `click`, `type`, `read`, `scroll`, `wait`, `ai_chat`, `ai_read_response` et `screenshot`. Les noms exacts et les règles Waggle sont définis dans la boucle agent gateway et dans [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md).

## Licence

[MIT](LICENSE)
