import { readPersistedGatewayTokenIfPresent } from "@beebridge/shared/gateway-token-file";

const baseUrl = process.env.beebridge_GATEWAY_URL ?? "http://localhost:4321";
const token =
  process.env.beebridge_GATEWAY_TOKEN ??
  process.env.GATEWAY_TOKEN ??
  readPersistedGatewayTokenIfPresent() ??
  "";

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

export async function managerPlan(goal: string, deadline?: string, priority?: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/plan`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ goal, deadline, priority }),
  });

  if (!response.ok) {
    throw new Error(`Manager plan creation failed: ${response.status}`);
  }

  const data = await response.json();
  console.log("[beebridge] Manager plan result");
  console.log(JSON.stringify(data, null, 2));
}

export async function runBeeQueue(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/queue/run`, {
    method: "POST",
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Bee queue execution failed: ${response.status}`);
  }

  const data = await response.json();
  console.log("[beebridge] Approved bee job execution result");
  console.log(JSON.stringify(data, null, 2));
}

export async function flowerStatus(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/flowers`, {
    method: "GET",
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Flower status query failed: ${response.status}`);
  }

  const data = await response.json();
  console.log("[beebridge] Flower status");
  console.log(JSON.stringify(data, null, 2));
}

export async function listBeeApprovals(): Promise<void> {
  const response = await fetch(`${baseUrl}/api/approvals`, {
    method: "GET",
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Approval list query failed: ${response.status}`);
  }

  const data = await response.json();
  console.log("[beebridge] Bee pending approvals");
  console.log(JSON.stringify(data, null, 2));
}

export async function approveBeeJob(jobId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/approvals/${jobId}/approve`, {
    method: "POST",
    headers: authHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Approval failed: ${response.status}`);
  }

  const data = await response.json();
  console.log("[beebridge] Bee job approved");
  console.log(JSON.stringify(data, null, 2));
}

// Backward compatibility for existing command aliases.
export const planTask = managerPlan;
export const runApproved = runBeeQueue;
