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
import { ApiServer } from "./api/server.js";
import { ProgressTracker, getToolDetail } from "./progress.js";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";

export class Gateway {
  private config: GatewayConfig;
  private log: Logger;
  private sessionManager: SessionManager;
  private processManager: ProcessManager;
  private pairingManager: PairingManager;
  private apiServer?: ApiServer;
  private telegram?: TelegramAdapter;
  private allowFrom: Set<string>;
  private dataDir: string;

  constructor(config: GatewayConfig, log: Logger) {
    this.config = config;
    this.log = log;
    this.dataDir = resolveDataDir(config);

    const sessionStore = new SessionStore(join(this.dataDir, "sessions"));
    this.sessionManager = new SessionManager(sessionStore);

    // Build extraArgs with model if configured
    const extraArgs = [...config.claude.extraArgs];
    if (config.claude.model) {
      extraArgs.push("--model", config.claude.model);
    }

    // Extract bot ID from token (part before the colon)
    const botId = config.channels.telegram?.botToken?.split(":")[0] ?? "default";

    const workspaceDir = join(this.dataDir, "workspace");
    const agentsDir = join(this.dataDir, "agents");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });

    this.processManager = new ProcessManager(
      {
        binary: config.claude.binary,
        idleTimeoutMs: config.claude.idleTimeoutMs,
        maxProcesses: config.claude.maxProcesses,
        extraArgs,
        workspaceDir,
        botId,
        apiPort: config.gateway.port,
        agentsDir,
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

      // Start API server for file sending
      this.apiServer = new ApiServer({
        port: this.config.gateway.port,
        telegram: this.telegram,
        dataDir: this.dataDir,
        log: this.log,
      });
      await this.apiServer.start();
    }

    this.log.info("Gateway started");
  }

  async stop(): Promise<void> {
    this.log.info("Stopping gateway...");
    await this.apiServer?.stop();
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
      if (access.reason === "needs_pairing") {
        await this.handlePairingChallenge(msg);
      } else if (access.reason === "group_not_configured") {
        await this.telegram!.send({
          chatId: msg.chatId,
          text: `This group is not configured.\n\nGroup chat ID: ${msg.chatId}\n\nAdd to config.yaml:\n  groups:\n    "${msg.chatId}":\n      enabled: true`,
        });
      }
      return;
    }

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);

    if (!session.title && msg.text) {
      this.sessionManager.update(session.sessionId, { title: msg.text.slice(0, 50) });
    }

    await this.telegram!.sendTyping(msg.chatId);

    // Build message with metadata (sender, time, reply context)
    let messageText = formatMessageWithMeta(msg);
    if (msg.attachments && msg.attachments.length > 0) {
      // Trigger acquire to create the workspace dir
      this.processManager.acquire(session);
      const wsDir = this.processManager.getWorkspaceDir(session.sessionId);
      if (wsDir) {
        const downloadsDir = join(wsDir, "downloads");
        for (const att of msg.attachments) {
          try {
            const localPath = await this.telegram!.downloadFile(
              att.fileId,
              downloadsDir,
              att.fileName,
            );
            att.localPath = localPath;
            this.log.info({ fileId: att.fileId, localPath }, "Downloaded attachment");

            const fileRef = `[Attached ${att.type}: ${localPath}]`;
            messageText = messageText
              ? `${messageText}\n\n${fileRef}`
              : `Please read and process this file: ${localPath}`;
          } catch (err) {
            this.log.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to download attachment");
          }
        }
      }
    }

    const progress = new ProgressTracker(this.telegram!, msg.chatId, msg.messageId);
    progress.start(); // auto-flush every 1.5s for spinner animation

    try {
      for await (const event of this.processManager.sendMessage(session, messageText)) {
        // --- Session init ---
        if (event.type === "system" && event.subtype === "init" && event.session_id) {
          this.sessionManager.update(session.sessionId, {
            claudeSessionId: event.session_id as string,
          });
        }

        // --- Real-time phase detection from raw API stream events ---
        if (event.type === "stream_event" && event.event) {
          const raw = event.event as Record<string, unknown>;
          if (raw.type === "content_block_start") {
            const block = raw.content_block as Record<string, unknown> | undefined;
            if (block?.type === "thinking") {
              progress.startThinking();
            }
          }
        }

        // --- Complete assistant message: extract tool_use + text ---
        if (event.type === "assistant" && event.message) {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block !== "object" || block === null) continue;
              const b = block as Record<string, unknown>;
              if (b.type === "tool_use" && typeof b.name === "string") {
                const detail = getToolDetail(b.name, b.input);
                progress.startTool(b.name, detail);
              }
              if ("text" in b && typeof b.text === "string") {
                progress.appendText(b.text);
              }
            }
          } else if (typeof content === "string") {
            progress.appendText(content);
          }
        }

        // --- Result: finalize ---
        if (event.type === "result") {
          // Stop timer + await any in-flight flush BEFORE sending final message.
          // This prevents the timer-fired flush from overwriting the response.
          await progress.finish();

          // Prefer buffer (accumulated text from all assistant events).
          // Fall back to result.result (Claude CLI's final output) if buffer is empty.
          const buf = progress.getBuffer();
          const finalText = buf.length > 0
            ? buf
            : (typeof event.result === "string" && event.result) || "";

          if (finalText.length > 0) {
            const { text: cleanText, buttons } = extractButtons(finalText);
            if (buttons.length > 0) {
              // Send/edit with inline keyboard buttons
              const existingMsgId = progress.getMessageId();
              if (existingMsgId) {
                await this.telegram!.editMessage(msg.chatId, existingMsgId, cleanText, buttons);
              } else {
                await this.telegram!.sendWithButtons(msg.chatId, cleanText, buttons, msg.messageId);
              }
            } else {
              await progress.sendOrEdit(cleanText);
            }
            if (cleanText.length > 4096) {
              for (const chunk of splitMessage(cleanText.slice(4096))) {
                await this.telegram!.send({ chatId: msg.chatId, text: chunk });
              }
            }
          } else if (event.is_error) {
            await progress.sendOrEdit(`Error: ${event.result ?? "Unknown error"}`);
          }
          break;
        }

        // --- Trigger flush on each event (debounced internally) ---
        await progress.flush();
      }
    } finally {
      progress.stop();
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
      `  openclaude pairing approve ${req.code}`,
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

/** Format message with sender name, timestamp, and reply context */
function formatMessageWithMeta(msg: InboundMessage): string {
  const dt = new Date(msg.timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;

  const lines: string[] = [];
  lines.push(`[${ts}] ${msg.senderName}:`);

  if (msg.replyText) {
    const quoteName = msg.replySenderName ?? "Unknown";
    const quoteText = msg.replyText.length > 200
      ? msg.replyText.slice(0, 200) + "…"
      : msg.replyText;
    const quoteLines = quoteText.split("\n");
    lines.push(`> ${quoteName}: ${quoteLines[0]}`);
    for (let i = 1; i < quoteLines.length; i++) {
      lines.push(`> ${quoteLines[i]}`);
    }
  }

  if (msg.text) {
    lines.push(msg.text);
  }

  return lines.join("\n");
}

/**
 * Extract <<button>> patterns from trailing lines of the response.
 * Only scans from the end — stops at the first line without buttons.
 */
function extractButtons(text: string): { text: string; buttons: string[] } {
  const lines = text.split("\n");
  const buttons: string[] = [];
  let cutoff = lines.length;

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue; // skip trailing blank lines
    const found = [...line.matchAll(/<<([^>]+)>>/g)].map((m) => m[1]);
    if (found.length === 0) break;
    buttons.unshift(...found);
    cutoff = i;
  }

  if (buttons.length === 0) return { text, buttons: [] };
  return { text: lines.slice(0, cutoff).join("\n").trimEnd(), buttons };
}
