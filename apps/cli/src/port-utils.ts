import { spawnSync } from "node:child_process";

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidsListeningOnPort(port: number): string[] {
  const lookup = spawnSync("lsof", ["-ti", `tcp:${port}`], {
    encoding: "utf8",
  });

  if (lookup.status !== 0 || !lookup.stdout.trim()) {
    return [];
  }

  return lookup.stdout
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
}

function signalPids(signal: "-TERM" | "-KILL", pids: string[]): void {
  for (const pid of pids) {
    const killResult = spawnSync("kill", [signal, pid], { stdio: "ignore" });
    if (killResult.status !== 0) continue;
  }
}

function waitForPortToClear(port: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pidsListeningOnPort(port).length === 0) {
      return true;
    }
    sleepMs(100);
  }
  return pidsListeningOnPort(port).length === 0;
}

/** Gracefully stop processes listening on `port`, then wait for the port to be free. */
export function stopProcessOnPort(port: number): void {
  if (process.platform === "win32") {
    throw new Error("Stopping a process by port is not yet supported on Windows.");
  }

  const pids = pidsListeningOnPort(port);
  if (pids.length === 0) {
    return;
  }

  signalPids("-TERM", pids);
  if (waitForPortToClear(port, 3000)) {
    return;
  }

  const remainingPids = pidsListeningOnPort(port);
  if (remainingPids.length > 0) {
    signalPids("-KILL", remainingPids);
  }
  if (!waitForPortToClear(port, 2000)) {
    throw new Error(`Failed to stop process on port ${port}.`);
  }
}
