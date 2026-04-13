import type { ChatCompletionTool } from "openai/resources/chat/completions.mjs";

export const BROWSER_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "navigate",
      description:
        "Navigate the browser to a URL. Use this to open a website.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "Full URL to navigate to" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click",
      description:
        "Click an element on the page identified by its uid from the snapshot.",
      parameters: {
        type: "object",
        properties: {
          uid: {
            type: "string",
            description: "The uid number from the page snapshot (e.g. '3')",
          },
        },
        required: ["uid"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fill",
      description:
        "Clear a text field and type new text into it, identified by uid from the snapshot.",
      parameters: {
        type: "object",
        properties: {
          uid: {
            type: "string",
            description: "The uid number from the page snapshot",
          },
          text: { type: "string", description: "Text to fill into the field" },
        },
        required: ["uid", "text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "snapshot",
      description:
        "Take a snapshot of the current page to see its interactive elements and content. " +
        "Always call this after navigate or click to observe the result.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "scroll",
      description: "Scroll the page up or down.",
      parameters: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down"],
            description: "Scroll direction",
          },
        },
        required: ["direction"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_text",
      description:
        "Read the full text content of the page or a specific element.",
      parameters: {
        type: "object",
        properties: {
          selector: {
            type: "string",
            description:
              "Optional CSS selector. Omit to read the entire page body text.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "wait",
      description: "Wait for a specified duration in milliseconds.",
      parameters: {
        type: "object",
        properties: {
          ms: {
            type: "number",
            description: "Milliseconds to wait (default 1000)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "done",
      description:
        "Call this when the task is complete. Provide a summary of what was accomplished.",
      parameters: {
        type: "object",
        properties: {
          result: {
            type: "string",
            description: "Summary of the completed task and any results found",
          },
        },
        required: ["result"],
      },
    },
  },
];

export const WAGGLE_ASK_TOOL: ChatCompletionTool = {
  type: "function",
  function: {
    name: "waggle_ask",
    description:
      "Ask your supervisor (the district's higher-tier channel: browser web AI or API). You are the browser executor; do not plan major steps alone. " +
      "Use waggle_ask to get an approach and concrete next steps, to recover from failures, and whenever you are unsure. " +
      "The harness requires at least one successful waggle_ask before browser tools unlock and before you may call done.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "A concrete question for the supervisor: e.g. how to approach this task, what to do next, or how to fix an error.",
        },
        context: {
          type: "string",
          description:
            "Always include enough for the supervisor to advise without seeing the browser: task title, full task description, district objective if known. " +
            "Add current URL or page summary, actions tried, and errors when you are mid-task.",
        },
      },
      required: ["question"],
    },
  },
};
