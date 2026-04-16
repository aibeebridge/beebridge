# Deployment (git clone)

This guide is for running beebridge from a **git clone** on a machine that will **serve production** gateway + web (not day-to-day UI development). For CLI details, see [`cli.md`](./cli.md).

## Requirements

- **Node.js** >= 18.x, **npm** >= 9.x (same as [`INSTALL.md`](../../INSTALL.md))
- **Google Chrome** and the Flower extension from this repo when using browser automation

## Install dependencies

Clone the repo to any path, then install and build. **`npm run build:release`** writes the built tree into **`~/.beebridge`** via [`scripts/install-home.mjs`](../../scripts/install-home.mjs) (requires **`rsync`**).

```bash
git clone https://github.com/aibeebridge/beebridge.git
cd beebridge
npm install
```

On a **dedicated deployment host** where you will not edit TypeScript locally, you may use:

```bash
npm ci --omit=dev
```

only if your workflow does not need devDependencies (for example `typescript` in workspaces). If `npm ci --omit=dev` fails or the app does not start, use a full `npm install` / `npm ci` without `--omit=dev`.

## Build scripts: release vs libraries-only

| Script | What it builds | When to use |
|--------|----------------|-------------|
| **`npm run build:release`** | Same as **`npm run build`**: `@beebridge/shared`, `worker-browser`, `core`, **`cli`**, **`gateway`** (`dist/`), **`web`** (Next.js `.next`) | **Before production** `beebridge gateway start` / `web start` / `servers restart` **without** `--dev` |
| **`npm run build:libs`** | Packages only: `shared`, `worker-browser`, `core` | Faster iteration when using **`--dev`** (`tsx` / `next dev`); **does not** produce gateway `dist` or web `.next` |

Production commands check for:

- `apps/gateway/dist/server/index.js`
- `apps/web/.next/BUILD_ID`

If those are missing, run **`npm run build:release`** (or `npm run build`).

The root **`setup`** script runs `npm install && npm run build:release`.

## Run in production (default)

From the install root (e.g. **`~/.beebridge`**) after **`build:release`**, with **`npm link`** so **`beebridge`** is on your PATH (see [`cli.md`](./cli.md)):

```bash
beebridge start --daemon
```

Restart after pulling new code (stops ports, then starts both):

```bash
beebridge servers restart --daemon
```

Or start services separately: **`beebridge gateway start --daemon`**, **`beebridge web start --daemon`**. Without **`npm link`**, prefix with **`node ~/.beebridge/beebridge.mjs`** (or `node beebridge.mjs` from that directory).

Convenience npm scripts: **`start:daemon`**, `servers:restart:daemon`, `gateway:start:daemon`, `web:start:daemon` (see root [`package.json`](../../package.json)).

- **Gateway** defaults to port **4321** (override with `PORT` or `--gateway-port` on subcommands).
- **Web** defaults to port **3000** for `servers restart` (use `--web-port`; avoid relying on `PORT` for the web port when also setting the gateway port).
- Logs and PID files for `--daemon`: `.beebridge-daemon/<gateway|web>-<port>.log` and `.pid`.

Environment variables: same as [`cli.md`](./cli.md#environment-variables) (`beebridge_HOME`, `beebridge_GATEWAY_URL`, etc.).

## Upgrade

In your **git clone** (not necessarily `~/.beebridge`):

```bash
git pull
npm install
npm run build:release
```

Then restart from **`~/.beebridge`** (or wherever **`beebridge_HOME`** points):

```bash
cd ~/.beebridge
node beebridge.mjs servers restart --daemon
```

## Developers vs operators (summary)

| Role | Typical build | Typical run |
|------|----------------|------------|
| **Operator / production** | `npm run build:release` | `beebridge gateway start`, `web start`, or **`servers restart --daemon`** (no `--dev`) |
| **Developer** | `npm run build:libs` when only packages changed; full **`build:release`** before testing production mode | `npm run dev:gateway` / `dev:web` or `beebridge … --dev` |

Foreground logs for **both** servers at once require **two terminals** (`gateway restart` and `web restart` without `--daemon`). **`beebridge servers restart` requires `--daemon`** to start gateway and web in one command.

## See also

- [`cli.md`](./cli.md) — full command reference including `servers restart`
- [`INSTALL.md`](../../INSTALL.md) — quick start and extension setup
