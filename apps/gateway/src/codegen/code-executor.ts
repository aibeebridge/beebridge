import { execFile } from "node:child_process";
import type { BeePersona, BeeTask, ConversationEntry, WaggleConfig } from "@beebridge/core";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { chatWithTools, type LlmConfig, resolveContextLimit, estimateMessageTokens } from "../browser/llm-client.js";
import { CODE_TOOLS, SPAWN_TASK_TOOL, CHECK_TASK_TOOL, WAGGLE_ASK_TOOL } from "./code-tools.js";
import { ProjectManager } from "./project-manager.js";
import { ProcessManager, gatewayPersistentBackgroundProcesses } from "./process-manager.js";
import { SubTaskManager, type SubTaskResult } from "./subtask-manager.js";
import { executeWaggle } from "../browser/waggle.js";
import { applyBridgeOutPlaceholders } from "../server/bridge-execution.js";
import type { TaskContext } from "../browser/controller.js";
import { executeTaskViaCdp } from "../browser/controller.js";
import type { AiHistoryEntry } from "../server/ai-history-store.js";
import { resolveOpenAiSecretToApiKey } from "../browser/openai-codex-token.js";
import {
  resolveSandboxConfig,
  runSandboxedShellCommand,
  spawnSandboxedShellCommand,
} from "./sandbox.js";

const MAX_AGENT_STEPS = 30;
const MAX_TOKEN_BUDGET = 200_000;
const COMPACTION_THRESHOLD = 0.7;
const DEFAULT_CMD_TIMEOUT_MS = 30_000;
const MAX_CMD_TIMEOUT_MS = 120_000;
const LOG_CONTEXT_MAX = 2000;
const LOG_WAGGLE_ANSWER_MAX = 12_000;

const LOOP_WARN_THRESHOLD = 3;
const LOOP_ABORT_THRESHOLD = 5;

const TOOL_RESULT_HARD_CAP = 30_000;
function capToolResult(content: string): string {
  if (content.length <= TOOL_RESULT_HARD_CAP) return content;
  return content.slice(0, TOOL_RESULT_HARD_CAP) +
    `\n\n[... output truncated at ${TOOL_RESULT_HARD_CAP} chars]`;
}

export interface CodeTaskResult {
  taskId: string;
  status: "done" | "failed";
  output: string;
  tokenUsage?: { promptTokens: number; completionTokens: number };
}

async function resolveLlmConfig(ctx: TaskContext): Promise<LlmConfig> {
  const profile = ctx.pmSettings.getActiveProfile();
  const policy = ctx.pmSettings.getModelPolicy();

  if (!profile) {
    throw new Error(
      "No active auth profile. Configure an API key in Settings > Auth Profiles.",
    );
  }

  let apiKey = profile.secret;
  let codexOAuth = false;
  if (profile.providerId === "openai" && profile.secret.trim().startsWith("{")) {
    const resolved = await resolveOpenAiSecretToApiKey(profile.secret, (s) => {
      ctx.pmSettings.updateProfileSecret(profile.id, s);
    });
    apiKey = resolved.apiKey;
    codexOAuth = resolved.codexOAuth;
  }

  return {
    apiKey,
    model: policy.defaultModel,
    providerId: profile.providerId,
    codexOAuth,
  };
}

function buildCodeSystemPrompt(
  persona: BeePersona | null | undefined,
  projectPath: string,
  depth: number,
  waggle?: WaggleConfig,
): string {
  const lines = [
    "You are a software development agent. You implement code projects by creating files, writing code, and running commands.",
    "",
    `Project directory: ${projectPath}`,
    "All file paths are relative to this project root.",
    "",
    "Workflow:",
    "1. Analyze the task requirements",
    "2. Plan the project structure (directories, files, dependencies)",
    "3. Create the project files using write_file (start with package.json/requirements.txt/etc. if needed)",
    "4. Implement the code file by file",
    "5. Run commands to install dependencies and verify the code works (e.g. npm install, npm test)",
    "6. Call 'done' with a summary of what was implemented and how to use it",
    "",
    "Tool tips:",
    "- Use edit_file for small changes instead of rewriting entire files with write_file",
    "- Use grep to find code patterns before editing",
    "- Use read_file with offset/limit for large files (returns numbered lines)",
    "- Use run_command with background=true for long-running servers, then process to check output",
    "- Background run_command sessions are not killed when the task ends; use process(action=\"kill\") or gateway shutdown to stop them. persist_after_job=true is optional (gw- session ids).",
    "- Do NOT append '&' to commands. For background work, set run_command(background=true) instead",
    "",
    "Best practices:",
    "- Create a README.md explaining the project, how to install, and how to run",
    "- Include a dependency manifest (package.json, requirements.txt, go.mod, etc.)",
    "- Write clean, well-structured code with proper error handling",
    "- Use list_files to verify project structure as you go",
    "- Use read_file to review files before modifying them",
    "- Use run_command to verify the code compiles/runs correctly",
    "- If a command fails, read the error output and fix the code",
    "",
    "Important rules:",
    "- All file paths must be relative (no leading '/' or '..')",
    "- Write complete file contents — write_file overwrites the entire file",
    "- Keep responses focused on implementation — avoid unnecessary discussion",
    "- If the task is ambiguous, make reasonable assumptions and document them in README",
  ];

  if (depth === 0) {
    lines.push(
      "",
      "Sub-tasks:",
      "- Use spawn_task to delegate work: type='code' for coding sub-tasks, type='browser' for web research",
      "- You can override the child's model with model='gpt-4o-mini' for lightweight tasks",
      "- Use wait=true (default) when you need the result before continuing",
      "- Use wait=false for parallel work — completed children auto-notify you; use check_task(action='result', wait_seconds=30) to wait for a specific child",
      "- Do NOT poll with check_task(action='status') in a loop — child completions are pushed to you automatically",
      "- Max 3 concurrent child tasks. Children cannot spawn their own children.",
      "- Code sub-tasks share this project directory — they can create/edit files here",
      "- Only use spawn_task when the work is substantial enough to benefit from delegation",
    );
  }

  if (persona) {
    lines.push("", `Role: ${persona.name} (${persona.role})`);
    if (persona.systemPrompt) {
      lines.push(persona.systemPrompt);
    }
  }

  if (waggle?.enabled) {
    lines.push(
      "",
      "WAGGLE — You have access to a supervisor (higher-tier AI channel) via waggle_ask.",
      "Use it to get guidance on architecture decisions, design patterns, or when requirements are unclear.",
      "You do not need to consult the supervisor for every step — use your own judgment for straightforward coding tasks.",
      "When using waggle_ask, include what you have implemented so far and what specific decision you need help with.",
    );
  }

  return lines.join("\n");
}

function summarizeToolCalls(calls: { name: string; args: Record<string, unknown> }[]): string {
  const parts = calls.map((t) => {
    if (t.name === "write_file" && typeof t.args.path === "string") {
      const content = typeof t.args.content === "string" ? t.args.content : "";
      return `write_file(${t.args.path}, ${content.length} chars)`;
    }
    if (t.name === "edit_file" && typeof t.args.path === "string") return `edit_file(${t.args.path})`;
    if (t.name === "read_file" && typeof t.args.path === "string") return `read_file(${t.args.path})`;
    if (t.name === "grep" && typeof t.args.pattern === "string") return `grep(${t.args.pattern})`;
    if (t.name === "list_files") return `list_files(${typeof t.args.path === "string" ? t.args.path : "."})`;
    if (t.name === "run_command" && typeof t.args.command === "string") {
      const cmd = t.args.command;
      const bg = t.args.background ? " &" : "";
      const persist = t.args.persist_after_job ? ", persist" : "";
      return `run_command(${cmd.length > 50 ? cmd.slice(0, 50) + "…" : cmd}${bg}${persist})`;
    }
    if (t.name === "process") return `process(${t.args.action})`;
    if (t.name === "spawn_task") {
      const type = t.args.type || "code";
      const wait = t.args.wait !== false ? "sync" : "async";
      const model = typeof t.args.model === "string" ? `, model=${t.args.model}` : "";
      return `spawn_task(${type}, ${wait}${model})`;
    }
    if (t.name === "check_task") return `check_task(${t.args.action}${t.args.child_task_id ? `, ${t.args.child_task_id}` : ""})`;
    if (t.name === "waggle_ask") return "waggle_ask";
    if (t.name === "done") return "done";
    return t.name;
  });
  let s = parts.join(" → ");
  if (s.length > 2000) s = s.slice(0, 2000) + "…";
  return s;
}

function detectLoop(sequence: { name: string; args: Record<string, unknown> }[]): "ok" | "warn" | "abort" {
  if (sequence.length < LOOP_WARN_THRESHOLD) return "ok";
  const key = (t: { name: string; args: Record<string, unknown> }) =>
    `${t.name}:${JSON.stringify(t.args)}`;

  const recentWarn = sequence.slice(-LOOP_WARN_THRESHOLD);
  const allSameWarn = recentWarn.every((t) => key(t) === key(recentWarn[0]));
  if (!allSameWarn) return "ok";

  if (sequence.length >= LOOP_ABORT_THRESHOLD) {
    const recentAbort = sequence.slice(-LOOP_ABORT_THRESHOLD);
    if (recentAbort.every((t) => key(t) === key(recentAbort[0]))) return "abort";
  }

  return "warn";
}

async function compactMessages(
  llmConfig: LlmConfig,
  messages: ChatCompletionMessageParam[],
  abortSignal?: AbortSignal,
): Promise<void> {
  const systemMsg = messages[0];
  const middleMessages = messages.slice(1, -3);
  const recentMessages = messages.slice(-3);

  if (middleMessages.length === 0) return;

  const summaryContent = middleMessages
    .filter((m) => m.role === "assistant" || m.role === "tool")
    .map((m) => {
      if (typeof m.content === "string") return m.content.slice(0, 500);
      return "";
    })
    .filter(Boolean)
    .join("\n---\n")
    .slice(0, 8000);

  try {
    const summaryResponse = await chatWithTools(
      llmConfig,
      [
        { role: "system", content: "Summarize the coding session so far. List: files created/modified, their purpose, commands run, current state, and what remains to do. Be concise." },
        { role: "user", content: summaryContent },
      ],
      [],
      { maxTokens: 1000, signal: abortSignal },
    );
    const summary = summaryResponse.content || "(compaction summary unavailable)";

    messages.length = 0;
    messages.push(
      systemMsg,
      { role: "user", content: `[Context Summary — previous steps compacted]\n${summary}` },
      ...recentMessages,
    );
  } catch {
    // compaction failed — continue with existing messages
  }
}

function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  projectId?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; sandboxed?: boolean }> {
  if (resolveSandboxConfig().mode === "docker") {
    return runSandboxedShellCommand(command, cwd, timeoutMs, projectId);
  }

  return new Promise((resolve) => {
    const child = execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HOME: process.env.HOME },
      },
      (error, stdout, stderr) => {
        if (error) {
          const errMsg = error.killed
            ? `Command timed out after ${timeoutMs}ms`
            : error.message;
          resolve({
            ok: false,
            stdout: stdout?.toString() ?? "",
            stderr: stderr?.toString() || errMsg,
          });
          return;
        }
        resolve({
          ok: true,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
        });
      },
    );
    child.stdin?.end();
  });
}

function readBackgroundOutput(taskPm: ProcessManager, sessionId: string, offset: number): string {
  if (taskPm.hasSession(sessionId)) return taskPm.readOutput(sessionId, offset);
  if (gatewayPersistentBackgroundProcesses.hasSession(sessionId)) {
    return gatewayPersistentBackgroundProcesses.readOutput(sessionId, offset);
  }
  return `Session not found: ${sessionId}`;
}

function killBackgroundProcess(taskPm: ProcessManager, sessionId: string): string {
  if (taskPm.hasSession(sessionId)) return taskPm.kill(sessionId);
  if (gatewayPersistentBackgroundProcesses.hasSession(sessionId)) {
    return gatewayPersistentBackgroundProcesses.kill(sessionId);
  }
  return `Session not found: ${sessionId}`;
}

function statusBackgroundProcess(
  taskPm: ProcessManager,
  sessionId: string,
): ReturnType<ProcessManager["status"]> {
  if (taskPm.hasSession(sessionId)) return taskPm.status(sessionId);
  if (gatewayPersistentBackgroundProcesses.hasSession(sessionId)) {
    return gatewayPersistentBackgroundProcesses.status(sessionId);
  }
  return { status: "not_found" };
}

function listBackgroundSessions(taskPm: ProcessManager): string {
  const lines: string[] = [];
  for (const s of taskPm.list()) {
    lines.push(
      `${s.sessionId}: ${s.command} [${s.status}${s.exitCode !== undefined ? `, exit=${s.exitCode}` : ""}] (ends when this task finishes)`,
    );
  }
  for (const s of gatewayPersistentBackgroundProcesses.list()) {
    lines.push(
      `${s.sessionId}: ${s.command} [${s.status}${s.exitCode !== undefined ? `, exit=${s.exitCode}` : ""}] (survives task completion; gateway shutdown stops it)`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : "(no background processes)";
}

function aggregateChildTokens(subtaskManager: SubTaskManager | null): { promptTokens: number; completionTokens: number } {
  if (!subtaskManager) return { promptTokens: 0, completionTokens: 0 };
  let promptTokens = 0;
  let completionTokens = 0;
  for (const child of subtaskManager.list()) {
    if (child.tokenUsage) {
      promptTokens += child.tokenUsage.promptTokens;
      completionTokens += child.tokenUsage.completionTokens;
    }
  }
  return { promptTokens, completionTokens };
}

export async function executeCodeTask(
  task: BeeTask,
  persona: BeePersona | null | undefined,
  ctx: TaskContext,
  projectManager: ProjectManager,
  waggleConfig?: WaggleConfig,
  bridgeContext?: string,
  bridgeOutMap?: Map<string, string>,
  depth = 0,
  sharedProjectPath?: string,
  sharedProjectId?: string,
  abortSignal?: AbortSignal,
  llmConfigOverride?: Partial<LlmConfig>,
): Promise<CodeTaskResult> {
  const jobId = task.id;

  let llmConfig: LlmConfig;
  try {
    llmConfig = await resolveLlmConfig(ctx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.jobStore.fail(jobId, msg);
    return { taskId: jobId, status: "failed", output: msg };
  }

  if (llmConfigOverride?.model) {
    llmConfig = { ...llmConfig, model: llmConfigOverride.model };
  }

  const projectPath = sharedProjectPath ?? projectManager.createProjectDir(task.id, task.title);
  const processManager = new ProcessManager();
  const subtaskManager = depth === 0 ? new SubTaskManager() : null;
  const sandboxConfig = resolveSandboxConfig();

  const gatewaySource = "Gateway";
  const workerSource = `Worker LLM (${llmConfig.providerId}/${llmConfig.model})`;
  const codeSource = "Code Executor";

  const makeResult = (status: "done" | "failed", output: string, promptTokens: number, completionTokens: number): CodeTaskResult => {
    const childTokens = aggregateChildTokens(subtaskManager);
    return {
      taskId: jobId,
      status,
      output,
      tokenUsage: {
        promptTokens: promptTokens + childTokens.promptTokens,
        completionTokens: completionTokens + childTokens.completionTokens,
      },
    };
  };

  const sendProgress = (
    action: string,
    content: string,
    source?: string,
    role: "flower" | "system" = "flower",
  ) => {
    const entry: ConversationEntry = {
      role,
      action,
      content,
      timestamp: new Date().toISOString(),
      ...(source ? { source } : {}),
    };
    ctx.jobStore.addEntry(jobId, entry);
    ctx.broadcastToWeb({ type: "job.update", jobId, entry });
  };

  sendProgress(
    "system",
    `Code task received: ${task.title}\nProject: ${projectPath}\nSandbox: ${sandboxConfig.mode === "docker" ? `docker (${sandboxConfig.image}, network=${sandboxConfig.network})` : "off"}`,
    gatewaySource,
    "system",
  );
  ctx.log("CODE", `starting code agent loop for task ${jobId}, project=${projectPath}, model=${llmConfig.model}, sandbox=${sandboxConfig.mode}`);

  const spawnTools = depth === 0 ? [SPAWN_TASK_TOOL, CHECK_TASK_TOOL] : [];
  const allTools = [
    ...CODE_TOOLS,
    ...spawnTools,
    ...(waggleConfig?.enabled ? [WAGGLE_ASK_TOOL] : []),
  ];

  let systemPrompt = buildCodeSystemPrompt(persona, projectPath, depth, waggleConfig);

  if (bridgeContext?.trim()) {
    systemPrompt += `\n\n=== Upstream pipeline context (from earlier districts / tasks in this run) ===\n${bridgeContext.trim()}\n=== End upstream context ===`;
  }

  const messages: ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: task.description ? `${task.title}\n\n${task.description}` : task.title },
  ];

  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  const startTime = Date.now();
  let finalOutput = "";
  const toolCallSequence: { name: string; args: Record<string, unknown> }[] = [];
  let compactionCount = 0;
  const contextLimit = resolveContextLimit(llmConfig);

  for (let step = 0; step < MAX_AGENT_STEPS; step++) {
    // --- Abort check ---
    if (abortSignal?.aborted) {
      const msg = "Task aborted by parent.";
      const result = makeResult("failed", msg, totalPromptTokens, totalCompletionTokens);
      recordHistory(ctx, jobId, task, llmConfig, startTime, result.tokenUsage!.promptTokens, result.tokenUsage!.completionTokens, msg, "error");
      processManager.cleanup();
      subtaskManager?.cleanup();
      ctx.jobStore.fail(jobId, msg);
      return result;
    }

    ctx.log("CODE", `step ${step + 1}/${MAX_AGENT_STEPS}`);

    // --- Inject child completion notifications ---
    if (subtaskManager) {
      const notifications = subtaskManager.drainCompletionNotifications();
      for (const n of notifications) {
        messages.push({
          role: "user",
          content: `[Child Task Completed] ${n.childTaskId} [${n.status}]: ${n.output || "(no output)"}`,
        });
      }
    }

    // --- Compaction check (usage-based) ---
    const totalTokens = totalPromptTokens + totalCompletionTokens;
    if (totalTokens > contextLimit * COMPACTION_THRESHOLD) {
      ctx.log("CODE", `compacting messages at ${totalTokens} tokens (${Math.round(totalTokens / contextLimit * 100)}% of limit ${contextLimit})`);
      sendProgress("system", "Compacting conversation to save context window...", gatewaySource, "system");
      await compactMessages(llmConfig, messages, abortSignal);
      compactionCount++;
    }

    // --- Preflight: estimate current message size vs context limit ---
    const estimatedTokens = estimateMessageTokens(messages);
    if (estimatedTokens > contextLimit * 0.85) {
      ctx.log("CODE", `preflight: estimated ${estimatedTokens} tokens exceeds 85% of limit ${contextLimit}, compacting...`);
      sendProgress("system", "Context nearing limit, compacting...", gatewaySource, "system");
      await compactMessages(llmConfig, messages, abortSignal);
      compactionCount++;
    }

    let llmResponse;
    try {
      sendProgress(
        "llm_call",
        `LLM thinking... (step ${step + 1})`,
        workerSource,
      );
      llmResponse = await chatWithTools(llmConfig, messages, allTools, { signal: abortSignal });
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError"
        || (err instanceof Error && err.name === "AbortError");
      if (isAbort) {
        const msg = "Task aborted by parent.";
        ctx.log("CODE", msg);
        sendProgress("warning", msg, workerSource);
        const result = makeResult("failed", msg, totalPromptTokens, totalCompletionTokens);
        recordHistory(ctx, jobId, task, llmConfig, startTime, result.tokenUsage!.promptTokens, result.tokenUsage!.completionTokens, msg, "error");
        processManager.cleanup();
        subtaskManager?.cleanup();
        ctx.jobStore.fail(jobId, msg);
        return result;
      }
      const msg = err instanceof Error ? err.message : String(err);

      if (/token.*(count|limit)|exceeds.*limit|context.*length/i.test(msg) && compactionCount < 3) {
        ctx.log("CODE", `Context overflow detected (attempt ${compactionCount + 1}), forcing compaction...`);
        sendProgress("system", "Context overflow — compacting and retrying...", gatewaySource, "system");
        await compactMessages(llmConfig, messages, abortSignal);
        compactionCount++;
        continue;
      }

      ctx.log("CODE", `LLM call failed: ${msg}`);
      sendProgress("error", `LLM error: ${msg}`, workerSource);
      const result = makeResult("failed", msg, totalPromptTokens, totalCompletionTokens);
      recordHistory(ctx, jobId, task, llmConfig, startTime, result.tokenUsage!.promptTokens, result.tokenUsage!.completionTokens, msg, "error");
      processManager.cleanup();
      subtaskManager?.cleanup();
      ctx.jobStore.fail(jobId, `LLM error: ${msg}`);
      return result;
    }

    if (llmResponse.usage) {
      totalPromptTokens += llmResponse.usage.promptTokens;
      totalCompletionTokens += llmResponse.usage.completionTokens;

      if (totalPromptTokens + totalCompletionTokens > MAX_TOKEN_BUDGET) {
        const budgetMsg = `Token budget exceeded (${totalPromptTokens + totalCompletionTokens} > ${MAX_TOKEN_BUDGET}). Stopping agent loop.`;
        ctx.log("CODE", budgetMsg);
        sendProgress("warning", budgetMsg, gatewaySource, "system");
        const result = makeResult("failed", budgetMsg, totalPromptTokens, totalCompletionTokens);
        recordHistory(ctx, jobId, task, llmConfig, startTime, result.tokenUsage!.promptTokens, result.tokenUsage!.completionTokens, budgetMsg, "error");
        processManager.cleanup();
        subtaskManager?.cleanup();
        ctx.jobStore.fail(jobId, budgetMsg);
        return result;
      }
    }

    if (llmResponse.toolCalls.length === 0) {
      if (llmResponse.content) {
        messages.push({ role: "assistant", content: llmResponse.content });
      }
      finalOutput = llmResponse.content || "Task completed (no tool calls)";
      sendProgress("done", finalOutput, workerSource);
      break;
    }

    const assistantMsg: ChatCompletionMessageParam = {
      role: "assistant",
      content: llmResponse.content || null,
      tool_calls: llmResponse.toolCalls.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: { name: tc.name, arguments: JSON.stringify(tc.args) },
      })),
    };
    messages.push(assistantMsg);

    sendProgress("worker_tool_plan", summarizeToolCalls(llmResponse.toolCalls), workerSource);

    for (const tc of llmResponse.toolCalls) {
      ctx.log("CODE", `tool_call: ${tc.name}(${JSON.stringify(tc.args).slice(0, 200)})`);
      toolCallSequence.push({ name: tc.name, args: tc.args });

      // --- Loop detection ---
      const loopStatus = detectLoop(toolCallSequence);
      if (loopStatus === "abort") {
        const abortMsg = `Loop detected: same tool call repeated ${LOOP_ABORT_THRESHOLD} times. Aborting agent loop.`;
        ctx.log("CODE", abortMsg);
        sendProgress("error", abortMsg, gatewaySource, "system");
        const result = makeResult("failed", abortMsg, totalPromptTokens, totalCompletionTokens);
        recordHistory(ctx, jobId, task, llmConfig, startTime, result.tokenUsage!.promptTokens, result.tokenUsage!.completionTokens, abortMsg, "error");
        processManager.cleanup();
        subtaskManager?.cleanup();
        ctx.jobStore.fail(jobId, abortMsg);
        return result;
      }
      if (loopStatus === "warn") {
        const warnMsg = "You are repeating the same action. Try a different approach or call 'done' if the task is complete.";
        sendProgress("warning", warnMsg, gatewaySource, "system");
        messages.push({ role: "tool", tool_call_id: tc.id, content: warnMsg });
        continue;
      }

      if (tc.name === "done") {
        finalOutput = (tc.args.result as string) || "Task completed";
        sendProgress("done", finalOutput, workerSource);

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: "Task marked as done.",
        });

        const result = makeResult("done", finalOutput, totalPromptTokens, totalCompletionTokens);
        recordHistory(ctx, jobId, task, llmConfig, startTime, result.tokenUsage!.promptTokens, result.tokenUsage!.completionTokens, finalOutput, "success");

        ctx.jobStore.complete(jobId, finalOutput);
        processManager.cleanup();
        subtaskManager?.cleanup();
        return result;
      }

      // --- spawn_task ---
      if (tc.name === "spawn_task" && subtaskManager) {
        const childTask = (tc.args.task as string) || "";
        const childType = (tc.args.type as "code" | "browser") || "code";
        const wait = tc.args.wait !== false;
        const timeoutSeconds = typeof tc.args.timeout_seconds === "number" ? tc.args.timeout_seconds : 300;
        const timeoutMs = Math.max(10_000, Math.min(timeoutSeconds * 1000, 600_000));
        const modelOverride = typeof tc.args.model === "string" ? tc.args.model.trim() : undefined;

        const canSpawn = subtaskManager.canSpawn();
        if (!canSpawn.ok) {
          messages.push({ role: "tool", tool_call_id: tc.id, content: `spawn_task rejected: ${canSpawn.reason}` });
          continue;
        }

        // CDP relay pre-check for browser tasks
        if (childType === "browser") {
          const relay = ctx.getCdpRelay?.();
          if (!relay?.isReady()) {
            messages.push({
              role: "tool", tool_call_id: tc.id,
              content: "spawn_task rejected: CDP relay not connected. Browser tasks require an active browser connection.",
            });
            continue;
          }
        }

        const childTaskId = subtaskManager.generateChildTaskId(jobId);
        const childBeeTask: BeeTask = {
          id: childTaskId,
          title: childTask.slice(0, 200),
          description: childTask,
          districtId: task.districtId,
          cityId: task.cityId,
          bee: task.bee,
          flower: childType === "code" ? task.flower : `${task.bee}-browser`,
          assignee: task.assignee,
          dueDate: task.dueDate,
          priority: task.priority,
          requiresApproval: false,
          status: "working",
          personaId: task.personaId,
        };

        ctx.jobStore.start(childTaskId, task.bee);
        sendProgress("spawn_task", `Spawning ${childType} child: ${childTask.slice(0, 120)}${modelOverride ? ` (model: ${modelOverride})` : ""}`, codeSource);

        const childAbortController = new AbortController();
        let childExecPromise: Promise<CodeTaskResult>;

        if (childType === "code") {
          childExecPromise = executeCodeTask(
            childBeeTask,
            persona,
            ctx,
            projectManager,
            waggleConfig,
            bridgeContext,
            bridgeOutMap,
            depth + 1,
            projectPath,
            sharedProjectId,
            childAbortController.signal,
            modelOverride ? { model: modelOverride } : undefined,
          );
        } else {
          childExecPromise = executeTaskViaCdp(
            childBeeTask,
            persona ?? null,
            ctx,
            waggleConfig,
            bridgeContext,
            bridgeOutMap,
            childAbortController.signal,
            modelOverride ? { model: modelOverride } : undefined,
          );
        }

        const childPromise: Promise<SubTaskResult> = childExecPromise.then((r) => ({
          taskId: r.taskId,
          status: r.status,
          output: r.output,
          tokenUsage: r.tokenUsage,
        }));

        subtaskManager.register({
          childTaskId,
          task: childTask,
          type: childType,
          status: "running",
          promise: childPromise,
          abortController: childAbortController,
          startedAt: Date.now(),
        });

        if (wait) {
          const result = await subtaskManager.waitFor(childTaskId, timeoutMs);
          const msg = `[${result.status}] ${result.output?.slice(0, 4000) || "(no output)"}`;
          sendProgress("spawn_task", `Child ${childTaskId} ${result.status}: ${result.output?.slice(0, 200) || ""}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: capToolResult(msg) });
        } else {
          const msg = `Child task spawned: child_task_id="${childTaskId}"\nCompleted children will auto-notify you. Use check_task(action="result", child_task_id="${childTaskId}", wait_seconds=30) to wait for output.`;
          sendProgress("spawn_task", `Child spawned: ${childTaskId}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: msg });
        }
        continue;
      }

      // --- check_task ---
      if (tc.name === "check_task" && subtaskManager) {
        const action = tc.args.action as string;
        const childId = tc.args.child_task_id as string | undefined;

        if (action === "list") {
          const children = subtaskManager.list();
          if (children.length === 0) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: "(no child tasks)" });
          } else {
            const lines = children.map((c) => {
              const runtime = Math.round(((c.endedAt ?? Date.now()) - c.startedAt) / 1000);
              const tokens = c.tokenUsage ? ` tokens=${c.tokenUsage.promptTokens}+${c.tokenUsage.completionTokens}` : "";
              return `${c.childTaskId}: ${c.type} [${c.status}] ${runtime}s${tokens} — ${c.task.slice(0, 80)}`;
            });
            messages.push({ role: "tool", tool_call_id: tc.id, content: lines.join("\n") });
          }
          sendProgress("check_task", `list: ${subtaskManager.list().length} children`, codeSource);
          continue;
        }

        if (!childId) {
          messages.push({ role: "tool", tool_call_id: tc.id, content: "child_task_id is required for this action" });
          continue;
        }

        if (action === "status") {
          const run = subtaskManager.get(childId);
          if (!run) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: `Child task not found: ${childId}` });
          } else {
            const runtime = Math.round(((run.endedAt ?? Date.now()) - run.startedAt) / 1000);
            messages.push({
              role: "tool",
              tool_call_id: tc.id,
              content: JSON.stringify({ childTaskId: childId, status: run.status, type: run.type, runtime_seconds: runtime }),
            });
          }
          sendProgress("check_task", `status(${childId})`, codeSource);
        } else if (action === "result") {
          const waitSeconds = typeof tc.args.wait_seconds === "number"
            ? Math.min(Math.max(tc.args.wait_seconds, 0), 300) : 0;
          const run = subtaskManager.get(childId);
          if (!run) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: `Child task not found: ${childId}` });
          } else if (run.status === "running" && waitSeconds > 0) {
            const result = await subtaskManager.waitFor(childId, waitSeconds * 1000);
            messages.push({ role: "tool", tool_call_id: tc.id, content: capToolResult(`[${result.status}] ${result.output?.slice(0, 4000) || "(no output)"}`) });
          } else if (run.status === "running") {
            messages.push({ role: "tool", tool_call_id: tc.id, content: `Child task ${childId} is still running. Use wait_seconds to wait, or child completions will auto-notify you.` });
          } else {
            messages.push({ role: "tool", tool_call_id: tc.id, content: capToolResult(`[${run.status}] ${run.output?.slice(0, 4000) || "(no output)"}`) });
          }
          sendProgress("check_task", `result(${childId}${waitSeconds > 0 ? `, wait=${waitSeconds}s` : ""})`, codeSource);
        } else if (action === "kill") {
          const result = subtaskManager.kill(childId);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
          sendProgress("check_task", `kill(${childId}): ${result}`, codeSource);
        } else {
          messages.push({ role: "tool", tool_call_id: tc.id, content: `Unknown check_task action: ${action}` });
        }
        continue;
      }

      if (tc.name === "waggle_ask" && waggleConfig?.enabled) {
        let question = (tc.args.question as string) || "";
        let qContext = tc.args.context as string | undefined;

        if (bridgeOutMap && bridgeOutMap.size > 0) {
          question = applyBridgeOutPlaceholders(question, bridgeOutMap);
          if (qContext) qContext = applyBridgeOutPlaceholders(qContext, bridgeOutMap);
        }

        if (bridgeContext?.trim()) {
          const upstream = `=== Upstream pipeline context ===\n${bridgeContext.trim()}\n=== End upstream context ===`;
          qContext = qContext ? `${upstream}\n\n${qContext}` : upstream;
        }

        const askBody =
          `Question:\n${question}` +
          (qContext
            ? `\n\nContext:\n${qContext.length > LOG_CONTEXT_MAX ? `${qContext.slice(0, LOG_CONTEXT_MAX)}…` : qContext}`
            : "");
        sendProgress("waggle_ask", askBody, "Waggle");

        const relay = ctx.getCdpRelay?.() ?? undefined;
        const waggleResult = await executeWaggle(question, qContext, waggleConfig, relay, ctx, {
          jobId: task.id,
          districtId: task.districtId,
        });

        if (waggleResult.ok) {
          const head = `[${waggleResult.latencyMs}ms${waggleResult.fromCache ? " · cache" : ""}]\n\n`;
          const ans = waggleResult.answer;
          const body = ans.length > LOG_WAGGLE_ANSWER_MAX ? `${ans.slice(0, LOG_WAGGLE_ANSWER_MAX)}…` : ans;
          sendProgress("waggle_answer", head + body, "Waggle");
        } else {
          sendProgress("waggle_error", waggleResult.answer.slice(0, 2000), "Waggle");
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: waggleResult.answer.slice(0, 6000),
        });
        continue;
      }

      // --- File system tools ---

      if (tc.name === "write_file") {
        const filePath = tc.args.path as string;
        const content = tc.args.content as string;
        try {
          projectManager.writeFile(projectPath, filePath, content);
          const msg = `File written: ${filePath} (${content.length} bytes)`;
          sendProgress("write_file", msg, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: msg });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          sendProgress("write_file", `Failed: ${errMsg}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: `write_file failed: ${errMsg}` });
        }
        continue;
      }

      if (tc.name === "edit_file") {
        const filePath = tc.args.path as string;
        const oldStr = tc.args.old_string as string;
        const newStr = tc.args.new_string as string;
        try {
          projectManager.editFile(projectPath, filePath, oldStr, newStr);
          const msg = `File edited: ${filePath} (replaced ${oldStr.length} chars with ${newStr.length} chars)`;
          sendProgress("edit_file", msg, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: msg });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          sendProgress("edit_file", `Failed: ${errMsg}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: `edit_file failed: ${errMsg}` });
        }
        continue;
      }

      if (tc.name === "read_file") {
        const filePath = tc.args.path as string;
        const offset = typeof tc.args.offset === "number" ? tc.args.offset : undefined;
        const limit = typeof tc.args.limit === "number" ? tc.args.limit : undefined;
        try {
          const content = projectManager.readFile(projectPath, filePath, offset, limit);
          sendProgress("read_file", `Read: ${filePath} (${content.length} chars)`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: capToolResult(content) });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          sendProgress("read_file", `Failed: ${errMsg}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: `read_file failed: ${errMsg}` });
        }
        continue;
      }

      if (tc.name === "grep") {
        const pattern = tc.args.pattern as string;
        const grepPath = tc.args.path as string | undefined;
        const include = tc.args.include as string | undefined;
        try {
          const result = projectManager.grepFiles(projectPath, pattern, grepPath, include);
          sendProgress("grep", `grep "${pattern}": ${result.split("\n").length} matches`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: capToolResult(result) });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          sendProgress("grep", `Failed: ${errMsg}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: `grep failed: ${errMsg}` });
        }
        continue;
      }

      if (tc.name === "list_files") {
        const dirPath = tc.args.path as string | undefined;
        const recursive = tc.args.recursive as boolean | undefined;
        try {
          const files = projectManager.listFiles(projectPath, dirPath, recursive);
          let result = files.length > 0 ? files.join("\n") : "(empty directory)";
          if (result.length > 8000) {
            result = result.slice(0, 8000) + `\n\n[... truncated, ${files.length} entries total]`;
          }
          sendProgress("list_files", `Listed ${dirPath ?? "."}: ${files.length} entries`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: capToolResult(result) });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          sendProgress("list_files", `Failed: ${errMsg}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: `list_files failed: ${errMsg}` });
        }
        continue;
      }

      if (tc.name === "run_command") {
        const commandRaw = String(tc.args.command ?? "");
        const background = tc.args.background as boolean | undefined;
        const trimmed = commandRaw.trim();
        // Guardrail: agents sometimes append trailing "&" while also expecting a managed background session.
        // Convert that pattern into managed background mode so session_id/status/kill stay correct.
        const inferredBackground = background !== true && /(^|[^\S\r\n])&\s*$/.test(trimmed);
        const command = inferredBackground
          ? trimmed.replace(/(^|[^\S\r\n])&\s*$/, "").trim()
          : commandRaw;
        const shouldBackground = background === true || inferredBackground;
        const persistAfterJob = tc.args.persist_after_job === true;

        if (persistAfterJob && !shouldBackground) {
          messages.push({
            role: "tool",
            tool_call_id: tc.id,
            content: "persist_after_job requires background=true (or a trailing '&' on the command).",
          });
          continue;
        }

        if (shouldBackground) {
          const targetPm = persistAfterJob ? gatewayPersistentBackgroundProcesses : processManager;
          const sessionId = targetPm.start(
            command,
            projectPath,
            sandboxConfig.mode === "docker"
              ? { spawnCommand: (cmd, cwd, sessionId) => spawnSandboxedShellCommand(cmd, cwd, sessionId, sharedProjectId) }
              : undefined,
          );
          const modeHint = inferredBackground
            ? `\n(Note: trailing '&' in command was normalized to managed background mode.)`
            : "";
          const sandboxHint = sandboxConfig.mode === "docker"
            ? "\nSandbox: Docker container with only this code project mounted at /project."
            : "";
          const persistHint = persistAfterJob
            ? "\nThis process is kept running after the task completes until the Beebridge gateway stops or you call process(action=\"kill\")."
            : "";
          const msg =
            `Background process started: session_id="${sessionId}"\nUse process(action="read_output", session_id="${sessionId}") to check output.${modeHint}${sandboxHint}${persistHint}`;
          sendProgress("run_command", `$ ${command} & → ${sessionId}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: msg });
          continue;
        }

        const timeoutMs = Math.min(
          typeof tc.args.timeout_ms === "number" ? tc.args.timeout_ms : DEFAULT_CMD_TIMEOUT_MS,
          MAX_CMD_TIMEOUT_MS,
        );

        sendProgress("run_command", `$ ${command}`, codeSource);

        const result = await runShellCommand(command, projectPath, timeoutMs, sharedProjectId);
        const sandboxPrefix = result.sandboxed ? "[sandbox: docker]\n" : "";
        const output = [
          result.stdout ? `stdout:\n${result.stdout.slice(0, 8000)}` : "",
          result.stderr ? `stderr:\n${result.stderr.slice(0, 4000)}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        const statusLabel = result.ok ? "ok" : "failed";
        sendProgress(
          "run_command",
          `[${statusLabel}] ${command}\n${sandboxPrefix}${output.slice(0, 1000)}`,
          codeSource,
        );

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: capToolResult(result.ok
            ? (sandboxPrefix + (output || "Command completed successfully (no output)"))
            : `${sandboxPrefix}Command failed:\n${output || "Unknown error"}`),
        });
        continue;
      }

      if (tc.name === "process") {
        const action = tc.args.action as string;
        const sessionId = tc.args.session_id as string | undefined;

        if (action === "list") {
          const result = listBackgroundSessions(processManager);
          const n =
            processManager.list().length + gatewayPersistentBackgroundProcesses.list().length;
          sendProgress("process", `list: ${n} sessions`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
          continue;
        }

        if (!sessionId) {
          messages.push({ role: "tool", tool_call_id: tc.id, content: "session_id is required for this action" });
          continue;
        }

        if (action === "read_output") {
          const offset = typeof tc.args.offset === "number" ? tc.args.offset : 0;
          const output = readBackgroundOutput(processManager, sessionId, offset);
          sendProgress("process", `read_output(${sessionId})`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: capToolResult(output) });
        } else if (action === "kill") {
          const result = killBackgroundProcess(processManager, sessionId);
          sendProgress("process", `kill(${sessionId}): ${result}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        } else if (action === "status") {
          const info = statusBackgroundProcess(processManager, sessionId);
          const result = JSON.stringify(info);
          sendProgress("process", `status(${sessionId}): ${info.status}`, codeSource);
          messages.push({ role: "tool", tool_call_id: tc.id, content: result });
        } else {
          messages.push({ role: "tool", tool_call_id: tc.id, content: `Unknown process action: ${action}` });
        }
        continue;
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `Unknown tool: ${tc.name}`,
      });
    }
  }

  if (!finalOutput) {
    finalOutput = "Code agent loop reached maximum steps without completing.";
    sendProgress("warning", finalOutput, gatewaySource, "system");
  }

  const result = finalOutput.includes("maximum")
    ? makeResult("failed", finalOutput, totalPromptTokens, totalCompletionTokens)
    : makeResult("done", finalOutput, totalPromptTokens, totalCompletionTokens);

  recordHistory(
    ctx,
    jobId,
    task,
    llmConfig,
    startTime,
    result.tokenUsage!.promptTokens,
    result.tokenUsage!.completionTokens,
    finalOutput,
    result.status === "failed" ? "error" : "success",
  );

  processManager.cleanup();
  subtaskManager?.cleanup();

  if (result.status === "failed") {
    ctx.jobStore.fail(jobId, finalOutput);
  } else {
    ctx.jobStore.complete(jobId, finalOutput);
  }
  return result;
}

function recordHistory(
  ctx: TaskContext,
  jobId: string,
  task: BeeTask,
  llmConfig: LlmConfig,
  startTime: number,
  promptTokens: number,
  completionTokens: number,
  output: string,
  status: "success" | "error",
): void {
  const entry: AiHistoryEntry = {
    id: `ai-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    provider: llmConfig.providerId,
    model: llmConfig.model,
    jobId,
    beeId: task.personaId || task.bee,
    action: "code_agent_loop",
    inputTokens: promptTokens,
    outputTokens: completionTokens,
    totalTokens: promptTokens + completionTokens,
    durationMs: Date.now() - startTime,
    promptPreview: task.title.slice(0, 200),
    responsePreview: output.slice(0, 200),
    status,
  };
  ctx.aiHistory.record(entry);
  ctx.broadcastToWeb({ type: "ai.history.new", entry });
  ctx.log(
    "AI_HISTORY",
    `recorded: ${llmConfig.providerId}/${llmConfig.model} ${entry.durationMs}ms tokens=${entry.totalTokens} ${status}`,
  );
}
