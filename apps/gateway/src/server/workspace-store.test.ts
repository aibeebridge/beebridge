import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { WorkspaceStore, type BridgeTemplateRecord } from "./workspace-store.js";

test("WorkspaceStore saves and loads bridge templates", () => {
  const root = mkdtempSync(join(tmpdir(), "beebridge-workspace-store-"));
  try {
    const store = new WorkspaceStore(root);
    const template: BridgeTemplateRecord = {
      id: "template-test",
      name: "Test template",
      createdAt: "2026-04-28T00:00:00.000Z",
      updatedAt: "2026-04-28T00:00:00.000Z",
      payload: {
        format: "beebridge.bridge-template.v1",
        districts: [],
        bridges: [],
      },
    };

    store.saveBridgeTemplates([template]);

    assert.deepEqual(store.loadBridgeTemplates(), [template]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
