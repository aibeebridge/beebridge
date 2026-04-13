const baseUrl = process.env.beebridge_GATEWAY_URL ?? "http://localhost:4321";
const token = process.env.beebridge_GATEWAY_TOKEN ?? "dev-token";

export async function createJob(goal: string): Promise<void> {
  const response = await fetch(`${baseUrl}/api/intake`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ goal, answers: {} }),
  });

  if (!response.ok) {
    throw new Error(`Job creation failed: ${response.status}`);
  }

  const data = await response.json();
  console.log("[beebridge] Manager has accepted the job.");
  console.log(JSON.stringify(data, null, 2));
}

// Backward compatibility for old command wiring.
export const createProject = createJob;
