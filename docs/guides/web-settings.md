# Web UI: Settings

The **Settings** screen configures the **gateway connection**, **PM auth profiles**, **model policy**, **workspace path**, and **diagnostics**. Implementation: [`apps/web/src/app/settings/page.tsx`](../../apps/web/src/app/settings/page.tsx) and [`apps/web/src/components/settings/pm-settings-panel.tsx`](../../apps/web/src/components/settings/pm-settings-panel.tsx).

## Opening Settings

- **Sidebar:** click **Settings** → route `/settings`.
- **Deep link:** `http://localhost:<web-port>/settings?tab=<tab>`  
  Valid `<tab>` values: `connection` | `auth` | `model` | `workspace` | `status`  
  The active tab is synced to the URL (replaceState) when you switch tabs in the UI.
- **CLI:** `beebridge manager setup` or `beebridge web settings` with `--tab <tab>` opens the same page (after [`build:cli`](./cli.md)); see [`web.ts`](../../apps/cli/src/commands/web.ts).

**Label vs URL:** the sidebar button labels differ slightly from the `tab` query value:

| URL `?tab=` | Sidebar label |
|-------------|----------------|
| `connection` | Connection |
| `auth` | Profiles |
| `model` | Model Policy |
| `workspace` | Workspace |
| `status` | Diagnostics |

## Gateway context vs Settings “Connection”

Most pages use [`GatewayProvider`](../../apps/web/src/context/gateway.tsx) with an **empty** gateway URL. That means HTTP calls use **same-origin** paths like `/api/...`, which Next.js can **rewrite** to the gateway (see `next.config`).

The **Settings** panel’s **Connection** tab uses **its own** `gatewayUrl` and `gatewayToken` state (defaults `http://localhost:4321` and `dev-token`). Use this when:

- The gateway runs on another host/port than the Next dev server, or
- You need to paste an explicit token.

After **Connect**, the panel loads PM settings with:

`GET /api/settings/pm`  
Headers: `Authorization: Bearer <token>`

All other actions on the panel use the same `gatewayUrl` + `gatewayToken` for requests.

## Tab reference

### Connection

- **Gateway URL** — Base URL of the gateway (no trailing path required for the code shown).
- **Gateway Token** — Must match gateway `GATEWAY_TOKEN`.
- **Connect** — Loads provider catalog, auth profiles, and model policy from `GET /api/settings/pm`.

### Profiles (`auth`)

Register **manager** credentials used by PM flows.

- **Provider** — From gateway provider catalog.
- **Sign-in mode** — Typically **API key** or **OAuth** (OpenAI shows **Codex** for OAuth-style flows per UI copy).
- **Profile label** — Optional display name.
- **Secret** — API key or token; use **Save profile** for manual entry.
- **Reset profiles** — `DELETE /api/settings/auth/profiles` (clears all profiles and in-progress device sessions).
- **OAuth / Codex** — **Start OAuth login** or **Start Codex setup** starts a device/session flow via `POST /api/settings/auth/device/start`, then completion via `POST /api/settings/auth/device/complete` (with polling for some providers). OpenAI Codex may ask you to paste the **redirect URL** after browser login.
- **Saved profiles** — Click a card to **activate** (`PATCH /api/settings/auth/profiles/:id/activate`); if the provider has models, the UI may also update **model policy** to match. Delete with the × control (`DELETE /api/settings/auth/profiles/:id`).

### Model Policy (`model`)

- **Default provider** / **Default model** — PM defaults.
- **Allowed models** — Comma-separated list.
- **Fallback model** — Optional.
- **Save model policy** — `PUT /api/settings/model-policy`.

### Workspace (`workspace`)

Data root for districts, jobs, and related files. Copy explains that `.beebridge/workspace` is created under the chosen path.

- **Change Workspace** — `PUT /api/settings/workspace` with `{ "workspacePath": "..." }`.
- On tab focus, the UI loads `GET /api/settings/workspace` to show current path, data root, and file list.

### Diagnostics (`status`)

- Read-only summary: active profile id, default provider/model, allowed model count (from loaded settings).
- **Restart gateway** — `POST /api/admin/restart` (shuts down the gateway process; you may need to run `npm run dev:gateway` or equivalent again locally).

## Optional environment variables (Next / browser)

Used elsewhere in the app shell; not required for Settings form fields:

- `NEXT_PUBLIC_GATEWAY_ORIGIN` — Fallback HTTP origin when building gateway URLs client-side ([`gateway.tsx`](../../apps/web/src/context/gateway.tsx)).
- `NEXT_PUBLIC_GATEWAY_WS_PORT` — WebSocket port segment when gateway URL is empty (default `4321`).

## See also

- [CLI](./cli.md) — `manager setup`, env vars `beebridge_GATEWAY_*`
- [Bridge graph](./bridge-graph.md) — workspace-related districts live under the configured workspace
