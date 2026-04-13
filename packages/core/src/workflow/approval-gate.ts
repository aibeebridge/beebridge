import type { PlannedTask } from "@beebridge/shared";

export class ApprovalGate {
  private pending = new Map<string, PlannedTask>();
  private approved = new Map<string, PlannedTask>();

  public needsApproval(task: PlannedTask): boolean {
    return task.requiresApproval || task.priority === "high";
  }

  public register(task: PlannedTask): void {
    this.pending.set(task.id, task);
  }

  public approve(taskId: string): PlannedTask | undefined {
    const task = this.pending.get(taskId);
    if (!task) return undefined;
    this.pending.delete(taskId);
    this.approved.set(taskId, task);
    return task;
  }

  /**
   * Tasks that do not {@link needsApproval} never enter {@link register} (pending).
   * Put them straight into the approved queue so `/api/queue/run` and the UI see them as runnable.
   */
  public seedAutoApproved(task: PlannedTask): void {
    if (this.needsApproval(task)) return;
    this.pending.delete(task.id);
    this.approved.set(task.id, task);
  }

  /** Move from approved → pending so the job can be approved and run again. */
  public unapprove(taskId: string): PlannedTask | undefined {
    const task = this.approved.get(taskId);
    if (!task) return undefined;
    this.approved.delete(taskId);
    this.pending.set(taskId, task);
    return task;
  }

  public listPending(): PlannedTask[] {
    return [...this.pending.values()];
  }

  public listApproved(): PlannedTask[] {
    return [...this.approved.values()];
  }

  /** True if this job id is in pending or approved (stale approved + new pending can otherwise share an id). */
  public isTracked(taskId: string): boolean {
    return this.pending.has(taskId) || this.approved.has(taskId);
  }

  /** Remove from pending and approved (e.g. task deleted). */
  public forget(taskId: string): void {
    this.pending.delete(taskId);
    this.approved.delete(taskId);
  }

  /**
   * After a process restart the gate is empty while tasks + audit are on disk.
   * Re-fills pending/approved from restored tasks; `approvedTaskIds` comes from audit (`bee.job.approved`).
   */
  public reseedRestoredTasks(tasks: Iterable<PlannedTask>, approvedTaskIds: Set<string>): void {
    for (const task of tasks) {
      if (!this.needsApproval(task)) continue;
      if (task.status !== "waiting") continue;
      if (this.pending.has(task.id) || this.approved.has(task.id)) continue;
      if (approvedTaskIds.has(task.id)) {
        this.approved.set(task.id, task);
      } else {
        this.pending.set(task.id, task);
      }
    }
  }
}
