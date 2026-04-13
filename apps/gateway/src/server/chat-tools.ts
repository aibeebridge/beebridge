/**
 * Chat action tools: schemas and prompt segment for the `/api/chat` tool-calling loop.
 *
 * When the user sends an action request via chat (e.g. "add a task with 2 bees"),
 * the LLM can invoke these tools to mutate workspace state (districts, bees, tasks,
 * bridges, waggle) instead of just answering questions.
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";

// ─── Tool argument types (consumed by executors in index.ts) ───

export interface SetupPlanArgs {
  title: string;
  objective?: string;
  bees: Array<{
    name: string;
    role: string;
    mission: string;
    needsBrowser?: boolean;
    /** When true, this bee uses Waggle (supervisor) with browser mode — must align with waggleMode "browser". */
    needsWaggle?: boolean;
    /** When true (or role coder), use code Flower instead of browser Flower. */
    needsCode?: boolean;
    /** 0-based indices of bees in this array that must complete before this bee starts. Empty = can start immediately (parallel). */
    dependsOnBees?: number[];
  }>;
  waggleMode?: "off" | "browser" | "api";
  /**
   * BCP-47 locale for user-visible bee output (e.g. ko, en). Defaults to "en" if omitted.
   * Should match the router intent block when available.
   */
  responseLocale?: string;
  /**
   * When false, the first Waggle step must be waggle_ask before browser tools. When true or omitted, URL tasks may use browser tools first.
   */
  allowBrowserBeforeFirstWaggle?: boolean;
  targetDistrictId?: string;
  priority?: "low" | "medium" | "high";
  /**
   * When true, tasks wait in Approvals before the queue can run them.
   * Chat-created plans default to false so work starts without a manual approve step.
   */
  requiresApproval?: boolean;
}

export interface UpdateDistrictSettingsArgs {
  districtId: string;
  waggleEnabled?: boolean;
  waggleMode?: "off" | "browser" | "api";
  waggleAutoDetect?: boolean;
  /** When false, first step is waggle_ask only until one supervisor reply; when true/omitted, URL tasks may navigate first. */
  allowBrowserBeforeFirstWaggle?: boolean;
  objective?: string;
  useUpstreamBridgeContext?: boolean;
}

export interface CreateBridgeArgs {
  fromDistrictId: string;
  toDistrictId: string;
  label: string;
  direction?: "one_way" | "two_way";
}

export interface SetBridgeStartArgs {
  /** District to set as pipeline entry; omit when using clear. */
  districtId?: string;
  /** If true, clear the pipeline start district. */
  clear?: boolean;
}

export interface ApprovePendingTasksArgs {
  /** Approve these pending task ids (from Jobs & approvals context). */
  taskIds?: string[];
  /** When true, approve every task currently in the pending approval queue. */
  approveAllPending?: boolean;
  /** Case-insensitive substring match on pending task titles (use when the user names a job but not its id). */
  titleSubstring?: string;
  /**
   * When true (default), start the execution queue for newly approved tasks after approving.
   * Set false if the user only wants approval without running yet.
   */
  runQueue?: boolean;
}

export interface RunTasksArgs {
  /** Specific task ids to run. */
  taskIds?: string[];
  /** Run all waiting/approved tasks in this district. */
  districtId?: string;
  /** Case-insensitive substring match on task titles. */
  titleSubstring?: string;
}

// ─── Tool schemas (OpenAI function-calling format) ───

export const CHAT_ACTION_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "setup_plan",
      description:
        "Create a new district with bees and tasks, or add bees/tasks to an existing district. " +
        "Auto-configures waggle mode and flower type based on task requirements. " +
        "Use when the user wants to create work items, add tasks, start a new project, or assign bees. " +
        "Waggle (supervisor) is OFF by default; set waggleMode to 'browser' only when needsWaggle is true for a bee or the user wants supervisor assistance. needsBrowser alone enables the browser Flower but does NOT enable Waggle. " +
        "Before creating a brand-new district, use list_districts (or graph context): if the user is continuing the same project or topic, pass targetDistrictId to add bees/tasks there — do not create duplicate districts for follow-up messages. " +
        "Each bee must include a detailed non-empty mission (what to build/do); empty missions are rejected.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Short title for the district/project (prefer the same language as the user)",
          },
          objective: {
            type: "string",
            description: "What this project aims to accomplish (prefer the user's language)",
          },
          bees: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Display name for this bee" },
                role: {
                  type: "string",
                  enum: ["researcher", "analyst", "writer", "coder", "reviewer"],
                  description: "Role template",
                },
                mission: {
                  type: "string",
                  description:
                    "Required. Concrete persona/work description (prefer the user's language). Empty strings are invalid.",
                },
                needsBrowser: {
                  type: "boolean",
                  description:
                    "True if this bee must use the browser Flower (live web: URLs, sites, search). False for text-only or repo work.",
                },
                needsWaggle: {
                  type: "boolean",
                  description:
                    "True if this bee should use Waggle supervisor (higher-tier channel). When true, set waggleMode to 'browser' (or 'api') for the district. False for simple open-URL-and-read tasks.",
                },
                needsCode: {
                  type: "boolean",
                  description: "True if this bee should use the code Flower (IDE/workspace) instead of browser",
                },
                dependsOnBees: {
                  type: "array",
                  items: { type: "number" },
                  description: "0-based indices of bees in this array that must complete before this bee starts. Empty or omitted = can start immediately (parallel with other root bees).",
                },
              },
              required: ["name", "role", "mission"],
            },
            description: "Bees to assign. Use dependsOnBees to define execution order graph (parallel/sequential).",
          },
          waggleMode: {
            type: "string",
            enum: ["off", "browser", "api"],
            description:
              "Waggle/supervisor mode. Default 'off'. Use 'browser' when any bee has needsWaggle=true or the user explicitly wants Waggle. Do NOT set from needsBrowser alone.",
          },
          responseLocale: {
            type: "string",
            description:
              "BCP-47 locale for user-visible output (e.g. ko, en). Use the router intent responseLocale when available.",
          },
          allowBrowserBeforeFirstWaggle: {
            type: "boolean",
            description:
              "If true (default), tasks with a URL may use browser tools before the first waggle_ask. If false, legacy strict Waggle-first step.",
          },
          targetDistrictId: {
            type: "string",
            description: "Existing district ID to add tasks to. Omit to create a new district.",
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Task priority (default: medium). Note: high priority still requires approval per workspace rules.",
          },
          requiresApproval: {
            type: "boolean",
            description:
              "If true, tasks stay pending until approved in Approvals. Default false for chat so jobs can run immediately.",
          },
        },
        required: ["title", "bees"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_district_settings",
      description: "Update waggle mode, objective, or other settings for an existing district.",
      parameters: {
        type: "object",
        properties: {
          districtId: { type: "string", description: "District ID to update" },
          waggleEnabled: { type: "boolean" },
          waggleMode: { type: "string", enum: ["off", "browser", "api"] },
          waggleAutoDetect: { type: "boolean" },
          allowBrowserBeforeFirstWaggle: { type: "boolean" },
          objective: { type: "string" },
          useUpstreamBridgeContext: { type: "boolean" },
        },
        required: ["districtId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_bridge",
      description: "Create a bridge between two districts for sequential data flow.",
      parameters: {
        type: "object",
        properties: {
          fromDistrictId: { type: "string", description: "Source district ID" },
          toDistrictId: { type: "string", description: "Target district ID" },
          label: { type: "string", description: "Human-readable label (English)" },
          direction: {
            type: "string",
            enum: ["one_way", "two_way"],
            description: "Default: one_way",
          },
        },
        required: ["fromDistrictId", "toDistrictId", "label"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_bridge_pipeline_start",
      description:
        "Set or clear the starting district for bridge pipeline execution. Use clear=true to remove the start.",
      parameters: {
        type: "object",
        properties: {
          districtId: {
            type: "string",
            description: "District ID to set as pipeline start (required unless clear is true)",
          },
          clear: {
            type: "boolean",
            description: "If true, clears the pipeline start (no entry district)",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_bridges",
      description:
        "List all district bridges with ids, endpoints, direction, status, and current pipeline start district.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_districts",
      description:
        "List all existing districts with IDs, titles, bee counts, task counts, and waggle status. " +
        "Use to look up district IDs before creating bridges or adding tasks to an existing district.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "approve_pending_tasks",
      description:
        "Move tasks from the pending approval queue to approved so they can run. " +
        "Use when the user confirms they want to approve (e.g. yes, OK, approve, ㅇㅇ, 승인) for jobs listed under Jobs & approvals in context. " +
        "Prefer taskIds from that list; use titleSubstring if the user describes the task by name. " +
        "By default starts the execution queue for approved tasks immediately.",
      parameters: {
        type: "object",
        properties: {
          taskIds: {
            type: "array",
            items: { type: "string" },
            description: "Pending task ids to approve (exact ids from context)",
          },
          approveAllPending: {
            type: "boolean",
            description: "If true, approve every currently pending job",
          },
          titleSubstring: {
            type: "string",
            description: "Approve pending jobs whose title contains this substring (case-insensitive)",
          },
          runQueue: {
            type: "boolean",
            description: "If true (default), run the approved tasks after approving. If false, only approve.",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_tasks",
      description:
        "Start execution for specific tasks that are in waiting state but haven't run yet. " +
        "Use when a specific task exists and the user asks to run, start, execute, or proceed (e.g. '진행해', '실행해', 'run it', 'start'). " +
        "Prefer taskIds for precision. Avoid districtId unless the user explicitly wants ALL tasks in a district to run. " +
        "Do NOT use this to re-run completed tasks or an entire district for follow-up work — use setup_plan to add new tasks instead.",
      parameters: {
        type: "object",
        properties: {
          taskIds: {
            type: "array",
            items: { type: "string" },
            description: "Specific task ids to run",
          },
          districtId: {
            type: "string",
            description: "Run all waiting tasks in this district",
          },
          titleSubstring: {
            type: "string",
            description: "Run tasks whose title contains this substring (case-insensitive)",
          },
        },
        required: [],
      },
    },
  },
];

// ─── System prompt addition for action-capable chat ───

export const CHAT_ACTION_PROMPT_SEGMENT = `
You have ACTION tools available. When the user requests changes (create district, add bees, update settings, create bridges, approve pending jobs, etc.), you MUST use the appropriate tool — do NOT just describe what should be done.

Auto-configuration guidelines:
- needsBrowser: true when the bee must open or interact with live websites (URLs, pages, forms, web apps). False for pasted text only, local/repo-only work, or pure chat.
- needsWaggle: true only when the bee should use the Waggle supervisor (higher-tier reasoning) in addition to browser tools. For simple "open this URL and summarize/extract", use needsBrowser: true and needsWaggle: false and waggleMode "off".
- waggleMode: default "off". Set to "browser" (or "api") only when at least one bee has needsWaggle: true or the user explicitly asks for supervisor/Waggle. Do NOT set waggleMode from needsBrowser alone.
- responseLocale: pass the router intent responseLocale (or infer from the user's language) on every setup_plan so bee output matches the user's language.
- If a bee's mission is purely analytical without visiting sites, needsBrowser is false.
- For programming or repo work, use role "coder" and/or needsCode: true so the code Flower is used.
- Use dependsOnBees to define the execution graph within a district:
  * Analyze task dependencies: if bee B needs output from bee A, set bee B's dependsOnBees to [index of A].
  * Independent tasks (e.g., parallel research on different topics) should have empty dependsOnBees for concurrent execution.
  * Sequential tasks (e.g., research → write → review) should chain dependsOnBees: bee 1 depends on [0], bee 2 depends on [1].
  * Final compilation/review bees should depend on all upstream bee indices.
  * Example: 3 bees where bee 0 and bee 1 are independent, bee 2 needs both → bee 2 has dependsOnBees: [0, 1].
- Tasks still receive earlier outputs via bridge context and {{bridgeOut:taskId}} when dependent tasks complete.
- Prefer the user's language for titles, objective, and missions when it helps the bees; always pass responseLocale for output language.
- When the user doesn't specify a district, create a new one automatically — do NOT ask which district.
- When the user says "new task" or similar without specifying a district, create a new district.
- For follow-ups on the same project (e.g. calculator, same app name), prefer list_districts then setup_plan with targetDistrictId instead of spawning another district.
- Infer reasonable defaults: priority=medium, waggle auto-detected from bee missions.
- When the user mentions Chrome relay, Flower, or code extension, set waggle/flower accordingly.
- When tasks span multiple districts with data dependencies, create bridges between them.
- To clear the bridge pipeline start, call set_bridge_pipeline_start with clear=true.
- When a task already exists and the user asks to run/start/proceed, call run_tasks with specific task id(s). Do NOT respond saying "the task is already active" or "it will proceed automatically" without calling run_tasks — merely describing the state does not trigger execution.
- IMPORTANT: Do NOT re-run an entire district's tasks when the user asks for follow-up work (review, fix, improve, check, 검토, 수정, 확인). Instead, use setup_plan with targetDistrictId to add a NEW bee with the specific follow-up task, then run_tasks with only the NEW task id. Existing completed tasks must not be re-executed unless the user explicitly says "re-run all" or "다시 전부 실행".
- For review/check requests: add a "reviewer" role bee whose mission describes what to review. For fix/improve requests: add a "coder" or appropriate role bee whose mission describes the fix. Always target the existing district via targetDistrictId.
- Never fabricate vague failures such as "system error", "auto-approval did not run", or "task could not be auto-configured" unless the tool return value or explicit runtime context states that exact problem. If you did not invoke a tool, say you did not run workspace actions instead of blaming the system.
- If a tool returns text starting with "Error:" or containing a concrete failure, your reply must reflect that exact information (quote or faithful summary). Do not substitute generic apologies such as "a problem occurred while creating the task" or "try again later" in any language unless the tool output truly says so.
- When the user affirms approval for pending jobs (yes, OK, sure, ㅇㅇ, 승인, etc.), call approve_pending_tasks with taskIds from the Jobs & approvals context or titleSubstring matching the task title. Do not tell the user they must open the web UI to approve if this tool is available.

After executing actions, respond to the user summarizing what was set up, in the user's language.`;

/** Appended to CHAT_ACTION_PROMPT_SEGMENT for Discord inbound when tools are enabled. */
export const DISCORD_INBOUND_CHAT_ACTION_APPEND = `

Discord channel: mirror web Chat workspace control. Chain multiple tools in one turn when the request needs it (e.g. setup_plan, then create_bridge or set_bridge_pipeline_start, then approve_pending_tasks if the user confirms). Use list_districts and list_bridges when you need current ids before mutating.
If setup_plan or another tool failed, tell the user the tool's returned error text — do not invent polite Korean (or other) system-failure messages that omit the real reason.
On follow-up messages, reuse the existing district (targetDistrictId) when the user is clearly continuing the same work — avoid creating a new district every time.`;
