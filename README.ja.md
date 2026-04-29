# beebridge

[English](README.md) | [한국어](README.ko.md) | 日本語 | [中文](README.zh.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Español](README.es.md)

**Website**: <https://aibeebridge.pages.dev/>

**beebridge** は、**ブラウザー自動化**(Flower / Chrome DevTools Protocol) によってタスクを実行する AI プランナー兼ワーカースタックのモノレポです。**gateway** はジョブと CDP ツールをオーケストレーションし、**web app** はダッシュボードを提供し、**CLI** は gateway/web プロセスを管理します。**Flower** MV3 拡張は `chrome.debugger` をローカルのループバックリレーへ接続します。任意機能の **Waggle mode** は、ワーカーモデルと監督チャンネル(ブラウザー上の AI タブまたは API)を組み合わせます。詳細は [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) を参照してください。

## ビジョン

beebridge は、単なる自由形式の会話ではなく、ユーザーが **AI で実際の作業目標を達成**できるようにするためのものです。

そのために、2 つの補完的なアプローチを採用します。第一に **オントロジーグラフ方式**です。タスク、district、bridge を意味と関係の明示的なグラフとして扱い、AI が毎回すべてを説明し直すのではなく構造化された知識の上で動けるようにします。これにより **トークン使用量を最小化**できます。第二に **目標近接履歴方式**です。コンテキストとメモリを現在の目標に近い形で整理し、目標達成に役立つ情報だけを前面に出します。

その上に **Waggle mode** があります。ローカルモデル、クラウドプロバイダー、異なる性能層など **複数の AI を購読・結合**し、会話しながら協働させる仕組みです。単一モデルだけでは届きにくい結果を引き出し、出発点となるモデルの限界を超えることを狙います。

各 bridge の中では、作業は **bee** という小さく見えるエージェントとして表現されます。1 つの目的は巨大なプロンプトではなく、役割を持つ複数の bee、接続された district、bridge からなる **hive** へ自然に広がります。

## アーキテクチャ

Flower 自動化は最初から最後まで **Chrome DevTools Protocol(CDP)** を使います。gateway は **ループバック WebSocket リレー**を実行し、既定では `PORT=4321` のとき `127.0.0.1:4323` です。**beebridge Flower** MV3 拡張は `chrome.debugger` でタブへ接続し、CDP リクエスト/レスポンスを中継します。高レベルの Flower コマンド(`navigate`, `snapshot`, `fill`, `ai_chat`, Waggle hooks など)は gateway 内で `Runtime.evaluate`, `Page.navigate` などの CDP メソッドにより実装されます。

```text
Gateway (Node)                    Extension (Flower)                 Chrome tab
  CDP relay WS  <--------------->  chrome.debugger.sendCommand  <-->  page
  + task loop        token            onEvent -> relay
  WebSocket /ws  (flower.register metadata only)
```

- **Gateway** (`apps/gateway`) - Express + WebSockets: jobs/history, chat routing, 任意の Discord hooks, codegen/code-executor, CDP relay, browser agent loop(Waggle を含む)。
- **Web UI** (`apps/web`) - Next.js: bridges, jobs, flowers UI, settings。
- **CLI** (`apps/cli`) - **`npm run build:release`** 後に **`~/.beebridge`** で **`npm link`** を実行すると PATH から **`beebridge`** を使えます。**`beebridge start --daemon`** は gateway + web を production モードで起動し、**`--dev`** は dev server を使います。
- **Chrome extension** (`extension/`) - relay + debugger attach。popup の **Attach DevTools to this tab** で badge が **ON** になります。

## ドキュメント

| Guide | Topics |
|-------|--------|
| [`docs/guides/cli.md`](docs/guides/cli.md) | `npm link`, `beebridge start --daemon`, 環境変数, daemon logs, Settings URL |
| [`docs/guides/web-settings.md`](docs/guides/web-settings.md) | Web Settings (`/settings`), Profiles, Model Policy, Workspace, Diagnostics |
| [`docs/guides/bridge-graph.md`](docs/guides/bridge-graph.md) | Districts & bridges, JSON export/import, pipeline run |
| [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) | Flower agent loop の Waggle supervisor/worker harness |

## 要件

- **Node.js** >= 18.x
- **npm** >= 9.x
- このリポジトリから読み込んだ beebridge Flower 拡張付きの **Google Chrome**

依存関係の詳細は [`INSTALL.md`](INSTALL.md) を参照してください。

## インストール

基本手順は **[`INSTALL.md`](INSTALL.md) - Quick Start** と同じです。詳細な設定、環境変数、トラブルシュートはそちらにあります。

```bash
git clone https://github.com/aibeebridge/beebridge.git
cd beebridge
npm install
npm run build:release
cd ~/.beebridge && npm link
beebridge start --daemon
```

`npm link` なしでは **`node ~/.beebridge/beebridge.mjs start --daemon`** を使えます。アップグレード後は **`beebridge servers restart --daemon`**、開発サーバーは **`beebridge start --daemon --dev`** を使います。Chrome 拡張は **`~/.beebridge/extension`** から読み込んでください。

## 実行

推奨: **`beebridge start --daemon`** で production の **gateway + web** をバックグラウンド起動します。片方だけ起動する場合は **`beebridge gateway start --daemon`** または **`beebridge web start --daemon`** を使います。**`--dev`** を追加すると **`tsx`** / **`next dev`** ベースの dev server を使います。

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
| `start` | gateway + web を同時に起動します。`--daemon` はバックグラウンド実行です。 |
| `gateway start` / `restart` | gateway を起動または再起動します。 |
| `web start` / `restart` | web を起動または再起動します。 |
| `servers restart` | 両方のポートを停止して gateway + web を再起動します。 |
| `stop` | 4321 と 3000 のプロセスへ `SIGTERM` を送ります。 |
| `gateway token` | 現在の gateway auth token を表示します。 |
| `onboard` | 初回 PM auth / model 設定を進めます。 |
| `tui` | キーボード操作の terminal UI を起動します。 |

## Chrome 拡張

1. `chrome://extensions/` を開き、**Developer mode** を有効化し、**Load unpacked** で `extension/` を選びます。
2. popup の **CDP relay URL** を `ws://127.0.0.1:4323` に設定します。`PORT` を変えた場合は `PORT+2` を使います。
3. 自動化するタブで拡張アイコンを押し、**Attach DevTools to this tab** を選びます。badge が **ON** なら接続済みです。

## 環境変数

| Variable | Default | Description |
|----------|---------|-------------|
| `beebridge_HOME` | _(auto)_ | spawned `npm run` が使う repo root。未設定なら完全なビルドがある `~/.beebridge` を優先します。 |
| `beebridge_GATEWAY_URL` | `http://localhost:4321` | CLI / TUI API 用の gateway HTTP base URL。 |
| `beebridge_GATEWAY_TOKEN` | _(optional)_ | Bearer token。未設定なら `GATEWAY_TOKEN` または `~/.beebridge/gateway-token` を使います。 |
| `GATEWAY_TOKEN` | _(auto)_ | 未設定なら token を生成して `~/.beebridge/gateway-token` へ保存します。 |
| `PORT` | `4321` | Gateway HTTP port |
| `BEEBRIDGE_CDP_RELAY_PORT` | `PORT + 2` | Loopback CDP relay port |
| `BEEBRIDGE_WEB_PORT` | `3000` | Next.js app へのリンクに使う web port |

## プロジェクト構成

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

## 対応する Flower コマンド

`navigate`, `click`, `type`, `read`, `scroll`, `wait`, `ai_chat`, `ai_read_response`, `screenshot` などをサポートします。正確な tool name と Waggle harness の規則は gateway agent loop と [`docs/guides/waggle-mode.md`](docs/guides/waggle-mode.md) にあります。

## ライセンス

[MIT](LICENSE)
