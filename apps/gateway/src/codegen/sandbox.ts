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
  user?: string;
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

export type SandboxContainerInfo = {
  id: string;
  name: string;
  state: string;
  status: string;
  projectId?: string;
  sessionId?: string;
  scope?: string;
  configHash?: string;
  createdAt?: string;
  image?: string;
};

export type SandboxProcessHandle = {
  containerName: string;
  sessionId: string;
  scope: SandboxScope;
};

type DockerResult = { ok: boolean; stdout: string; stderr: string };
type DockerRunner = (args: string[]) => DockerResult;

const DEFAULT_IMAGE = "node:22-bookworm-slim";
const SANDBOX_LABEL = "beebridge.sandbox";
const SANDBOX_SESSION_LABEL = "beebridge.session_id";
const SANDBOX_PROJECT_LABEL = "beebridge.project_id";
const SANDBOX_SCOPE_LABEL = "beebridge.scope";
const SANDBOX_CONFIG_HASH_LABEL = "beebridge.config_hash";
const SANDBOX_CREATED_AT_LABEL = "beebridge.created_at";
let sandboxModeProvider: (() => SandboxMode | undefined) | undefined;
let dockerRunnerForTests: DockerRunner | undefined;

function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}

function cleanOptional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function defaultDockerUser(): string | undefined {
  if (process.platform !== "linux") return undefined;
  if (typeof process.getuid !== "function" || typeof process.getgid !== "function") return undefined;
  return `${process.getuid()}:${process.getgid()}`;
}

export function setSandboxModeProvider(provider?: () => SandboxMode | undefined): void {
  sandboxModeProvider = provider;
}

export function setDockerRunnerForTests(runner?: DockerRunner): void {
  dockerRunnerForTests = runner;
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
    user: cleanOptional(process.env.BEEBRIDGE_SANDBOX_USER) ?? defaultDockerUser(),
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
      user: cfg.user,
      projectRoot: path.resolve(projectRoot),
    }))
    .digest("hex")
    .slice(0, 16);
}

export function buildDockerRunArgs(params: {
  command?: string;
  cwd: string;
  cfg: SandboxConfig;
  backgroundName?: string;
  persistent?: boolean;
  projectId?: string;
  sessionId?: string;
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
    `${SANDBOX_LABEL}=1`,
    "--label",
    `beebridge.project_id=${params.projectId ?? ""}`,
    "--label",
    `${SANDBOX_SESSION_LABEL}=${params.sessionId ?? ""}`,
    "--label",
    `${SANDBOX_SCOPE_LABEL}=${params.cfg.scope}`,
    "--label",
    `${SANDBOX_CONFIG_HASH_LABEL}=${configHash(params.cfg, projectRoot)}`,
    "--label",
    `${SANDBOX_CREATED_AT_LABEL}=${new Date().toISOString()}`,
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
  if (params.cfg.user) {
    args.push("--user", params.cfg.user);
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
    const foregroundSessionId = `fg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const foregroundContainerName = containerNameForTask(foregroundSessionId);
    const args =
      cfg.scope === "project"
        ? ["exec", containerNameForProject(projectId ?? "", cwd), "/bin/sh", "-lc", command]
        : buildDockerRunArgs({
            command,
            cwd,
            cfg,
            backgroundName: foregroundContainerName,
            projectId,
            sessionId: foregroundSessionId,
          });
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
          if (cfg.scope === "task" && nodeError.killed) {
            runDocker(["rm", "-f", foregroundContainerName]);
          }
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
  const containerName = cfg.scope === "project"
    ? containerNameForProject(projectId ?? "", cwd)
    : containerNameForTask(sessionId);
  const args =
    cfg.scope === "project"
      ? ["exec", containerName, "/bin/sh", "-lc", wrapProjectBackgroundCommand(command, sessionId)]
      : buildDockerRunArgs({ command, cwd, cfg, backgroundName: containerName, projectId, sessionId });
  if (cfg.scope === "project") {
    ensureProjectContainer(cwd, cfg, projectId);
  }
  const child = spawn("docker", args, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  (child as ChildProcess & { sandbox?: SandboxProcessHandle }).sandbox = {
    containerName,
    sessionId,
    scope: cfg.scope,
  };
  return child;
}

function pidFileForSession(sessionId: string): string {
  return `/tmp/beebridge-session-${safeDockerName(sessionId)}.pid`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function wrapProjectBackgroundCommand(command: string, sessionId: string): string {
  const pidFile = pidFileForSession(sessionId);
  const quotedCommand = shellQuote(command);
  return [
    "set -eu",
    "if command -v setsid >/dev/null 2>&1; then",
    `  setsid /bin/sh -lc ${quotedCommand} &`,
    "else",
    `  /bin/sh -lc ${quotedCommand} &`,
    "fi",
    "pid=$!",
    `printf '%s\\n' \"$pid\" > ${shellQuote(pidFile)}`,
    "wait \"$pid\"",
  ].join("\n");
}

function runDocker(args: string[]): DockerResult {
  if (dockerRunnerForTests) return dockerRunnerForTests(args);
  try {
    const stdout = execFileSync("docker", args, { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
    return {
      ok: false,
      stdout: "",
      stderr: typeof err.stderr === "string" ? err.stderr : err.stderr?.toString() || dockerUnavailableMessage(err),
    };
  }
}

export function listSandboxContainers(): SandboxContainerInfo[] {
  const ids = runDocker(["ps", "-a", "-q", "--filter", `label=${SANDBOX_LABEL}=1`]);
  if (!ids.ok) {
    throw new Error(ids.stderr);
  }
  const containerIds = ids.stdout.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  if (containerIds.length === 0) return [];

  const inspect = runDocker(["inspect", ...containerIds]);
  if (!inspect.ok) {
    throw new Error(inspect.stderr);
  }
  const parsed = JSON.parse(inspect.stdout) as Array<{
    Id?: string;
    Name?: string;
    State?: { Status?: string; Running?: boolean };
    Config?: { Image?: string; Labels?: Record<string, string> };
  }>;
  return parseSandboxInspect(parsed);
}

export function parseSandboxInspect(parsed: Array<{
  Id?: string;
  Name?: string;
  State?: { Status?: string; Running?: boolean };
  Config?: { Image?: string; Labels?: Record<string, string> };
}>): SandboxContainerInfo[] {
  return parsed.map((c) => {
    const labels = c.Config?.Labels ?? {};
    return {
      id: (c.Id ?? "").slice(0, 12),
      name: (c.Name ?? "").replace(/^\//, ""),
      state: c.State?.Status ?? (c.State?.Running ? "running" : "unknown"),
      status: c.State?.Status ?? "unknown",
      projectId: labels[SANDBOX_PROJECT_LABEL] || undefined,
      sessionId: labels[SANDBOX_SESSION_LABEL] || undefined,
      scope: labels[SANDBOX_SCOPE_LABEL] || undefined,
      configHash: labels[SANDBOX_CONFIG_HASH_LABEL] || undefined,
      createdAt: labels[SANDBOX_CREATED_AT_LABEL] || undefined,
      image: c.Config?.Image,
    };
  });
}

function projectContainerHasSession(containerName: string, sessionId: string): boolean {
  const result = runDocker(["exec", containerName, "test", "-f", pidFileForSession(sessionId)]);
  return result.ok;
}

function findSandboxContainers(containerOrSession: string): SandboxContainerInfo[] {
  const needle = containerOrSession.trim();
  if (!needle) return [];
  const containers = listSandboxContainers();
  const direct = containers.filter((c) =>
    c.name === needle ||
    c.id === needle ||
    c.id.startsWith(needle)
  );
  if (direct.length > 0) return direct;

  const byLabel = containers.filter((c) => c.sessionId === needle);
  const byProjectPidFile = containers.filter((c) =>
    c.scope === "project" &&
    !c.sessionId &&
    projectContainerHasSession(c.name, needle)
  );
  return [...byLabel, ...byProjectPidFile];
}

export function removeSandboxContainer(containerOrSession: string): { removed: boolean; container?: SandboxContainerInfo; containers?: SandboxContainerInfo[]; message: string; errors?: string[] } {
  const containers = findSandboxContainers(containerOrSession);
  if (containers.length === 0) {
    return { removed: false, message: `Sandbox container not found: ${containerOrSession}` };
  }
  const removed: SandboxContainerInfo[] = [];
  const errors: string[] = [];
  for (const container of containers) {
    const result = runDocker(["rm", "-f", container.name]);
    if (result.ok) removed.push(container);
    else errors.push(`${container.name}: ${result.stderr}`);
  }
  if (errors.length > 0) {
    return {
      removed: removed.length > 0,
      container: removed[0] ?? containers[0],
      containers: removed,
      message: `Removed ${removed.length}/${containers.length} sandbox container(s).`,
      errors,
    };
  }
  return {
    removed: true,
    container: removed[0],
    containers: removed,
    message: removed.length === 1
      ? `Removed sandbox container ${removed[0].name}`
      : `Removed ${removed.length} sandbox containers`,
  };
}

export function killSandboxSession(sessionId: string): { killed: boolean; containers: SandboxContainerInfo[]; message: string; errors?: string[] } {
  const containers = findSandboxContainers(sessionId);
  if (containers.length === 0) {
    return { killed: false, containers: [], message: `Sandbox session not found: ${sessionId}` };
  }
  const killed: SandboxContainerInfo[] = [];
  const errors: string[] = [];
  for (const container of containers) {
    if (container.scope === "project") {
      killSandboxProcess({ containerName: container.name, sessionId, scope: "project" });
      killed.push(container);
      continue;
    }
    const result = runDocker(["rm", "-f", container.name]);
    if (result.ok) killed.push(container);
    else errors.push(`${container.name}: ${result.stderr}`);
  }
  return {
    killed: killed.length > 0,
    containers: killed,
    message: errors.length > 0
      ? `Killed ${killed.length}/${containers.length} sandbox container(s) for session ${sessionId}: ${errors.join("; ")}`
      : `Killed sandbox session ${sessionId}`,
    ...(errors.length > 0 ? { errors } : {}),
  };
}

export function killSandboxProcess(handle: SandboxProcessHandle): void {
  if (handle.scope === "task") {
    runDocker(["rm", "-f", handle.containerName]);
    return;
  }
  const pidFile = pidFileForSession(handle.sessionId);
  const script = [
    `pid="$(cat ${shellQuote(pidFile)} 2>/dev/null || true)"`,
    "if [ -n \"$pid\" ]; then",
    "  kill -TERM -$pid 2>/dev/null || kill -TERM $pid 2>/dev/null || true",
    "  sleep 0.2",
    "  kill -KILL -$pid 2>/dev/null || kill -KILL $pid 2>/dev/null || true",
    "fi",
    `rm -f ${shellQuote(pidFile)}`,
  ].join("\n");
  runDocker(["exec", handle.containerName, "/bin/sh", "-lc", script]);
}

export function cleanupSandboxContainers(options?: { includeProject?: boolean }): { removed: SandboxContainerInfo[]; errors: string[] } {
  const includeProject = options?.includeProject === true;
  const removed: SandboxContainerInfo[] = [];
  const errors: string[] = [];
  for (const container of listSandboxContainers()) {
    if (!includeProject && container.scope === "project") continue;
    const result = runDocker(["rm", "-f", container.name]);
    if (result.ok) removed.push(container);
    else errors.push(`${container.name}: ${result.stderr}`);
  }
  return { removed, errors };
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
