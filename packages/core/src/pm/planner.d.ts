import type { SprintPlan, Story, PlannedTask } from "@beebridge/shared";
import type { IntakeBrief } from "./intake.js";
export interface DraftPlan {
    projectTitle: string;
    stories: Story[];
    tasks: PlannedTask[];
}
export declare function createPlanFromBrief(brief: IntakeBrief): DraftPlan;
export declare function toSprintPlan(plan: DraftPlan): SprintPlan;
