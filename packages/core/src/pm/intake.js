export function buildIntakeQuestions(goal, answers) {
    const questions = [];
    if (!goal.trim()) {
        return [{ key: "constraints", prompt: "Describe the task you want to assign in one sentence." }];
    }
    if (!answers.deadline) {
        questions.push({ key: "deadline", prompt: "When is the deadline? (e.g. 2026-04-10)" });
    }
    if (!answers.priority) {
        questions.push({ key: "priority", prompt: "What is the priority? (low/medium/high)" });
    }
    if (!answers.constraints) {
        questions.push({ key: "constraints", prompt: "Are there any constraints that must be followed?" });
    }
    return questions;
}
