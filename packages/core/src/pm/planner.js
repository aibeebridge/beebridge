function priorityFromBrief(value) {
    if (value === "high" || value === "medium" || value === "low")
        return value;
    return "medium";
}
export function createPlanFromBrief(brief) {
    const projectTitle = brief.goal.slice(0, 80) || "Untitled Project";
    const priority = priorityFromBrief(brief.priority);
    const dueDate = brief.deadline ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const stories = [
        { id: "story-intake", title: "Requirements Gathering", objective: "Document the scope of work and define completion criteria." },
        { id: "story-build", title: "Core Implementation", objective: "Produce executable deliverables." },
        { id: "story-review", title: "Review & Delivery", objective: "Validate results and deliver to the user." },
    ];
    const tasks = [
        {
            id: "task-1",
            title: `${projectTitle} Requirements Structuring`,
            storyId: "story-intake",
            assignee: "pm-ai",
            dueDate,
            priority,
            requiresApproval: false,
        },
        {
            id: "task-2",
            title: `${projectTitle} Implementation & Testing`,
            storyId: "story-build",
            assignee: "worker-browser",
            dueDate,
            priority,
            requiresApproval: priority === "high",
        },
        {
            id: "task-3",
            title: `${projectTitle} Final Review`,
            storyId: "story-review",
            assignee: "review-ai",
            dueDate,
            priority,
            requiresApproval: true,
        },
    ];
    return { projectTitle, stories, tasks };
}
export function toSprintPlan(plan) {
    return {
        id: `sprint-${Date.now()}`,
        title: `${plan.projectTitle} Sprint 1`,
        stories: plan.stories,
        tasks: plan.tasks,
    };
}
