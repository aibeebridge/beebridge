import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

export type SandboxMode = "off" | "docker";
export type SandboxScope = "project" | "task";

export type SandboxConfig = {
  mode: SandboxMode;
  scope: SandboxScope;
  image: string;
  network: string;
  readOnlyRoot: boolean;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
};

export type CommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  sandboxed: boolean;
};

const DEFAULT_IMAGE = "node:22-bookworm-slim";
let sandboxModeProvider: (() => SandboxMode | undefined) | undefined;

function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function setSandboxModeProvider(provider?: () => SandboxMode | undefined): void {
  sandboxModeProvider = provider;
}

export function resolveSandboxConfig(): SandboxConfig {
  const providedMode = (() => {
    try {
      return sandboxModeProvider?.();
    } catch {
      return undefined;
    }
  })();
  const rawMode = process.env.BEEBRIDGE_SANDBOX_MODE?.trim().toLowerCase();
  const envMode: SandboxMode =
    rawMode === "docker" || envFlag("BEEBRIDGE_SANDBOX") ? "docker" : "off";
  const mode: SandboxMode = providedMode ?? envMode;

  return {
    mode,
    scope: process.env.BEEBRIDGE_SANDBOX_SCOPE?.trim().toLowerCase() === "task" ? "task" : "project",
    image: cleanOptional(process.env.BEEBRIDGE_SANDBOX_IMAGE) ?? DEFAULT_IMAGE,
    network: cleanOptional(process.env.BEEBRIDGE_SANDBOX_NETWORK) ?? "none",
    readOnlyRoot: process.env.BEEBRIDGE_SANDBOX_READ_ONLY_ROOT?.trim() === "0" ? false : true,
    memory: cleanOptional(process.env.BEEBRIDGE_SANDBOX_MEMORY),
    cpus: cleanOptional(process.env.BEEBRIDGE_SANDBOX_CPUS),
    pidsLimit: cleanOptional(process.env.BEEBRIDGE_SANDBOX_PIDS_LIMIT),
  };
}

export function sandboxStatus(): SandboxConfig & { enabled: boolean } {
  const cfg = resolveSandboxConfig();
  return { ...cfg, enabled: cfg.mode !== "off" };
}

function safeDockerName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "project";
}

function containerNameForTask(sessionId: string): string {
  return `beebridge-sbx-${safeDockerName(sessionId)}-${Date.now().toString(36)}`.slice(0, 63);
}

function containerNameForProject(projectId: string, cwd: string): string {
  const key = projectId.trim() || path.basename(path.resolve(cwd)) || "project";
  return `beebridge-sbx-project-${safeDockerName(key)}`.slice(0, 63);
}

function configHash(cfg: SandboxConfig, projectRoot: string): string {
  return createHash("sha256")
    .update(JSON.stringify({
      image: cfg.image,
      network: cfg.network,
      readOnlyRoot: cfg.readOnlyRoot,
      memory: cfg.memory,
      cpus: cfg.cpus,
      pidsLimit: cfg.pidsLimit,
      projectRoot: path.resolve(projectRoot),
    }))
    .digest("hex")
    .slice(0, 16);
}

function buildDockerRunArgs(params: {
  command?: string;
  cwd: string;
  cfg: SandboxConfig;
  backgroundName?: string;
  persistent?: boolean;
  projectId?: string;
}): string[] {
  const projectRoot = path.resolve(params.cwd);
  const args = params.persistent ? ["create"] : ["run", "--rm"];

  if (params.backgroundName) {
    args.push("--name", params.backgroundName, "--init");
  }

  args.push(
    "--workdir",
    "/project",
    "--network",
    params.cfg.network,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--env",
    "HOME=/tmp",
    "--env",
    "BEEBRIDGE_SANDBOX=1",
    "--label",
    `beebridge.project_id=${params.projectId ?? ""}`,
    "--label",
    `beebridge.config_hash=${configHash(params.cfg, projectRoot)}`,
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/var/tmp",
    "--tmpfs",
    "/run",
  );

  if (params.cfg.readOnlyRoot) {
    args.push("--read-only");
  }
  if (params.cfg.memory) {
    args.push("--memory", params.cfg.memory);
  }
  if (params.cfg.cpus) {
    args.push("--cpus", params.cfg.cpus);
  }
  if (params.cfg.pidsLimit) {
    args.push("--pids-limit", params.cfg.pidsLimit);
  }

  args.push("-v", `${projectRoot}:/project:rw`, params.cfg.image, "/bin/sh", "-lc", params.command ?? "sleep infinity");
  return args;
}

function dockerUnavailableMessage(error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") {
    return "Docker sandbox is enabled, but the `docker` command was not found in PATH. Install Docker or set BEEBRIDGE_SANDBOX_MODE=off.";
  }
  return error.message;
}

export function runSandboxedShellCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  projectId?: string,
): Promise<CommandResult> {
  const cfg = resolveSandboxConfig();
  if (cfg.mode === "off") {
    return Promise.reject(new Error("Sandbox is disabled."));
  }

  return new Promise((resolve) => {
    const args =
      cfg.scope === "project"
        ? ["exec", containerNameForProject(projectId ?? "", cwd), "/bin/sh", "-lc", command]
        : buildDockerRunArgs({ command, cwd, cfg, projectId });
    if (cfg.scope === "project") {
      try {
        ensureProjectContainer(cwd, cfg, projectId);
      } catch (error) {
        const nodeError = error as NodeJS.ErrnoException;
        resolve({
          ok: false,
          stdout: "",
          stderr: dockerUnavailableMessage(nodeError),
          sandboxed: true,
        });
        return;
      }
    }
    const child = execFile(
      "docker",
      args,
      {
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const nodeError = error as NodeJS.ErrnoException & { killed?: boolean };
          resolve({
            ok: false,
            stdout: stdout?.toString() ?? "",
            stderr:
              stderr?.toString() ||
              (nodeError.killed ? `Command timed out after ${timeoutMs}ms` : dockerUnavailableMessage(nodeError)),
            sandboxed: true,
          });
          return;
        }
        resolve({
          ok: true,
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? "",
          sandboxed: true,
        });
      },
    );
    child.stdin?.end();
  });
}

export function spawnSandboxedShellCommand(
  command: string,
  cwd: string,
  sessionId: string,
  projectId?: string,
): ChildProcess {
  const cfg = resolveSandboxConfig();
  const args =
    cfg.scope === "project"
      ? ["exec", containerNameForProject(projectId ?? "", cwd), "/bin/sh", "-lc", command]
      : buildDockerRunArgs({ command, cwd, cfg, backgroundName: containerNameForTask(sessionId), projectId });
  if (cfg.scope === "project") {
    ensureProjectContainer(cwd, cfg, projectId);
  }
  return spawn("docker", args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function ensureProjectContainer(cwd: string, cfg: SandboxConfig, projectId?: string): void {
  const name = containerNameForProject(projectId ?? "", cwd);
  const expectedHash = configHash(cfg, cwd);
  try {
    const inspect = execFileSync("docker", ["inspect", name], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    const parsed = JSON.parse(inspect) as Array<{ State?: { Running?: boolean }; Config?: { Labels?: Record<string, string> } }>;
    const info = parsed[0];
    const actualHash = info?.Config?.Labels?.["beebridge.config_hash"];
    if (actualHash && actualHash !== expectedHash) {
      throw new Error(`Sandbox container ${name} exists with stale config. Remove it or set BEEBRIDGE_SANDBOX_SCOPE=task to use throwaway containers.`);
    }
    if (!info?.State?.Running) {
      execFileSync("docker", ["start", name], { stdio: ["ignore", "pipe", "pipe"] });
    }
    return;
  } catch (error) {
    const status = (error as { status?: number }).status;
    const message = error instanceof Error ? error.message : String(error);
    if (status !== 1 && !message.includes("No such object") && !message.includes("No such container")) {
      throw error;
    }
  }

  const createArgs = buildDockerRunArgs({
    cwd,
    cfg,
    backgroundName: name,
    persistent: true,
    projectId,
  });
  execFileSync("docker", createArgs, { stdio: ["ignore", "pipe", "pipe"] });
  execFileSync("docker", ["start", name], { stdio: ["ignore", "pipe", "pipe"] });
}
