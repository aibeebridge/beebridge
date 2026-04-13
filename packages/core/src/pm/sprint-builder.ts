import type { CityPlan, SprintPlan } from "@beebridge/shared";
import { toCityPlan, toSprintPlan, type DraftPlan, type CityDraft } from "./planner.js";

export function createSprintFromPlan(plan: DraftPlan): SprintPlan {
  return toSprintPlan(plan);
}

export { createHiveFromPlan } from "./planner.js";

export function createCityFromPlan(plan: CityDraft): CityPlan {
  return toCityPlan(plan);
}
