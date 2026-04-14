/**
 * Runs Discord bot clients for Flower rows of type discord_bot.
 */

import {
  Client,
  Events,
  GatewayIntentBits,
  type Message,
  Partials,
} from "discord.js";
import type { FlowerConfig } from "@beebridge/core";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions.mjs";
import { runChatMessage, type RunChatMessageDeps } from "./chat-request.js";

const DISCORD_MESSAGE_MAX = 1990;
const HISTORY_MAX_TURNS = 20;
/** Default min ms between handled messages per flower+channel when config omits discordCooldownMs. */
const DEFAULT_DISCORD_COOLDOWN_MS = 1200;

function discordFlowerDebugEnabled(): boolean {
  const v = process.env.DISCORD_FLOWER_DEBUG ?? process.env.BEEBRIDGE_DISCORD_DEBUG ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

function chunkDiscordText(text: string): string[] {
  const t = text.trim();
  if (!t) return [];
  if (t.length <= DISCORD_MESSAGE_MAX) return [t];
  const out: string[] = [];
  for (let i = 0; i < t.length; i += DISCORD_MESSAGE_MAX) {
    out.push(t.slice(i, i + DISCORD_MESSAGE_MAX));
  }
  return out;
}

export type DiscordFlowerManagerParams = {
  getConfigs: () => FlowerConfig[];
  chatDeps: RunChatMessageDeps;
  log: (tag: string, detail: string) => void;
};

type ActiveBot = {
  client: Client;
  flowerId: string;
  token: string;
  allowlist: Set<string>;
};

export class DiscordFlowerManager {
  private readonly getConfigs: () => FlowerConfig[];
  private readonly chatDeps: RunChatMessageDeps;
  private readonly log: (tag: string, detail: string) => void;
  private readonly bots = new Map<string, ActiveBot>();
  /** flowerId:channelId -> prior turns */
  private readonly history = new Map<string, ChatCompletionMessageParam[]>();
  /** flowerId:channelId -> tail of promise chain */
  private readonly chains = new Map<string, Promise<void>>();
  /** flowerId:channelId -> last handled message timestamp */
  private readonly lastHandledAt = new Map<string, number>();
  private readonly lastErrors = new Map<string, string>();
  /** Dedupe one-shot hints so busy servers do not spam logs */
  private readonly loggedAllowlistSkip = new Set<string>();
  private readonly loggedEmptyTextHint = new Set<string>();
  private readonly loggedUserAllowlistSkip = new Set<string>();
  private readonly loggedCooldownSkip = new Set<string>();
  private readonly loggedChannelNotSendable = new Set<string>();
  /** Log once when Discord actually delivers a user MessageCreate (proves gateway wiring). */
  private readonly loggedFirstUserMessageCreate = new Set<string>();
  /** Avoid double-handling when both Raw DM bridge and MessageCreate fire for the same snowflake. */
  private readonly recentDiscordInbound = new Map<string, number>();
  private static readonly INBOUND_DEDUPE_MS = 30_000;
  /** taskId → { flowerId, channelId } so we can notify Discord when a task finishes. */
  private readonly taskOriginChannels = new Map<string, { flowerId: string; channelId: string }>();

  constructor(params: DiscordFlowerManagerParams) {
    this.getConfigs = params.getConfigs;
    this.chatDeps = params.chatDeps;
    this.log = params.log;
  }

  /** Register a task id as originating from a specific Discord channel. */
  registerTaskOrigin(taskId: string, flowerId: string, channelId: string): void {
    this.taskOriginChannels.set(taskId, { flowerId, channelId });
  }

  /** Notify the originating Discord channel when a task completes. */
  async notifyTaskComplete(taskId: string, status: "done" | "failed", summary?: string): Promise<void> {
    const origin = this.taskOriginChannels.get(taskId);
    if (!origin) return;
    this.taskOriginChannels.delete(taskId);

    const bot = this.bots.get(origin.flowerId);
    if (!bot?.client.isReady()) return;

    try {
      const ch = await bot.client.channels.fetch(origin.channelId);
      if (!ch?.isTextBased() || !ch.isSendable()) return;

      const icon = status === "done" ? "✅" : "❌";
      const statusText = status === "done" ? "Done" : "Failed";
      let msg = `${icon} Task ${statusText}: \`${taskId}\``;
      if (summary) {
        msg += `\n${summary}`;
      }

      const chunks = chunkDiscordText(msg);
      for (const chunk of chunks) {
        await ch.send(chunk);
      }
    } catch (e) {
      this.log("DISCORD", `notify task complete failed for ${taskId}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  isFlowerConnected(flowerId: string): boolean {
    const b = this.bots.get(flowerId);
    return Boolean(b?.client.isReady());
  }

  getLastError(flowerId: string): string | undefined {
    return this.lastErrors.get(flowerId);
  }

  /** One line for buildChatRuntimeContextForPrompt */
  getRuntimeSummary(): string {
    const ids = [...this.bots.entries()].filter(([, b]) => b.client.isReady()).map(([id]) => id);
    if (ids.length === 0) return "discord_flower_bots_ready: 0";
    return `discord_flower_bots_ready: ${ids.length} (${ids.join(", ")})`;
  }

  async sync(): Promise<void> {
    const configs = this.getConfigs();
    const wanted = new Map<string, { token: string; allowlist: Set<string> }>();

    for (const c of configs) {
      if (c.type !== "discord_bot" || !c.enabled) continue;
      const token = c.discordBotToken?.trim();
      const list = [...new Set((c.discordChannelAllowlist ?? []).map((s) => s.trim()).filter(Boolean))];
      if (!token || list.length === 0) continue;
      wanted.set(c.id, { token, allowlist: new Set(list) });
    }

    for (const [flowerId, bot] of [...this.bots.entries()]) {
      const w = wanted.get(flowerId);
      if (!w || w.token !== bot.token || ![...w.allowlist].every((id) => bot.allowlist.has(id)) || w.allowlist.size !== bot.allowlist.size) {
        await this.destroyBot(flowerId);
      }
    }

    for (const [flowerId, w] of wanted) {
      const existing = this.bots.get(flowerId);
      if (existing && existing.token === w.token && existing.allowlist.size === w.allowlist.size && [...w.allowlist].every((id) => existing.allowlist.has(id))) {
        existing.allowlist = w.allowlist;
        continue;
      }
      if (existing) await this.destroyBot(flowerId);
      await this.startBot(flowerId, w.token, w.allowlist);
    }
  }

  private clearLastError(flowerId: string): void {
    this.lastErrors.delete(flowerId);
  }

  private setLastError(flowerId: string, message: string): void {
    this.lastErrors.set(flowerId, message);
  }

  private async destroyBot(flowerId: string): Promise<void> {
    const bot = this.bots.get(flowerId);
    if (!bot) return;
    try {
      bot.client.removeAllListeners();
      await bot.client.destroy();
    } catch {
      // best-effort
    }
    this.bots.delete(flowerId);
    this.loggedFirstUserMessageCreate.delete(flowerId);
    this.log("DISCORD", `stopped bot for flower ${flowerId}`);
  }

  private async startBot(flowerId: string, token: string, allowlist: Set<string>): Promise<void> {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      /** DM channels/messages often start uncached; partials + fetch below help MessageCreate reach the handler. */
      partials: [Partials.Channel, Partials.Message, Partials.User],
    });

    const bot: ActiveBot = { client, flowerId, token, allowlist };
    this.bots.set(flowerId, bot);

    client.once(Events.ClientReady, (c) => {
      this.clearLastError(flowerId);
      this.log("DISCORD", `flower ${flowerId} ready as ${c.user?.tag ?? "?"}`);
      this.log(
        "DISCORD",
        `flower ${flowerId}: if your texts never produce [CHAT] or skip lines, confirm (1) this bot is in the server (2) channel “View channel” for the bot (3) Developer Portal → Bot → Message Content Intent ON (4) allowlist uses “Copy channel ID” for that exact channel (DMs use the DM channel id, not the guild channel id). Verbose: DISCORD_FLOWER_DEBUG=1`,
      );
    });

    client.on(Events.MessageCreate, async (rawMsg) => {
      let msg: Message = rawMsg;
      if (msg.partial) {
        try {
          msg = await msg.fetch();
        } catch (e) {
          this.log(
            "DISCORD",
            `partial MessageCreate fetch failed flower=${flowerId}: ${e instanceof Error ? e.message : String(e)}`,
          );
          return;
        }
      }
      if (msg.author.partial) {
        try {
          await msg.author.fetch();
        } catch (e) {
          if (discordFlowerDebugEnabled()) {
            this.log(
              "DISCORD",
              `author partial fetch failed flower=${flowerId}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
      if (!msg.author.bot && !msg.webhookId && !this.loggedFirstUserMessageCreate.has(flowerId)) {
        this.loggedFirstUserMessageCreate.add(flowerId);
        this.log(
          "DISCORD",
          `flower ${flowerId}: first user MessageCreate → channel=${msg.channelId} contentLen=${msg.content?.length ?? 0}`,
        );
      }
      void this.enqueueMessage(flowerId, msg);
    });

    /** DM messages sometimes never emit MessageCreate with partials alone; bridge from gateway dispatch. */
    client.on(Events.Raw, (packet: { t?: string; d?: Record<string, unknown> }) => {
      if (packet.t !== "MESSAGE_CREATE" || !packet.d || typeof packet.d !== "object") return;
      const d = packet.d as {
        guild_id?: string | null;
        channel_id?: string;
        id?: string;
        author?: { bot?: boolean };
      };
      if (d.guild_id) return;
      if (d.author?.bot) return;
      const channelId = d.channel_id;
      const messageId = d.id;
      if (!channelId || !messageId) return;
      void (async () => {
        try {
          const ch = await client.channels.fetch(channelId);
          if (!ch?.isTextBased()) return;
          const full = await ch.messages.fetch(messageId);
          if (discordFlowerDebugEnabled()) {
            this.log("DISCORD", `raw DM → enqueue flower=${flowerId} ch=${channelId} msg=${messageId}`);
          }
          void this.enqueueMessage(flowerId, full);
        } catch (e) {
          if (discordFlowerDebugEnabled()) {
            this.log(
              "DISCORD",
              `raw DM bridge failed flower=${flowerId} ch=${channelId}: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      })();
    });

    try {
      await client.login(token);
    } catch (e) {
      this.bots.delete(flowerId);
      const msg = e instanceof Error ? e.message : String(e);
      this.setLastError(flowerId, `login failed: ${msg}`);
      this.log("DISCORD", `login failed flower ${flowerId}: ${msg}`);
    }
  }

  private historyKey(flowerId: string, channelId: string): string {
    return `${flowerId}:${channelId}`;
  }

  private resolveCooldownMs(config: FlowerConfig | undefined): number {
    const n = config?.discordCooldownMs;
    if (n === 0) return 0;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return Math.floor(n);
    return DEFAULT_DISCORD_COOLDOWN_MS;
  }

  /** Returns false if this snowflake was already handed to enqueueMessage recently (Raw + MessageCreate overlap). */
  private takeInboundIfNew(messageId: string): boolean {
    const now = Date.now();
    const maxAge = DiscordFlowerManager.INBOUND_DEDUPE_MS;
    for (const [id, t] of this.recentDiscordInbound) {
      if (now - t > maxAge) this.recentDiscordInbound.delete(id);
    }
    if (this.recentDiscordInbound.has(messageId)) return false;
    this.recentDiscordInbound.set(messageId, now);
    return true;
  }

  private enqueueMessage(flowerId: string, msg: Message): void {
    if (!this.takeInboundIfNew(msg.id)) return;
    if (discordFlowerDebugEnabled()) {
      this.log(
        "DISCORD",
        `rx flower=${flowerId} ch=${msg.channelId} author=${msg.author.id} len=${msg.content?.length ?? 0} bot=${msg.author.bot} webhook=${Boolean(msg.webhookId)}`,
      );
    }
    const key = this.historyKey(flowerId, msg.channelId);
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.handleInboundMessage(flowerId, msg))
      .catch((err) => {
        this.log("DISCORD", `handler error ${key}: ${err instanceof Error ? err.message : String(err)}`);
      });
    this.chains.set(key, next);
  }

  private shouldIgnoreMessage(msg: Message): boolean {
    if (msg.author.bot) return true;
    if (msg.webhookId) return true;
    if (msg.system) return true;
    return false;
  }

  private async handleInboundMessage(flowerId: string, msg: Message): Promise<void> {
    const bot = this.bots.get(flowerId);
    if (!bot) return;
    if (this.shouldIgnoreMessage(msg)) return;

    const allowlist = bot.allowlist;
    if (!allowlist.has(msg.channelId)) {
      const onceKey = `${flowerId}:${msg.channelId}`;
      if (!this.loggedAllowlistSkip.has(onceKey)) {
        this.loggedAllowlistSkip.add(onceKey);
        this.log(
          "DISCORD",
          `skip: channel ${msg.channelId} not in allowlist for flower ${flowerId}. Configured ids: ${[...allowlist].join(", ") || "(none)"}`,
        );
      }
      return;
    }

    const config = this.getConfigs().find((c) => c.id === flowerId);
    const userList = config?.discordUserAllowlist?.map((s) => s.trim()).filter(Boolean) ?? [];
    if (userList.length > 0 && !userList.includes(msg.author.id)) {
      const onceKey = `${flowerId}:${msg.author.id}`;
      if (!this.loggedUserAllowlistSkip.has(onceKey)) {
        this.loggedUserAllowlistSkip.add(onceKey);
        this.log(
          "DISCORD",
          `skip: user ${msg.author.id} not in discordUserAllowlist for flower ${flowerId}`,
        );
      }
      return;
    }

    const text = msg.content?.trim() ?? "";
    const imageUrls: string[] = [];
    for (const att of msg.attachments.values()) {
      if (att.contentType?.startsWith("image/") && att.url) {
        imageUrls.push(att.url);
      }
    }

    if (!text && imageUrls.length === 0) {
      const hkHint = this.historyKey(flowerId, msg.channelId);
      if (!this.loggedEmptyTextHint.has(hkHint)) {
        this.loggedEmptyTextHint.add(hkHint);
        this.log(
          "DISCORD",
          `skip: empty message text in allowlisted channel ${msg.channelId} (sticker/image-only?) — if this is a guild channel, enable Message Content Intent on the bot in Discord Developer Portal`,
        );
      }
      return;
    }

    const hk = this.historyKey(flowerId, msg.channelId);
    const cooldownMs = this.resolveCooldownMs(config);
    if (cooldownMs > 0) {
      const last = this.lastHandledAt.get(hk) ?? 0;
      const now = Date.now();
      if (now - last < cooldownMs) {
        if (discordFlowerDebugEnabled()) {
          this.log("DISCORD", `skip: cooldown ${hk} (${cooldownMs}ms)`);
        } else if (!this.loggedCooldownSkip.has(hk)) {
          this.loggedCooldownSkip.add(hk);
          this.log("DISCORD", `skip: cooldown (${cooldownMs}ms) for ${hk} — wait or set discordCooldownMs to 0`);
        }
        return;
      }
    }

    const ch = msg.channel;
    if (!ch.isTextBased() || !ch.isSendable()) {
      if (!this.loggedChannelNotSendable.has(hk)) {
        this.loggedChannelNotSendable.add(hk);
        this.log("DISCORD", `skip: channel ${msg.channelId} is not text+sendable for flower ${flowerId}`);
      }
      return;
    }

    try {
      await ch.sendTyping();
    } catch {
      // ignore
    }

    let prior = this.history.get(hk) ?? [];
    const chatActionToolsEnabled = config?.discordChatToolsEnabled !== false;

    const chatResult = await runChatMessage({
      userMessage: text || "(image attached)",
      imageUrls: imageUrls.length > 0 ? imageUrls : undefined,
      history: prior,
      deps: this.chatDeps,
      chatActionToolsEnabled,
      fullWorkspaceContext: chatActionToolsEnabled,
      discordInbound: true,
    });

    let reply: string;
    if (!chatResult.ok) {
      reply =
        chatResult.code === "no_profile"
          ? "Beebridge: no active auth profile on the gateway. Open Settings and activate an API profile."
          : chatResult.code === "empty_message"
            ? "Beebridge: empty message."
            : `Beebridge error: ${chatResult.error}`;
    } else {
      reply = chatResult.reply || "(no reply)";
      const details = chatResult.actionDetails;
      if (details && details.length > 0) {
        const failures = details.filter((d) => !d.ok || d.summary.trim().startsWith("Error"));
        if (failures.length > 0) {
          const block = failures.map((f) => `[${f.name}] ${f.summary}`.trim()).join("\n");
          reply = `${reply}\n\n—\nBeebridge tool result(s):\n${block}`;
        }
      }

      if (
        chatActionToolsEnabled &&
        (!chatResult.actions || chatResult.actions.length === 0) &&
        /error|fail(ed|ure)?|problem\s*(occurred|detected)|system\s*(issue|error)/i.test(reply)
      ) {
        reply = `${reply}\n\n_(Beebridge: no workspace tools were called. The above is generated text, not a system report.)_`;
      }

      if (chatResult.actions && chatResult.actions.length > 0) {
        const fullText = [reply, ...(chatResult.actionDetails?.map((d) => d.summary) ?? [])].join(" ");
        const taskIdMatches = fullText.matchAll(/task-[\w-]+/g);
        for (const m of taskIdMatches) {
          this.taskOriginChannels.set(m[0], { flowerId, channelId: msg.channelId });
        }
      }
    }

    const chunks = chunkDiscordText(reply);
    try {
      for (const chunk of chunks) {
        await ch.send(chunk);
      }
    } catch (sendErr) {
      const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      this.log("DISCORD", `send failed ${hk}: ${errMsg}`);
      try {
        await ch.send("Beebridge: failed to send reply.");
      } catch {
        // ignore
      }
      return;
    }

    prior = [...prior, { role: "user", content: text }, { role: "assistant", content: reply }];
    while (prior.length > HISTORY_MAX_TURNS * 2) {
      prior = prior.slice(-(HISTORY_MAX_TURNS * 2));
    }
    this.history.set(hk, prior);
    if (cooldownMs > 0) {
      this.lastHandledAt.set(hk, Date.now());
    }
  }
}
