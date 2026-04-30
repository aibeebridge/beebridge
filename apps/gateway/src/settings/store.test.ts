import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { providerCatalog } from "./providers.js";
import { PmSettingsStore } from "./store.js";

test("PmSettingsStore persists sandbox mode", () => {
  const root = mkdtempSync(join(tmpdir(), "beebridge-pm-settings-"));
  try {
    const store = new PmSettingsStore(providerCatalog, root);
    assert.equal(store.getSandboxSettings().mode, "off");

    store.setSandboxMode("docker");
    assert.equal(store.getSandboxSettings().mode, "docker");

    const reloaded = new PmSettingsStore(providerCatalog, root);
    assert.equal(reloaded.getSandboxSettings().mode, "docker");

    const raw = JSON.parse(readFileSync(join(root, "pm-settings.json"), "utf-8")) as {
      sandbox?: { mode?: string };
    };
    assert.equal(raw.sandbox?.mode, "docker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
