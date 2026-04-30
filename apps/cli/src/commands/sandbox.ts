import { readPersistedGatewayTokenIfPresent } from "@beebridge/shared/gateway-token-file";

type SandboxContainerInfo = {
  id: string;
  name: string;
  state: string;
  status: string;
  projectId?: string;
  sessionId?: string;
  scope?: string;
  image?: string;
  createdAt?: string;
};

function gatewayBaseUrl(): string {
  return process.env.beebridge_GATEWAY_URL ?? "http://localhost:4321";
}

function gatewayToken(): string {
  return (
    process.env.beebridge_GATEWAY_TOKEN ??
    process.env.GATEWAY_TOKEN ??
    readPersistedGatewayTokenIfPresent() ??
    ""
  );
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${gatewayToken()}`,
    ...extra,
  };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${gatewayBaseUrl()}${path}`, {
    ...init,
    headers: {
      ...authHeaders(init?.body ? { "Content-Type": "application/json" } : undefined),
      ...(init?.headers as Record<string, string> | undefined),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) as T & { error?: string } : {} as T & { error?: string };
  if (!response.ok) {
    throw new Error(data.error ?? `Gateway request failed: HTTP ${response.status}`);
  }
  return data as T;
}

export async function sandboxList(): Promise<void> {
  const data = await request<{ containers: SandboxContainerInfo[] }>("/api/sandbox/containers");
  if (data.containers.length === 0) {
    process.stdout.write("(no sandbox containers)\n");
    return;
  }
  for (const c of data.containers) {
    process.stdout.write(
      [
        c.name,
        `id=${c.id}`,
        `state=${c.state}`,
        `scope=${c.scope ?? "-"}`,
        `session=${c.sessionId ?? "-"}`,
        `project=${c.projectId ?? "-"}`,
        `image=${c.image ?? "-"}`,
      ].join("  ") + "\n",
    );
  }
}

export async function sandboxRemove(target: string): Promise<void> {
  const data = await request<{ message: string }>("/api/sandbox/remove", {
    method: "POST",
    body: JSON.stringify({ target }),
  });
  process.stdout.write(`${data.message}\n`);
}

export async function sandboxKill(sessionId: string): Promise<void> {
  const data = await request<{ message: string }>("/api/sandbox/kill", {
    method: "POST",
    body: JSON.stringify({ sessionId }),
  });
  process.stdout.write(`${data.message}\n`);
}

export async function sandboxCleanup(options: { includeProject?: boolean }): Promise<void> {
  const data = await request<{ removed: SandboxContainerInfo[]; errors: string[] }>("/api/sandbox/cleanup", {
    method: "POST",
    body: JSON.stringify({ includeProject: options.includeProject === true }),
  });
  process.stdout.write(`Removed ${data.removed.length} sandbox container(s).\n`);
  for (const c of data.removed) {
    process.stdout.write(`  ${c.name} (${c.scope ?? "-"})\n`);
  }
  for (const err of data.errors) {
    process.stderr.write(`cleanup failed: ${err}\n`);
  }
}
