# beebridge CLI

**Project site:** <https://aibeebridge.pages.dev/>

The CLI lives in [`apps/cli`](../../apps/cli) and is loaded from the repo root via [`beebridge.mjs`](../../beebridge.mjs).

## Prerequisites

```bash
npm run build:cli
node beebridge.mjs --help
```

If `apps/cli/dist/index.js` is missing, the root loader exits with a message to run `npm run build:cli` first.

## `beebridge` on your PATH (recommended)

After a release build, from **`~/.beebridge`** (or your clone root):

```bash
npm link
```

This registers the package’s **`bin`** entry ([`package.json`](../../package.json)) so you can run **`beebridge`** instead of **`node beebridge.mjs`** from any directory. To remove later: **`npm unlink -g beebridge`** (or from the same directory, **`npm unlink`**).

Same commands either way — for example **`beebridge start --daemon`** (both servers) or **`beebridge gateway start --daemon`**.

## Default behavior (no arguments)

Running `node beebridge.mjs` with **no subcommand** launches the **keyboard-driven terminal TUI** ([`launchTerminalGui`](../../apps/cli/src/tui/terminal-gui.ts)).

To print help instead, pass `--help` or a subcommand (e.g. `node beebridge.mjs gateway --help`).

## Environment variables

| Variable | Used by | Default | Purpose |
|----------|---------|---------|---------|
| `beebridge_HOME` | Repo resolution ([`repo-root.ts`](../../apps/cli/src/repo-root.ts)), root [`beebridge.mjs`](../../beebridge.mjs) | If unset: **`~/.beebridge`** when that folder has `package.json` and a built CLI (`apps/cli/dist/index.js`); otherwise the directory of `beebridge.mjs` | Working directory for `npm run start:gateway` / `start:web` (or `dev:*` with `--dev`) spawned by CLI |
| `beebridge_GATEWAY_URL` | Manager, task, project, TUI | `http://localhost:4321` | Gateway HTTP base URL for API calls |
| `beebridge_GATEWAY_TOKEN` | Same | _(unset)_ | Bearer token; falls back to `GATEWAY_TOKEN`, then `~/.beebridge/gateway-token` if present |
| `PORT` | `gateway` / `web` start commands | `4321` (gateway) / `3000` (web) via each command | Listen port when starting servers |

GitHub Copilot device login (`manager auth login --provider github-copilot`) requires an **interactive TTY**.

## Production vs development

By default, `gateway start|restart` and `web start|restart` run **production** scripts: `npm run start:gateway` (compiled `dist/`) and `npm run start:web` (`next start`). Run **`npm run build:release`** (same as **`npm run build`**) from the repo root first.

For faster iteration when only workspace packages change, **`npm run build:libs`** builds `shared`, `worker-browser`, and `core` only; it does **not** build the gateway `dist` or the Next.js `.next` output, so production `start` (without `--dev`) still requires a full **`build:release`**.

Pass **`--dev`** to use **`npm run dev:gateway`** (tsx) or **`npm run dev:web`** (`next dev`) instead.

## Daemon mode (`-d` / `--daemon`)

`beebridge gateway start|restart`, `beebridge web start|restart`, and **`beebridge servers restart`** accept **`--daemon`** ( **`servers restart` requires it** ). The CLI spawns the chosen npm script **detached**, with:

- Logs: `.beebridge-daemon/<gateway|web>-<port>.log`
- PID file: `.beebridge-daemon/<gateway|web>-<port>.pid`

See [`daemon-spawn.ts`](../../apps/cli/src/daemon-spawn.ts).

## Command reference

Top-level name: `beebridge` (see [`index.ts`](../../apps/cli/src/index.ts)).

### `onboard`

Interactive first-time setup (PM auth, model, runtime).

| Option | Description |
|--------|-------------|
| `--install-daemon` | Include daemon install step |
| `-y`, `--yes` | Non-interactive with defaults |

### `job create`

| Option | Description |
|--------|-------------|
| `-g`, `--goal <goal>` | **Required.** Job description |

### `manager` — Project manager AI

| Subcommand | Options | Description |
|------------|---------|-------------|
| `plan` | `-g` goal (required), `-d` deadline, `-p` priority | Plan with goal |
| `ask` | `-g` goal (required) | Same as creating a job (alias flow) |
| `settings` | — | Print PM settings JSON (`managerSettingsShow`) |
| `setup` | `--tab`, `--port`, `--no-open`, `--dev` | Start web UI and open **Settings** (see below) |

#### `manager setup` (opens web Settings)

| Option | Default | Description |
|--------|---------|-------------|
| `--tab <tab>` | `connection` | `connection` \| `auth` \| `model` \| `workspace` \| `status` — matches [`/settings?tab=`](./web-settings.md) |
| `--port <port>` | `3000` | Web UI port |
| `--no-open` | — | Do not open the browser |
| `--dev` | — | Use `next dev` instead of `next start` |

### `manager auth`

| Subcommand | Options | Description |
|------------|---------|-------------|
| `add` | `--provider`, `--mode` (`api_key` \| `oauth`), `--secret`, `--label?` | Add auth profile via gateway API |
| `login` | `--provider` (required), `--label?`, `--no-open?` | OAuth/device flows (e.g. GitHub Copilot) or gateway-assisted login |
| `activate` | `--profile <profileId>` | Activate a profile |
| `remove` | `--profile <profileId>` | Delete a profile |

### `manager model`

| Subcommand | Options | Description |
|------------|---------|-------------|
| `providers` | — | List provider catalog (JSON) |
| `set` | `--provider`, `--model` (required), `--allow`, `--fallback` | Set default model policy |

### `bee` — Worker queue

| Subcommand | Description |
|------------|-------------|
| `run` | Run approved bee queue |
| `approvals` | List pending approvals |
| `approve` | `-j`, `--job <jobId>` — approve a job |

### `flower`

| Subcommand | Description |
|------------|-------------|
| `status` | Flower / integration status |

### `stop`

| Option | Description |
|--------|-------------|
| `--gateway-port <port>` | Gateway listen port to clear (default: `4321`) |
| `--web-port <port>` | Web UI listen port to clear (default: `3000`) |

Sends **SIGTERM** to any process(es) listening on those ports (same mechanism as the first half of `gateway restart` / `web restart`). On Windows, port-based stop is not supported yet ([`port-utils.ts`](../../apps/cli/src/port-utils.ts)).

### `start` (top-level)

| Option | Description |
|--------|-------------|
| `--gateway-port <port>` | Gateway port (default: `4321`, or `PORT` env) |
| `--web-port <port>` | Web UI port (default: `3000`) |
| **`-d` / `--daemon` (required)** | Start **gateway and web** as background processes (same as two `gateway start --daemon` + `web start --daemon`) |
| `--dev` | Use `dev:gateway` + `dev:web` instead of production |
| `-o` / `--open` | Open `/dashboard` after the web server starts |

Does **not** stop existing listeners first — use **`servers restart --daemon`** to stop then start. For foreground logs, use two terminals with **`gateway start`** and **`web start`** (no `--daemon`).

### `servers`

| Subcommand | Options | Description |
|------------|---------|-------------|
| `start` | `--gateway-port`, `--web-port`, **`-d` / `--daemon` (required)**, `--dev`, `-o` / `--open` | Start gateway and web as background daemons after clearing the target ports. |
| `restart` | `--gateway-port`, `--web-port`, **`-d` / `--daemon` (required)**, `--dev`, `-o` / `--open` | Stop gateway and web ports, then start **gateway first**, then **web**. Use **`--daemon`** to run both in the background in one terminal; for foreground logs, use **`gateway restart`** and **`web restart`** in two terminals instead. |

### `sandbox`

| Subcommand | Options | Description |
|------------|---------|-------------|
| `list` | -- | List Beebridge Docker sandbox containers tracked by gateway labels. |
| `remove <target>` | -- | Remove a sandbox container by container name, id, or background session id. |
| `kill <session-id>` | -- | Kill sandbox containers for a managed background process session. |
| `cleanup` | `--include-project` | Remove task/background sandbox containers. Persistent project-scope containers are kept unless `--include-project` is passed. |

### `gateway`

| Subcommand | Options | Description |
|------------|---------|-------------|
| `start` | `--port`, `-d` / `--daemon`, `--dev` | Run gateway (`npm run start:gateway` by default; `--dev` uses `dev:gateway`) |
| `restart` | Same | Stop process on port, then start again |

### `web`

| Subcommand | Options | Description |
|------------|---------|-------------|
| `start` | `-o` / `--open`, `--port`, `-d` / `--daemon`, `--dev` | Next.js UI; production `next start` unless `--dev`; `--open` goes to `/dashboard` |
| `restart` | Same | Stop process on port, then start |
| `settings` | `--tab`, `--port`, `--no-open`, `--dev` | Same as `manager setup` — opens `/settings?tab=…` |

### `tui`

Launch the terminal GUI explicitly (same as running `beebridge` with no args, but keeps parity with `--help`).

### Legacy aliases

| Command | Maps to |
|---------|---------|
| `project create -g <goal>` | `job create` |
| `task plan …` | `manager plan …` |
| `task run-approved` | `bee run` |

## See also

- [Deployment (git clone)](./deployment.md) — production build and `servers restart`
- [Web Settings](./web-settings.md) — Settings tabs opened by `manager setup` / `web settings`
- [Bridge graph](./bridge-graph.md) — districts / export (UI, not CLI-specific)
- Root [`package.json`](../../package.json) — npm scripts `start:daemon` (`beebridge start --daemon`), `start:gateway`, `start:web`, `dev:gateway`, `dev:web`, `build`, `build:release`, `build:libs`, `build:cli`, `servers:restart:daemon`, etc.
