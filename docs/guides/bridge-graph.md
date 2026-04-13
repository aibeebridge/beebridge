# Bridge graph: districts, export/import, and pipeline

This guide describes the **bridge graph** in beebridge: how **districts** connect via **bridges**, how to **back up and share** that configuration as JSON, and how the **pipeline run** walks the graph to execute work.

## Concepts

| Term | Meaning |
|------|---------|
| **District** | A container for bees, tasks, and settings (objective, Waggle options, layout on the graph, etc.). Shown as a node on the **Bridges** page graph. |
| **Bridge** | An edge between two districts: `from` → `to`, label, optional `dataFlow`, and **`direction`**. |
| **`one_way`** | Used for **pipeline traversal**: the runner follows **forward** edges only (`from` → `to`). Only **`active`** one-way bridges participate. |
| **`two_way`** | Treated as **not** forward for pipeline BFS; use for documentation or bidirectional semantics in the UI without implying automatic run order. |
| **Start district** | The district where a **pipeline run** begins. Stored as `bridgeGraphMeta.startDistrictId` and shown in the Bridges header. Can be set explicitly or carried in an import file. |

Export/import is **not** a separate “workflow file” format from core’s `approval-gate` / `queue` modules—it is **beebridge workspace data**: districts (including nested bees and tasks) plus bridge records.

## Export (Bridges page → JSON file)

1. Open the web app **Bridges** page (`/bridges`).
2. **Select** at least one **district node** on the graph (the selection drives what gets exported).
3. Use **Export selection** (toolbar control next to the graph). The UI builds a JSON file and downloads it, typically named like `bridge-settings-YYYY-MM-DDTHH-MM-SS.json`.

**What is included**

- **`format`**: always `beebridge.bridge-settings.v1`.
- **`exportedAt`**: ISO timestamp when the file was generated.
- **`startDistrictId`**: the current start district **only if** it is among the exported districts; otherwise `null`.
- **`districts`**: for each selected district, a bundle from `GET /api/districts/:id`—full **district** record plus **bees** and **tasks** (ids, prompts, `dependsOn`, `schedule`, approval flags, etc.).
- **`bridges`**: bridges that are either explicitly selected or **both endpoints lie inside** the selected district set (so internal edges are kept).

Use exports to **back up** a subgraph, **copy** districts between machines, or **version** a layout in git (mind secrets inside prompts or paths).

## Import (`/api/bridge-graph/import`)

1. On **Bridges**, use **Import** and choose a `.json` file.
2. The gateway parses the body; the file must declare `"format": "beebridge.bridge-settings.v1"`.

**Behavior (merge into the running workspace)**

- **Districts** and nested **bees** / **tasks** are **upserted** by id into the gateway’s in-memory stores and **persisted** (same workspace as normal UI edits).
- **`dependsOn`** on tasks is **sanitized** after import: references to unknown task ids are dropped.
- **Bridges** are applied **only** when **both** `fromDistrictId` and `toDistrictId` exist after district import. Otherwise that bridge row is skipped.
- If **`startDistrictId`** in the file matches an existing district after import, it becomes the graph **start** district.

The response includes a **`summary`** (counts of districts, tasks, bees, bridges applied). Import does **not** wipe unrelated districts; it merges with what you already have unless ids collide (then values are overwritten by the file).

## Bridge pipeline run

**Goal:** from a chosen district, run **all tasks that are not `done`** in every district **reachable** along **active `one_way` bridges** going **forward** (BFS from the start). Used for coordinated multi-district runs with **upstream context** (see below).

**API**

- `POST /api/bridge-graph/run` with JSON `{ "districtId": "<id>" }` (requires gateway auth).
- Sets **`startDistrictId`** to that district, persists, then computes **reachable** districts and queues eligible tasks. The HTTP request **blocks until** the pipeline finishes (same behavior as the Bridges UI “run” control).

**Implementation notes**

- Reachability uses only **`one_way`** bridges with **`status === "active"`** (see `reachableDistrictsFromStart` in `apps/gateway/src/server/bridge-execution.ts`).
- Tasks in reachable districts with `status !== "done"` are collected (`collectPipelineTasks`). Ordering and job execution follow gateway pipeline / approval rules.

**History**

- `GET /api/bridge-pipeline/history` — list of past runs (newest first).
- `GET /api/bridge-pipeline/history/:runId` — one run record (ordered task ids, per-district results, summary text).

## Upstream context and `{{bridgeOut:taskId}}`

For editors and waggle flows, tasks in **upstream** districts (along **one_way** edges **into** the current district) can be listed via:

- `GET /api/bridge-graph/upstream-tasks?districtId=...`
- `GET /api/bridge-graph/upstream-overview?districtId=...` (used when creating jobs from upstream).

Placeholders like `{{bridgeOut:<taskId>}}` in prompts are resolved using completed outputs from the **same pipeline run** (and related persisted conversation text). Details live in `bridge-execution.ts` and the Waggle guide where applicable.

## Minimal JSON shape (export file)

```json
{
  "format": "beebridge.bridge-settings.v1",
  "exportedAt": "2026-04-13T12:00:00.000Z",
  "startDistrictId": "district-abc" ,
  "districts": [
    {
      "district": { "id": "…", "title": "…", "objective": "…", "cityId": "…", "…": "…" },
      "bees": [ { "id": "…", "name": "…", "systemPrompt": "…", "…": "…" } ],
      "tasks": [ { "id": "…", "title": "…", "districtId": "…", "dependsOn": [], "…": "…" } ]
    }
  ],
  "bridges": [
    {
      "id": "…",
      "fromDistrictId": "…",
      "toDistrictId": "…",
      "label": "…",
      "direction": "one_way",
      "status": "active",
      "…": "…"
    }
  ]
}
```

Do not hand-edit ids carelessly: bridges and `dependsOn` must reference districts and tasks that exist after import.

## Related UI

- **Bridges** (`/bridges`) — graph editor, export/import, set start district, run pipeline, pipeline history panel.
- **Jobs** — may reference upstream tasks when creating work from a district.

## See also

- [Waggle mode](./waggle-mode.md) — supervisor/worker harness when tasks use Flower + Waggle.
