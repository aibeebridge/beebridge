import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson, safeReadJson } from "./safe-fs.js";

const MAX_ENTRIES = 500;
const SAVE_DEBOUNCE_MS = 3_000;

export interface AiHistoryEntry {
  id: string;
  timestamp: string;
  provider: string;
  model: string;
  jobId?: string;
  /** When set, this row belongs to waggle calls tied to tasks in this district (shared pool). */
  districtId?: string;
  beeId?: string;
  action: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  promptPreview: string;
  responsePreview: string;
  status: "success" | "error";
  error?: string;
  /** Tool calls executed during chat (e.g. "setup_plan: OK", "approve_pending_tasks: FAILED"). */
  actions?: string[];
  /** Per-tool detail: name, ok, summary snippet. */
  actionDetails?: { name: string; ok: boolean; summary: string }[];
}

export class AiHistoryStore {
  private entries: AiHistoryEntry[] = [];
  private readonly filePath: string;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataRoot: string) {
    this.filePath = path.join(dataRoot, "ai-history.json");
    this.loadFromDisk();
  }

  record(entry: AiHistoryEntry): void {
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(0, MAX_ENTRIES);
    }
    this.scheduleSave();
  }

  list(): AiHistoryEntry[] {
    return [...this.entries];
  }

  /** Recent waggle Q&A recorded for a district (newest first). Used to share intelligence across bees in the same district. */
  recentWaggleForDistrict(districtId: string, limit: number): AiHistoryEntry[] {
    const waggleActions = new Set([
      "waggle_browser",
      "waggle_browser_cached",
      "waggle_api",
      "waggle_api_cached",
    ]);
    return this.entries.filter(
      (e) => e.districtId === districtId && waggleActions.has(e.action) && e.status === "success",
    ).slice(0, limit > 0 ? limit : 12);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
  }

  stats(): {
    totalCalls: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    totalTokens: number;
    avgDurationMs: number;
    errorCount: number;
    byProvider: Record<string, { calls: number; tokens: number }>;
    byModel: Record<string, { calls: number; tokens: number }>;
  } {
    const byProvider: Record<string, { calls: number; tokens: number }> = {};
    const byModel: Record<string, { calls: number; tokens: number }> = {};
    let totalInput = 0;
    let totalOutput = 0;
    let totalDuration = 0;
    let errorCount = 0;

    for (const entry of this.entries) {
      totalInput += entry.inputTokens;
      totalOutput += entry.outputTokens;
      totalDuration += entry.durationMs;
      if (entry.status === "error") errorCount++;

      if (!byProvider[entry.provider]) byProvider[entry.provider] = { calls: 0, tokens: 0 };
      byProvider[entry.provider].calls++;
      byProvider[entry.provider].tokens += entry.totalTokens;

      if (!byModel[entry.model]) byModel[entry.model] = { calls: 0, tokens: 0 };
      byModel[entry.model].calls++;
      byModel[entry.model].tokens += entry.totalTokens;
    }

    return {
      totalCalls: this.entries.length,
      totalInputTokens: totalInput,
      totalOutputTokens: totalOutput,
      totalTokens: totalInput + totalOutput,
      avgDurationMs: this.entries.length > 0 ? Math.round(totalDuration / this.entries.length) : 0,
      errorCount,
      byProvider,
      byModel,
    };
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, SAVE_DEBOUNCE_MS);
  }

  private saveToDisk(): void {
    try {
      atomicWriteJson(this.filePath, this.entries);
    } catch {
      // best-effort
    }
  }

  private loadFromDisk(): void {
    const data = safeReadJson<unknown[]>(this.filePath, []);
    if (Array.isArray(data)) {
      this.entries = data.slice(0, MAX_ENTRIES) as AiHistoryEntry[];
    }
  }
}
