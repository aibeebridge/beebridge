import type { PlannedTask } from "@beebridge/shared";
export declare class ApprovalGate {
    private pending;
    private approved;
    needsApproval(task: PlannedTask): boolean;
    register(task: PlannedTask): void;
    approve(taskId: string): PlannedTask | undefined;
    seedAutoApproved(task: PlannedTask): void;
    unapprove(taskId: string): PlannedTask | undefined;
    listPending(): PlannedTask[];
    listApproved(): PlannedTask[];
    isTracked(taskId: string): boolean;
    forget(taskId: string): void;
    reseedRestoredTasks(tasks: Iterable<PlannedTask>, approvedTaskIds: Set<string>): void;
}
