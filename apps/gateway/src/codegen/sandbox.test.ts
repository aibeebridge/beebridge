import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDockerRunArgs,
  killSandboxSession,
  parseSandboxInspect,
  removeSandboxContainer,
  resolveSandboxConfig,
  setDockerRunnerForTests,
  setSandboxModeProvider,
} from "./sandbox.js";

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

test("killSandboxSession kills project-scope process when pid file exists", () => {
  const calls: string[][] = [];
  setDockerRunnerForTests((args) => {
    calls.push(args);
    if (args[0] === "ps") {
      return { ok: true, stdout: "project-container\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      return {
        ok: true,
        stdout: JSON.stringify([
          {
            Id: "abcdef1234567890",
            Name: "/project-container",
            State: { Status: "running", Running: true },
            Config: {
              Image: "node:22-bookworm-slim",
              Labels: {
                "beebridge.sandbox": "1",
                "beebridge.scope": "project",
                "beebridge.project_id": "proj-1",
              },
            },
          },
        ]),
        stderr: "",
      };
    }
    if (args[0] === "exec" && args[2] === "test") {
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args[0] === "exec" && args[2] === "/bin/sh") {
      return { ok: true, stdout: "", stderr: "" };
    }
    return { ok: false, stdout: "", stderr: `unexpected docker call: ${args.join(" ")}` };
  });

  try {
    const result = killSandboxSession("proc-1");
    assert.equal(result.killed, true);
    assert.equal(result.containers[0].name, "project-container");
    assert.ok(calls.some((args) => args[0] === "exec" && args[1] === "project-container" && args[2] === "test"));
    assert.ok(calls.some((args) => args[0] === "exec" && args[1] === "project-container" && args[2] === "/bin/sh"));
  } finally {
    setDockerRunnerForTests(undefined);
  }
});

test("removeSandboxContainer removes every container matching a session id and reports failures", () => {
  setDockerRunnerForTests((args) => {
    if (args[0] === "ps") {
      return { ok: true, stdout: "c1\nc2\n", stderr: "" };
    }
    if (args[0] === "inspect") {
      return {
        ok: true,
        stdout: JSON.stringify([
          {
            Id: "111111111111aaaa",
            Name: "/task-one",
            State: { Status: "running", Running: true },
            Config: {
              Labels: {
                "beebridge.sandbox": "1",
                "beebridge.scope": "task",
                "beebridge.session_id": "proc-1",
              },
            },
          },
          {
            Id: "222222222222bbbb",
            Name: "/task-two",
            State: { Status: "running", Running: true },
            Config: {
              Labels: {
                "beebridge.sandbox": "1",
                "beebridge.scope": "task",
                "beebridge.session_id": "proc-1",
              },
            },
          },
        ]),
        stderr: "",
      };
    }
    if (args.join(" ") === "rm -f task-one") {
      return { ok: true, stdout: "", stderr: "" };
    }
    if (args.join(" ") === "rm -f task-two") {
      return { ok: false, stdout: "", stderr: "daemon unavailable" };
    }
    return { ok: false, stdout: "", stderr: `unexpected docker call: ${args.join(" ")}` };
  });

  try {
    const result = removeSandboxContainer("proc-1");
    assert.equal(result.removed, true);
    assert.equal(result.containers?.length, 1);
    assert.deepEqual(result.errors, ["task-two: daemon unavailable"]);
  } finally {
    setDockerRunnerForTests(undefined);
  }
});

test("buildDockerRunArgs labels Beebridge sandbox containers and applies configured user", () => {
  const args = buildDockerRunArgs({
    command: "npm test",
    cwd: "/tmp/project",
    cfg: {
      mode: "docker",
      scope: "task",
      image: "node:22-bookworm-slim",
      network: "none",
      readOnlyRoot: true,
      user: "1000:1000",
    },
    backgroundName: "beebridge-sbx-test",
    projectId: "proj-1",
    sessionId: "proc-1",
  });

  assert.equal(args[0], "run");
  assert.ok(args.includes("--rm"));
  assert.ok(args.includes("--read-only"));
  assert.deepEqual(args.slice(args.indexOf("--user"), args.indexOf("--user") + 2), ["--user", "1000:1000"]);
  assert.ok(args.includes("beebridge.sandbox=1"));
  assert.ok(args.includes("beebridge.project_id=proj-1"));
  assert.ok(args.includes("beebridge.session_id=proc-1"));
  assert.ok(args.includes("beebridge.scope=task"));
});

test("parseSandboxInspect maps Docker inspect output to sandbox container info", () => {
  const containers = parseSandboxInspect([
    {
      Id: "abcdef1234567890",
      Name: "/beebridge-sbx-test",
      State: { Status: "running", Running: true },
      Config: {
        Image: "node:22-bookworm-slim",
        Labels: {
          "beebridge.sandbox": "1",
          "beebridge.project_id": "proj-1",
          "beebridge.session_id": "proc-1",
          "beebridge.scope": "task",
          "beebridge.config_hash": "hash-1",
          "beebridge.created_at": "2026-04-30T00:00:00.000Z",
        },
      },
    },
  ]);

  assert.deepEqual(containers, [
    {
      id: "abcdef123456",
      name: "beebridge-sbx-test",
      state: "running",
      status: "running",
      projectId: "proj-1",
      sessionId: "proc-1",
      scope: "task",
      configHash: "hash-1",
      createdAt: "2026-04-30T00:00:00.000Z",
      image: "node:22-bookworm-slim",
    },
  ]);
});
