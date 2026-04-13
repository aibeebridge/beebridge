import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

/** Resolves the beebridge monorepo root (where package.json workspaces live). */
export function resolveBeebridgeRepoRoot(): string {
  if (process.env.beebridge_HOME) {
    return process.env.beebridge_HOME;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  // apps/cli/src/*.ts -> ../../../ = beebridge root
  return path.resolve(here, "../../..");
}
