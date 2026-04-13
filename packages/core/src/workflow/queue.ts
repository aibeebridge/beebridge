import type { BeeTask, PlannedTask } from "@beebridge/shared";

export interface QueueResult {
  taskId: string;
  status: "done" | "failed";
  output: string;
}

export type QueueExtras = {
  bridgeContext?: string;
  /** When set, agent uses these instead of task title/description (e.g. {{bridgeOut:taskId}} resolved). */
  resolvedTitle?: string;
  resolvedDescription?: string;
  /** Resolved {{bridgeOut:taskId}} map so downstream waggle_ask calls can substitute remaining tags. */
  bridgeOutMap?: Map<string, string>;
};

export type QueueExecutor = (task: PlannedTask, extras?: QueueExtras) => Promise<QueueResult>;

/**
 * Build execution waves from tasks using `dependsOn` DAG.
 * Each wave contains tasks whose dependencies are all in earlier waves.
 * Returns null if a cycle is detected.
 */
export function buildExecutionWaves(tasks: BeeTask[]): BeeTask[][] | null {
  const taskMap = new Map<string, BeeTask>();
  for (const t of tasks) taskMap.set(t.id, t);

  const taskIds = new Set(tasks.map((t) => t.id));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const t of tasks) {
    indegree.set(t.id, 0);
    dependents.set(t.id, []);
  }

  for (const t of tasks) {
    const deps = (t.dependsOn ?? []).filter((d) => taskIds.has(d));
    indegree.set(t.id, deps.length);
    for (const d of deps) {
      dependents.get(d)!.push(t.id);
    }
  }

  const waves: BeeTask[][] = [];
  const placed = new Set<string>();

  while (placed.size < tasks.length) {
    const wave: BeeTask[] = [];
    for (const t of tasks) {
      if (placed.has(t.id)) continue;
      if ((indegree.get(t.id) ?? 0) === 0) {
        wave.push(t);
      }
    }
    if (wave.length === 0) return null;

    for (const t of wave) {
      placed.add(t.id);
      for (const dep of dependents.get(t.id) ?? []) {
        indegree.set(dep, (indegree.get(dep) ?? 1) - 1);
      }
    }
    waves.push(wave);
  }
  return waves;
}

/** Returns true if any task in the list has a non-empty `dependsOn` referencing another task in the list. */
export function hasIntraGraph(tasks: BeeTask[]): boolean {
  const ids = new Set(tasks.map((t) => t.id));
  return tasks.some((t) => t.dependsOn?.some((d) => ids.has(d)));
}

export class ExecutionQueue {
  constructor(private readonly executor: QueueExecutor) {}

  public async run(
    tasks: PlannedTask[],
    options?: {
      getExtras?: (task: PlannedTask) => QueueExtras | undefined;
      beforeEach?: (task: PlannedTask) => void;
      afterEach?: (task: PlannedTask, result: QueueResult) => void;
    },
  ): Promise<QueueResult[]> {
    const beeTasks = tasks as BeeTask[];
    if (hasIntraGraph(beeTasks)) {
      return this.runParallelWaves(tasks, beeTasks, options);
    }
    return this.runSequential(tasks, options);
  }

  private async runSequential(
    tasks: PlannedTask[],
    options?: {
      getExtras?: (task: PlannedTask) => QueueExtras | undefined;
      beforeEach?: (task: PlannedTask) => void;
      afterEach?: (task: PlannedTask, result: QueueResult) => void;
    },
  ): Promise<QueueResult[]> {
    const results: QueueResult[] = [];
    for (const task of tasks) {
      options?.beforeEach?.(task);
      const extras = options?.getExtras?.(task);
      const result = await this.executor(task, extras);
      results.push(result);
      options?.afterEach?.(task, result);
    }
    return results;
  }

  private async runParallelWaves(
    tasks: PlannedTask[],
    beeTasks: BeeTask[],
    options?: {
      getExtras?: (task: PlannedTask) => QueueExtras | undefined;
      beforeEach?: (task: PlannedTask) => void;
      afterEach?: (task: PlannedTask, result: QueueResult) => void;
    },
  ): Promise<QueueResult[]> {
    const waves = buildExecutionWaves(beeTasks);
    if (!waves) {
      return this.runSequential(tasks, options);
    }

    const plannedMap = new Map<string, PlannedTask>();
    for (const t of tasks) plannedMap.set(t.id, t);

    const results: QueueResult[] = [];
    for (const wave of waves) {
      const wavePromises = wave.map(async (bt) => {
        const task = plannedMap.get(bt.id);
        if (!task) return null;
        options?.beforeEach?.(task);
        const extras = options?.getExtras?.(task);
        const result = await this.executor(task, extras);
        options?.afterEach?.(task, result);
        return result;
      });
      const settled = await Promise.allSettled(wavePromises);
      for (const s of settled) {
        if (s.status === "fulfilled" && s.value) {
          results.push(s.value);
        } else if (s.status === "rejected") {
          results.push({ taskId: "unknown", status: "failed", output: String(s.reason) });
        }
      }
    }
    return results;
  }
}
