#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Prefer ~/.beebridge when it contains a full install (package.json + built CLI).
 * Otherwise use this script's directory (e.g. development clone elsewhere).
 * Override anytime with beebridge_HOME.
 */
function resolveRepoRoot() {
  if (process.env.beebridge_HOME) {
    return path.resolve(process.env.beebridge_HOME);
  }
  const homeInstall = path.join(homedir(), ".beebridge");
  const pkg = path.join(homeInstall, "package.json");
  const cli = path.join(homeInstall, "apps/cli/dist/index.js");
  if (existsSync(pkg) && existsSync(cli)) {
    return homeInstall;
  }
  return thisDir;
}

const repoRoot = resolveRepoRoot();
process.env.beebridge_HOME = repoRoot;

const cliDistEntry = path.join(repoRoot, "apps/cli/dist/index.js");

if (!existsSync(cliDistEntry)) {
  console.error(
    "[beebridge] CLI not built yet. Run `npm run build:cli` first.",
  );
  process.exit(1);
}

await import(pathToFileURL(cliDistEntry).href);
