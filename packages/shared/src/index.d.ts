export type TaskPriority = "low" | "medium" | "high";
export interface PlannedTask {
    id: string;
    title: string;
    storyId: string;
    assignee: string;
    dueDate: string;
    priority: TaskPriority;
    requiresApproval: boolean;
}
export interface Story {
    id: string;
    title: string;
    objective: string;
}
export interface SprintPlan {
    id: string;
    title: string;
    stories: Story[];
    tasks: PlannedTask[];
}
