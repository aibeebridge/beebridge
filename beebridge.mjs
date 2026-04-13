#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const cliDistEntry = path.join(thisDir, "apps/cli/dist/index.js");
process.env.beebridge_HOME ??= thisDir;

if (!existsSync(cliDistEntry)) {
  console.error(
    "[beebridge] CLI not built yet. Run `npm run build:cli` first.",
  );
  process.exit(1);
}

await import(pathToFileURL(cliDistEntry).href);
