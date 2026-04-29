# beebridge

[English](README.md) | [한국어](README.ko.md) | [日本語](README.ja.md) | 中文 | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md)

**Website**: <https://aibeebridge.pages.dev/>

**beebridge** 是一个用于 AI 规划器和工作器栈的 monorepo，通过 **浏览器自动化**(Flower / Chrome DevTools Protocol) 完成任务。**gateway** 编排 jobs 和 CDP tools；**web app** 是仪表盘；**CLI** 可管理 gateway/web 进程；**Flower** MV3 扩展把 `chrome.debugger` 连接到本机 loopback relay。可选的 **Waggle mode** 会把 worker model 与 supervisor channel(浏览器 AI 标签页或 API)配对，详见 [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md)。

## 愿景

beebridge 的目标是让用户通过 **AI 完成真实工作目标**，而不是停留在开放式对话中。

系统采用两种互补方式。第一是 **ontology graph approach**：把 tasks、districts、bridges 组织成明确的语义和关系图，让 AI 在结构化知识上工作，而不必每次从头解释上下文，从而 **尽量减少 token 使用量**。第二是 **goal-proximate history approach**：把上下文和记忆整理到当前目标附近，只保留真正推动目标的信息。

在此之上是 **Waggle mode**：一种 **订阅并组合多个 AI** 的方式，包括本地模型、云端供应商和不同层级的模型，让它们在对话中协作。来回讨论可以产生单个模型难以独立给出的结果，并突破起始模型的局限。

在每个 bridge 中，工作被表示为 **bees**，也就是小而可见、具有明确角色的 agent。单个目标会自然扩展成一个 **hive**：多个 bee 形态的步骤、相互连接的 districts 和 bridges，而不是一个巨大的 prompt。

## 架构

Flower 自动化端到端使用 **Chrome DevTools Protocol(CDP)**。gateway 运行 **loopback WebSocket relay**，默认在 `PORT=4321` 时使用 `127.0.0.1:4323`。**beebridge Flower** MV3 扩展通过 `chrome.debugger` 连接到标签页并转发 CDP 请求/响应。高层 Flower commands(`navigate`, `snapshot`, `fill`, `ai_chat`, Waggle hooks 等)在 gateway 中通过 `Runtime.evaluate`, `Page.navigate` 等 CDP 方法实现。

```text
Gateway (Node)                    Extension (Flower)                 Chrome tab
  CDP relay WS  <--------------->  chrome.debugger.sendCommand  <-->  page
  + task loop        token            onEvent -> relay
  WebSocket /ws  (flower.register metadata only)
```

- **Gateway** (`apps/gateway`) - Express + WebSockets: jobs/history, chat routing, 可选 Discord hooks, codegen/code-executor, CDP relay, browser agent loop(含 Waggle)。
- **Web UI** (`apps/web`) - Next.js: bridges, jobs, flowers UI, settings。
- **CLI** (`apps/cli`) - 运行 **`npm run build:release`** 后，在 **`~/.beebridge`** 中执行 **`npm link`**，即可在 PATH 中使用 **`beebridge`**。**`beebridge start --daemon`** 以 production 模式启动 gateway + web，**`--dev`** 使用 dev servers。
- **Chrome extension** (`extension/`) - relay + debugger attach。点击 popup 中的 **Attach DevTools to this tab**，badge 显示 **ON**。

## 文档

| Guide | Topics |
|-------|--------|
| [`docs/guides/cli.md`](docs/guides/cli.md) | `npm link`, `beebridge start --daemon`, 环境变量, daemon logs, Settings URL |
| [`docs/guides/web-settings.md`](docs/guides/web-settings.md) | Web Settings (`/settings`), Profiles, Model Policy, Workspace, Diagnostics |
| [`docs/guides/bridge-graph.md`](docs/guides/bridge-graph.md) | Districts & bridges, JSON export/import, pipeline run |
| [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) | Flower agent loop 中的 Waggle supervisor/worker harness |

## 要求

- **Node.js** >= 18.x
- **npm** >= 9.x
- 从本仓库加载 beebridge Flower 扩展的 **Google Chrome**

完整依赖说明见 [`INSTALL.md`](INSTALL.md)。

## 安装

基本流程与 **[`INSTALL.md`](INSTALL.md) - Quick Start** 相同，详细配置、环境变量和排错也在该文档中。

```bash
git clone https://github.com/aibeebridge/beebridge.git
cd beebridge
npm install
npm run build:release
cd ~/.beebridge && npm link
beebridge start --daemon
```

不使用 `npm link` 时可运行 **`node ~/.beebridge/beebridge.mjs start --daemon`**。升级后使用 **`beebridge servers restart --daemon`**。开发服务器使用 **`beebridge start --daemon --dev`**。Chrome 扩展请从 **`~/.beebridge/extension`** 加载。

## 运行

推荐方式：使用 **`beebridge start --daemon`** 在后台运行 production 模式的 **gateway + web**。只启动一侧时使用 **`beebridge gateway start --daemon`** 或 **`beebridge web start --daemon`**。添加 **`--dev`** 可使用 **`tsx`** / **`next dev`**。

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
| `start` | 同时启动 gateway + web；`--daemon` 表示后台运行。 |
| `gateway start` / `restart` | 启动或重启 gateway。 |
| `web start` / `restart` | 启动或重启 web。 |
| `servers restart` | 停止两个端口后重启 gateway + web。 |
| `stop` | 向 4321 和 3000 上的进程发送 `SIGTERM`。 |
| `gateway token` | 输出当前 gateway auth token。 |
| `onboard` | 进行首次 PM auth / model 设置。 |
| `tui` | 启动键盘驱动的 terminal UI。 |

## Chrome 扩展

1. 打开 `chrome://extensions/`，启用 **Developer mode**，点击 **Load unpacked** 并选择 `extension/`。
2. 在 popup 中把 **CDP relay URL** 设为 `ws://127.0.0.1:4323`。如果修改了 `PORT`，请使用 `PORT+2`。
3. 打开要自动化的标签页，点击扩展图标并选择 **Attach DevTools to this tab**。badge 为 **ON** 表示已连接。

## 环境变量

| Variable | Default | Description |
|----------|---------|-------------|
| `beebridge_HOME` | _(auto)_ | spawned `npm run` 使用的 repo root。未设置时优先使用包含完整构建的 `~/.beebridge`。 |
| `beebridge_GATEWAY_URL` | `http://localhost:4321` | CLI / TUI API 调用的 gateway HTTP base URL。 |
| `beebridge_GATEWAY_TOKEN` | _(optional)_ | Bearer token；缺省时回退到 `GATEWAY_TOKEN` 或 `~/.beebridge/gateway-token`。 |
| `GATEWAY_TOKEN` | _(auto)_ | 未设置时生成 token 并保存到 `~/.beebridge/gateway-token`。 |
| `PORT` | `4321` | Gateway HTTP port |
| `BEEBRIDGE_CDP_RELAY_PORT` | `PORT + 2` | Loopback CDP relay port |
| `BEEBRIDGE_WEB_PORT` | `3000` | 用于链接 Next.js app 的 web port |

## 项目结构

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

## 支持的 Flower 命令

支持 `navigate`, `click`, `type`, `read`, `scroll`, `wait`, `ai_chat`, `ai_read_response`, `screenshot` 等。准确的 tool name 和 Waggle harness 规则在 gateway agent loop 与 [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) 中定义。

## 许可证

[MIT](LICENSE)
