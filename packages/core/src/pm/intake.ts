export interface IntakeBrief {
  goal: string;
  deadline?: string;
  priority?: "low" | "medium" | "high";
  constraints?: string[];
  beeCount?: number;
  beeRoles?: string[];
}

export type IntakeQuestionKey = "deadline" | "priority" | "constraints" | "beeCount" | "beeRoles";

export interface IntakeQuestion {
  key: IntakeQuestionKey;
  prompt: string;
}

export function buildIntakeQuestions(goal: string, answers: Record<string, string>): IntakeQuestion[] {
  const questions: IntakeQuestion[] = [];

  if (!goal.trim()) {
    return [{ key: "constraints", prompt: "Describe the task you want to assign to the Project Manager in one sentence." }];
  }

  if (!answers.deadline) {
    questions.push({ key: "deadline", prompt: "When is the deadline for this task? (e.g. 2026-04-10)" });
  }

  if (!answers.priority) {
    questions.push({ key: "priority", prompt: "What priority should the manager assign to the bees? (low/medium/high)" });
  }

  if (!answers.beeCount) {
    questions.push({ key: "beeCount", prompt: "How many bees should be assigned to this task? (1-5, default: 1)" });
  }

  if (!answers.constraints) {
    questions.push({ key: "constraints", prompt: "Are there any constraints the bees must follow?" });
  }

  return questions;
}
