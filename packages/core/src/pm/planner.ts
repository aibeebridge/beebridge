import { randomUUID } from "node:crypto";
import { newBeeId } from "@beebridge/shared";
import type {
  BeeTask, BeeDistrict, BeePersona, BeePriority, CityPlan,
  SprintPlan, PlannedTask,
} from "@beebridge/shared";
import type { IntakeBrief } from "./intake.js";

export interface CityDraft {
  projectTitle: string;
  districts: BeeDistrict[];
  tasks: BeeTask[];
  bees: BeePersona[];
}

export type HiveDraft = CityDraft;
export type DraftPlan = CityDraft;

export interface PmRuntimeContext {
  providerId: string;
  model: string;
  bee: string;
  flower: string;
}

function priorityFromBrief(value?: string): BeePriority {
  if (value === "high" || value === "medium" || value === "low") return value;
  return "medium";
}

import type { FlowerType } from "@beebridge/shared";

const DEFAULT_PERSONAS: Record<string, { name: string; role: string; systemPrompt: string; flowerType?: FlowerType }> = {
  researcher: {
    name: "Researcher",
    role: "researcher",
    systemPrompt: "You are an information gathering specialist. Collect and organize key information through web searches and document exploration.",
  },
  analyst: {
    name: "Analyst",
    role: "analyst",
    systemPrompt: "You are a data analysis specialist. Analyze gathered information and derive actionable insights.",
  },
  writer: {
    name: "Writer",
    role: "writer",
    systemPrompt: "You are a document writing specialist. Create reports, blog posts, and summaries based on collected information.",
  },
  coder: {
    name: "Coder",
    role: "coder",
    systemPrompt: "You are a programming specialist. Write code, debug issues, and perform refactoring.",
    flowerType: "code",
  },
  reviewer: {
    name: "Reviewer",
    role: "reviewer",
    systemPrompt: "You are a quality review specialist. Validate deliverables and suggest improvements.",
  },
};

function pickPersonaTemplate(index: number, total: number): { name: string; role: string; systemPrompt: string; flowerType?: FlowerType } {
  if (total === 1) return DEFAULT_PERSONAS.researcher;
  const roles = Object.values(DEFAULT_PERSONAS);
  return roles[index % roles.length];
}

function buildBeePersonas(
  count: number,
  customRoles: string[] | undefined,
  providerId: string,
  model: string,
): BeePersona[] {
  const bees: BeePersona[] = [];
  for (let i = 0; i < count; i++) {
    const template = pickPersonaTemplate(i, count);
    const customRole = customRoles?.[i];
    bees.push({
      id: newBeeId(),
      name: customRole ? customRole.split(":")[0].trim() : template.name,
      role: customRole ? customRole : template.role,
      systemPrompt: customRole
        ? `You perform the following role: ${customRole}`
        : template.systemPrompt,
      providerId,
      model,
      flowerType: template.flowerType ?? "browser",
    });
  }
  return bees;
}

export function createCityPlanFromBrief(brief: IntakeBrief, runtime?: PmRuntimeContext): CityDraft {
  const projectTitle = brief.goal.slice(0, 80) || "Untitled City";
  const cityId = `city-${Date.now()}`;
  const priority = priorityFromBrief(brief.priority);
  const dueDate = brief.deadline ?? new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  const resolvedProvider = runtime?.providerId ?? "openai";
  const resolvedModel = runtime?.model ?? "gpt-4o";
  const beeCount = Math.max(1, Math.min(brief.beeCount ?? 1, 5));

  const bees = buildBeePersonas(beeCount, brief.beeRoles, resolvedProvider, resolvedModel);

  const districtId = `district-${Date.now()}`;
  const districts: BeeDistrict[] = [
    { id: districtId, title: projectTitle, objective: brief.goal, status: "active", cityId },
  ];

  const tasks: BeeTask[] = [];

  for (const bee of bees) {
    // One id per task row — never reuse bee id alone (same bee can appear in multiple tasks later / merges).
    tasks.push({
      id: `task-${randomUUID().slice(0, 10)}`,
      title: `${projectTitle} — ${bee.name}`,
      districtId,
      cityId,
      bee: bee.id,
      flower: `${bee.providerId}-browser`,
      assignee: bee.id,
      dueDate,
      priority,
      requiresApproval: true,
      status: "waiting",
      personaId: bee.id,
    });
  }

  return { projectTitle, districts, tasks, bees };
}

export function createHivePlanFromBrief(brief: IntakeBrief, runtime?: PmRuntimeContext): CityDraft {
  return createCityPlanFromBrief(brief, runtime);
}

export function toCityPlan(draft: CityDraft): CityPlan {
  return {
    id: `city-${Date.now()}`,
    title: `${draft.projectTitle} City`,
    districts: draft.districts,
    tasks: draft.tasks,
    bees: draft.bees,
  };
}

export function toHivePlan(plan: CityDraft): CityPlan {
  return toCityPlan(plan);
}

export function createPlanFromBrief(brief: IntakeBrief): DraftPlan {
  return createCityPlanFromBrief(brief);
}

export function toSprintPlan(plan: DraftPlan): SprintPlan {
  return {
    id: `sprint-${Date.now()}`,
    title: `${plan.projectTitle} Sprint 1`,
    stories: plan.districts,
    tasks: plan.tasks as PlannedTask[],
  };
}

export function createHiveFromPlan(plan: CityDraft): CityPlan {
  return toCityPlan(plan);
}
