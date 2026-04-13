import path from "node:path";
import type { FlowerConfig } from "@beebridge/core";
import { atomicWriteJson, safeReadJson } from "./safe-fs.js";

export class FlowerConfigStore {
  private configs = new Map<string, FlowerConfig>();
  private readonly filePath: string;

  constructor(dataRoot: string) {
    this.filePath = path.join(dataRoot, "flowers.json");
    this.loadFromDisk();
  }

  getAll(): FlowerConfig[] {
    return [...this.configs.values()];
  }

  get(id: string): FlowerConfig | undefined {
    return this.configs.get(id);
  }

  set(id: string, config: FlowerConfig): void {
    this.configs.set(id, config);
    this.saveToDisk();
  }

  delete(id: string): boolean {
    const ok = this.configs.delete(id);
    if (ok) this.saveToDisk();
    return ok;
  }

  get size(): number {
    return this.configs.size;
  }

  private saveToDisk(): void {
    try {
      atomicWriteJson(this.filePath, [...this.configs.values()]);
    } catch {
      // best-effort
    }
  }

  private loadFromDisk(): void {
    const arr = safeReadJson<FlowerConfig[]>(this.filePath, []);
    if (!Array.isArray(arr)) return;
    for (const f of arr) {
      if (f.id) this.configs.set(f.id, f);
    }
  }
}
