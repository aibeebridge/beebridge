import {
  BEEGATEWAY_TOKEN_FILE,
  readPersistedGatewayTokenIfPresent,
} from "@beebridge/shared/gateway-token-file";

export async function showGatewayToken(): Promise<void> {
  const envToken = (process.env.GATEWAY_TOKEN ?? process.env.beebridge_GATEWAY_TOKEN ?? "").trim();
  const fileToken = readPersistedGatewayTokenIfPresent();

  if (envToken) {
    process.stdout.write(`${envToken}\n`);
    process.stdout.write(`  (source: environment variable)\n`);
    return;
  }

  if (fileToken) {
    process.stdout.write(`${fileToken}\n`);
    process.stdout.write(`  (source: ${BEEGATEWAY_TOKEN_FILE})\n`);
    return;
  }

  process.stderr.write(
    `No gateway token found.\n` +
    `Start the gateway once (beebridge gateway start) to auto-generate one,\n` +
    `or set GATEWAY_TOKEN in the environment.\n`,
  );
  process.exitCode = 1;
}
