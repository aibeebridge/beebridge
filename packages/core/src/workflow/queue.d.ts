import type { PlannedTask } from "@beebridge/shared";
export interface QueueResult {
    taskId: string;
    status: "done" | "failed";
    output: string;
}
export type QueueExtras = {
    bridgeContext?: string;
    resolvedTitle?: string;
    resolvedDescription?: string;
};
export type QueueExecutor = (task: PlannedTask, extras?: QueueExtras) => Promise<QueueResult>;
export declare class ExecutionQueue {
    private readonly executor;
    constructor(executor: QueueExecutor);
    run(tasks: PlannedTask[], options?: {
        getExtras?: (task: PlannedTask) => QueueExtras | undefined;
        beforeEach?: (task: PlannedTask) => void;
        afterEach?: (task: PlannedTask, result: QueueResult) => void;
    }): Promise<QueueResult[]>;
}
