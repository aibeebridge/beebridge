import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveSandboxConfig, setSandboxModeProvider } from "./sandbox.js";

test("resolveSandboxConfig prefers persisted sandbox mode over env", () => {
  const originalMode = process.env.BEEBRIDGE_SANDBOX_MODE;
  const originalFlag = process.env.BEEBRIDGE_SANDBOX;
  try {
    process.env.BEEBRIDGE_SANDBOX_MODE = "docker";
    process.env.BEEBRIDGE_SANDBOX = "1";

    setSandboxModeProvider(() => "off");
    assert.equal(resolveSandboxConfig().mode, "off");

    setSandboxModeProvider(() => "docker");
    assert.equal(resolveSandboxConfig().mode, "docker");
  } finally {
    setSandboxModeProvider(undefined);
    if (originalMode === undefined) delete process.env.BEEBRIDGE_SANDBOX_MODE;
    else process.env.BEEBRIDGE_SANDBOX_MODE = originalMode;
    if (originalFlag === undefined) delete process.env.BEEBRIDGE_SANDBOX;
    else process.env.BEEBRIDGE_SANDBOX = originalFlag;
  }
});
