#!/usr/bin/env node
/**
 * Installed as `beebridge` in node_modules/.bin — delegates to repo-root launcher
 * so `beebridge_HOME` and the built-CLI check stay in one place.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const cliDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(cliDir, "../..");
await import(pathToFileURL(path.join(root, "beebridge.mjs")).href);
