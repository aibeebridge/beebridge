export class ApprovalGate {
    pending = new Map();
    approved = new Map();
    needsApproval(task) {
        return task.requiresApproval || task.priority === "high";
    }
    register(task) {
        this.pending.set(task.id, task);
    }
    approve(taskId) {
        const task = this.pending.get(taskId);
        if (!task) return undefined;
        this.pending.delete(taskId);
        this.approved.set(taskId, task);
        return task;
    }
    seedAutoApproved(task) {
        if (this.needsApproval(task)) return;
        this.pending.delete(task.id);
        this.approved.set(task.id, task);
    }
    unapprove(taskId) {
        const task = this.approved.get(taskId);
        if (!task) return undefined;
        this.approved.delete(taskId);
        this.pending.set(taskId, task);
        return task;
    }
    listPending() {
        return [...this.pending.values()];
    }
    listApproved() {
        return [...this.approved.values()];
    }
    isTracked(taskId) {
        return this.pending.has(taskId) || this.approved.has(taskId);
    }
    forget(taskId) {
        this.pending.delete(taskId);
        this.approved.delete(taskId);
    }
    reseedRestoredTasks(tasks, approvedTaskIds) {
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
