export interface IntakeBrief {
    goal: string;
    deadline?: string;
    priority?: "low" | "medium" | "high";
    constraints?: string[];
}
export interface IntakeQuestion {
    key: "deadline" | "priority" | "constraints";
    prompt: string;
}
export declare function buildIntakeQuestions(goal: string, answers: Record<string, string>): IntakeQuestion[];
