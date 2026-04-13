import readline from "node:readline";
import { spawn } from "node:child_process";
import {
  managerAuthAdd,
  managerAuthLogin,
  managerModelSet,
} from "../commands/manager-settings.js";

type ProviderId = "openai" | "anthropic" | "google" | "xai" | "openrouter" | "github-copilot";

type AiChoice = {
  label: string;
  provider: ProviderId;
  defaultModel: string;
  authModes: Array<"api_key" | "oauth">;
};

const AI_CHOICES: AiChoice[] = [
  { label: "OpenAI (Codex)", provider: "openai", defaultModel: "gpt-5.4-mini", authModes: ["api_key", "oauth"] },
  { label: "Claude (Anthropic)", provider: "anthropic", defaultModel: "claude-sonnet-4.6", authModes: ["api_key", "oauth"] },
  { label: "Gemini (Google)", provider: "google", defaultModel: "gemini-2.5-pro", authModes: ["api_key", "oauth"] },
  { label: "Copilot (GitHub)", provider: "github-copilot", defaultModel: "gpt-5.4-mini", authModes: ["oauth", "api_key"] },
  { label: "Grok (xAI)", provider: "xai", defaultModel: "grok-4.1", authModes: ["api_key"] },
  { label: "OpenRouter", provider: "openrouter", defaultModel: "openai/gpt-5.4-mini", authModes: ["api_key"] },
];

const PROVIDER_MODELS: Record<ProviderId, string[]> = {
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

const ENV_KEY_NAMES: Record<ProviderId, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "github-copilot": "GITHUB_TOKEN",
};

type TabId = "connection" | "auth" | "model" | "actions";

type UiMode = "main" | "taskList" | "taskHistory";

type TaskJobRow = { id: string; title: string; status: string };

type ConvEntryRow = {
  role: string;
  action: string;
  content: string;
  timestamp: string;
  source?: string;
};

type TabAction = {
  label: string;
  run: () => Promise<void>;
};

type Keypress = {
  name?: string;
  ctrl?: boolean;
};

export async function launchTerminalGui(): Promise<void> {
  const app = new BeebridgeTerminalGui();
  await app.start();
}

class BeebridgeTerminalGui {
  private tabOrder: TabId[] = ["model", "auth", "actions", "connection"];
  private activeTab: TabId = "model";
  private selectedIndexByTab: Record<TabId, number> = {
    connection: 0,
    auth: 0,
    model: 0,
    actions: 0,
  };

  private gatewayUrl = process.env.beebridge_GATEWAY_URL ?? "http://localhost:4321";
  private gatewayToken = process.env.beebridge_GATEWAY_TOKEN ?? "dev-token";
  private logs: string[] = ["beebridge Terminal GUI started"];
  private closing = false;
  private busy = false;
  private gatewayAutoStartAttempted = false;

  private uiMode: UiMode = "main";
  private taskJobs: TaskJobRow[] = [];
  private taskListCursor = 0;
  private taskListScrollTop = 0;
  private taskBrowserSessionResolve: (() => void) | null = null;
  private historyDetail: {
    jobId: string;
    title: string;
    taskStatus: string;
    convStatus: string;
    entries: ConvEntryRow[];
  } | null = null;
  private historyScrollLine = 0;

  public async start(): Promise<void> {
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.on("keypress", this.onKeypress);

    this.render();

    await new Promise<void>((resolve) => {
      const wait = () => {
        if (this.closing) {
          resolve();
          return;
        }
        setTimeout(wait, 80);
      };
      wait();
    });
  }

  private stop(): void {
    this.closing = true;
    if (this.taskBrowserSessionResolve) {
      this.taskBrowserSessionResolve();
      this.taskBrowserSessionResolve = null;
    }
    this.uiMode = "main";
    process.stdin.off("keypress", this.onKeypress);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write("beebridge GUI closed\n");
  }

  private readonly onKeypress = async (str: string, key: Keypress) => {
    if (this.busy && this.uiMode === "main") return;

    if (key.ctrl && key.name === "c") {
      this.stop();
      return;
    }
    if (this.uiMode === "taskList") {
      await this.handleTaskListKey(str, key);
      return;
    }
    if (this.uiMode === "taskHistory") {
      this.handleTaskHistoryKey(str, key);
      return;
    }

    if (key.name === "q") {
      this.stop();
      return;
    }
    if (key.name === "t" && !this.busy) {
      await this.enterTaskConversationBrowser();
      return;
    }
    if (key.name === "left") {
      this.switchTab(-1);
      return;
    }
    if (key.name === "right") {
      this.switchTab(1);
      return;
    }
    if (key.name === "up" || key.name === "k") {
      this.moveSelection(-1);
      return;
    }
    if (key.name === "down" || key.name === "j") {
      this.moveSelection(1);
      return;
    }
    if (this.isActivateKey(str, key)) {
      await this.executeSelectedAction();
      return;
    }
    if (key.name === "r") {
      this.log("Screen refreshed");
      this.render();
      return;
    }
  };

  private getActions(tab: TabId): TabAction[] {
    const connection: TabAction[] = [
      {
        label: "Change Gateway URL",
        run: async () => {
          const next = await this.prompt("Gateway URL", this.gatewayUrl);
          if (next.trim()) {
            this.gatewayUrl = next.trim();
            this.log(`Gateway URL updated: ${this.gatewayUrl}`);
          }
        },
      },
      {
        label: "Change Gateway token",
        run: async () => {
          const next = await this.prompt("Gateway Token", this.gatewayToken);
          if (next.trim()) {
            this.gatewayToken = next.trim();
            this.log("Gateway token updated");
          }
        },
      },
      {
        label: "Test connection (/health)",
        run: async () => {
          const data = await this.request("/health");
          this.log(`Connection OK: authMode=${String(data.authMode ?? "-")}`);
        },
      },
      {
        label: "Start gateway dev server",
        run: async () => {
          this.startGatewayProcess();
        },
      },
    ];

    const auth: TabAction[] = [
      {
        label: "View auth profiles",
        run: async () => {
          const data = await this.request("/api/settings/pm");
          const profiles = Array.isArray(data.authProfiles) ? data.authProfiles : [];
          if (profiles.length === 0) {
            this.log("No auth profiles configured.");
            return;
          }
          for (const p of profiles) {
            const active = p.active ? " [ACTIVE]" : "";
            this.log(`${String(p.providerId)}/${String(p.mode)}${active} (${String(p.id ?? p.label ?? "-")})`);
          }
        },
      },
      {
        label: "Add auth profile",
        run: async () => {
          const choiceIdx = await this.promptChoice(
            "Select provider",
            AI_CHOICES.map((c) => c.label),
          );
          const choice = AI_CHOICES[choiceIdx];

          let mode: "api_key" | "oauth" = "api_key";
          if (choice.authModes.length > 1) {
            const modeIdx = await this.promptChoice(
              "Select sign-in mode",
              choice.provider === "openai" ? ["API key", "Codex (same as oauth)"] : ["API Key", "OAuth (web login)"],
            );
            mode = modeIdx === 0 ? "api_key" : "oauth";
          }

          await this.runAuthFlow(choice.provider, mode);
        },
      },
      {
        label: "Activate profile",
        run: async () => {
          const profiles = await this.fetchAuthProfiles();
          if (profiles.length === 0) {
            this.log("No profiles to activate.");
            return;
          }
          const idx = await this.promptChoice(
            "Select profile to activate",
            profiles.map((p) => `${String(p.providerId)}/${String(p.mode)} (${String(p.id ?? p.label ?? "-")})`),
          );
          const profileId = String(profiles[idx].id);
          await this.request(`/api/settings/auth/profiles/${profileId}/activate`, { method: "PATCH" });
          this.log(`Profile activated: ${profileId}`);
        },
      },
      {
        label: "Remove profile",
        run: async () => {
          const profiles = await this.fetchAuthProfiles();
          if (profiles.length === 0) {
            this.log("No profiles to remove.");
            return;
          }
          const idx = await this.promptChoice(
            "Select profile to remove",
            profiles.map((p) => `${String(p.providerId)}/${String(p.mode)} (${String(p.id ?? p.label ?? "-")})`),
          );
          const profileId = String(profiles[idx].id);
          await this.request(`/api/settings/auth/profiles/${profileId}`, { method: "DELETE" });
          this.log(`Profile removed: ${profileId}`);
        },
      },
    ];

    const model: TabAction[] = [
      {
        label: "Setup AI (Provider > Auth > Model)",
        run: async () => {
          const choiceIdx = await this.promptChoice(
            "Select AI provider",
            AI_CHOICES.map((c) => c.label),
          );
          const choice = AI_CHOICES[choiceIdx];

          const hasAuth = await this.providerHasAuth(choice.provider);
          if (!hasAuth) {
            this.log(`${choice.label}: No auth found. Setting up authentication.`);

            let mode: "api_key" | "oauth" = choice.authModes[0];
            if (choice.authModes.length > 1) {
              const modeIdx = await this.promptChoice(
                "Select sign-in mode",
                choice.provider === "openai" ? ["API key", "Codex (oauth)"] : ["API Key", "OAuth (web login)"],
              );
              mode = modeIdx === 0 ? "api_key" : "oauth";
            }

            const authOk = await this.runAuthFlow(choice.provider, mode);
            if (!authOk) {
              this.log("Auth failed. Aborting model setup.");
              return;
            }
          } else {
            this.log(`${choice.label}: Auth verified.`);
          }

          const models = PROVIDER_MODELS[choice.provider];
          const modelIdx = await this.promptChoice("Select model", models);
          const selectedModel = models[modelIdx];

          await managerModelSet({
            provider: choice.provider,
            model: selectedModel,
            allow: selectedModel,
          });
          this.log(`Setup complete: ${choice.provider}/${selectedModel}`);

          const nextIdx = await this.promptChoice("Select next step", [
            "Open web dashboard",
            "Create a job (Manager Plan)",
            "Check Bee/Flower status",
            "Done (return to menu)",
          ]);

          if (nextIdx === 0) {
            this.launchWebUi();
            this.log("Starting web dashboard. Opening in browser.");
          } else if (nextIdx === 1) {
            const goal = (await this.prompt("Enter job goal", "")).trim();
            if (!goal) {
              this.log("Job goal is empty.");
              return;
            }
            const priority = (await this.prompt("Priority (low/medium/high)", "medium")).trim();
            const data = await this.request("/api/plan", {
              method: "POST",
              body: JSON.stringify({ goal, priority }),
            });
            const runtime = data.runtime ?? {};
            this.log(`Plan created: ${String(runtime.providerId ?? "-")}/${String(runtime.model ?? "-")}`);
          } else if (nextIdx === 2) {
            try {
              const data = await this.request("/api/flowers");
              const flowers = Array.isArray(data.flowers) ? data.flowers : [];
              this.log(`Connected flowers: ${flowers.length}`);
            } catch { /* ignore */ }
            try {
              const data = await this.request("/api/approvals");
              const pending = Array.isArray(data.pendingBeeApprovals) ? data.pendingBeeApprovals : [];
              this.log(`Pending jobs: ${pending.length}`);
            } catch { /* ignore */ }
          }
        },
      },
      {
        label: "View current model",
        run: async () => {
          const data = await this.request("/api/settings/pm");
          const policy = data.modelPolicy ?? {};
          const pid = String(policy.defaultProviderId ?? "-");
          const mid = String(policy.defaultModel ?? "-");
          if (pid === "-") {
            this.log("No model configured yet. Use 'Setup AI' to configure.");
          } else {
            this.log(`Current model: ${pid}/${mid}`);
          }
        },
      },
    ];

    const actions: TabAction[] = [
      {
        label: "Run manager plan",
        run: async () => {
          const goal = (await this.prompt("goal", "new job plan")).trim();
          const priority = (await this.prompt("priority (low/medium/high)", "medium")).trim();
          const data = await this.request("/api/plan", {
            method: "POST",
            body: JSON.stringify({ goal, priority }),
          });
          const runtime = data.runtime ?? {};
          this.log(`Plan created: ${String(runtime.providerId ?? "-")}/${String(runtime.model ?? "-")}`);
        },
      },
      {
        label: "Check flower status",
        run: async () => {
          const data = await this.request("/api/flowers");
          const flowers = Array.isArray(data.flowers) ? data.flowers : [];
          this.log(`Connected flowers: ${flowers.length}`);
        },
      },
      {
        label: "List pending approvals",
        run: async () => {
          const data = await this.request("/api/approvals");
          const pending = Array.isArray(data.pendingBeeApprovals) ? data.pendingBeeApprovals : [];
          this.log(`Pending jobs: ${pending.length}`);
        },
      },
      {
        label: "Conversation history (tasks)",
        run: async () => {
          await this.enterTaskConversationBrowser();
        },
      },
    ];

    if (tab === "connection") return connection;
    if (tab === "auth") return auth;
    if (tab === "model") return model;
    return actions;
  }

  private switchTab(delta: number): void {
    const current = this.tabOrder.indexOf(this.activeTab);
    const next = (current + delta + this.tabOrder.length) % this.tabOrder.length;
    this.activeTab = this.tabOrder[next];
    this.render();
  }

  private moveSelection(delta: number): void {
    const actions = this.getActions(this.activeTab);
    if (actions.length === 0) return;
    const current = this.selectedIndexByTab[this.activeTab];
    const next = (current + delta + actions.length) % actions.length;
    this.selectedIndexByTab[this.activeTab] = next;
    this.render();
  }

  private async executeSelectedAction(): Promise<void> {
    const actions = this.getActions(this.activeTab);
    const selected = actions[this.selectedIndexByTab[this.activeTab]];
    if (!selected) return;

    this.busy = true;
    try {
      await selected.run();
    } catch (error) {
      this.log(error instanceof Error ? `Error: ${error.message}` : "Unknown error");
    } finally {
      this.restoreTerminal();
      this.busy = false;
      this.render();
    }
  }

  private async request(path: string, init?: RequestInit): Promise<any> {
    const doFetch = async (): Promise<Response> =>
      fetch(`${this.gatewayUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.gatewayToken}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {}),
        },
      });

    let response: Response;
    try {
      response = await doFetch();
    } catch (error) {
      if (!this.gatewayAutoStartAttempted) {
        this.gatewayAutoStartAttempted = true;
        this.startGatewayProcess();
        this.log("Gateway appears offline. Auto-start requested, retrying...");
        await new Promise((resolve) => setTimeout(resolve, 1800));
        try {
          response = await doFetch();
        } catch (retryError) {
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(
            `Cannot reach gateway (${retryMessage}). Auto-start failed; check URL/token in Connection tab.`,
          );
        }
      } else {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Cannot reach gateway (${message}). Use Connection tab -> "Start gateway dev server" or verify URL/token.`,
        );
      }
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`${response.status} ${response.statusText} - ${text}`);
    }

    this.gatewayAutoStartAttempted = false;
    if (response.status === 204) return {};
    return response.json();
  }

  private log(message: string): void {
    this.logs.unshift(`${new Date().toLocaleTimeString()}  ${message}`);
    this.logs = this.logs.slice(0, 12);
  }

  private async prompt(label: string, initialValue: string): Promise<string> {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const promptLabel = initialValue ? `${label} [${initialValue}]: ` : `${label}: `;
    const answer = await new Promise<string>((resolve) => {
      rl.question(promptLabel, resolve);
    });
    rl.close();
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    return answer.trim() ? answer : initialValue;
  }

  private restoreTerminal(): void {
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.removeListener("keypress", this.onKeypress);
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", this.onKeypress);
  }

  private async promptChoice(question: string, choices: string[], defaultIndex = 0): Promise<number> {
    process.stdin.removeListener("keypress", this.onKeypress);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    readline.emitKeypressEvents(process.stdin);

    let cursor = defaultIndex;

    const renderChoices = (): void => {
      process.stdout.write("\u001b[2J\u001b[H");
      process.stdout.write(`${question}\n`);
      process.stdout.write("Up/Down: navigate  Enter: select\n\n");
      choices.forEach((c, i) => {
        const marker = i === cursor ? ">" : " ";
        process.stdout.write(`${marker} ${c}\n`);
      });
    };

    renderChoices();

    return new Promise<number>((resolve) => {
      const handler = (_str: string, key: Keypress): void => {
        if (!key) return;
        if (key.name === "up") {
          cursor = (cursor - 1 + choices.length) % choices.length;
          renderChoices();
        } else if (key.name === "down") {
          cursor = (cursor + 1) % choices.length;
          renderChoices();
        } else if (key.name === "return") {
          process.stdin.removeListener("keypress", handler);
          resolve(cursor);
        } else if (key.name === "q" || (key.ctrl && key.name === "c")) {
          process.stdin.removeListener("keypress", handler);
          resolve(defaultIndex);
        }
      };
      process.stdin.on("keypress", handler);
    });
  }

  private async fetchAuthProfiles(): Promise<Array<Record<string, unknown>>> {
    try {
      const data = await this.request("/api/settings/pm");
      return Array.isArray(data.authProfiles) ? data.authProfiles : [];
    } catch {
      return [];
    }
  }

  private async providerHasAuth(providerId: string): Promise<boolean> {
    const profiles = await this.fetchAuthProfiles();
    return profiles.some((p) => String(p.providerId) === providerId);
  }

  private async runAuthFlow(provider: ProviderId, mode: "api_key" | "oauth"): Promise<boolean> {
    try {
      if (mode === "api_key") {
        const envKey = ENV_KEY_NAMES[provider];
        const fromEnv = process.env[envKey]?.trim() ?? "";
        let secret = fromEnv;
        if (!secret) {
          secret = (await this.prompt(`API key (${envKey})`, "")).trim();
        } else {
          this.log(`Using ${envKey} from environment.`);
        }
        if (!secret) {
          this.log("API key not provided. Auth cancelled.");
          return false;
        }
        await managerAuthAdd({
          provider,
          mode: "api_key",
          secret,
          label: `tui-${provider}`,
        });
        this.log(`API key saved for ${provider}.`);
        return true;
      }

      await managerAuthLogin({ provider, label: `tui-${provider}`, open: true });
      this.log(provider === "openai" ? `Codex profile saved for ${provider}.` : `OAuth profile saved for ${provider}.`);
      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`Auth failed: ${msg}`);
      return false;
    }
  }

  private async openExternal(url: string): Promise<void> {
    const { spawn } = await import("node:child_process");
    if (process.platform === "darwin") {
      spawn("open", [url], { stdio: "ignore", detached: true });
      return;
    }
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { stdio: "ignore", detached: true });
      return;
    }
    spawn("xdg-open", [url], { stdio: "ignore", detached: true });
  }

  private launchWebUi(): void {
    const projectHome = process.env.beebridge_HOME ?? process.cwd();
    const port = process.env.PORT ?? "3000";
    const child = spawn("npm", ["run", "dev:web"], {
      cwd: projectHome,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PORT: port },
      shell: process.platform === "win32",
    });
    child.unref();
    setTimeout(() => {
      this.openExternal(`http://localhost:${port}/dashboard`);
    }, 1500);
  }

  private startGatewayProcess(): void {
    const projectHome = process.env.beebridge_HOME ?? process.cwd();
    const child = spawn("npm", ["run", "dev:gateway"], {
      cwd: projectHome,
      detached: true,
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.unref();
    this.log(`Gateway start requested (cwd=${projectHome})`);
  }

  private async enterTaskConversationBrowser(): Promise<void> {
    try {
      const data = await this.request("/api/jobs");
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      this.taskJobs = jobs
        .map((j: Record<string, unknown>) => ({
          id: String(j.id ?? ""),
          title: String(j.title ?? "(no title)"),
          status: String(j.status ?? "-"),
        }))
        .filter((t: TaskJobRow) => t.id.length > 0);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log(`Failed to load jobs: ${msg}`);
      return;
    }
    if (this.taskJobs.length === 0) {
      this.log("No tasks from gateway.");
      return;
    }
    this.uiMode = "taskList";
    this.taskListCursor = 0;
    this.taskListScrollTop = 0;
    this.busy = false;
    this.renderTaskList();
    await new Promise<void>((resolve) => {
      this.taskBrowserSessionResolve = resolve;
    });
  }

  /** Enter / Space / ^M — return key name varies across terminals */
  private isActivateKey(str: string, key: Keypress): boolean {
    if (key.name === "return" || key.name === "enter" || key.name === "space") return true;
    if (key.ctrl && key.name === "m") return true;
    return str === "\r" || str === "\n";
  }

  private exitTaskBrowserToMain(): void {
    this.uiMode = "main";
    this.historyDetail = null;
    this.taskJobs = [];
    this.taskListCursor = 0;
    this.taskListScrollTop = 0;
    this.taskBrowserSessionResolve?.();
    this.taskBrowserSessionResolve = null;
  }

  private async handleTaskListKey(str: string, key: Keypress): Promise<void> {
    if (!key) return;
    if (key.ctrl && key.name === "c") {
      this.stop();
      return;
    }
    if (key.name === "escape" || key.name === "q") {
      this.exitTaskBrowserToMain();
      return;
    }
    const n = this.taskJobs.length;
    if (n === 0) return;

    if (key.name === "up" || key.name === "k") {
      this.taskListCursor = (this.taskListCursor - 1 + n) % n;
      this.renderTaskList();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      this.taskListCursor = (this.taskListCursor + 1) % n;
      this.renderTaskList();
      return;
    }
    if (this.isActivateKey(str, key) && !this.busy) {
      const job = this.taskJobs[this.taskListCursor];
      if (!job) return;
      this.busy = true;
      this.renderTaskList();
      try {
        const data = await this.request(`/api/jobs/${job.id}/conversation`);
        const conv = data.conversation as
          | {
              entries?: ConvEntryRow[];
              status?: string;
            }
          | null
          | undefined;
        this.historyDetail = {
          jobId: job.id,
          title: job.title,
          taskStatus: job.status,
          convStatus: conv?.status ?? "(none)",
          entries: Array.isArray(conv?.entries) ? conv.entries : [],
        };
        this.uiMode = "taskHistory";
        this.historyScrollLine = 0;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.log(`Conversation load failed: ${msg}`);
      } finally {
        this.busy = false;
      }
      if (this.uiMode === "taskHistory") {
        this.renderTaskHistory();
      } else {
        this.renderTaskList();
      }
    }
  }

  private handleTaskHistoryKey(_str: string, key: Keypress): void {
    if (!key) return;
    if (key.ctrl && key.name === "c") {
      this.stop();
      return;
    }
    if (key.name === "escape" || key.name === "q") {
      this.uiMode = "taskList";
      this.historyDetail = null;
      this.renderTaskList();
      return;
    }
    const lines = this.flattenHistoryLines();
    const rows = process.stdout.rows ?? 24;
    const visible = Math.max(5, rows - 7);
    const maxScroll = Math.max(0, lines.length - visible);

    if (key.name === "up" || key.name === "k") {
      this.historyScrollLine = Math.max(0, this.historyScrollLine - 1);
      this.renderTaskHistory();
      return;
    }
    if (key.name === "down" || key.name === "j") {
      this.historyScrollLine = Math.min(maxScroll, this.historyScrollLine + 1);
      this.renderTaskHistory();
      return;
    }
    if (key.name === "pageup") {
      this.historyScrollLine = Math.max(0, this.historyScrollLine - visible);
      this.renderTaskHistory();
      return;
    }
    if (key.name === "pagedown") {
      this.historyScrollLine = Math.min(maxScroll, this.historyScrollLine + visible);
      this.renderTaskHistory();
    }
  }

  private wrapLine(text: string, maxWidth: number): string[] {
    if (maxWidth < 8) return [text];
    if (text.length <= maxWidth) return [text];
    const lines: string[] = [];
    let remaining = text;
    while (remaining.length > maxWidth) {
      lines.push(remaining.slice(0, maxWidth));
      remaining = remaining.slice(maxWidth);
    }
    if (remaining.length) lines.push(remaining);
    return lines;
  }

  private flattenHistoryLines(): string[] {
    const h = this.historyDetail;
    if (!h) return [];
    const cols = Math.max(40, (process.stdout.columns ?? 80) - 2);
    const lines: string[] = [];
    lines.push(`Task: ${h.title}`);
    lines.push(`ID: ${h.jobId}  task: ${h.taskStatus}  conversation: ${h.convStatus}`);
    lines.push("");
    if (h.entries.length === 0) {
      lines.push("(no conversation entries)");
      return lines;
    }
    for (const e of h.entries) {
      const src = e.source ? ` [${e.source}]` : "";
      lines.push(`--- ${e.timestamp}  ${e.role}/${e.action}${src}`);
      for (const part of e.content.split("\n")) {
        lines.push(...this.wrapLine(part.length ? part : " ", cols));
      }
      lines.push("");
    }
    return lines;
  }

  private renderTaskList(): void {
    const rows = process.stdout.rows ?? 24;
    const cols = process.stdout.columns ?? 80;
    const headerLines = 5;
    const footerLines = 3;
    const maxVisible = Math.max(3, rows - headerLines - footerLines);
    const n = this.taskJobs.length;

    if (n > 0) {
      if (this.taskListCursor < this.taskListScrollTop) {
        this.taskListScrollTop = this.taskListCursor;
      }
      if (this.taskListCursor >= this.taskListScrollTop + maxVisible) {
        this.taskListScrollTop = this.taskListCursor - maxVisible + 1;
      }
    }

    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write("beebridge — CONVERSATION HISTORY (tasks)\n");
    process.stdout.write("↑↓/j/k: move  Enter/Space: open  Esc: back\n\n");

    if (this.busy) {
      process.stdout.write("Loading…\n");
      return;
    }

    const slice = this.taskJobs.slice(this.taskListScrollTop, this.taskListScrollTop + maxVisible);
    for (let i = 0; i < slice.length; i++) {
      const idx = this.taskListScrollTop + i;
      const job = slice[i];
      const mark = idx === this.taskListCursor ? "▶" : " ";
      const line = `${mark} ${job.title} (${job.status})`.slice(0, cols - 1);
      if (idx === this.taskListCursor) {
        process.stdout.write(`\u001b[7m${line}\u001b[0m\n`);
      } else {
        process.stdout.write(`${line}\n`);
      }
    }
    if (n > maxVisible) {
      const from = this.taskListScrollTop + 1;
      const to = Math.min(n, this.taskListScrollTop + maxVisible);
      process.stdout.write(`\n${from}-${to} / ${n} tasks\n`);
    }
  }

  private renderTaskHistory(): void {
    if (!this.historyDetail) {
      this.renderTaskList();
      return;
    }
    const cols = process.stdout.columns ?? 80;
    const rows = process.stdout.rows ?? 24;
    const visible = Math.max(5, rows - 7);
    const lines = this.flattenHistoryLines();
    const maxScroll = Math.max(0, lines.length - visible);
    this.historyScrollLine = Math.min(this.historyScrollLine, maxScroll);
    this.historyScrollLine = Math.max(0, this.historyScrollLine);

    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write("beebridge — CONVERSATION HISTORY\n");
    process.stdout.write("↑↓/j/k: scroll  PgUp/PgDn: page  Esc: back\n\n");

    const slice = lines.slice(this.historyScrollLine, this.historyScrollLine + visible);
    for (const line of slice) {
      process.stdout.write(`${line.slice(0, cols - 1)}\n`);
    }
    if (lines.length > visible) {
      const end = Math.min(lines.length, this.historyScrollLine + visible);
      process.stdout.write(`\n--- lines ${this.historyScrollLine + 1}-${end} / ${lines.length} ---\n`);
    }
  }

  private render(): void {
    const tabTitle = {
      connection: "Connection",
      auth: "Auth",
      model: "Model",
      actions: "Actions",
    };
    const actions = this.getActions(this.activeTab);
    const selected = this.selectedIndexByTab[this.activeTab];
    const cols = process.stdout.columns ?? 80;

    process.stdout.write("\u001b[2J\u001b[H");
    process.stdout.write("beebridge TERMINAL GUI\n");
    process.stdout.write(
      "←/→: tab  ↑/↓/j/k: item  Enter/Space: run  t: history  q: quit\n",
    );
    process.stdout.write(`Gateway: ${this.gatewayUrl}\n`);
    process.stdout.write(`Token: ${this.gatewayToken ? "set" : "not set"}\n\n`);

    process.stdout.write(
      this.tabOrder
        .map((tab) => (tab === this.activeTab ? `[${tabTitle[tab]}]` : ` ${tabTitle[tab]} `))
        .join("  ") + "\n\n",
    );

    actions.forEach((action, index) => {
      const mark = index === selected ? "▶" : " ";
      const line = `${mark} ${action.label}`.slice(0, cols - 1);
      if (index === selected) {
        process.stdout.write(`\u001b[7m${line}\u001b[0m\n`);
      } else {
        process.stdout.write(`${line}\n`);
      }
    });

    process.stdout.write("\n--- Logs ---\n");
    if (this.logs.length === 0) {
      process.stdout.write("No logs\n");
    } else {
      for (const line of this.logs) {
        process.stdout.write(`${line}\n`);
      }
    }
  }
}
