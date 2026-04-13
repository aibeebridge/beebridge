export interface SubTaskResult {
  taskId: string;
  status: "done" | "failed";
  output: string;
  tokenUsage?: { promptTokens: number; completionTokens: number };
}

export interface SubTaskRun {
  childTaskId: string;
  task: string;
  type: "code" | "browser";
  status: "running" | "done" | "failed";
  output?: string;
  promise: Promise<SubTaskResult>;
  abortController: AbortController;
  tokenUsage?: { promptTokens: number; completionTokens: number };
  startedAt: number;
  endedAt?: number;
}

interface CompletionNotification {
  childTaskId: string;
  status: string;
  output?: string;
}

const MAX_CHILDREN = 3;
const DEFAULT_TIMEOUT_MS = 300_000;

export class SubTaskManager {
  private runs = new Map<string, SubTaskRun>();
  private completionQueue: CompletionNotification[] = [];
  private nextId = 1;

  generateChildTaskId(parentTaskId: string): string {
    return `${parentTaskId}-child-${this.nextId++}`;
  }

  canSpawn(): { ok: boolean; reason?: string } {
    const running = [...this.runs.values()].filter(
      (r) => r.status === "running",
    ).length;
    if (running >= MAX_CHILDREN) {
      return {
        ok: false,
        reason: `Max concurrent children reached (${running}/${MAX_CHILDREN}). Wait for a child to finish or kill one.`,
      };
    }
    return { ok: true };
  }

  register(run: SubTaskRun): void {
    this.runs.set(run.childTaskId, run);

    run.promise
      .then((result) => {
        const entry = this.runs.get(run.childTaskId);
        if (entry && entry.status === "running") {
          entry.status = result.status;
          entry.output = result.output;
          entry.tokenUsage = result.tokenUsage;
          entry.endedAt = Date.now();
          this.completionQueue.push({
            childTaskId: run.childTaskId,
            status: result.status,
            output: result.output?.slice(0, 2000),
          });
        }
      })
      .catch((err) => {
        const entry = this.runs.get(run.childTaskId);
        if (entry && entry.status === "running") {
          entry.status = "failed";
          entry.output = err instanceof Error ? err.message : String(err);
          entry.endedAt = Date.now();
          this.completionQueue.push({
            childTaskId: run.childTaskId,
            status: "failed",
            output: entry.output?.slice(0, 2000),
          });
        }
      });
  }

  get(childTaskId: string): SubTaskRun | undefined {
    return this.runs.get(childTaskId);
  }

  list(): SubTaskRun[] {
    return [...this.runs.values()];
  }

  drainCompletionNotifications(): CompletionNotification[] {
    const drained = [...this.completionQueue];
    this.completionQueue = [];
    return drained;
  }

  async waitFor(
    childTaskId: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<SubTaskResult> {
    const run = this.runs.get(childTaskId);
    if (!run) {
      return {
        taskId: childTaskId,
        status: "failed",
        output: `Child task not found: ${childTaskId}`,
      };
    }

    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<SubTaskResult>((resolve) => {
      timer = setTimeout(() => {
        run.abortController.abort("Timed out");
        run.status = "failed";
        run.output = `Child task timed out after ${Math.round(timeoutMs / 1000)}s`;
        run.endedAt = Date.now();
        resolve({
          taskId: childTaskId,
          status: "failed",
          output: run.output,
        });
      }, timeoutMs);
    });

    try {
      return await Promise.race([run.promise, timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  kill(childTaskId: string): string {
    const run = this.runs.get(childTaskId);
    if (!run) return `Child task not found: ${childTaskId}`;
    if (run.status !== "running") return `Child task already ${run.status}`;
    run.abortController.abort("Killed by parent");
    run.status = "failed";
    run.output = "Killed by parent";
    run.endedAt = Date.now();
    return `Child task ${childTaskId} killed`;
  }

  killAll(): number {
    let killed = 0;
    for (const run of this.runs.values()) {
      if (run.status === "running") {
        run.abortController.abort("Killed by parent (cleanup)");
        run.status = "failed";
        run.output = "Killed by parent (cleanup)";
        run.endedAt = Date.now();
        killed++;
      }
    }
    return killed;
  }

  cleanup(): void {
    this.killAll();
    this.completionQueue = [];
    this.runs.clear();
  }
}
