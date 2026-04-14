import process from "node:process";

/**
 * Environment for `npm run dev:web` / `next dev`.
 *
 * On low-RAM hosts, an uncapped V8 heap plus gateway + browser can drive the system into heavy
 * swap and make SSH sessions drop. We cap the Next/Node heap unless the user opted out.
 *
 * - BEEBRIDGE_SKIP_NEXT_HEAP_CAP=1 — do not append --max-old-space-size
 * - BEEBRIDGE_NEXT_MAX_OLD_SPACE_MB=<512-8192> — override cap (default 3072)
 * - If NODE_OPTIONS already contains --max-old-space-size, we do not change it
 */
export function envForNextWebDev(port: number): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    NEXT_TELEMETRY_DISABLED: "1",
  };

  if (process.env.BEEBRIDGE_SKIP_NEXT_HEAP_CAP === "1") {
    return base;
  }

  const existing = process.env.NODE_OPTIONS ?? "";
  if (/--max-old-space-size=\d+/.test(existing)) {
    return base;
  }

  const mbRaw = process.env.BEEBRIDGE_NEXT_MAX_OLD_SPACE_MB;
  const mb =
    mbRaw !== undefined && mbRaw !== "" && /^\d+$/.test(mbRaw)
      ? Math.min(Math.max(Number(mbRaw), 512), 8192)
      : 3072;

  const extra = `--max-old-space-size=${mb}`;
  base.NODE_OPTIONS = existing.trim() ? `${existing.trim()} ${extra}` : extra;
  return base;
}
