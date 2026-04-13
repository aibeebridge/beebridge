import { spawnSync } from "node:child_process";

/** Best-effort SIGTERM to processes listening on `port` (Unix: lsof + kill). */
export function stopProcessOnPort(port: number): void {
  if (process.platform === "win32") {
    throw new Error("Stopping a process by port is not yet supported on Windows.");
  }

  const lookup = spawnSync("lsof", ["-ti", `tcp:${port}`], {
    encoding: "utf8",
  });

  if (lookup.status !== 0 || !lookup.stdout.trim()) {
    return;
  }

  const pids = lookup.stdout
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  for (const pid of pids) {
    const killResult = spawnSync("kill", ["-TERM", pid], { stdio: "ignore" });
    if (killResult.status !== 0) {
      throw new Error(`Failed to stop process on port ${port} (pid=${pid}).`);
    }
  }
}
