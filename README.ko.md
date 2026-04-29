# beebridge

[English](README.md) | 한국어 | [日本語](README.ja.md) | [中文](README.zh.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md)

**Website**: <https://aibeebridge.pages.dev/>

**beebridge**는 **브라우저 자동화**(Flower / Chrome DevTools Protocol)를 통해 작업을 수행하는 AI 플래너 및 워커 스택을 위한 모노레포입니다. **gateway**는 작업과 CDP 도구를 오케스트레이션하고, **web app**은 대시보드 역할을 하며, **CLI**는 gateway/web 프로세스를 관리할 수 있습니다. **Flower** MV3 확장 프로그램은 `chrome.debugger`를 로컬 루프백 릴레이에 연결합니다. 선택 기능인 **Waggle mode**는 워커 모델과 감독 채널(브라우저 AI 탭 또는 API)을 함께 사용합니다. 자세한 내용은 [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md)를 참고하세요.

## 비전

beebridge는 사용자가 열린 대화에 머무르지 않고, **AI를 통해 실제 업무 목표를 달성**하도록 돕기 위해 만들어졌습니다.

이를 위해 두 가지 접근 방식을 결합합니다. 첫째, **온톨로지 그래프 접근**입니다. 작업, district, bridge를 의미와 관계의 명시적인 그래프로 다루어 AI가 매번 모든 맥락을 다시 설명하지 않고 구조화된 지식 위에서 동작하게 합니다. 이는 **토큰 사용량을 최소화**하는 데 도움이 됩니다. 둘째, **목표 근접 히스토리 접근**입니다. 컨텍스트와 메모리를 현재 목표에 가깝게 정리해, 목표 달성에 실제로 도움이 되는 정보만 드러내고 불필요한 잡음을 줄입니다.

그 위에 **Waggle mode**가 있습니다. Waggle mode는 로컬 모델, 클라우드 제공자, 서로 다른 성능 계층의 모델 등 **여러 AI를 구독하고 결합**해 서로 대화하며 협업하게 하는 방식입니다. 이런 왕복 대화는 단일 모델만으로 얻기 어려운 결과를 끌어내며, 시작점이 된 모델의 한계를 넘어서는 데 도움을 줍니다. 이 흐름은 의도적으로 **사람과 비슷한 방식**을 따릅니다. 사람도 전지전능하지 않지만 도구를 바꾸고, 모델을 바꾸고, 다시 질문하고, 반복하면서 목표에 도달합니다. beebridge는 바로 그 루프를 재현합니다.

각 bridge 안에서 작업은 **bee**라는 작고 가시적인 에이전트로 표현됩니다. 하나의 목표는 하나의 거대한 프롬프트가 아니라, 역할이 분명한 여러 bee, 연결된 district, bridge로 이루어진 **hive**로 자연스럽게 확장됩니다. bee 은유는 장식이 아니라 작업 생성, 할당, 연결 방식에 영향을 주는 핵심 구조입니다.

더 큰 목표는 **네트워크**입니다. 사용자가 beebridge를 사용하면서 만든 워크플로, 그래프, export, 패턴은 서로 공유될 수 있습니다. 시간이 지나면 이런 공유 워크플로가 하나의 **넓은 AI 기반 기술 네트워크**로 이어집니다. 개별 hive에서 공유 생태계로 성장하는 것이 beebridge가 지향하는 방향입니다.

## 아키텍처

Flower 자동화는 처음부터 끝까지 **Chrome DevTools Protocol(CDP)**을 사용합니다. gateway는 **루프백 WebSocket 릴레이**를 실행하며, 기본값은 `PORT=4321`일 때 `127.0.0.1:4323`입니다. **beebridge Flower** MV3 확장 프로그램은 `chrome.debugger`로 탭에 연결하고 CDP 요청/응답을 전달합니다. 고수준 Flower 명령(`navigate`, `snapshot`, `fill`, `ai_chat`, Waggle hooks 등)은 gateway에서 `Runtime.evaluate`, `Page.navigate` 및 관련 CDP 메서드로 구현되며, `tabs.sendMessage` 기반 content script 방식이 아닙니다.

```text
Gateway (Node)                    Extension (Flower)                 Chrome tab
  CDP relay WS  <--------------->  chrome.debugger.sendCommand  <-->  page
  + task loop        token            onEvent -> relay
  WebSocket /ws  (flower.register metadata only)
```

- **Gateway** (`apps/gateway`) - Express + WebSockets: jobs/history, chat routing, 선택적 Discord hooks, codegen/code-executor 경로, CDP relay 및 브라우저 agent loop(Waggle 포함).
- **Web UI** (`apps/web`) - Next.js: bridges, jobs, flowers UI, settings.
- **CLI** (`apps/cli`) - **`npm run build:release`** 이후 **`~/.beebridge`**에서 **`npm link`**를 실행하면 PATH에서 **`beebridge`** 명령을 사용할 수 있습니다. 최상위 **`beebridge start --daemon`**은 gateway + web을 production 모드로 실행하며, **`--dev`**는 dev server를 사용합니다. `stop`, `servers restart`, `gateway token`, onboarding, TUI도 제공합니다. 자세한 내용은 [`docs/guides/cli.md`](docs/guides/cli.md)를 참고하세요.
- **Chrome extension** (`extension/`) - relay + debugger attach. popup에서 **Attach DevTools to this tab**을 눌러 badge가 **ON**으로 표시되게 합니다.

## 문서

| Guide | Topics |
|-------|--------|
| [`docs/guides/cli.md`](docs/guides/cli.md) | **`npm link`**, **`beebridge start --daemon`**, `beebridge_HOME` / `beebridge_GATEWAY_*`, daemon logs, `manager setup` -> Settings URL |
| [`docs/guides/web-settings.md`](docs/guides/web-settings.md) | **Web Settings** (`/settings`): Connection, Profiles, Model Policy, Workspace, Diagnostics, gateway APIs |
| [`docs/guides/bridge-graph.md`](docs/guides/bridge-graph.md) | Districts & bridges, JSON **export/import** (`beebridge.bridge-settings.v1`), one-way bridge 기반 **pipeline run**, upstream tasks / `{{bridgeOut:...}}` |
| [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) | Flower agent loop의 Waggle supervisor/worker harness |

## 요구 사항

- **Node.js** >= 18.x
- **npm** >= 9.x
- 이 저장소에서 로드한 beebridge Flower 확장 프로그램이 설치된 **Google Chrome**

전체 의존성 관련 내용은 [`INSTALL.md`](INSTALL.md)를 참고하세요.

## 설치

기본 흐름은 **[`INSTALL.md`](INSTALL.md) - Quick Start**와 같습니다. 자세한 설정, 환경 변수, 문제 해결은 해당 문서에 있습니다.

원하는 위치에 clone할 수 있습니다. **`npm run build:release`**는 **`npm run build`**와 동일하며, 전체 빌드를 수행한 뒤 **`~/.beebridge`**로 동기화합니다. macOS/Linux에서는 [`scripts/install-home.mjs`](scripts/install-home.mjs)가 **`rsync`**를 사용합니다. **`~/.beebridge`** 아래의 **`gateway-token`**과 **`config.json`**은 동기화 과정에서 덮어쓰지 않습니다.

```bash
# 1. Clone (example path)
git clone https://github.com/aibeebridge/beebridge.git
cd beebridge

# 2. Install dependencies
npm install

# 3. Production build + install into ~/.beebridge
npm run build:release

# 4. npm link (once) - then you can type `beebridge`
cd ~/.beebridge && npm link

# 5. Start gateway + web in the background
beebridge start --daemon

# Same without PATH:
node ~/.beebridge/beebridge.mjs start --daemon

# Single service:
beebridge gateway start --daemon
beebridge web start --daemon

# After upgrade:
beebridge servers restart --daemon

# Dev servers:
beebridge start --daemon --dev
```

3단계 이후 launcher는 완성된 빌드가 있으면 기본적으로 **`~/.beebridge`**를 우선 사용합니다. 필요한 경우 **`beebridge_HOME`**으로 override할 수 있습니다. Chrome 확장 프로그램은 **`~/.beebridge/extension`**에서 로드하세요.

개발 중 **`--dev`**와 함께 빠르게 package만 다시 빌드하려면 **`npm run build:libs`**를 사용하세요. 이 명령은 **`install:home`**을 실행하지 않습니다. **`~/.beebridge`**를 갱신하려면 **`npm run install:home`** 또는 **`npm run build:release`**를 실행하세요. 추가 문서는 [`docs/guides/deployment.md`](docs/guides/deployment.md), [`docs/guides/cli.md`](docs/guides/cli.md)에 있습니다.

## 실행

**권장 방식:** [설치](#설치)에서 설명한 대로 **`npm link`**를 설정한 뒤, **`beebridge start --daemon`**으로 production 모드의 **gateway + web**을 백그라운드에서 실행합니다. **`beebridge gateway start --daemon`** / **`beebridge web start --daemon`**은 한쪽 서비스만 실행합니다. **`--dev`**를 추가하면 **`tsx`** / **`next dev`** 기반 dev server를 사용합니다.

**`npm link`** 없이 실행하려면 **`node ~/.beebridge/beebridge.mjs ...`** 또는 설치 디렉터리에서 **`node beebridge.mjs`**를 사용하세요.

**npm script로도 동일하게 실행할 수 있습니다:** **`npm run start:gateway`** / **`npm run start:web`** 또는 **`npm run start:daemon`**.

### Gateway (API + WebSocket + CDP relay)

```bash
cd ~/.beebridge
beebridge gateway start --daemon
# Foreground: beebridge gateway start
# npm: npm run start:gateway
# Default HTTP API: http://localhost:4321  (Next.js UI가 아님)
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

CLI를 사용하려면 빌드가 필요합니다. **`npm run build:release`**에 CLI 빌드가 포함되어 있습니다. **`~/.beebridge`**에서 **`npm link`**를 실행했다면 **`beebridge ...`**를 사용할 수 있고, 그렇지 않으면 **`node beebridge.mjs ...`**로 실행합니다. 전체 명령어는 [`docs/guides/cli.md`](docs/guides/cli.md)를 참고하세요.

| Command | Purpose |
|---------|---------|
| **`start`** | **gateway + web**을 함께 시작합니다. **`--daemon`**은 백그라운드 실행이며, **`--dev`**가 없으면 production 모드입니다. |
| `gateway start` \| `restart` | Production gateway(`start:gateway`). **`--dev`**는 `dev:gateway`, **`--daemon`**은 백그라운드 실행입니다. 로그는 `.beebridge-daemon/gateway-<port>.log`에 저장됩니다. |
| `web start` \| `restart` | Production web(`start:web`). **`--dev`**는 `dev:web`, **`--daemon`**은 백그라운드 실행, **`--open`**은 `/dashboard`를 엽니다. |
| `servers restart` | 두 포트를 중지한 뒤 gateway + web을 다시 시작합니다. **`--daemon`**이 필요합니다. |
| `web settings`, `manager setup` | 브라우저에서 **Settings**를 엽니다. **`--dev`**를 함께 사용할 수 있습니다. |
| `stop` | **4321**(gateway)과 **3000**(web)을 사용하는 프로세스에 **`SIGTERM`**을 보냅니다. **`--gateway-port`** / **`--web-port`**로 override할 수 있습니다. |
| `gateway token` | 현재 gateway auth token을 출력합니다. 자동 생성 시 `~/.beebridge/gateway-token`과 같은 값입니다. |
| `onboard` | 최초 PM auth / model 설정을 진행합니다. |
| _(no args)_ or `tui` | 키보드 기반 terminal UI를 실행합니다. |

루트 `package.json`의 편의 npm script도 이 명령들을 반영합니다. 예: `start:daemon`, `gateway:start:daemon`, `web:start:daemon`.

```bash
beebridge start --daemon
beebridge gateway start --daemon
beebridge web start --daemon
beebridge servers restart --daemon
beebridge stop
# Or: node ~/.beebridge/beebridge.mjs ...
# Add --dev for development servers.
```

### Chrome extension

1. `chrome://extensions/`를 열고 **Developer mode**를 켠 뒤 **Load unpacked**를 선택하고 `extension/` 폴더를 지정합니다.
2. popup에서 **CDP relay URL**을 `ws://127.0.0.1:4323`으로 설정합니다. `PORT`를 바꿨다면 `PORT+2`를 사용합니다.
3. 자동화할 탭을 열고 extension icon -> **Attach DevTools to this tab**을 누릅니다. badge가 **ON**이면 연결된 상태입니다.

## 환경 변수

| Variable | Default | Description |
|----------|---------|-------------|
| `beebridge_HOME` | _(auto)_ | spawned `npm run` 명령이 사용할 repo root입니다. unset이면 [`beebridge.mjs`](beebridge.mjs)는 완성된 빌드가 있는 **`~/.beebridge`**를 사용하고, 없으면 실행한 `beebridge.mjs`의 디렉터리를 사용합니다. |
| `beebridge_GATEWAY_URL` | `http://localhost:4321` | CLI / TUI API 호출을 위한 gateway HTTP base URL입니다. |
| `beebridge_GATEWAY_TOKEN` | _(optional)_ | Bearer token입니다. 없으면 `GATEWAY_TOKEN` 또는 `~/.beebridge/gateway-token`으로 fallback합니다. |
| `GATEWAY_TOKEN` | _(auto)_ | unset이면 token이 생성되어 `~/.beebridge/gateway-token`에 저장됩니다. 직접 설정하면 해당 값을 사용합니다. |
| `PORT` | `4321` | Gateway HTTP port |
| `BEEBRIDGE_CDP_RELAY_PORT` | `PORT + 2` | Loopback CDP relay port입니다. 예: `PORT=4321`이면 `4323` |
| `BEEBRIDGE_WEB_PORT` | `3000` | gateway의 API-only help page에서 Next.js app 링크에 사용됩니다. |
| `GITHUB_CLIENT_ID` | -- | GitHub OAuth app client ID입니다. 예: Copilot 관련 flow |
| `BEEBRIDGE_GITHUB_CLIENT_ID` | -- | `GITHUB_CLIENT_ID`의 alias입니다. |
| `AIBRIDGE_GITHUB_CLIENT_ID` | -- | 이전 설정을 위한 legacy alias입니다. |
| `OPENAI_CODEX_CLIENT_ID` / `OPENAI_CODEX_REDIRECT_URI` | see code | 선택적 OpenAI Codex OAuth override입니다. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1` | TLS 검증을 끄려면 `0`으로 설정합니다. **개발 환경에서만 사용하세요.** |

`NEXT_PUBLIC_GATEWAY_TOKEN`이 설정되지 않은 경우 Next.js app은 서버에서 gateway token을 해석합니다. shared persistence와 internal API route를 사용하므로, 첫 gateway 실행 후에는 대시보드에서 보통 token을 수동으로 복사할 필요가 없습니다. 터미널에서 값이 필요하면 **`beebridge gateway token`**을 사용하세요.

더 많은 옵션(`.env` 예시, CORS, auth mode)은 [`INSTALL.md`](INSTALL.md)에 있습니다.

## 프로젝트 구조

```text
beebridge/
├── apps/
│   ├── gateway/          # @beebridge/gateway - Express, WS, CDP relay, browser/waggle, chat, codegen
│   │   └── src/
│   │       ├── server/   # API, stores, Discord flower manager, chat routing
│   │       ├── browser/  # CDP relay, Flower commands, waggle, LLM client
│   │       ├── codegen/  # Code executor, project/subtask/process managers
│   │       ├── auth/
│   │       └── settings/
│   ├── web/              # @beebridge/web - Next.js dashboard
│   └── cli/              # @beebridge/cli - process helpers via beebridge.mjs
├── extension/            # MV3 Flower - relay + chrome.debugger
├── packages/
│   ├── shared/           # @beebridge/shared - shared types
│   └── core/             # @beebridge/core - planner, approval gate, queue
├── docs/guides/          # e.g. Waggle mode
├── beebridge.mjs         # Root CLI loader (built CLI 필요)
└── package.json          # Workspaces + scripts
```

## 지원되는 Flower 명령(상위 수준)

| Command | Description |
|---------|-------------|
| `navigate` | URL을 엽니다. |
| `click` | selector로 element를 클릭합니다. |
| `type` | input에 텍스트를 입력합니다. |
| `read` | 보이는 텍스트를 읽습니다. |
| `scroll` | 페이지를 스크롤합니다. |
| `wait` | 지정한 시간 동안 대기합니다. |
| `ai_chat` / `ai_read_response` | Chat UI 자동화입니다. Waggle tab에서 자주 사용됩니다. |
| `screenshot` | 현재 viewport screenshot을 캡처합니다. |

정확한 tool name과 Waggle harness 규칙은 gateway agent loop에 정의되어 있습니다. supervisor/worker 동작은 [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md)를 참고하세요.

## 설정 저장

Auth profile과 model policy는 `.beebridge-data/` 아래에 저장됩니다. 예: `pm-settings.json`. 이 경로는 gitignore 처리되어 있습니다.

## 라이선스

[MIT](LICENSE)
