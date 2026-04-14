import fs from "node:fs";
import path from "node:path";

const BUILD_HINT = "Run from the beebridge repo root: npm run build";

export function assertGatewayDistExists(repoRoot: string): void {
  const entry = path.join(repoRoot, "apps/gateway/dist/server/index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Gateway is not built (missing ${path.relative(repoRoot, entry)}). ${BUILD_HINT}`,
    );
  }
}

export function assertWebNextBuildExists(repoRoot: string): void {
  const buildId = path.join(repoRoot, "apps/web/.next/BUILD_ID");
  if (!fs.existsSync(buildId)) {
    throw new Error(
      `Web UI is not built (missing ${path.relative(repoRoot, buildId)}). ${BUILD_HINT}`,
    );
  }
}
