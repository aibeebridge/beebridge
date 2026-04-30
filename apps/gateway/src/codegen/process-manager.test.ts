import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { test } from "node:test";
import { ProcessManager } from "./process-manager.js";
import { setDockerRunnerForTests, type SandboxProcessHandle } from "./sandbox.js";

test("ProcessManager kill handles sandbox-backed sessions", () => {
  const dockerCalls: string[][] = [];
  setDockerRunnerForTests((args) => {
    dockerCalls.push(args);
    return { ok: true, stdout: "", stderr: "" };
  });
  const manager = new ProcessManager("test");
  try {
    const sessionId = manager.start("sleep 30", process.cwd(), {
      spawnCommand: (_command, cwd, id) => {
        const child = spawn("/bin/sh", ["-c", "sleep 30"], {
          cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        }) as ChildProcess & { sandbox?: SandboxProcessHandle };
        child.sandbox = {
          containerName: "beebridge-sbx-test",
          sessionId: id,
          scope: "task",
        };
        return child;
      },
    });

    assert.match(manager.kill(sessionId), /Kill signal sent/);
    assert.deepEqual(dockerCalls[0], ["rm", "-f", "beebridge-sbx-test"]);
    manager.cleanup({ killRunning: true });
  } finally {
    setDockerRunnerForTests(undefined);
  }
});
