import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteJson, safeReadJson } from "./safe-fs.js";

const MAX_CHAIN_LENGTH = 10;
const SAVE_DEBOUNCE_MS = 5_000;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 1 week
const MAX_AGENT_STEPS = 20;

const SENSITIVE_KEYS = new Set(["password", "secret", "apiKey", "api_key", "token", "authorization"]);
const SENSITIVE_PARAMS = /[?&](token|key|secret|password|auth)=[^&]*/gi;

// ─── Types ───

export interface ChainEntry {
  id: string;
  pattern: string[];
  args: Record<string, unknown>[];
  result: string;
  score: number;
  tokens: number;
  durationMs: number;
  createdAt: number;
  usedAt: number;
  taskId?: string;
}

export interface ChainKey {
  domain: string;
  intent: string;
}

export interface ChainNode {
  key: ChainKey;
  keyHash: string;
  description: string;
  entries: ChainEntry[];
}

interface ChainSnapshot {
  nodes: ChainNode[];
  stats: { hits: number; misses: number; tokensSaved: number };
}

// ─── Score Calculation ───

export function calculateScore(
  status: "success" | "error",
  steps: number,
  createdAt: number,
): number {
  const successWeight = status === "success" ? 1.0 : 0.0;
  const efficiencyWeight = 1.0 - Math.min(steps / MAX_AGENT_STEPS, 1.0);
  const ageHours = (Date.now() - createdAt) / 3_600_000;
  const recencyWeight = 1.0 - Math.min(ageHours / 168, 1.0);

  return successWeight * 0.4 + efficiencyWeight * 0.3 + recencyWeight * 0.3;
}

export function hashKey(key: ChainKey): string {
  return createHash("md5")
    .update(`${key.domain}::${key.intent}`)
    .digest("hex")
    .slice(0, 16);
}

// ─── Store ───

export class InteractionChainStore {
  private nodes = new Map<string, ChainNode>();
  private hits = 0;
  private misses = 0;
  private tokensSaved = 0;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly chainFile: string;

  constructor(workspaceRoot: string) {
    this.chainFile = path.join(workspaceRoot, "chain-store.json");
    this.loadFromDisk();
  }

  lookup(key: ChainKey, minScore = 0.3): ChainEntry | null {
    const kh = hashKey(key);
    const node = this.nodes.get(kh);
    if (!node || node.entries.length === 0) {
      this.misses++;
      return null;
    }

    this.pruneExpired(node);
    this.refreshNodeScores(node);
    if (node.entries.length === 0) {
      this.misses++;
      return null;
    }

    const best = node.entries[0];
    if (best.score < minScore) {
      this.misses++;
      return null;
    }

    best.usedAt = Date.now();
    this.hits++;
    this.scheduleSave();
    return best;
  }

  lookupByDomain(domain: string, minScore = 0.3): ChainNode[] {
    const result: ChainNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.key.domain !== domain) continue;
      this.pruneExpired(node);
      this.refreshNodeScores(node);
      if (node.entries.length === 0) continue;
      if (node.entries[0].score < minScore) continue;
      result.push(node);
    }
    result.sort((a, b) => b.entries[0].score - a.entries[0].score);
    return result;
  }

  lookupAll(key: ChainKey, minScore = 0.3): ChainEntry[] {
    const kh = hashKey(key);
    const node = this.nodes.get(kh);
    if (!node) return [];
    this.pruneExpired(node);
    this.refreshNodeScores(node);
    return node.entries.filter((e) => e.score >= minScore);
  }

  record(
    key: ChainKey,
    pattern: string[],
    args: Record<string, unknown>[],
    result: string,
    status: "success" | "error",
    tokens: number,
    durationMs: number,
    taskId?: string,
    description?: string,
  ): ChainEntry | null {
    if (status !== "success") return null;

    const kh = hashKey(key);
    let node = this.nodes.get(kh);
    if (!node) {
      node = { key, keyHash: kh, description: description ?? "", entries: [] };
      this.nodes.set(kh, node);
    } else if (description) {
      node.description = description;
    }

    const entry: ChainEntry = {
      id: `chain-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      pattern,
      args: this.sanitizeArgs(args),
      result: result.slice(0, 2000),
      score: calculateScore(status, pattern.length, Date.now()),
      tokens,
      durationMs,
      createdAt: Date.now(),
      usedAt: Date.now(),
      taskId,
    };

    node.entries.push(entry);
    node.entries.sort((a, b) => b.score - a.score);

    if (node.entries.length > MAX_CHAIN_LENGTH) {
      node.entries = node.entries.slice(0, MAX_CHAIN_LENGTH);
    }

    this.scheduleSave();
    return entry;
  }

  invalidate(key: ChainKey): void {
    const kh = hashKey(key);
    this.nodes.delete(kh);
    this.scheduleSave();
  }

  invalidateDomain(domain: string): void {
    const toDelete: string[] = [];
    for (const [kh, node] of this.nodes) {
      if (node.key.domain === domain) toDelete.push(kh);
    }
    for (const kh of toDelete) this.nodes.delete(kh);
    if (toDelete.length > 0) this.scheduleSave();
  }

  recordTokensSaved(tokens: number): void {
    this.tokensSaved += tokens;
  }

  stats(): {
    totalNodes: number;
    totalEntries: number;
    hits: number;
    misses: number;
    hitRate: number;
    tokensSaved: number;
    topPatterns: { domain: string; intent: string; description: string; entryCount: number; bestScore: number }[];
  } {
    const totalEntries = [...this.nodes.values()].reduce(
      (sum, n) => sum + n.entries.length,
      0,
    );
    const totalLookups = this.hits + this.misses;

    for (const node of this.nodes.values()) {
      this.refreshNodeScores(node);
    }

    const topPatterns = [...this.nodes.values()]
      .filter((n) => n.entries.length > 0)
      .sort((a, b) => b.entries[0].score - a.entries[0].score)
      .slice(0, 10)
      .map((n) => ({
        domain: n.key.domain,
        intent: n.key.intent,
        description: n.description,
        entryCount: n.entries.length,
        bestScore: n.entries[0].score,
      }));

    return {
      totalNodes: this.nodes.size,
      totalEntries,
      hits: this.hits,
      misses: this.misses,
      hitRate: totalLookups > 0 ? this.hits / totalLookups : 0,
      tokensSaved: this.tokensSaved,
      topPatterns,
    };
  }

  allNodes(): ChainNode[] {
    return [...this.nodes.values()];
  }

  clear(): void {
    this.nodes.clear();
    this.hits = 0;
    this.misses = 0;
    this.tokensSaved = 0;
    this.scheduleSave();
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveToDisk();
  }

  // ─── Internal ───

  private refreshNodeScores(node: ChainNode): void {
    for (const entry of node.entries) {
      const ageHours = (Date.now() - entry.createdAt) / 3_600_000;
      const recency = 1.0 - Math.min(ageHours / 168, 1.0);
      const efficiency = 1.0 - Math.min(entry.pattern.length / MAX_AGENT_STEPS, 1.0);
      const elapsed = Date.now() - entry.createdAt;
      const useBoost = elapsed > 0
        ? Math.min(((entry.usedAt - entry.createdAt) / elapsed) * 0.1, 0.1)
        : 0;
      entry.score = 0.4 + efficiency * 0.3 + recency * 0.3 + useBoost;
    }
    node.entries.sort((a, b) => b.score - a.score);
  }

  private pruneExpired(node: ChainNode): void {
    const now = Date.now();
    node.entries = node.entries.filter(
      (e) => now - e.usedAt < DEFAULT_TTL_MS,
    );
  }

  private sanitizeArgs(args: Record<string, unknown>[]): Record<string, unknown>[] {
    return args.map((arg) => {
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(arg)) {
        if (SENSITIVE_KEYS.has(k)) {
          cleaned[k] = "[REDACTED]";
          continue;
        }
        if (k === "text" && typeof v === "string" && v.length > 20) {
          cleaned[k] = v.slice(0, 10) + "...";
          continue;
        }
        if (k === "url" && typeof v === "string") {
          cleaned[k] = v.replace(SENSITIVE_PARAMS, "");
          continue;
        }
        cleaned[k] = v;
      }
      return cleaned;
    });
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
      const snapshot: ChainSnapshot = {
        nodes: [...this.nodes.values()],
        stats: { hits: this.hits, misses: this.misses, tokensSaved: this.tokensSaved },
      };
      atomicWriteJson(this.chainFile, snapshot);
    } catch {
      // best-effort
    }
  }

  private loadFromDisk(): void {
    const data = safeReadJson<ChainSnapshot | null>(this.chainFile, null);
    if (!data) return;
    if (Array.isArray(data.nodes)) {
      for (const node of data.nodes) {
        if (!node.description) node.description = "";
        this.nodes.set(node.keyHash, node);
      }
    }
    if (data.stats) {
      this.hits = data.stats.hits || 0;
      this.misses = data.stats.misses || 0;
      this.tokensSaved = data.stats.tokensSaved || 0;
    }
  }
}
