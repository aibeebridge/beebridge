import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";

export const CODE_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create or overwrite a file in the project directory. " +
        "Use relative paths from the project root (e.g. 'src/index.ts'). Intermediate directories are created automatically.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative file path from project root (e.g. 'src/index.ts', 'package.json'). " +
              "Must not start with '/' or contain '..'.",
          },
          content: {
            type: "string",
            description: "The full file content to write.",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing a specific string with new content. " +
        "More token-efficient than write_file for small changes. The old_string must appear exactly once in the file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path from project root.",
          },
          old_string: {
            type: "string",
            description: "The exact string to find in the file. Must be unique (appear exactly once).",
          },
          new_string: {
            type: "string",
            description: "The replacement string.",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file in the project directory. Returns the file content as text. " +
        "For large files, use offset and limit to read specific line ranges.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative file path from project root.",
          },
          offset: {
            type: "number",
            description: "Start line number (1-based). Omit to read from the beginning.",
          },
          limit: {
            type: "number",
            description: "Number of lines to read. Omit to read the entire file.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search for a pattern in project files. Returns matching lines with file paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Search pattern (regex supported).",
          },
          path: {
            type: "string",
            description: "Directory or file to search in, relative to project root. Defaults to project root.",
          },
          include: {
            type: "string",
            description: "File glob filter (e.g. '*.ts', '*.py').",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files and directories in the project. Returns names with '/' suffix for directories.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Relative directory path from project root. Omit or use '.' for project root.",
          },
          recursive: {
            type: "boolean",
            description:
              "If true, list all files recursively. Defaults to false (single level).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Execute a shell command in the project directory. " +
        "Use for installing dependencies, running tests, building, etc. " +
        "The working directory is the project root.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute (e.g. 'npm install', 'python main.py').",
          },
          timeout_ms: {
            type: "number",
            description:
              "Maximum execution time in milliseconds. Defaults to 30000 (30 seconds). Max 120000.",
          },
          background: {
            type: "boolean",
            description:
              "If true, run the command in the background and return a session_id immediately. " +
              "Use the 'process' tool to check output, status, or kill the process.",
          },
          persist_after_job: {
            type: "boolean",
            description:
              "Only when background is true: if true, start under a gw- session id directly. " +
              "If false, the server still survives task completion by default; running sessions move to the gateway process list.",
          },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "process",
      description:
        "Manage background processes started with run_command(background=true), including gateway-persisted servers (gw- session ids).",
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["read_output", "kill", "status", "list"],
            description: "Action to perform on the background process.",
          },
          session_id: {
            type: "string",
            description: "The session_id returned by run_command(background=true). Required for read_output, kill, status.",
          },
          offset: {
            type: "number",
            description: "Line offset for read_output (skip first N lines). Defaults to 0.",
          },
        },
        required: ["action"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Call this when the task is complete. Provide a summary of what was implemented.",
      parameters: {
        type: "object",
        properties: {
          result: {
            type: "string",
            description:
              "Summary of the completed implementation: files created, technologies used, how to run.",
          },
        },
        required: ["result"],
      },
    },
  },
];

export const SPAWN_TASK_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "spawn_task",
    description:
      "Spawn a child task that runs as an isolated agent. Use type='code' for coding sub-tasks " +
      "(shares the same project directory) or type='browser' for web research. " +
      "With wait=true (default), blocks until the child finishes and returns the result. " +
      "With wait=false, returns a child_task_id immediately — use check_task to poll. " +
      "Max 3 concurrent children. Children cannot spawn their own children.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description:
            "Description of the work for the child agent to perform.",
        },
        type: {
          type: "string",
          enum: ["code", "browser"],
          description:
            "Execution type. 'code' for coding tasks (file creation, editing, commands). " +
            "'browser' for web research via browser automation. Defaults to 'code'.",
        },
        wait: {
          type: "boolean",
          description:
            "If true (default), block until the child task completes and return its result. " +
            "If false, return the child_task_id immediately for async polling via check_task.",
        },
        timeout_seconds: {
          type: "number",
          description:
            "Max execution time in seconds. Defaults to 300 (5 minutes). Only applies when wait=true.",
        },
        model: {
          type: "string",
          description:
            "Override LLM model for the child task (e.g. 'gpt-4o-mini' for lightweight sub-tasks). Uses parent's model if omitted.",
        },
      },
      required: ["task"],
    },
  },
};

export const CHECK_TASK_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "check_task",
    description:
      "Check status, get results, kill, or list spawned child tasks.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["status", "result", "kill", "list"],
          description:
            "Action: 'status' = check if running/done/failed, 'result' = get output (must be done), " +
            "'kill' = stop a running child, 'list' = show all children.",
        },
        child_task_id: {
          type: "string",
          description:
            "The child_task_id returned by spawn_task. Required for status, result, and kill.",
        },
        wait_seconds: {
          type: "number",
          description:
            "For action='result': wait up to N seconds for the child to finish before returning. Defaults to 0 (return immediately). Max 300.",
        },
      },
      required: ["action"],
    },
  },
};

export const WAGGLE_ASK_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "waggle_ask",
    description:
      "Ask your supervisor (the district's higher-tier channel) for guidance on architecture, design decisions, or implementation strategy. " +
      "Use this when you need help deciding between approaches, are unsure about requirements, or want to validate your plan before coding.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "A concrete question about the implementation: e.g. architecture choice, library selection, or design pattern.",
        },
        context: {
          type: "string",
          description:
            "Include task details, what you have implemented so far, and what specific decision you need help with.",
        },
      },
      required: ["question"],
    },
  },
};
