#!/usr/bin/env node
import { Command } from "commander";
import { launchTerminalGui } from "./tui/terminal-gui.js";
import { createJob } from "./commands/project.js";
import { runOnboard } from "./commands/onboard.js";
import {
  approveBeeJob,
  flowerStatus,
  listBeeApprovals,
  managerPlan,
  runBeeQueue,
} from "./commands/task.js";
import {
  managerAuthActivate,
  managerAuthAdd,
  managerAuthLogin,
  managerAuthRemove,
  managerModelSet,
  managerProvidersList,
  managerSettingsShow,
} from "./commands/manager-settings.js";
import { restartGatewayUi, startGatewayUi } from "./commands/gateway.js";
import { stopBeebridgeServers } from "./commands/stop.js";
import { openSettingsUi, restartWebUi, startWebUi } from "./commands/web.js";

const program = new Command();
program.name("beebridge").description("beebridge CLI").version("0.1.0");

if (process.argv.length <= 2) {
  await launchTerminalGui();
  process.exit(0);
}

program
  .command("onboard")
  .description("Interactive first-time setup (PM auth, model, runtime)")
  .option("--install-daemon", "Include daemon install step during onboarding")
  .option("-y, --yes", "Run non-interactive with defaults")
  .action(async ({ installDaemon, yes }) => {
    await runOnboard({ installDaemon, yes });
  });

const job = program.command("job").description("Jobs to assign to the manager");
job
  .command("create")
  .requiredOption("-g, --goal <goal>", "job description")
  .action(async ({ goal }) => {
    await createJob(goal);
  });

const manager = program.command("manager").description("Project manager AI controls");
manager
  .command("plan")
  .requiredOption("-g, --goal <goal>", "task goal")
  .option("-d, --deadline <deadline>", "deadline")
  .option("-p, --priority <priority>", "priority")
  .action(async ({ goal, deadline, priority }) => {
    await managerPlan(goal, deadline, priority);
  });

manager.command("ask").requiredOption("-g, --goal <goal>", "job description").action(async ({ goal }) => {
  await createJob(goal);
});
manager.command("settings").action(async () => {
  await managerSettingsShow();
});
manager
  .command("setup")
  .option(
    "--tab <tab>",
    "connection|auth|model|workspace|status",
    "connection",
  )
  .option("--port <port>", "web server port (default: 3000)")
  .option("--no-open", "do not open browser automatically")
  .option("--dev", "run Next.js dev server (tsx / next dev) instead of production build")
  .action(async ({ tab, port, open, dev }) => {
    await openSettingsUi({ tab, port, open, dev });
  });

const managerAuth = manager.command("auth").description("PM auth profile settings");
managerAuth
  .command("add")
  .requiredOption("--provider <provider>", "provider id")
  .requiredOption("--mode <mode>", "api_key or oauth")
  .requiredOption("--secret <secret>", "API key or OAuth token")
  .option("--label <label>", "profile label")
  .action(async ({ provider, mode, secret, label }) => {
    if (mode !== "api_key" && mode !== "oauth") {
      throw new Error("mode must be api_key or oauth.");
    }
    await managerAuthAdd({ provider, mode, secret, label });
  });
managerAuth
  .command("login")
  .requiredOption("--provider <provider>", "provider id (e.g. github-copilot)")
  .option("--label <label>", "profile label")
  .option("--no-open", "do not open browser automatically")
  .action(async ({ provider, label, open }) => {
    await managerAuthLogin({ provider, label, open });
  });
managerAuth
  .command("activate")
  .requiredOption("--profile <profileId>", "profile id to activate")
  .action(async ({ profile }) => {
    await managerAuthActivate(profile);
  });
managerAuth
  .command("remove")
  .requiredOption("--profile <profileId>", "profile id to remove")
  .action(async ({ profile }) => {
    await managerAuthRemove(profile);
  });

const managerModel = manager.command("model").description("PM model policy settings");
managerModel.command("providers").action(async () => {
  await managerProvidersList();
});
managerModel
  .command("set")
  .requiredOption("--provider <provider>", "default provider id")
  .requiredOption("--model <model>", "default model")
  .option("--allow <models>", "allowed models (comma-separated)")
  .option("--fallback <model>", "fallback model")
  .action(async ({ provider, model, allow, fallback }) => {
    await managerModelSet({ provider, model, allow, fallback });
  });

const bee = program.command("bee").description("Bee worker controls");
bee.command("run").action(async () => {
  await runBeeQueue();
});
bee.command("approvals").action(async () => {
  await listBeeApprovals();
});
bee.command("approve").requiredOption("-j, --job <jobId>", "job id to approve").action(async ({ job }) => {
  await approveBeeJob(job);
});

const flower = program.command("flower").description("Flower (integration target) status");
flower.command("status").action(async () => {
  await flowerStatus();
});

program
  .command("stop")
  .description("Stop gateway and web UI servers (SIGTERM processes listening on their ports)")
  .option("--gateway-port <port>", "gateway port (default: 4321)")
  .option("--web-port <port>", "web UI port (default: 3000)")
  .action((opts) => {
    try {
      stopBeebridgeServers({ gatewayPort: opts.gatewayPort, webPort: opts.webPort });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exit(1);
    }
  });

const gateway = program.command("gateway").description("Gateway API / WebSocket server");
gateway
  .command("start")
  .option("--port <port>", "gateway port (default: 4321, or PORT env)")
  .option("-d, --daemon", "run in background; logs under .beebridge-daemon/")
  .option("--dev", "run gateway from TypeScript via tsx (development)")
  .action(async ({ port, daemon, dev }) => {
    await startGatewayUi({ port, daemon, dev });
  });

gateway
  .command("restart")
  .option("--port <port>", "gateway port (default: 4321, or PORT env)")
  .option("-d, --daemon", "run in background; logs under .beebridge-daemon/")
  .option("--dev", "run gateway from TypeScript via tsx (development)")
  .action(async ({ port, daemon, dev }) => {
    await restartGatewayUi({ port, daemon, dev });
  });

gateway.command("token").description("Show current gateway auth token").action(async () => {
  const { showGatewayToken } = await import("./commands/gateway-token.js");
  await showGatewayToken();
});

const web = program.command("web").description("Web UI (Next.js dashboard)");
web
  .command("start")
  .option("-o, --open", "open browser automatically")
  .option("--port <port>", "web server port (default: 3000)")
  .option("-d, --daemon", "run in background; logs under .beebridge-daemon/")
  .option("--dev", "run next dev instead of production (next start)")
  .action(async ({ open, port, daemon, dev }) => {
    await startWebUi({ open, port, daemon, dev });
  });

web
  .command("restart")
  .option("-o, --open", "open browser automatically")
  .option("--port <port>", "web server port (default: 3000)")
  .option("-d, --daemon", "run in background; logs under .beebridge-daemon/")
  .option("--dev", "run next dev instead of production (next start)")
  .action(async ({ open, port, daemon, dev }) => {
    await restartWebUi({ open, port, daemon, dev });
  });

web
  .command("settings")
  .option(
    "--tab <tab>",
    "connection|auth|model|workspace|status",
    "connection",
  )
  .option("--port <port>", "web server port (default: 3000)")
  .option("--no-open", "do not open browser automatically")
  .option("--dev", "run Next.js dev server instead of production build")
  .action(async ({ tab, port, open, dev }) => {
    await openSettingsUi({ tab, port, open, dev });
  });

program.command("tui").description("Launch keyboard-driven terminal GUI").action(async () => {
  await launchTerminalGui();
});

// Legacy aliases kept for older usage.
const project = program.command("project").description("legacy alias");
project.command("create").requiredOption("-g, --goal <goal>", "project goal").action(async ({ goal }) => {
  await createJob(goal);
});

const task = program.command("task").description("legacy alias");
task
  .command("plan")
  .requiredOption("-g, --goal <goal>", "task goal")
  .option("-d, --deadline <deadline>", "deadline")
  .option("-p, --priority <priority>", "priority")
  .action(async ({ goal, deadline, priority }) => {
    await managerPlan(goal, deadline, priority);
  });
task.command("run-approved").action(async () => {
  await runBeeQueue();
});

program.parseAsync(process.argv);
