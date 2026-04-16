#!/usr/bin/env node
/**
 * Copies the built monorepo into ~/.beebridge so production runs from a fixed home path.
 * Invoked after `npm run build:release` (see package.json).
 *
 * Preserves local-only files already under ~/.beebridge (gateway token, global config)
 * via rsync --exclude. Requires `rsync` (macOS/Linux).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dest = path.join(homedir(), ".beebridge");

const rsyncExcludes = [
  ".git",
  "gateway-token",
  "config.json",
  ".env",
  ".beebridge-daemon",
  ".beebridge-data",
  "node_modules/.cache",
  "apps/web/.next/cache",
];

function main() {
  mkdirSync(dest, { recursive: true });

  const args = [
    "-a",
    "--delete",
    ...rsyncExcludes.flatMap((ex) => ["--exclude", ex]),
    `${path.join(repoRoot, "/")}`,
    `${path.join(dest, "/")}`,
  ];

  try {
    execFileSync("rsync", args, { stdio: "inherit" });
  } catch {
    console.error("[install-home] rsync failed; copying without --delete (fallback).");
    copyTreeFallback(repoRoot, dest, repoRoot);
  }

  console.log(`[install-home] Installed to ${dest}`);
}

/** Skip .git and heavy caches; do not delete extra files in dest (no --delete). */
function shouldSkipEntry(relPosix) {
  if (relPosix === ".git" || relPosix.startsWith(".git/")) return true;
  if (relPosix === "node_modules/.cache" || relPosix.startsWith("node_modules/.cache/"))
    return true;
  if (
    relPosix === "apps/web/.next/cache" ||
    relPosix.startsWith("apps/web/.next/cache/")
  )
    return true;
  return false;
}

function copyTreeFallback(fromRoot, toRoot, base) {
  const names = readdirSync(fromRoot);
  for (const name of names) {
    const from = path.join(fromRoot, name);
    const rel = path.relative(base, from);
    const relPosix = rel.split(path.sep).join("/");
    if (shouldSkipEntry(relPosix)) continue;

    const to = path.join(toRoot, name);
    const st = statSync(from);
    if (st.isDirectory()) {
      mkdirSync(to, { recursive: true });
      copyTreeFallback(from, to, base);
    } else {
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
    }
  }
}

main();
