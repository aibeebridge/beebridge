import { spawn, type ChildProcess } from "node:child_process";
import { killSandboxProcess, type SandboxProcessHandle } from "./sandbox.js";

interface ProcessSession {
  proc: ChildProcess;
  sandbox?: SandboxProcessHandle;
  output: string[];
  exitCode: number | null;
  startedAt: number;
  command: string;
}

const MAX_OUTPUT_LINES = 5000;

type SpawnCommand = (command: string, cwd: string, sessionId: string) => ChildProcess;

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

/** Monotonic ids so session_id stays unique across tasks after running sessions are adopted into the gateway store. */
let globalBackgroundSessionSeq = 1;

/** Kill all background processes across all active ProcessManager instances (gateway shutdown). */
export function cleanupAllProcessManagers(): number {
  let killed = 0;
  const snapshot = [...activeManagers];
  for (const mgr of snapshot) {
    killed += mgr.activeCount();
    mgr.cleanup({ killRunning: true });
  }
  return killed;
}

export class ProcessManager {
  private sessions = new Map<string, ProcessSession>();

  constructor(private readonly sessionIdPrefix = "proc") {
    activeManagers.add(this);
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Move a running session into this manager (used when a task ends without killing servers). */
  adoptSession(sessionId: string, session: ProcessSession): void {
    this.sessions.set(sessionId, session);
  }

  start(command: string, cwd: string, options?: { spawnCommand?: SpawnCommand }): string {
    const sessionId = `${this.sessionIdPrefix}-${globalBackgroundSessionSeq++}`;
    let proc: ChildProcess;
    try {
      proc = options?.spawnCommand
        ? options.spawnCommand(command, cwd, sessionId)
        : spawn("/bin/sh", ["-c", command], {
            cwd,
            detached: true,
            env: { ...process.env, HOME: process.env.HOME },
            stdio: ["ignore", "pipe", "pipe"],
          });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      proc = spawn("/bin/sh", ["-c", `printf '%s\\n' ${JSON.stringify(message)} >&2; exit 1`], {
        cwd,
        detached: true,
        env: { ...process.env, HOME: process.env.HOME },
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    const session: ProcessSession = {
      proc,
      sandbox: (proc as ChildProcess & { sandbox?: SandboxProcessHandle }).sandbox,
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
    if (session.sandbox) {
      killSandboxProcess(session.sandbox);
    }
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

  /**
   * @param options.killRunning — default false: do not SIGKILL running children (e.g. dev servers).
   *   Running sessions are handed off to `gatewayPersistentBackgroundProcesses` so `process()` keeps working.
   *   Use true only for gateway shutdown (see cleanupAllProcessManagers).
   */
  cleanup(options?: { killRunning?: boolean }): void {
    const killRunning = options?.killRunning === true;
    if (killRunning) {
      for (const [, session] of this.sessions) {
        if (session.exitCode === null) {
          if (session.sandbox) {
            killSandboxProcess(session.sandbox);
          }
          killProcessTree(session.proc, "SIGKILL");
        }
      }
      this.sessions.clear();
      activeManagers.delete(this);
      return;
    }

    for (const [id, session] of [...this.sessions]) {
      if (session.exitCode === null) {
        try {
          session.proc.unref();
        } catch {
          /* ignore */
        }
        if (this !== gatewayPersistentBackgroundProcesses) {
          gatewayPersistentBackgroundProcesses.adoptSession(id, session);
        }
      }
    }
    this.sessions.clear();
    activeManagers.delete(this);
  }
}

/**
 * Long-lived background commands (e.g. dev servers) started with run_command(..., persist_after_job=true).
 * Survives individual code-task completion; cleared on gateway shutdown via cleanupAllProcessManagers().
 */
export const gatewayPersistentBackgroundProcesses = new ProcessManager("gw");
