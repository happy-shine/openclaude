import type { Logger } from "pino";
import type { GatewayConfig } from "./config/types.js";
import type { InboundMessage } from "./channels/types.js";
import type { StreamEvent } from "./process/types.js";
import { TelegramAdapter } from "./channels/telegram/adapter.js";
import { SessionManager } from "./sessions/manager.js";
import { SessionStore } from "./sessions/store.js";
import { ProcessManager } from "./process/manager.js";
import { checkAccess } from "./auth/access.js";
import { PairingManager } from "./auth/pairing.js";
import { resolveDataDir } from "./config/loader.js";
import { splitMessage } from "./channels/telegram/formatter.js";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";

export class Gateway {
  private config: GatewayConfig;
  private log: Logger;
  private sessionManager: SessionManager;
  private processManager: ProcessManager;
  private pairingManager: PairingManager;
  private telegram?: TelegramAdapter;
  private allowFrom: Set<string>;
  private dataDir: string;

  constructor(config: GatewayConfig, log: Logger) {
    this.config = config;
    this.log = log;
    this.dataDir = resolveDataDir(config);

    const sessionStore = new SessionStore(join(this.dataDir, "sessions"));
    this.sessionManager = new SessionManager(sessionStore);

    this.processManager = new ProcessManager(
      {
        binary: config.claude.binary,
        idleTimeoutMs: config.claude.idleTimeoutMs,
        maxProcesses: config.claude.maxProcesses,
        extraArgs: config.claude.extraArgs,
      },
      log,
    );

    const pairingPath = join(this.dataDir, "credentials", "telegram-pairing.json");
    this.pairingManager = new PairingManager(pairingPath);

    this.allowFrom = this.loadAllowFrom();
  }

  private loadAllowFrom(): Set<string> {
    const configAllow = this.config.channels.telegram?.allowFrom ?? [];
    const filePath = join(this.dataDir, "credentials", "telegram-allowFrom.json");
    let fileAllow: string[] = [];
    if (existsSync(filePath)) {
      try {
        fileAllow = JSON.parse(readFileSync(filePath, "utf-8")).allowFrom ?? [];
      } catch {
        // ignore malformed file
      }
    }
    return new Set([...configAllow, ...fileAllow]);
  }

  private saveAllowFrom(): void {
    const filePath = join(this.dataDir, "credentials", "telegram-allowFrom.json");
    mkdirSync(join(this.dataDir, "credentials"), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, allowFrom: [...this.allowFrom] }, null, 2));
    renameSync(tmp, filePath);
  }

  async start(): Promise<void> {
    this.log.info("Starting gateway...");
    this.sessionManager.loadAll();

    const tgConfig = this.config.channels.telegram;
    if (tgConfig) {
      this.telegram = new TelegramAdapter(tgConfig.botToken, this.log);
      this.telegram.onCommand("new", (msg) => this.handleNewSession(msg));
      this.telegram.onCommand("switch", (msg) => this.handleSwitchSession(msg));
      this.telegram.onCommand("sessions", (msg) => this.handleListSessions(msg));
      this.telegram.onCommand("help", (msg) => this.handleHelp(msg));
      this.telegram.onMessage((msg) => this.handleMessage(msg));
      await this.telegram.start();
      this.log.info("Telegram adapter started");
    }

    this.log.info("Gateway started");
  }

  async stop(): Promise<void> {
    this.log.info("Stopping gateway...");
    await this.telegram?.stop();
    await this.processManager.shutdown();
    await this.sessionManager.flushAll();
    this.log.info("Gateway stopped");
  }

  private checkMessageAccess(msg: InboundMessage) {
    // Reload allowFrom from disk on every check so CLI-side approvals
    // are picked up by the running Gateway without a restart.
    this.allowFrom = this.loadAllowFrom();
    const tgConfig = this.config.channels.telegram!;
    return checkAccess({
      senderId: msg.senderId,
      chatId: msg.chatId,
      isGroup: msg.isGroup,
      dmPolicy: tgConfig.dmPolicy,
      groupPolicy: tgConfig.groupPolicy,
      allowFrom: [...this.allowFrom],
      groups: tgConfig.groups,
    });
  }

  private async handleMessage(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) {
      if (access.reason === "needs_pairing") await this.handlePairingChallenge(msg);
      return;
    }

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);

    if (!session.title && msg.text) {
      this.sessionManager.update(session.sessionId, { title: msg.text.slice(0, 50) });
    }

    await this.telegram!.sendTyping(msg.chatId);

    let sentMessageId: string | null = null;
    let buffer = "";
    let lastFlush = Date.now();
    const FLUSH_INTERVAL = 500;

    for await (const event of this.processManager.sendMessage(session, msg.text)) {
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        this.sessionManager.update(session.sessionId, {
          claudeSessionId: event.session_id as string,
        });
      }

      if (event.type === "assistant" && event.message) {
        const content = event.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && "text" in block) {
              buffer += (block as { text: string }).text;
            }
          }
        } else if (typeof content === "string") {
          buffer += content;
        }
      }

      const now = Date.now();
      if (buffer.length > 0 && now - lastFlush >= FLUSH_INTERVAL) {
        if (!sentMessageId) {
          sentMessageId = await this.telegram!.send({
            chatId: msg.chatId,
            text: buffer.slice(0, 4096),
            replyToMessageId: msg.messageId,
          });
        } else {
          await this.telegram!.editMessage(msg.chatId, sentMessageId, buffer.slice(0, 4096));
        }
        lastFlush = now;
      }

      if (event.type === "result") {
        if (buffer.length > 0) {
          if (!sentMessageId) {
            await this.telegram!.send({
              chatId: msg.chatId,
              text: buffer,
              replyToMessageId: msg.messageId,
            });
          } else {
            await this.telegram!.editMessage(msg.chatId, sentMessageId, buffer.slice(0, 4096));
            if (buffer.length > 4096) {
              for (const chunk of splitMessage(buffer.slice(4096))) {
                await this.telegram!.send({ chatId: msg.chatId, text: chunk });
              }
            }
          }
        } else if (event.is_error) {
          await this.telegram!.send({
            chatId: msg.chatId,
            text: `Error: ${event.result ?? "Unknown error"}`,
            replyToMessageId: msg.messageId,
          });
        }
        break;
      }
    }

    this.sessionManager.update(session.sessionId, { lastActiveAt: Date.now() });
    await this.sessionManager.flush(msg.chatId);
  }

  private async handlePairingChallenge(msg: InboundMessage): Promise<void> {
    const req = this.pairingManager.challenge(msg.senderId, msg.senderName, msg.channelType, msg.chatId);
    const text = [
      "Access not configured.",
      "",
      `Your Telegram user ID: ${msg.senderId}`,
      "",
      `Pairing code: ${req.code}`,
      "",
      "Ask the bot owner to approve with:",
      `  claude-gateway pairing approve ${req.code}`,
    ].join("\n");
    await this.telegram!.send({ chatId: msg.chatId, text });
  }

  private async handleNewSession(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    this.sessionManager.resolve(msg.chatId, msg.channelType);
    this.sessionManager.createNew(msg.chatId);
    const count = this.sessionManager.list(msg.chatId).length;
    await this.telegram!.send({
      chatId: msg.chatId,
      text: `New session started. (Session #${count})`,
    });
    await this.sessionManager.flush(msg.chatId);
  }

  private async handleSwitchSession(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const index = parseInt(msg.text, 10);
    if (isNaN(index)) {
      await this.handleListSessions(msg);
      return;
    }

    const switched = this.sessionManager.switchTo(msg.chatId, index);
    if (!switched) {
      await this.telegram!.send({
        chatId: msg.chatId,
        text: `Session #${index} not found. Use /sessions to see available sessions.`,
      });
      return;
    }

    await this.telegram!.send({
      chatId: msg.chatId,
      text: `Switched to session #${index}: ${switched.title ?? "(untitled)"}`,
    });
    await this.sessionManager.flush(msg.chatId);
  }

  private async handleListSessions(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const sessions = this.sessionManager.list(msg.chatId);
    if (sessions.length === 0) {
      await this.telegram!.send({ chatId: msg.chatId, text: "No sessions yet." });
      return;
    }

    const lines = sessions.map((s, i) => {
      const active = s.isActive ? " << active" : "";
      const title = s.title ?? "(untitled)";
      const age = formatAge(Date.now() - s.lastActiveAt);
      return `#${i + 1}  "${title}"  ${age}${active}`;
    });
    await this.telegram!.send({ chatId: msg.chatId, text: lines.join("\n") });
  }

  private async handleHelp(msg: InboundMessage): Promise<void> {
    const text = [
      "Claude Gateway Commands:",
      "",
      "/new — Start a new session",
      "/switch [N] — Switch to session #N (or list sessions)",
      "/sessions — List all sessions",
      "/help — Show this help",
    ].join("\n");
    await this.telegram!.send({ chatId: msg.chatId, text });
  }

  getPairingManager(): PairingManager {
    return this.pairingManager;
  }

  approvePairing(code: string): { senderId: string } | null {
    const result = this.pairingManager.approve(code);
    if (result) {
      this.allowFrom.add(result.senderId);
      this.saveAllowFrom();
    }
    return result;
  }
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
