import { randomUUID } from "node:crypto";
import type { ConversationEntry, TaskConversation } from "@beebridge/shared";

const MAX_ARCHIVES_PER_TASK = 50;
const MAX_ENTRIES_PER_CONVERSATION = 500;

function cloneTaskConversation(c: TaskConversation): TaskConversation {
  return {
    taskId: c.taskId,
    jobId: c.jobId,
    beeId: c.beeId,
    entries: c.entries.map((e) => ({ ...e })),
    status: c.status,
    startedAt: c.startedAt,
    finishedAt: c.finishedAt,
    sessionId: c.sessionId,
  };
}

export class JobStore {
  private conversations = new Map<string, TaskConversation>();
  /** Past runs per task, newest first */
  private archives = new Map<string, TaskConversation[]>();
  private listeners = new Set<(taskId: string, conversation: TaskConversation) => void>();

  private pushArchive(taskId: string, conv: TaskConversation): void {
    if (conv.entries.length === 0) return;
    const snapshot = cloneTaskConversation(conv);
    snapshot.sessionId = snapshot.sessionId ?? `sess-${randomUUID().slice(0, 12)}`;
    const list = this.archives.get(taskId) ?? [];
    list.unshift(snapshot);
    if (list.length > MAX_ARCHIVES_PER_TASK) list.length = MAX_ARCHIVES_PER_TASK;
    this.archives.set(taskId, list);
  }

  start(taskId: string, beeId: string): TaskConversation {
    const existing = this.conversations.get(taskId);
    if (existing && (existing.status === "done" || existing.status === "failed")) {
      this.pushArchive(taskId, existing);
    }

    const conv: TaskConversation = {
      taskId,
      jobId: taskId,
      beeId,
      entries: [],
      status: "running",
      startedAt: new Date().toISOString(),
    };
    this.conversations.set(taskId, conv);
    this.notify(taskId, conv);
    return conv;
  }

  addEntry(taskId: string, entry: ConversationEntry): void {
    const conv = this.conversations.get(taskId);
    if (!conv) return;
    conv.entries.push(entry);
    if (conv.entries.length > MAX_ENTRIES_PER_CONVERSATION) {
      conv.entries = conv.entries.slice(-MAX_ENTRIES_PER_CONVERSATION);
    }
    this.notify(taskId, conv);
  }

  complete(taskId: string, result: string): TaskConversation | undefined {
    const conv = this.conversations.get(taskId);
    if (!conv) return undefined;
    conv.status = "done";
    conv.finishedAt = new Date().toISOString();
    conv.entries.push({
      role: "system",
      action: "done",
      content: result,
      timestamp: new Date().toISOString(),
      source: "Gateway",
    });
    this.notify(taskId, conv);
    return conv;
  }

  fail(taskId: string, error: string): TaskConversation | undefined {
    const conv = this.conversations.get(taskId);
    if (!conv) return undefined;
    conv.status = "failed";
    conv.finishedAt = new Date().toISOString();
    conv.entries.push({
      role: "system",
      action: "error",
      content: error,
      timestamp: new Date().toISOString(),
      source: "Gateway",
    });
    this.notify(taskId, conv);
    return conv;
  }

  reset(taskId: string): void {
    const existing = this.conversations.get(taskId);
    if (existing && existing.entries.length > 0) {
      this.pushArchive(taskId, existing);
    }
    this.conversations.delete(taskId);
  }

  get(taskId: string): TaskConversation | undefined {
    return this.conversations.get(taskId);
  }

  listHistory(taskId: string): TaskConversation[] {
    return [...(this.archives.get(taskId) ?? [])];
  }

  /** Remove current + all stored history (task deleted from workspace). */
  purgeTaskConversations(taskId: string): void {
    this.conversations.delete(taskId);
    this.archives.delete(taskId);
  }

  listAll(): TaskConversation[] {
    return [...this.conversations.values()];
  }

  replaceAll(conversations: TaskConversation[]): void {
    this.conversations = new Map(conversations.map((conv) => [conv.taskId, conv]));
  }

  /** Persisted past sessions (newest first per task). */
  exportArchives(): Record<string, TaskConversation[]> {
    return Object.fromEntries(this.archives);
  }

  replaceArchives(raw: Record<string, TaskConversation[] | undefined> | null | undefined): void {
    this.archives = new Map();
    if (!raw || typeof raw !== "object") return;
    for (const [taskId, list] of Object.entries(raw)) {
      if (!Array.isArray(list)) continue;
      const normalized = list.map((c, i) => {
        const copy = cloneTaskConversation(c);
        copy.sessionId =
          copy.sessionId ?? `sess-legacy-${taskId}-${i}-${String(copy.startedAt).replace(/[:.]/g, "-")}`;
        return copy;
      });
      this.archives.set(taskId, normalized);
    }
  }

  onChange(listener: (taskId: string, conversation: TaskConversation) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(taskId: string, conv: TaskConversation) {
    for (const listener of this.listeners) {
      listener(taskId, conv);
    }
  }
}
