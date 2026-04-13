/**
 * Optional chrome-devtools-mcp (npx) integration — not wired to the task loop.
 * Production browser automation uses the loopback CDP relay + `chrome.debugger` (see `cdp-relay.ts`).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export type McpToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<Record<string, unknown>>;
  isError?: boolean;
};

type McpSession = {
  client: Client;
  transport: StdioClientTransport;
  ready: Promise<void>;
};

type StructuredPage = {
  id: number;
  url?: string;
  selected?: boolean;
};

const DEFAULT_COMMAND = "npx";
const DEFAULT_ARGS = [
  "-y",
  "chrome-devtools-mcp@latest",
  "--autoConnect",
  "--experimentalStructuredContent",
  "--experimental-page-id-routing",
];

let session: McpSession | null = null;
let pendingSession: Promise<McpSession> | null = null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asPages(value: unknown): StructuredPage[] {
  if (!Array.isArray(value)) return [];
  const out: StructuredPage[] = [];
  for (const entry of value) {
    const rec = asRecord(entry);
    if (!rec || typeof rec.id !== "number") continue;
    out.push({
      id: rec.id,
      url: typeof rec.url === "string" ? rec.url : undefined,
      selected: rec.selected === true,
    });
  }
  return out;
}

function extractStructuredContent(result: McpToolResult): Record<string, unknown> {
  return asRecord(result.structuredContent) ?? {};
}

function extractTextContent(result: McpToolResult): string[] {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .map((entry) => {
      const rec = asRecord(entry);
      return rec && typeof rec.text === "string" ? rec.text : "";
    })
    .filter(Boolean);
}

function extractTextPages(result: McpToolResult): StructuredPage[] {
  const pages: StructuredPage[] = [];
  for (const block of extractTextContent(result)) {
    for (const line of block.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+):\s+(.+?)(?:\s+\[(selected)\])?\s*$/i);
      if (!match) continue;
      pages.push({
        id: Number.parseInt(match[1] ?? "", 10),
        url: match[2]?.trim() || undefined,
        selected: Boolean(match[3]),
      });
    }
  }
  return pages;
}

function extractStructuredPages(result: McpToolResult): StructuredPage[] {
  const structured = asPages(extractStructuredContent(result).pages);
  return structured.length > 0 ? structured : extractTextPages(result);
}

function extractErrorMessage(result: McpToolResult, name: string): string {
  const structured = extractStructuredContent(result);
  const message = structured.message;
  if (typeof message === "string" && message.trim()) return message;
  const blocks = extractTextContent(result);
  return blocks.find((b) => b.trim()) ?? `Chrome MCP tool "${name}" failed.`;
}

async function createSession(): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: DEFAULT_COMMAND,
    args: [...DEFAULT_ARGS],
    stderr: "pipe",
  });
  const client = new Client({ name: "beebridge-browser", version: "0.1.0" }, {});

  const ready = (async () => {
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      if (!tools.tools.some((t) => t.name === "list_pages")) {
        throw new Error("Chrome MCP server did not expose list_pages tool.");
      }
    } catch (err) {
      await client.close().catch(() => {});
      throw new Error(
        `Chrome MCP attach failed. Make sure Chrome is running. Details: ${String(err)}`,
      );
    }
  })();

  return { client, transport, ready };
}

async function getSession(): Promise<McpSession> {
  if (session && session.transport.pid === null) {
    session = null;
  }

  if (!session) {
    if (!pendingSession) {
      pendingSession = (async () => {
        const created = await createSession();
        session = created;
        return created;
      })();
    }
    try {
      session = await pendingSession;
    } finally {
      pendingSession = null;
    }
  }

  await session.ready;
  return session;
}

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<McpToolResult> {
  const s = await getSession();
  let result: McpToolResult;
  try {
    result = (await s.client.callTool({ name, arguments: args })) as McpToolResult;
  } catch (err) {
    session = null;
    await s.client.close().catch(() => {});
    throw err;
  }
  if (result.isError) {
    throw new Error(extractErrorMessage(result, name));
  }
  return result;
}

// ─── Public API ───

export async function ensureAvailable(): Promise<void> {
  await getSession();
}

export async function closeMcpSession(): Promise<void> {
  if (session) {
    const s = session;
    session = null;
    await s.client.close().catch(() => {});
  }
}

export async function listPages(): Promise<StructuredPage[]> {
  const result = await callTool("list_pages");
  return extractStructuredPages(result);
}

export async function openTab(url: string): Promise<StructuredPage> {
  const result = await callTool("new_page", { url });
  const pages = extractStructuredPages(result);
  const chosen = pages.find((p) => p.selected) ?? pages.at(-1);
  if (!chosen) throw new Error("Chrome MCP did not return the created page.");
  return chosen;
}

export async function selectPage(pageId: number): Promise<void> {
  await callTool("select_page", { pageId, bringToFront: true });
}

export async function closePage(pageId: number): Promise<void> {
  await callTool("close_page", { pageId });
}

export async function navigatePage(
  pageId: number,
  url: string,
  timeoutMs?: number,
): Promise<void> {
  await callTool("navigate_page", {
    pageId,
    type: "url",
    url,
    ...(typeof timeoutMs === "number" ? { timeout: timeoutMs } : {}),
  });
}

export type SnapshotNode = Record<string, unknown>;

export async function takeSnapshot(pageId: number): Promise<SnapshotNode> {
  const result = await callTool("take_snapshot", { pageId });
  const structured = extractStructuredContent(result);
  const snapshot = asRecord(structured.snapshot);
  if (snapshot) return snapshot;

  const text = extractTextContent(result).join("\n");
  return { type: "text", text };
}

export async function takeScreenshot(
  pageId: number,
  format: "png" | "jpeg" = "png",
): Promise<string> {
  const result = await callTool("take_screenshot", { pageId, format });
  const blocks = extractTextContent(result);
  return blocks.join("\n");
}

export async function clickElement(pageId: number, uid: string): Promise<void> {
  await callTool("click", { pageId, uid });
}

export async function fillElement(pageId: number, uid: string, value: string): Promise<void> {
  await callTool("fill", { pageId, uid, value });
}

export async function pressKey(pageId: number, key: string): Promise<void> {
  await callTool("press_key", { pageId, key });
}

export async function evaluateScript(
  pageId: number,
  fn: string,
  args?: string[],
): Promise<unknown> {
  const result = await callTool("evaluate_script", {
    pageId,
    function: fn,
    ...(args?.length ? { args } : {}),
  });
  const structured = extractStructuredContent(result);
  const message = structured.message;
  if (typeof message === "string" && message.trim()) {
    try {
      const jsonMatch = message.match(/```json\s*([\s\S]*?)\s*```/i);
      const raw = jsonMatch?.[1]?.trim() || message.trim();
      return JSON.parse(raw);
    } catch {
      return message;
    }
  }
  const blocks = extractTextContent(result);
  for (const block of blocks) {
    try {
      const jsonMatch = block.match(/```json\s*([\s\S]*?)\s*```/i);
      const raw = jsonMatch?.[1]?.trim() || block.trim();
      return JSON.parse(raw);
    } catch {
      // continue
    }
  }
  return blocks.join("\n") || null;
}

export async function waitForText(
  pageId: number,
  text: string[],
  timeoutMs?: number,
): Promise<void> {
  await callTool("wait_for", {
    pageId,
    text,
    ...(typeof timeoutMs === "number" ? { timeout: timeoutMs } : {}),
  });
}
