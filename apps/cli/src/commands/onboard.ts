import readline from "node:readline";
import { managerAuthAdd, managerAuthLogin, managerModelSet } from "./manager-settings.js";

type AuthMode = "api_key" | "oauth";
type ProviderId = "openai" | "anthropic" | "google" | "xai" | "openrouter" | "github-copilot";

type AiChoice = {
  label: string;
  provider: ProviderId;
  defaultModel: string;
};

interface OnboardState {
  workspaceMode: "local" | "remote";
  authMode: AuthMode;
  provider: ProviderId;
  model: string;
  installDaemon: boolean;
  applyModelPolicy: boolean;
}

const providerModels: Record<ProviderId, string[]> = {
  openai: [
    "gpt-5.4", "gpt-5.4-mini", "gpt-5.4-nano",
    "gpt-5", "gpt-5-mini", "gpt-5-nano",
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "o3", "o3-mini", "o4-mini",
  ],
  anthropic: [
    "claude-sonnet-4.6", "claude-sonnet-4", "claude-haiku-4",
    "claude-3-7-sonnet", "claude-3-5-sonnet", "claude-3-5-haiku",
    "claude-3-opus",
  ],
  google: [
    "gemini-3.1-pro", "gemini-3.1-flash-lite",
    "gemini-2.5-pro", "gemini-2.5-flash",
    "gemini-2.0-flash", "gemini-2.0-flash-lite",
    "gemini-1.5-pro", "gemini-1.5-flash",
  ],
  xai: [
    "grok-4.20", "grok-4.1", "grok-4.1-fast", "grok-4.1-mini",
    "grok-3", "grok-3-mini",
  ],
  openrouter: [
    "openai/gpt-5.4-mini", "openai/gpt-5-mini", "openai/gpt-4o", "openai/o4-mini",
    "anthropic/claude-sonnet-4.6", "anthropic/claude-sonnet-4",
    "google/gemini-2.5-pro", "google/gemini-2.5-flash",
    "meta-llama/llama-4-maverick", "meta-llama/llama-4-scout",
    "deepseek/deepseek-r1", "deepseek/deepseek-v3-0324",
    "qwen/qwen3-235b-a22b",
  ],
  "github-copilot": [
    "gpt-5.4", "gpt-5.4-mini",
    "gpt-4o", "gpt-4.1", "gpt-4o-mini",
    "o3-mini", "o4-mini",
    "claude-sonnet-4.6", "claude-sonnet-4",
    "gemini-2.5-pro", "gemini-2.0-flash",
  ],
};

const aiChoices: AiChoice[] = [
  { label: "OpenAI (Codex)", provider: "openai", defaultModel: "gpt-5.4-mini" },
  { label: "Claude (Anthropic)", provider: "anthropic", defaultModel: "claude-sonnet-4.6" },
  { label: "Gemini (Google)", provider: "google", defaultModel: "gemini-2.5-pro" },
  { label: "Copilot (GitHub)", provider: "github-copilot", defaultModel: "gpt-5.4-mini" },
  { label: "Grok (xAI)", provider: "xai", defaultModel: "grok-4.1" },
  { label: "OpenRouter", provider: "openrouter", defaultModel: "openai/gpt-5.4-mini" },
];

function clearScreen(): void {
  process.stdout.write("\u001b[2J\u001b[H");
}

function renderHeader(step: number, total: number, title: string): void {
  clearScreen();
  process.stdout.write("beebridge Onboard\n");
  process.stdout.write("──────────────────────────────────────────────\n");
  process.stdout.write(`Step ${step}/${total}  ${title}\n`);
  process.stdout.write("──────────────────────────────────────────────\n\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function prompt(question: string, defaultValue?: string): Promise<string> {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const label = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  const answer = await new Promise<string>((resolve) => rl.question(label, resolve));
  rl.close();

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
  }
  const trimmed = answer.trim();
  return trimmed || defaultValue || "";
}

async function promptChoice(question: string, choices: string[], defaultIndex = 0): Promise<number> {
  process.stdout.write(`${question}\n`);
  choices.forEach((value, index) => {
    process.stdout.write(`  ${index + 1}) ${value}\n`);
  });
  const raw = await prompt("Select number", String(defaultIndex + 1));
  const idx = Number(raw) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= choices.length) {
    return defaultIndex;
  }
  return idx;
}

async function promptYesNo(question: string, defaultYes = true): Promise<boolean> {
  const defaultValue = defaultYes ? "Y/n" : "y/N";
  const answer = (await prompt(`${question} (${defaultValue})`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

function renderSummary(state: OnboardState): void {
  process.stdout.write("\nConfiguration Summary\n");
  process.stdout.write("──────────────────────────────────────────────\n");
  process.stdout.write(`- Workspace mode: ${state.workspaceMode}\n`);
  process.stdout.write(`- PM auth mode: ${state.authMode}\n`);
  process.stdout.write(`- AI provider: ${state.provider}\n`);
  process.stdout.write(`- Default model: ${state.model}\n`);
  process.stdout.write(`- Daemon install: ${state.installDaemon ? "Yes" : "No"}\n`);
  process.stdout.write("──────────────────────────────────────────────\n");
}

async function runDaemonStepIfNeeded(state: OnboardState): Promise<void> {
  if (!state.installDaemon) {
    return;
  }
  renderHeader(7, 7, "Daemon Install");
  process.stdout.write("Preparing beebridge background service installation...\n");
  await sleep(500);
  process.stdout.write("Verifying service registration...\n");
  await sleep(400);
  process.stdout.write("Running install script...\n");
  await sleep(600);
  process.stdout.write("\n[Done] Daemon install simulation finished.\n");
  process.stdout.write("In production, replace with launchd/systemd integration.\n");
  await sleep(900);
}

function envApiKeyName(provider: ProviderId): string {
  if (provider === "openai") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "google") return "GOOGLE_API_KEY";
  if (provider === "xai") return "XAI_API_KEY";
  if (provider === "openrouter") return "OPENROUTER_API_KEY";
  return "GITHUB_TOKEN";
}

async function runAuthSetupStep(state: OnboardState, options: { yes?: boolean }): Promise<void> {
  renderHeader(5, 7, "Auth Setup");
  process.stdout.write(`Configuring authentication for provider (${state.provider}).\n\n`);

  if (state.authMode === "api_key") {
    const envKey = envApiKeyName(state.provider);
    const secretFromEnv = process.env[envKey]?.trim() ?? "";
    let secret = secretFromEnv;

    if (!secret && !options.yes) {
      secret = await prompt(`Enter API key (${envKey})`);
    }
    if (!secret) {
      throw new Error(`API key not found. Provide ${envKey} environment variable or enter manually.`);
    }

    await managerAuthAdd({
      provider: state.provider,
      mode: "api_key",
      secret,
      label: `onboard-${state.provider}`,
    });
    process.stdout.write(`[Done] API key profile saved (${state.provider})\n`);
  } else {
    if (options.yes) {
      throw new Error(
        state.provider === "openai"
          ? "Codex onboarding requires interactive mode. Run again without --yes."
          : "OAuth onboarding requires interactive mode. Run again without --yes.",
      );
    }
    await managerAuthLogin({
      provider: state.provider,
      label: `onboard-${state.provider}`,
      open: true,
    });
    process.stdout.write(
      `[Done] ${state.provider === "openai" ? "Codex" : "OAuth"} profile saved (${state.provider})\n`,
    );
  }

}

async function runModelSetupStep(state: OnboardState, options: { yes?: boolean }): Promise<void> {
  renderHeader(6, 7, "Model Setup");
  process.stdout.write("Authentication complete. Saving model policy.\n\n");
  if (!options.yes) {
    const models = providerModels[state.provider];
    const modelIdx = await promptChoice("Select default model", models, 0);
    state.model = models[modelIdx];
  } else {
    state.model = providerModels[state.provider][0];
  }
  await managerModelSet({
    provider: state.provider,
    model: state.model,
    allow: state.model,
  });
  process.stdout.write(`[Done] Default model configured (${state.provider}/${state.model})\n`);
  await sleep(700);
}

export async function runOnboard(options: { installDaemon?: boolean; yes?: boolean }): Promise<void> {
  const state: OnboardState = {
    workspaceMode: "local",
    authMode: "oauth",
    provider: "openai",
    model: "gpt-4o",
    installDaemon: Boolean(options.installDaemon),
    applyModelPolicy: true,
  };

  renderHeader(1, 7, "Welcome");
  process.stdout.write(
    "First-time setup for beebridge: configure PM auth, model, and runtime environment in one go.\n\n",
  );
  await sleep(400);

  renderHeader(2, 7, "Workspace Mode");
  if (!options.yes) {
    const modeIdx = await promptChoice("Which runtime mode would you like to start with?", ["local", "remote"], 0);
    state.workspaceMode = modeIdx === 1 ? "remote" : "local";
  }

  renderHeader(3, 7, "AI Selection");
  if (!options.yes) {
    const choiceIdx = await promptChoice(
      "Select the AI provider for the Project Manager",
      aiChoices.map((choice) => choice.label),
      0,
    );
    const selected = aiChoices[choiceIdx];
    state.provider = selected.provider;
    state.model = selected.defaultModel;
  }

  renderHeader(4, 7, "PM Auth Mode");
  const oauthCapable = ["openai", "anthropic", "google", "github-copilot"].includes(state.provider);
  if (!options.yes) {
    if (oauthCapable) {
      const authIdx = await promptChoice(
        "Select sign-in mode",
        state.provider === "openai" ? ["Codex (web login)", "api_key"] : ["oauth (web login)", "api_key"],
        0,
      );
      state.authMode = authIdx === 0 ? "oauth" : "api_key";
    } else {
      state.authMode = "api_key";
      process.stdout.write(`Provider (${state.provider}) currently only supports api_key mode.\n`);
      await sleep(900);
    }
  } else {
    state.authMode = "api_key";
  }

  if (options.installDaemon && !options.yes) {
    state.installDaemon = await promptYesNo("Continue with daemon installation?", true);
  }

  renderSummary(state);
  if (!options.yes) {
    const proceed = await promptYesNo("Complete onboarding with these settings?", true);
    if (!proceed) {
      process.stdout.write("\nOnboarding cancelled.\n");
      return;
    }
  }

  try {
    await runAuthSetupStep(state, options);
    if (state.applyModelPolicy) {
      await runModelSetupStep(state, options);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown auth setup error";
    process.stdout.write(`\n[ERROR] Auth setup failed: ${message}\n`);
    process.stdout.write("Hint: start gateway first (`beebridge gateway start` or `npm run start:gateway`) and set:\n");
    process.stdout.write("  beebridge_GATEWAY_URL=http://localhost:4321\n");
    process.stdout.write("  beebridge_GATEWAY_TOKEN=<or omit: reads ~/.beebridge/gateway-token>\n");
    throw error;
  }
  await runDaemonStepIfNeeded(state);

  process.stdout.write("\nOnboarding complete (auth/model configured)\n");
  process.stdout.write("Open the web settings panel with:\n");
  process.stdout.write("  beebridge web settings --tab auth\n");
  process.stdout.write("  beebridge web settings --tab model\n");
}
