import type { BeeTask, DistrictBridge } from "@beebridge/core";

import { buildExecutionWaves, hasIntraGraph } from "@beebridge/core";

const PRI: Record<string, number> = { high: 0, medium: 1, low: 2 };

/** Sort tasks within one district by priority then id (legacy fallback). */
function sortByPriorityThenId(tasks: BeeTask[]): BeeTask[] {
  return [...tasks].sort((a, b) => {
    const pa = PRI[a.priority] ?? 1;
    const pb = PRI[b.priority] ?? 1;
    if (pa !== pb) return pa - pb;
    return a.id.localeCompare(b.id);
  });
}

/**
 * Sort tasks within one district: if any dependsOn edges exist, use topological order
 * (flattened waves); otherwise fall back to priority → id.
 */
export function sortTasksWithinDistrict(tasks: BeeTask[]): BeeTask[] {
  if (!hasIntraGraph(tasks)) {
    return sortByPriorityThenId(tasks);
  }
  const waves = buildExecutionWaves(tasks);
  if (!waves) {
    return sortByPriorityThenId(tasks);
  }
  return waves.flat();
}

function groupByDistrict(tasks: BeeTask[], unassignedId: string): Map<string, BeeTask[]> {
  const m = new Map<string, BeeTask[]>();
  for (const t of tasks) {
    const d = String(t.districtId ?? "").trim() || unassignedId;
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(t);
  }
  for (const [key, arr] of m) m.set(key, sortTasksWithinDistrict(arr));
  return m;
}

/** Scan order of first appearance of each district in the original list */
function districtScanOrder(tasks: BeeTask[], unassignedId: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const t of tasks) {
    const d = String(t.districtId ?? "").trim() || unassignedId;
    if (!seen.has(d)) {
      seen.add(d);
      order.push(d);
    }
  }
  return order;
}

function oneWayEdges(bridges: Iterable<DistrictBridge>): [string, string][] {
  const out: [string, string][] = [];
  for (const b of bridges) {
    if (b.direction !== "one_way" || b.status !== "active") continue;
    out.push([b.fromDistrictId, b.toDistrictId]);
  }
  return out;
}

/** Kahn topological sort; tie-break: prefer `startId` when picking among zero-indegree nodes */
function topologicalDistricts(
  districts: Set<string>,
  edges: [string, string][],
  startId: string,
): { order: string[] | null; cycle: boolean } {
  const nodes = [...districts];
  const adj = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const n of nodes) {
    adj.set(n, new Set());
    indeg.set(n, 0);
  }
  for (const [f, t] of edges) {
    if (!districts.has(f) || !districts.has(t)) continue;
    adj.get(f)!.add(t);
    indeg.set(t, (indeg.get(t) ?? 0) + 1);
  }

  const result: string[] = [];
  const inResult = new Set<string>();

  const pickZeros = (): string[] => {
    return nodes.filter((n) => !inResult.has(n) && (indeg.get(n) ?? 0) === 0);
  };

  while (result.length < nodes.length) {
    const zeros = pickZeros();
    if (zeros.length === 0) return { order: null, cycle: true };
    zeros.sort((a, b) => {
      if (a === startId) return -1;
      if (b === startId) return 1;
      return a.localeCompare(b);
    });
    const n = zeros[0]!;
    result.push(n);
    inResult.add(n);
    for (const t of adj.get(n) ?? []) {
      indeg.set(t, (indeg.get(t) ?? 1) - 1);
    }
  }

  return { order: result, cycle: false };
}

/**
 * Order approved tasks: when `startDistrictId` is set and present among task districts,
 * order districts by one_way bridge DAG; otherwise preserve first-seen district order with stable inner sort.
 */
export function orderTasksForBridgeRun(
  tasks: BeeTask[],
  bridges: Iterable<DistrictBridge>,
  startDistrictId: string | null,
  unassignedDistrictId: string,
): { ordered: BeeTask[]; usedBridgeOrder: boolean; warning?: string } {
  if (tasks.length === 0) return { ordered: [], usedBridgeOrder: false };

  const byDist = groupByDistrict(tasks, unassignedDistrictId);
  const scan = districtScanOrder(tasks, unassignedDistrictId);

  const districtSet = new Set(byDist.keys());
  const start =
    startDistrictId && districtSet.has(startDistrictId) ? startDistrictId : null;

  if (!start) {
    const ordered: BeeTask[] = [];
    for (const d of scan) {
      ordered.push(...(byDist.get(d) ?? []));
    }
    return { ordered, usedBridgeOrder: false };
  }

  const edges = oneWayEdges(bridges);
  const { order, cycle } = topologicalDistricts(districtSet, edges, start);

  if (cycle || !order) {
    const ordered: BeeTask[] = [];
    for (const d of scan) ordered.push(...(byDist.get(d) ?? []));
    return {
      ordered,
      usedBridgeOrder: false,
      warning:
        "one_way bridge graph has a cycle among these districts (or could not be sorted). Using default order.",
    };
  }

  const ordered: BeeTask[] = [];
  for (const d of order) {
    const chunk = byDist.get(d);
    if (chunk?.length) ordered.push(...chunk);
  }
  return { ordered, usedBridgeOrder: true };
}

/** All districts U ≠ `districtId` that can reach `districtId` via one_way forward edges */
export function upstreamDistrictsOneWay(
  districtId: string,
  bridges: Iterable<DistrictBridge>,
): Set<string> {
  const forward = new Map<string, Set<string>>();
  for (const b of bridges) {
    if (b.direction !== "one_way" || b.status !== "active") continue;
    if (!forward.has(b.fromDistrictId)) forward.set(b.fromDistrictId, new Set());
    forward.get(b.fromDistrictId)!.add(b.toDistrictId);
  }

  const rev = new Map<string, Set<string>>();
  for (const [f, tos] of forward) {
    for (const t of tos) {
      if (!rev.has(t)) rev.set(t, new Set());
      rev.get(t)!.add(f);
    }
  }

  const up = new Set<string>();
  const stack = [...(rev.get(districtId) ?? [])];
  while (stack.length) {
    const u = stack.pop()!;
    if (u === districtId) continue;
    if (up.has(u)) continue;
    up.add(u);
    for (const p of rev.get(u) ?? []) stack.push(p);
  }
  return up;
}

export type CompletedTaskInfo = {
  districtId: string;
  taskId: string;
  title: string;
  output: string;
};

export function buildBridgeContextForTask(
  task: BeeTask,
  unassignedDistrictId: string,
  upstream: Set<string>,
  completed: CompletedTaskInfo[],
  districtTitle: (id: string) => string,
): string {
  const d = String(task.districtId ?? "").trim() || unassignedDistrictId;
  const parts: string[] = [];

  const upstreamBlocks = completed.filter((c) => c.districtId !== d && upstream.has(c.districtId));
  if (upstreamBlocks.length > 0) {
    const byD = new Map<string, CompletedTaskInfo[]>();
    for (const c of upstreamBlocks) {
      if (!byD.has(c.districtId)) byD.set(c.districtId, []);
      byD.get(c.districtId)!.push(c);
    }
    for (const [did, rows] of [...byD.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      parts.push(`[${districtTitle(did)}]`);
      for (const row of rows) {
        const snippet = row.output.length > 4000 ? `${row.output.slice(0, 4000)}…` : row.output;
        parts.push(`- ${row.title}: ${snippet}`);
      }
    }
  }

  const sameDistrictBefore = completed.filter((c) => c.districtId === d);
  if (sameDistrictBefore.length > 0) {
    parts.push(`[Earlier tasks in this district]`);
    for (const row of sameDistrictBefore) {
      const snippet = row.output.length > 4000 ? `${row.output.slice(0, 4000)}…` : row.output;
      parts.push(`- ${row.title}: ${snippet}`);
    }
  }

  return parts.join("\n");
}

/** BFS from `startId` along one_way active bridge edges (forward). */
export function reachableDistrictsFromStart(
  startId: string,
  bridges: Iterable<DistrictBridge>,
): Set<string> {
  const forward = new Map<string, Set<string>>();
  for (const b of bridges) {
    if (b.direction !== "one_way" || b.status !== "active") continue;
    if (!forward.has(b.fromDistrictId)) forward.set(b.fromDistrictId, new Set());
    forward.get(b.fromDistrictId)!.add(b.toDistrictId);
  }
  const seen = new Set<string>([startId]);
  const q = [startId];
  while (q.length) {
    const u = q.shift()!;
    for (const v of forward.get(u) ?? []) {
      if (!seen.has(v)) {
        seen.add(v);
        q.push(v);
      }
    }
  }
  return seen;
}

/** Tasks in reachable districts that are not yet done (pipeline auto-run). */
export function collectPipelineTasks(
  allTasks: Iterable<BeeTask>,
  reachable: Set<string>,
  unassignedDistrictId: string,
): BeeTask[] {
  const out: BeeTask[] = [];
  for (const t of allTasks) {
    const d = String(t.districtId ?? "").trim() || unassignedDistrictId;
    if (!reachable.has(d)) continue;
    if (t.status === "done") continue;
    out.push(t);
  }
  return out;
}

const BRIDGE_OUT_RE = /\{\{bridgeOut:([^}]+)\}\}/g;

/** Collect unique `taskId` tokens from `{{bridgeOut:taskId}}` in text. */
export function extractBridgeOutTaskIds(text: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  BRIDGE_OUT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BRIDGE_OUT_RE.exec(text)) !== null) {
    const id = String(m[1]).trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

export type MinimalConversation = {
  entries: Array<{ role: string; action: string; content: string; source?: string }>;
  status?: string;
};

/**
 * Serialize a finished (or partial) job conversation for injection into {{bridgeOut:}} (worker + waggle history).
 */
export function taskConversationToBridgeOutText(conv: MinimalConversation | undefined): string | undefined {
  if (!conv?.entries?.length) return undefined;
  const lines: string[] = [];
  for (const e of conv.entries) {
    const c = e.content?.trim();
    if (!c) continue;
    const src = e.source ?? `${e.role}/${e.action}`;
    lines.push(`[${src}]\n${c}`);
  }
  let s = lines.join("\n\n");
  const max = 48_000;
  if (s.length > max) s = s.slice(0, max) + "\n…[truncated]";
  return s || undefined;
}

/**
 * Map for placeholder resolution: same-run `completed` first, then persisted conversations for any
 * referenced task ids still missing (retry, cross-run, or ordering edge cases).
 */
export function buildOutputByTaskIdForBridgeOut(
  completed: CompletedTaskInfo[],
  taskTitle: string,
  taskDescription: string,
  getConversation: (taskId: string) => MinimalConversation | undefined,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of completed) map.set(c.taskId, c.output);

  const combined = `${taskTitle}\n${taskDescription ?? ""}`;
  for (const id of extractBridgeOutTaskIds(combined)) {
    if (map.has(id)) continue;
    const text = taskConversationToBridgeOutText(getConversation(id));
    if (text) map.set(id, text);
  }
  return map;
}

/** Replace `{{bridgeOut:taskId}}` with completed outputs from the same pipeline run. */
export function applyBridgeOutPlaceholders(text: string, outputByTaskId: Map<string, string>): string {
  return text.replace(BRIDGE_OUT_RE, (_full, rawId: string) => {
    const id = String(rawId).trim();
    if (outputByTaskId.has(id)) return outputByTaskId.get(id)!;
    return `[bridgeOut: not available — ${id}]`;
  });
}
