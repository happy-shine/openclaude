import type { Logger } from "pino";
import type { GatewayConfig, ResolvedBotConfig } from "./config/types.js";
import type { InboundMessage } from "./channels/types.js";
import type { StreamEvent } from "./process/types.js";
import { TelegramAdapter } from "./channels/telegram/adapter.js";
import { getRecentGroupContext, getRecentGroupContextForSession } from "./channels/telegram/handlers.js";
import { MessageStore } from "./sessions/message-store.js";
import { SessionManager } from "./sessions/manager.js";
import { SessionStore } from "./sessions/store.js";
import { ProcessManager } from "./process/manager.js";
import { checkAccess } from "./auth/access.js";
import { PairingManager } from "./auth/pairing.js";
import { splitMessage, toMarkdownV2 } from "./channels/telegram/formatter.js";
import { ProgressTracker, getToolDetail } from "./progress.js";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";

const SESSIONS_PER_PAGE = 10;

export class BotInstance {
  readonly botId: string;
  readonly name: string;
  readonly config: ResolvedBotConfig;
  readonly telegram: TelegramAdapter;
  private sessionManager: SessionManager;
  private pairingManager: PairingManager;
  private processManager: ProcessManager;  // shared reference
  private messageStore: MessageStore;       // shared reference
  private log: Logger;
  private dataDir: string;
  private allowFrom: Set<string>;
  private runtimeGroups: Record<string, { enabled: boolean; allowFrom?: string[] }>;
  private lastButtonMsg = new Map<string, string>();
  private chatQueues = new Map<string, Promise<void>>();
  private gatewayConfig: GatewayConfig;
  private extraArgs: string[];
  /** Other bots in the same gateway (for group @mention hints) */
  private peerBots: Array<{ name: string; username: string }> = [];

  constructor(opts: {
    botConfig: ResolvedBotConfig;
    gatewayConfig: GatewayConfig;
    processManager: ProcessManager;
    messageStore: MessageStore;
    dataDir: string;
    log: Logger;
  }) {
    this.config = opts.botConfig;
    this.gatewayConfig = opts.gatewayConfig;
    this.processManager = opts.processManager;
    this.messageStore = opts.messageStore;
    this.dataDir = opts.dataDir;
    this.log = opts.log.child({ bot: opts.botConfig.name, botId: opts.botConfig.botId });
    this.botId = opts.botConfig.botId;
    this.name = opts.botConfig.name;

    // Per-bot session store
    const sessionStore = new SessionStore(join(opts.dataDir, "sessions", this.botId));
    this.sessionManager = new SessionManager(sessionStore);

    // Per-bot pairing manager
    const pairingPath = join(opts.dataDir, "credentials", this.botId, "telegram-pairing.json");
    this.pairingManager = new PairingManager(pairingPath);

    // Per-bot telegram adapter
    this.telegram = new TelegramAdapter(opts.botConfig.token, this.log);

    // Build per-bot extraArgs (includes --model if configured)
    this.extraArgs = [...opts.botConfig.extraArgs];
    if (opts.botConfig.model) {
      this.extraArgs.push("--model", opts.botConfig.model);
    }

    // Load allow-from list
    this.allowFrom = this.loadAllowFrom();

    // Load runtime groups (approved via pairing / CLI)
    this.runtimeGroups = this.loadRuntimeGroups();
  }

  // --- AllowFrom management ---

  private loadAllowFrom(): Set<string> {
    const configAllow = this.config.allowFrom ?? [];
    const filePath = join(this.dataDir, "credentials", this.botId, "telegram-allowFrom.json");
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
    const filePath = join(this.dataDir, "credentials", this.botId, "telegram-allowFrom.json");
    mkdirSync(join(this.dataDir, "credentials", this.botId), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, allowFrom: [...this.allowFrom] }, null, 2));
    renameSync(tmp, filePath);
  }

  /** Refresh allowFrom from config + disk (called on config reload) */
  refreshAllowFrom(): void {
    this.allowFrom = this.loadAllowFrom();
  }

  // --- Runtime groups management ---

  private getRuntimeGroupsPath(): string {
    return join(this.dataDir, "credentials", this.botId, "telegram-groups.json");
  }

  private loadRuntimeGroups(): Record<string, { enabled: boolean; allowFrom?: string[] }> {
    const filePath = this.getRuntimeGroupsPath();
    if (existsSync(filePath)) {
      try {
        return JSON.parse(readFileSync(filePath, "utf-8")).groups ?? {};
      } catch {
        // ignore malformed file
      }
    }
    return {};
  }

  private saveRuntimeGroups(): void {
    const filePath = this.getRuntimeGroupsPath();
    mkdirSync(join(this.dataDir, "credentials", this.botId), { recursive: true });
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, JSON.stringify({ version: 1, groups: this.runtimeGroups }, null, 2));
    renameSync(tmp, filePath);
  }

  /** Merge config groups with runtime groups (runtime wins on conflict) */
  private mergedGroups(): Record<string, { enabled: boolean; allowFrom?: string[] }> {
    return { ...this.config.groups, ...this.runtimeGroups };
  }

  // --- Access control ---

  private checkMessageAccess(msg: InboundMessage) {
    // Reload from disk on every check so CLI-side approvals
    // are picked up by the running instance without a restart.
    this.allowFrom = this.loadAllowFrom();
    this.runtimeGroups = this.loadRuntimeGroups();
    return checkAccess({
      senderId: msg.senderId,
      chatId: msg.chatId,
      isGroup: msg.isGroup,
      dmPolicy: this.config.dmPolicy,
      groupPolicy: this.config.groupPolicy,
      allowFrom: [...this.allowFrom],
      groups: this.mergedGroups(),
    });
  }

  // --- Lifecycle ---

  async start(): Promise<void> {
    this.sessionManager.loadAll();
    this.telegram.setMessageStore(this.messageStore, this.name);

    // Register commands
    this.telegram.onCommand("new", (msg) => this.handleNewSession(msg));
    this.telegram.onCommand("btw", (msg) => this.handleBtw(msg));
    this.telegram.onCommand("sessions", (msg) => this.handleSessionsCommand(msg));
    this.telegram.onCommand("help", (msg) => this.handleHelp(msg));
    this.telegram.onCommand("model", (msg) => this.handleModel(msg));
    this.telegram.onCommand("effort", (msg) => this.handleEffort(msg));
    this.telegram.onCommand("stop", (msg) => this.handleInterrupt(msg));
    this.telegram.onCommand("title", (msg) => this.handleTitle(msg));

    // Register callback handlers (per-bot, not module-level)
    this.telegram.onCallback("sw", async (ctx) => {
      const data = (ctx as any).callbackQuery?.data as string;
      const parts = data.split(":");
      const chatId = parts[1];
      const index = parseInt(parts[2], 10);
      if (!chatId || isNaN(index)) return;
      const switched = this.sessionManager.switchTo(chatId, index);
      if (switched) {
        try {
          const orig = (ctx as any).callbackQuery?.message;
          if (orig && "text" in orig) {
            await (ctx as any).editMessageText(orig.text, { reply_markup: { inline_keyboard: [] } });
          }
        } catch { /* ignore */ }
        await this.telegram.send({ chatId, text: `Switched to session #${index}: ${switched.title ?? "(untitled)"}` });
        await this.sessionManager.flush(chatId);
      }
    });

    this.telegram.onCallback("pg", async (ctx) => {
      const data = (ctx as any).callbackQuery?.data as string;
      const parts = data.split(":");
      const chatId = parts[1];
      const page = parseInt(parts[2], 10);
      if (!chatId || isNaN(page)) return;
      const orig = (ctx as any).callbackQuery?.message;
      if (!orig) return;
      const messageId = String(orig.message_id);
      // Rebuild session list for the requested page (newest first)
      const sessions = this.sessionManager.list(chatId).reverse();
      const perPage = SESSIONS_PER_PAGE;
      const totalPages = Math.ceil(sessions.length / perPage);
      const p = Math.max(0, Math.min(page, totalPages - 1));
      const slice = sessions.slice(p * perPage, (p + 1) * perPage);
      const lines = slice.map((s) => {
        const active = s.isActive ? " << active" : "";
        const title = s.title ?? "(untitled)";
        const age = formatAge(Date.now() - s.lastActiveAt);
        return `#${s.sessionNum}  "${title}"  ${age}${active}`;
      });
      const sessionButtons = slice.map((s) => {
        return { text: `${s.sessionNum}`, callback_data: `sw:${chatId}:${s.sessionNum}` };
      });
      const buttonRows: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < sessionButtons.length; i += 5) {
        buttonRows.push(sessionButtons.slice(i, i + 5));
      }
      if (totalPages > 1) {
        const navRow: Array<{ text: string; callback_data: string }> = [];
        if (p > 0) navRow.push({ text: "\u25C0 Prev", callback_data: `pg:${chatId}:${p - 1}` });
        navRow.push({ text: `${p + 1}/${totalPages}`, callback_data: "noop" });
        if (p < totalPages - 1) navRow.push({ text: "Next \u25B6", callback_data: `pg:${chatId}:${p + 1}` });
        buttonRows.push(navRow);
      }
      await this.telegram.editMessageWithKeyboard(chatId, messageId, lines.join("\n"), buttonRows);
    });

    this.telegram.onCallback("noop", async () => { /* do nothing */ });

    this.telegram.onCallback("model", async (ctx) => {
      const data = (ctx as any).callbackQuery?.data as string;
      const value = data?.split(":")[1];
      if (!value) return;
      const chat = (ctx as any).callbackQuery?.message?.chat;
      if (!chat) return;
      const chatId = String(chat.id);
      try {
        const orig = (ctx as any).callbackQuery?.message;
        if (orig && "text" in orig) {
          await (ctx as any).editMessageText(`Model: ${value}`, { reply_markup: { inline_keyboard: [] } });
        }
      } catch { /* ignore */ }
      const session = this.sessionManager.resolve(chatId, "telegram");
      if (!this.processManager.hasProcess(session.sessionId)) {
        await this.telegram.send({ chatId, text: `Model set to ${value}. Will apply on next message.` });
        return;
      }
      const sent = this.processManager.sendControl(session.sessionId, { subtype: "set_model", model: value });
      await this.telegram.send({ chatId, text: sent ? `Model switched to ${value}` : "No active process." });
    });

    this.telegram.onCallback("effort", async (ctx) => {
      const data = (ctx as any).callbackQuery?.data as string;
      const value = data?.split(":")[1];
      if (!value) return;
      const chat = (ctx as any).callbackQuery?.message?.chat;
      if (!chat) return;
      const chatId = String(chat.id);
      try {
        const orig = (ctx as any).callbackQuery?.message;
        if (orig && "text" in orig) {
          await (ctx as any).editMessageText(`Effort: ${value}`, { reply_markup: { inline_keyboard: [] } });
        }
      } catch { /* ignore */ }
      const session = this.sessionManager.resolve(chatId, "telegram");
      if (!this.processManager.hasProcess(session.sessionId)) {
        await this.telegram.send({ chatId, text: `Effort set to ${value}. Will apply on next message.` });
        return;
      }
      const sent = this.processManager.sendControl(session.sessionId, {
        subtype: "apply_flag_settings",
        settings: { effortLevel: value },
      });
      await this.telegram.send({ chatId, text: sent ? `Effort set to ${value}` : "No active process." });
    });

    this.telegram.onMessage((msg) => this.enqueueChat(msg));
    await this.telegram.start();
    this.log.info({ botName: this.name }, "Bot instance started");
  }

  async stop(): Promise<void> {
    await this.telegram.stop();
    await this.sessionManager.flushAll();
    this.log.info({ botName: this.name }, "Bot instance stopped");
  }

  /** Set peer bots for group @mention hints */
  setPeerBots(peers: Array<{ name: string; username: string }>): void {
    this.peerBots = peers;
  }

  /** Accept a relayed message from another bot in the same gateway */
  relayMessage(msg: InboundMessage): void {
    this.log.info({ from: msg.senderName, chatId: msg.chatId }, "Received relayed message");
    // Clear messageId — bots cannot reply_to other bots' messages in Telegram
    this.enqueueChat({ ...msg, messageId: "" });
  }

  // --- Chat queue ---

  private async enqueueChat(msg: InboundMessage): Promise<void> {
    const chatId = msg.chatId;
    const prev = this.chatQueues.get(chatId) ?? Promise.resolve();
    const next = prev
      .then(() => this.handleMessage(msg))
      .catch((err) => {
        this.log.error(
          { error: err instanceof Error ? err.message : String(err), chatId },
          "Message handler error",
        );
      });
    this.chatQueues.set(chatId, next);
    next.finally(() => {
      if (this.chatQueues.get(chatId) === next) this.chatQueues.delete(chatId);
    });
  }

  // --- Message handling ---

  private async handleMessage(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) {
      if (access.reason === "needs_pairing") {
        await this.handlePairingChallenge(msg);
      } else if (access.reason === "needs_group_pairing") {
        await this.handleGroupPairingChallenge(msg);
      } else if (access.reason === "group_not_configured") {
        await this.telegram.send({
          chatId: msg.chatId,
          text: `This group is not configured.\n\nGroup chat ID: ${msg.chatId}\n\nAdd to config.yaml:\n  groups:\n    "${msg.chatId}":\n      enabled: true`,
        });
      }
      return;
    }

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType, msg.isGroup);

    if (!session.title && msg.text) {
      this.sessionManager.update(session.sessionId, { title: msg.text.slice(0, 50) });
    }

    await this.telegram.sendTyping(msg.chatId);

    // Remove stale inline buttons from previous message
    const prevBtnMsg = this.lastButtonMsg.get(msg.chatId);
    if (prevBtnMsg) {
      this.lastButtonMsg.delete(msg.chatId);
      this.telegram.removeButtons(msg.chatId, prevBtnMsg).catch(() => {});
    }

    // Build message with metadata (sender, time, reply context)
    let messageText = formatMessageWithMeta(msg, session.sessionId);

    // Inject peer bot hints for group chats
    if (msg.isGroup && this.peerBots.length > 0) {
      const botList = this.peerBots.map(b => `@${b.username} (${b.name})`).join(", ");
      messageText = `[本群可@的bot: ${botList} — 注意: 只有以上列出的bot可以被@到，@其他任何bot都无效（消息不会送达）。除非用户明确要求bot间交流，否则不要主动@其他bot。]\n\n${messageText}`;
    }

    // Collect all attachments to download (current message + reply media)
    const allAttachments = [
      ...(msg.attachments ?? []).map((a) => ({ att: a, source: "direct" as const })),
      ...(msg.replyAttachments ?? []).map((a) => ({ att: a, source: "reply" as const })),
    ];

    if (allAttachments.length > 0) {
      // Trigger acquire to create the workspace dir
      this.processManager.acquire(session, this.botId, this.extraArgs);
      const wsDir = this.processManager.getWorkspaceDir(session.sessionId);
      if (wsDir) {
        const downloadsDir = join(wsDir, "downloads");
        for (const { att, source } of allAttachments) {
          try {
            const localPath = await this.telegram.downloadFile(
              att.fileId,
              downloadsDir,
              att.fileName,
            );
            att.localPath = localPath;
            this.log.info({ fileId: att.fileId, localPath, source }, "Downloaded attachment");

            const label = source === "reply" ? `Replied-to ${att.type}` : `Attached ${att.type}`;
            const fileRef = `[${label}: ${localPath}]`;
            messageText = messageText
              ? `${messageText}\n\n${fileRef}`
              : `Please read and process this file: ${localPath}`;
          } catch (err) {
            this.log.error({ error: err instanceof Error ? err.message : String(err) }, "Failed to download attachment");
          }
        }
      }
    }

    const progress = new ProgressTracker(this.telegram, msg.chatId, msg.messageId);
    progress.start(); // auto-flush every 1.5s for spinner animation

    try {
      for await (const event of this.processManager.sendMessage(session, messageText, this.botId, this.extraArgs)) {
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
          await progress.finish();

          const buf = progress.getBuffer();
          const finalText = buf.length > 0
            ? buf
            : (typeof event.result === "string" && event.result) || "";

          if (finalText.length > 0) {
            const { text: cleanText, buttons } = extractButtons(finalText);
            const progressMsgId = progress.getMessageId();
            const mdv2 = toMarkdownV2(cleanText);
            const chunks = splitMessage(mdv2);

            const plainChunks = splitMessage(cleanText);

            if (buttons.length > 0) {
              if (progressMsgId) {
                await this.telegram.deleteMessage(msg.chatId, progressMsgId);
              }
              const btnMsgId = await this.telegram.sendWithButtons(
                msg.chatId, chunks[0], buttons, msg.messageId, "MarkdownV2", plainChunks[0],
              );
              this.lastButtonMsg.set(msg.chatId, btnMsgId);
              this.telegram.notifyOutbound(msg.chatId, cleanText, btnMsgId);
              for (let ci = 1; ci < chunks.length; ci++) {
                await this.telegram.send({ chatId: msg.chatId, text: chunks[ci], parseMode: "MarkdownV2", plainFallback: plainChunks[ci] });
              }
            } else if (progressMsgId) {
              await this.telegram.editMessage(msg.chatId, progressMsgId, chunks[0], undefined, "MarkdownV2", plainChunks[0]);
              // Trigger relay for the final edited content
              this.telegram.notifyOutbound(msg.chatId, cleanText, progressMsgId);
              for (let ci = 1; ci < chunks.length; ci++) {
                await this.telegram.send({ chatId: msg.chatId, text: chunks[ci], parseMode: "MarkdownV2", plainFallback: plainChunks[ci] });
              }
            } else {
              for (let i = 0; i < chunks.length; i++) {
                await this.telegram.send({
                  chatId: msg.chatId,
                  text: chunks[i],
                  parseMode: "MarkdownV2",
                  plainFallback: plainChunks[i],
                  ...(i === 0 ? { replyToMessageId: msg.messageId } : {}),
                });
              }
            }
          } else if (event.is_error) {
            await this.telegram.send({
              chatId: msg.chatId,
              text: `Error: ${event.result ?? "Unknown error"}`,
            });
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

    // Advance this session's cursor past all messages (including our own replies)
    if (msg.isGroup) {
      const latest = this.messageStore.getRecent(msg.chatId, msg.threadId, 1);
      if (latest.length > 0) {
        this.messageStore.advanceCursor(session.sessionId, latest[0].id);
      }
    }
  }

  // --- Command handlers ---

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
      `  openclaude pairing approve ${req.code} --bot ${this.config.name}`,
    ].join("\n");
    await this.telegram.send({ chatId: msg.chatId, text });
  }

  private async handleGroupPairingChallenge(msg: InboundMessage): Promise<void> {
    // Reuse pairing manager but store chatId as the "senderId" key so each group gets one code
    const req = this.pairingManager.challenge(
      `group:${msg.chatId}`,
      `Group ${msg.chatId}`,
      msg.channelType,
      msg.chatId,
    );
    const text = [
      "This group is not yet authorized.",
      "",
      `Group chat ID: ${msg.chatId}`,
      `Pairing code: ${req.code}`,
      "",
      "Ask the bot owner to approve with:",
      `  openclaude group approve ${req.code} --bot ${this.config.name}`,
    ].join("\n");
    await this.telegram.send({ chatId: msg.chatId, text });
  }

  private async handleBtw(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const question = msg.text.trim();
    if (!question) {
      await this.telegram.send({ chatId: msg.chatId, text: "Usage: /btw <question>" });
      return;
    }

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);
    if (!session.claudeSessionId) {
      await this.telegram.send({
        chatId: msg.chatId,
        text: "No active session to fork from. Send a message first.",
      });
      return;
    }

    this.log.info(
      { chatId: msg.chatId, sessionId: session.sessionId, claudeSessionId: session.claudeSessionId },
      "/btw: forking session",
    );

    const progress = new ProgressTracker(this.telegram, msg.chatId, msg.messageId);
    progress.start();

    try {
      for await (const event of this.processManager.forkAndAsk(session, question, this.botId)) {
        if (event.type === "stream_event" && event.event) {
          const raw = event.event as Record<string, unknown>;
          if (raw.type === "content_block_start") {
            const block = raw.content_block as Record<string, unknown> | undefined;
            if (block?.type === "thinking") progress.startThinking();
          }
        }

        if (event.type === "assistant" && event.message) {
          const content = event.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block !== "object" || block === null) continue;
              const b = block as Record<string, unknown>;
              if (b.type === "tool_use" && typeof b.name === "string") {
                progress.startTool(b.name, undefined);
              }
              if ("text" in b && typeof b.text === "string") {
                progress.appendText(b.text);
              }
            }
          } else if (typeof content === "string") {
            progress.appendText(content);
          }
        }

        if (event.type === "result") {
          await progress.finish();
          const buf = progress.getBuffer();
          const finalText = buf.length > 0
            ? buf
            : (typeof event.result === "string" && event.result) || "";

          if (finalText.length > 0) {
            const progressMsgId = progress.getMessageId();
            const mdv2 = toMarkdownV2(finalText);
            const chunks = splitMessage(mdv2);
            const plainChunks = splitMessage(finalText);
            if (progressMsgId) {
              await this.telegram.editMessage(msg.chatId, progressMsgId, chunks[0], undefined, "MarkdownV2", plainChunks[0]);
              for (let ci = 1; ci < chunks.length; ci++) {
                await this.telegram.send({ chatId: msg.chatId, text: chunks[ci], parseMode: "MarkdownV2", plainFallback: plainChunks[ci] });
              }
            } else {
              for (let i = 0; i < chunks.length; i++) {
                await this.telegram.send({
                  chatId: msg.chatId,
                  text: chunks[i],
                  parseMode: "MarkdownV2",
                  plainFallback: plainChunks[i],
                  ...(i === 0 ? { replyToMessageId: msg.messageId } : {}),
                });
              }
            }
          } else if (event.is_error) {
            const progressMsgId = progress.getMessageId();
            const errText = `btw error: ${event.result ?? "Unknown error"}`;
            if (progressMsgId) {
              await this.telegram.editMessage(msg.chatId, progressMsgId, errText);
            } else {
              await this.telegram.send({ chatId: msg.chatId, text: errText });
            }
          }
          break;
        }

        await progress.flush();
      }
    } catch (err) {
      await progress.finish();
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.error({ error: errMsg }, "/btw failed");
      await this.telegram.send({ chatId: msg.chatId, text: `btw error: ${errMsg}` });
    } finally {
      progress.stop();
    }
  }

  private async handleNewSession(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    this.sessionManager.resolve(msg.chatId, msg.channelType);
    this.sessionManager.createNew(msg.chatId);
    const count = this.sessionManager.list(msg.chatId).length;
    await this.telegram.send({
      chatId: msg.chatId,
      text: `New session started. (Session #${count})`,
    });
    await this.sessionManager.flush(msg.chatId);
  }

  private async handleSessionsCommand(msg: InboundMessage): Promise<void> {
    const index = parseInt(msg.text, 10);
    if (!isNaN(index)) {
      const access = this.checkMessageAccess(msg);
      if (!access.allowed) return;
      const switched = this.sessionManager.switchTo(msg.chatId, index);
      if (!switched) {
        await this.telegram.send({
          chatId: msg.chatId,
          text: `Session #${index} not found. Use /sessions to see available sessions.`,
        });
        return;
      }
      await this.telegram.send({
        chatId: msg.chatId,
        text: `Switched to session #${index}: ${switched.title ?? "(untitled)"}`,
      });
      await this.sessionManager.flush(msg.chatId);
      return;
    }
    await this.handleListSessions(msg);
  }

  private async handleListSessions(msg: InboundMessage, page = 0): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const sessions = this.sessionManager.list(msg.chatId).reverse();
    if (sessions.length === 0) {
      await this.telegram.send({ chatId: msg.chatId, text: "No sessions yet." });
      return;
    }

    const perPage = SESSIONS_PER_PAGE;
    const totalPages = Math.ceil(sessions.length / perPage);
    const p = Math.max(0, Math.min(page, totalPages - 1));
    const slice = sessions.slice(p * perPage, (p + 1) * perPage);

    const lines = slice.map((s) => {
      const active = s.isActive ? " << active" : "";
      const title = s.title ?? "(untitled)";
      const age = formatAge(Date.now() - s.lastActiveAt);
      return `#${s.sessionNum}  "${title}"  ${age}${active}`;
    });
    const text = lines.join("\n");

    const sessionButtons = slice.map((s) => {
      return { text: `${s.sessionNum}`, callback_data: `sw:${msg.chatId}:${s.sessionNum}` };
    });
    const buttonRows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < sessionButtons.length; i += 5) {
      buttonRows.push(sessionButtons.slice(i, i + 5));
    }
    if (totalPages > 1) {
      const navRow: Array<{ text: string; callback_data: string }> = [];
      if (p > 0) navRow.push({ text: "\u25C0 Prev", callback_data: `pg:${msg.chatId}:${p - 1}` });
      navRow.push({ text: `${p + 1}/${totalPages}`, callback_data: "noop" });
      if (p < totalPages - 1) navRow.push({ text: "Next \u25B6", callback_data: `pg:${msg.chatId}:${p + 1}` });
      buttonRows.push(navRow);
    }

    await this.telegram.sendWithKeyboard(msg.chatId, text, buttonRows);
  }

  private async handleHelp(msg: InboundMessage): Promise<void> {
    const text = [
      "OpenClaude Commands:",
      "",
      "/new \u2014 Start a new session",
      "/btw <question> \u2014 Quick side question (non-blocking)",
      "/sessions [N] \u2014 List sessions or switch to #N",
      "/model [name] \u2014 Switch model (sonnet/opus/haiku)",
      "/effort [level] \u2014 Set thinking depth (low/medium/high/max)",
      "/stop \u2014 Interrupt current task",
      "/title [text] \u2014 Set session title (empty = auto-generate)",
      "/help \u2014 Show this help",
    ].join("\n");
    await this.telegram.send({ chatId: msg.chatId, text });
  }

  private async handleModel(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const input = msg.text.trim().toLowerCase();
    const aliases: Record<string, string> = {
      opus: "opus",
      sonnet: "sonnet",
      haiku: "haiku",
      "claude-opus-4-6": "opus",
      "claude-sonnet-4-6": "sonnet",
      "claude-haiku-4-5": "haiku",
    };
    const model = aliases[input];
    if (!input || !model) {
      await this.telegram.sendWithButtons(msg.chatId, "Select model:", [
        { text: "opus", data: "model:opus" },
        { text: "sonnet", data: "model:sonnet" },
        { text: "haiku", data: "model:haiku" },
      ]);
      return;
    }

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);
    if (!this.processManager.hasProcess(session.sessionId)) {
      await this.telegram.send({ chatId: msg.chatId, text: `Model set to ${model}. Will apply on next message.` });
      return;
    }

    const sent = this.processManager.sendControl(session.sessionId, { subtype: "set_model", model });
    await this.telegram.send({
      chatId: msg.chatId,
      text: sent ? `Model switched to ${model}` : "No active process. Send a message first.",
    });
  }

  private async handleEffort(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const level = msg.text.trim().toLowerCase();
    const valid = ["low", "medium", "high", "max"];
    if (!level || !valid.includes(level)) {
      await this.telegram.sendWithButtons(
        msg.chatId,
        "Select effort level:",
        valid.map((v) => ({ text: v, data: `effort:${v}` })),
      );
      return;
    }

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);
    if (!this.processManager.hasProcess(session.sessionId)) {
      await this.telegram.send({ chatId: msg.chatId, text: `Effort set to ${level}. Will apply on next message.` });
      return;
    }

    const sent = this.processManager.sendControl(session.sessionId, {
      subtype: "apply_flag_settings",
      settings: { effortLevel: level },
    });
    await this.telegram.send({
      chatId: msg.chatId,
      text: sent ? `Effort set to ${level}` : "No active process. Send a message first.",
    });
  }

  private async handleInterrupt(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);
    const sent = this.processManager.sendControl(session.sessionId, { subtype: "interrupt" });
    await this.telegram.send({
      chatId: msg.chatId,
      text: sent ? "Interrupted." : "Nothing to interrupt.",
    });
  }

  private async handleTitle(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);
    const userTitle = msg.text.trim();

    if (userTitle) {
      this.sessionManager.update(session.sessionId, { title: userTitle.slice(0, 80) });
      await this.sessionManager.flush(msg.chatId);
      await this.telegram.send({
        chatId: msg.chatId,
        text: `Session #${session.sessionNum} title set to: "${userTitle.slice(0, 80)}"`,
      });
    } else {
      const messageText = "Generate a short title (under 30 characters, Chinese preferred) that summarizes this conversation. Reply with ONLY the title text, nothing else.";
      const progress = new ProgressTracker(this.telegram, msg.chatId, msg.messageId);
      progress.start();
      try {
        let generatedTitle = "";
        for await (const event of this.processManager.sendMessage(session, messageText, this.botId, this.extraArgs)) {
          if (event.type === "assistant" && event.message) {
            const content = event.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (typeof block === "object" && block !== null && "text" in block) {
                  generatedTitle += (block as { text: string }).text;
                }
              }
            } else if (typeof content === "string") {
              generatedTitle += content;
            }
          }
          if (event.type === "result") {
            await progress.finish();
            const title = generatedTitle.trim().replace(/^["']|["']$/g, "").slice(0, 80) || "(untitled)";
            this.sessionManager.update(session.sessionId, { title });
            await this.sessionManager.flush(msg.chatId);
            const progressMsgId = progress.getMessageId();
            if (progressMsgId) {
              await this.telegram.editMessage(msg.chatId, progressMsgId, `Session #${session.sessionNum} title: "${title}"`);
            } else {
              await this.telegram.send({
                chatId: msg.chatId,
                text: `Session #${session.sessionNum} title: "${title}"`,
              });
            }
            break;
          }
          await progress.flush();
        }
      } finally {
        progress.stop();
      }
    }
  }

  // --- Pairing ---

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

  // --- Group management ---

  /** Approve a group pairing code — adds the group to the runtime store */
  approveGroupPairing(code: string): { chatId: string } | null {
    const result = this.pairingManager.approve(code);
    if (!result) return null;
    // The senderId for group pairing is "group:<chatId>"
    const chatId = result.senderId.replace(/^group:/, "");
    this.runtimeGroups = this.loadRuntimeGroups();
    this.runtimeGroups[chatId] = { enabled: true };
    this.saveRuntimeGroups();
    return { chatId };
  }

  /** Add a group to the runtime store */
  addGroup(chatId: string, config?: { allowFrom?: string[] }): void {
    this.runtimeGroups = this.loadRuntimeGroups();
    this.runtimeGroups[chatId] = { enabled: true, ...config };
    this.saveRuntimeGroups();
  }

  /** Remove a group from the runtime store */
  removeGroup(chatId: string): boolean {
    this.runtimeGroups = this.loadRuntimeGroups();
    if (!(chatId in this.runtimeGroups)) return false;
    delete this.runtimeGroups[chatId];
    this.saveRuntimeGroups();
    return true;
  }

  /** Get all configured group chat IDs (config + runtime merged) */
  getGroupChatIds(): string[] {
    return Object.keys(this.mergedGroups());
  }

  /** Get all groups with their config (config + runtime merged) */
  getAllGroups(): Record<string, { enabled: boolean; allowFrom?: string[]; source: "config" | "runtime" | "both" }> {
    const configGroups = this.config.groups;
    this.runtimeGroups = this.loadRuntimeGroups();
    const result: Record<string, { enabled: boolean; allowFrom?: string[]; source: "config" | "runtime" | "both" }> = {};
    for (const [id, g] of Object.entries(configGroups)) {
      result[id] = { ...g, source: id in this.runtimeGroups ? "both" : "config" };
    }
    for (const [id, g] of Object.entries(this.runtimeGroups)) {
      if (!(id in result)) {
        result[id] = { ...g, source: "runtime" };
      }
    }
    return result;
  }
}

// --- Module-level helper functions ---

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Format message with sender name, timestamp, reply/quote context, and group history */
function formatMessageWithMeta(msg: InboundMessage, sessionId?: string): string {
  const dt = new Date(msg.timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;

  const lines: string[] = [];

  // Prepend recent group chat context (with per-session dedup if sessionId available)
  if (msg.isGroup) {
    const groupContext = sessionId
      ? getRecentGroupContextForSession(msg.chatId, msg.threadId, sessionId, 20)
      : getRecentGroupContext(msg.chatId, msg.threadId, 20);
    if (groupContext) {
      lines.push("--- Recent group chat context ---");
      lines.push(groupContext);
      lines.push("--- End of context ---");
      lines.push("");
    }
  }

  lines.push(`[${ts}] ${msg.senderName}:`);

  if (msg.replyText) {
    const quoteName = msg.replySenderName ?? "Unknown";

    if (msg.replyIsQuote) {
      const quoteLines = msg.replyText.split("\n");
      lines.push(`> ${quoteName} (quoted): ${quoteLines[0]}`);
      for (let i = 1; i < quoteLines.length; i++) {
        lines.push(`> ${quoteLines[i]}`);
      }
    } else {
      const HEAD = 50;
      const TAIL = 50;
      const text = msg.replyText.replace(/\n/g, " ").trim();
      const summary = text.length <= HEAD + TAIL + 10
        ? text
        : `${text.slice(0, HEAD)}\u2026${text.slice(-TAIL)}`;
      lines.push(`> ${quoteName}: ${summary}`);
    }
  }

  if (msg.text) {
    lines.push(msg.text);
  }

  return lines.join("\n");
}

/**
 * Extract <<button>> patterns from trailing lines of the response.
 * Only scans from the end -- stops at the first line without buttons.
 */
function extractButtons(text: string): { text: string; buttons: string[] } {
  const lines = text.split("\n");
  const buttons: string[] = [];
  const keepLines: string[] = [];

  for (const line of lines) {
    const found = [...line.matchAll(/<<([^>]+)>>/g)].map((m) => m[1]);
    if (found.length > 0) {
      buttons.push(...found);
      // Remove the button markers from the line, keep any remaining text
      const cleaned = line.replace(/<<[^>]+>>/g, "").trim();
      if (cleaned) keepLines.push(cleaned);
    } else {
      keepLines.push(line);
    }
  }

  if (buttons.length === 0) return { text, buttons: [] };
  return { text: keepLines.join("\n").trimEnd(), buttons };
}
