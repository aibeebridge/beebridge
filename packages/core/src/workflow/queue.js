export class ExecutionQueue {
    executor;
    constructor(executor) {
        this.executor = executor;
    }
    async run(tasks, options) {
        const results = [];
        for (const task of tasks) {
            options?.beforeEach?.(task);
            const extras = options?.getExtras?.(task);
            const result = await this.executor(task, extras);
            results.push(result);
            options?.afterEach?.(task, result);
        }
        return results;
    }
}
