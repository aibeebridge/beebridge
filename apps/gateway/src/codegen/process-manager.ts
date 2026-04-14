import { spawn, type ChildProcess } from "node:child_process";

interface ProcessSession {
  proc: ChildProcess;
  output: string[];
  exitCode: number | null;
  startedAt: number;
  command: string;
}

const MAX_OUTPUT_LINES = 5000;

/** Kill an entire process group so child processes (e.g. esbuild spawned by Vite) are also reaped. */
function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  const pid = proc.pid;
  if (pid == null) { proc.kill(signal); return; }
  try {
    process.kill(-pid, signal);
  } catch {
    try { proc.kill(signal); } catch { /* already dead */ }
  }
}

const activeManagers = new Set<ProcessManager>();

/** Kill all background processes across all active ProcessManager instances (gateway shutdown). */
export function cleanupAllProcessManagers(): number {
  let killed = 0;
  for (const mgr of activeManagers) {
    killed += mgr.activeCount();
    mgr.cleanup();
  }
  return killed;
}

export class ProcessManager {
  private sessions = new Map<string, ProcessSession>();
  private nextId = 1;

  constructor() {
    activeManagers.add(this);
  }

  start(command: string, cwd: string): string {
    const sessionId = `proc-${this.nextId++}`;
    const proc = spawn("/bin/sh", ["-c", command], {
      cwd,
      detached: true,
      env: { ...process.env, HOME: process.env.HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const session: ProcessSession = {
      proc,
      output: [],
      exitCode: null,
      startedAt: Date.now(),
      command,
    };

    const pushLine = (line: string) => {
      session.output.push(line);
      if (session.output.length > MAX_OUTPUT_LINES) {
        session.output.splice(0, session.output.length - MAX_OUTPUT_LINES);
      }
    };

    proc.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        pushLine(`[stdout] ${line}`);
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        pushLine(`[stderr] ${line}`);
      }
    });

    proc.on("exit", (code) => {
      session.exitCode = code ?? -1;
      pushLine(`[exit] code=${code}`);
    });

    proc.on("error", (err) => {
      session.exitCode = -1;
      pushLine(`[error] ${err.message}`);
    });

    this.sessions.set(sessionId, session);
    return sessionId;
  }

  readOutput(sessionId: string, offset = 0): string {
    const session = this.sessions.get(sessionId);
    if (!session) return `Session not found: ${sessionId}`;
    const lines = session.output.slice(offset);
    if (lines.length === 0) return "(no new output)";
    return lines.join("\n").slice(0, 8000);
  }

  kill(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return `Session not found: ${sessionId}`;
    if (session.exitCode !== null) return `Process already exited with code ${session.exitCode}`;
    killProcessTree(session.proc, "SIGTERM");
    setTimeout(() => {
      if (session.exitCode === null) killProcessTree(session.proc, "SIGKILL");
    }, 3000);
    return "Kill signal sent";
  }

  status(sessionId: string): { status: "running" | "exited" | "not_found"; exitCode?: number; command?: string; uptime?: number } {
    const session = this.sessions.get(sessionId);
    if (!session) return { status: "not_found" };
    if (session.exitCode !== null) {
      return { status: "exited", exitCode: session.exitCode, command: session.command };
    }
    return { status: "running", command: session.command, uptime: Date.now() - session.startedAt };
  }

  list(): { sessionId: string; command: string; status: "running" | "exited"; exitCode?: number }[] {
    const result: { sessionId: string; command: string; status: "running" | "exited"; exitCode?: number }[] = [];
    for (const [id, session] of this.sessions) {
      result.push({
        sessionId: id,
        command: session.command,
        status: session.exitCode !== null ? "exited" : "running",
        ...(session.exitCode !== null ? { exitCode: session.exitCode } : {}),
      });
    }
    return result;
  }

  activeCount(): number {
    let n = 0;
    for (const [, s] of this.sessions) { if (s.exitCode === null) n++; }
    return n;
  }

  cleanup(): void {
    for (const [, session] of this.sessions) {
      if (session.exitCode === null) {
        killProcessTree(session.proc, "SIGKILL");
      }
    }
    this.sessions.clear();
    activeManagers.delete(this);
  }
}
