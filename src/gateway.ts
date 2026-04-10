import type { Logger } from "pino";
import type { GatewayConfig } from "./config/types.js";
import type { InboundMessage } from "./channels/types.js";
import type { StreamEvent } from "./process/types.js";
import { TelegramAdapter } from "./channels/telegram/adapter.js";
import { getRecentGroupContext, getRecentGroupContextForSession, setMessageStore, onCallback } from "./channels/telegram/handlers.js";
import { MessageStore } from "./sessions/message-store.js";
import { SessionManager } from "./sessions/manager.js";
import { SessionStore } from "./sessions/store.js";
import { ProcessManager } from "./process/manager.js";
import { checkAccess } from "./auth/access.js";
import { PairingManager } from "./auth/pairing.js";
import { resolveDataDir } from "./config/loader.js";
import { splitMessage } from "./channels/telegram/formatter.js";
import { ApiServer } from "./api/server.js";
import { ProgressTracker, getToolDetail } from "./progress.js";
import { join, resolve } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, watch, type FSWatcher } from "node:fs";
import { loadConfig } from "./config/loader.js";

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
  /** Track the last message with inline buttons per chat, so we can remove stale buttons */
  private lastButtonMsg = new Map<string, string>();
  /** Accumulated cost per chat (USD) */
  /** Per-chat promise chain: serializes messages within a chat, parallel across chats */
  private chatQueues = new Map<string, Promise<void>>();
  private messageStore: MessageStore;
  private configPath: string;
  private configWatcher?: FSWatcher;

  constructor(config: GatewayConfig, log: Logger, configPath?: string) {
    this.config = config;
    this.log = log;
    this.dataDir = resolveDataDir(config);
    this.configPath = configPath ?? join(this.dataDir, "config.yaml");

    const sessionStore = new SessionStore(join(this.dataDir, "sessions"));
    this.sessionManager = new SessionManager(sessionStore);

    this.messageStore = new MessageStore(this.dataDir);
    setMessageStore(this.messageStore);

    // Build extraArgs with model if configured
    const extraArgs = [...config.claude.extraArgs];
    if (config.claude.model) {
      extraArgs.push("--model", config.claude.model);
    }

    // Extract bot ID from token (part before the colon)
    const botId = config.channels?.telegram?.botToken?.split(":")[0] ?? "default";

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
    const configAllow = this.config.channels?.telegram?.allowFrom ?? [];
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

  reloadConfig(): { ok: boolean; changes: string[] } {
    try {
      const newConfig = loadConfig(this.configPath);
      const changes: string[] = [];

      // Claude process config (applies to newly spawned processes)
      const extraArgs = [...newConfig.claude.extraArgs];
      if (newConfig.claude.model) extraArgs.push("--model", newConfig.claude.model);

      if (newConfig.claude.model !== this.config.claude.model) {
        changes.push(`model: ${this.config.claude.model ?? "default"} → ${newConfig.claude.model ?? "default"}`);
      }
      if (newConfig.claude.maxProcesses !== this.config.claude.maxProcesses) {
        changes.push(`maxProcesses: ${this.config.claude.maxProcesses} → ${newConfig.claude.maxProcesses}`);
      }
      if (newConfig.claude.idleTimeoutMs !== this.config.claude.idleTimeoutMs) {
        changes.push(`idleTimeoutMs: ${this.config.claude.idleTimeoutMs} → ${newConfig.claude.idleTimeoutMs}`);
      }

      this.processManager.updateConfig({
        binary: newConfig.claude.binary,
        idleTimeoutMs: newConfig.claude.idleTimeoutMs,
        maxProcesses: newConfig.claude.maxProcesses,
        extraArgs,
      });

      // Log level
      if (newConfig.gateway.logLevel !== this.config.gateway.logLevel) {
        changes.push(`logLevel: ${this.config.gateway.logLevel} → ${newConfig.gateway.logLevel}`);
        this.log.level = newConfig.gateway.logLevel;
      }

      // Allowed chat IDs for history API
      const tgConfig = newConfig.channels?.telegram;
      if (tgConfig) {
        const newAllowedChatIds = new Set<string>(Object.keys(tgConfig.groups ?? {}));
        this.apiServer?.updateAllowedChatIds(newAllowedChatIds);
      }

      // Refresh allowFrom from config + disk
      this.config = newConfig;
      this.allowFrom = this.loadAllowFrom();

      if (changes.length === 0) changes.push("no changes detected");
      this.log.info({ changes }, "Config reloaded");
      return { ok: true, changes };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ error: msg }, "Config reload failed");
      return { ok: false, changes: [`error: ${msg}`] };
    }
  }

  private setupConfigWatcher(): void {
    let debounceTimer: NodeJS.Timeout | undefined;
    try {
      this.configWatcher = watch(this.configPath, () => {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          this.log.info("Config file changed, reloading...");
          this.reloadConfig();
        }, 500);
      });
      this.log.info({ path: this.configPath }, "Watching config for changes");
    } catch (err) {
      this.log.warn({ error: err instanceof Error ? err.message : String(err) }, "Failed to watch config file");
    }
  }

  async start(): Promise<void> {
    this.log.info("Starting gateway...");
    this.sessionManager.loadAll();

    const tgConfig = this.config.channels?.telegram;
    if (tgConfig) {
      this.telegram = new TelegramAdapter(tgConfig.botToken, this.log);
      this.telegram.setMessageStore(this.messageStore);
      this.telegram.onCommand("new", (msg) => this.handleNewSession(msg));
      this.telegram.onCommand("btw", (msg) => this.handleBtw(msg));
      this.telegram.onCommand("sessions", (msg) => this.handleSessionsCommand(msg));
      this.telegram.onCommand("help", (msg) => this.handleHelp(msg));
      this.telegram.onCommand("model", (msg) => this.handleModel(msg));
      this.telegram.onCommand("effort", (msg) => this.handleEffort(msg));
      this.telegram.onCommand("stop", (msg) => this.handleInterrupt(msg));
      this.telegram.onCommand("title", (msg) => this.handleTitle(msg));

      // Register system callback handlers for session picker
      onCallback("sw", async (ctx) => {
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
          await this.telegram!.send({ chatId, text: `Switched to session #${index}: ${switched.title ?? "(untitled)"}` });
          await this.sessionManager.flush(chatId);
        }
      });

      onCallback("pg", async (ctx) => {
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
        const perPage = Gateway.SESSIONS_PER_PAGE;
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
          if (p > 0) navRow.push({ text: "◀ Prev", callback_data: `pg:${chatId}:${p - 1}` });
          navRow.push({ text: `${p + 1}/${totalPages}`, callback_data: "noop" });
          if (p < totalPages - 1) navRow.push({ text: "Next ▶", callback_data: `pg:${chatId}:${p + 1}` });
          buttonRows.push(navRow);
        }
        await this.telegram!.editMessageWithKeyboard(chatId, messageId, lines.join("\n"), buttonRows);
      });

      onCallback("noop", async () => { /* do nothing */ });

      onCallback("model", async (ctx) => {
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
          await this.telegram!.send({ chatId, text: `Model set to ${value}. Will apply on next message.` });
          return;
        }
        const sent = this.processManager.sendControl(session.sessionId, { subtype: "set_model", model: value });
        await this.telegram!.send({ chatId, text: sent ? `Model switched to ${value}` : "No active process." });
      });

      onCallback("effort", async (ctx) => {
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
          await this.telegram!.send({ chatId, text: `Effort set to ${value}. Will apply on next message.` });
          return;
        }
        const sent = this.processManager.sendControl(session.sessionId, {
          subtype: "apply_flag_settings",
          settings: { effortLevel: value },
        });
        await this.telegram!.send({ chatId, text: sent ? `Effort set to ${value}` : "No active process." });
      });

      this.telegram.onMessage((msg) => this.enqueueChat(msg));
      await this.telegram.start();
      this.log.info("Telegram adapter started");

      // Start API server for file sending
      // Build allowed chat IDs from configured groups for chat history isolation
      const allowedChatIds = new Set<string>(Object.keys(tgConfig.groups ?? {}));
      this.apiServer = new ApiServer({
        port: this.config.gateway.port,
        telegram: this.telegram,
        dataDir: this.dataDir,
        log: this.log,
        messageStore: this.messageStore,
        allowedChatIds,
        onReloadConfig: () => this.reloadConfig(),
      });
      await this.apiServer.start();
    }

    this.setupConfigWatcher();
    this.log.info("Gateway started");
  }

  async stop(): Promise<void> {
    this.log.info("Stopping gateway...");
    this.configWatcher?.close();
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
    const tgConfig = this.config.channels?.telegram!;
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

  /** Enqueue message processing: same chat serialized, different chats parallel */
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

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType, msg.isGroup);

    if (!session.title && msg.text) {
      this.sessionManager.update(session.sessionId, { title: msg.text.slice(0, 50) });
    }

    await this.telegram!.sendTyping(msg.chatId);

    // Remove stale inline buttons from previous message
    const prevBtnMsg = this.lastButtonMsg.get(msg.chatId);
    if (prevBtnMsg) {
      this.lastButtonMsg.delete(msg.chatId);
      this.telegram!.removeButtons(msg.chatId, prevBtnMsg).catch(() => {});
    }

    // Build message with metadata (sender, time, reply context)
    let messageText = formatMessageWithMeta(msg, session.sessionId);

    // Collect all attachments to download (current message + reply media)
    const allAttachments = [
      ...(msg.attachments ?? []).map((a) => ({ att: a, source: "direct" as const })),
      ...(msg.replyAttachments ?? []).map((a) => ({ att: a, source: "reply" as const })),
    ];

    if (allAttachments.length > 0) {
      // Trigger acquire to create the workspace dir
      this.processManager.acquire(session);
      const wsDir = this.processManager.getWorkspaceDir(session.sessionId);
      if (wsDir) {
        const downloadsDir = join(wsDir, "downloads");
        for (const { att, source } of allAttachments) {
          try {
            const localPath = await this.telegram!.downloadFile(
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
            const progressMsgId = progress.getMessageId();

            if (buttons.length > 0) {
              // Buttons: delete progress message, send new message with buttons
              if (progressMsgId) {
                await this.telegram!.deleteMessage(msg.chatId, progressMsgId);
              }
              const btnMsgId = await this.telegram!.sendWithButtons(
                msg.chatId, splitMessage(cleanText)[0], buttons, msg.messageId,
              );
              this.lastButtonMsg.set(msg.chatId, btnMsgId);
              for (const chunk of splitMessage(cleanText).slice(1)) {
                await this.telegram!.send({ chatId: msg.chatId, text: chunk });
              }
            } else if (progressMsgId) {
              // Has progress message: edit it to final content (no duplicate)
              // Then send a lightweight "done" notification so user gets a ping
              await this.telegram!.editMessage(msg.chatId, progressMsgId, splitMessage(cleanText)[0]);
              for (const chunk of splitMessage(cleanText).slice(1)) {
                await this.telegram!.send({ chatId: msg.chatId, text: chunk });
              }
            } else {
              // No progress message: send as new message
              for (let i = 0; i < splitMessage(cleanText).length; i++) {
                await this.telegram!.send({
                  chatId: msg.chatId,
                  text: splitMessage(cleanText)[i],
                  ...(i === 0 ? { replyToMessageId: msg.messageId } : {}),
                });
              }
            }
          } else if (event.is_error) {
            await this.telegram!.send({
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
    // so they won't be re-injected as group context next time
    if (msg.isGroup) {
      const latest = this.messageStore.getRecent(msg.chatId, 1);
      if (latest.length > 0) {
        this.messageStore.advanceCursor(session.sessionId, latest[0].id);
      }
    }
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

  private async handleBtw(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const question = msg.text.trim();
    if (!question) {
      await this.telegram!.send({ chatId: msg.chatId, text: "Usage: /btw <question>" });
      return;
    }

    // Get current active session
    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);
    if (!session.claudeSessionId) {
      await this.telegram!.send({
        chatId: msg.chatId,
        text: "No active session to fork from. Send a message first.",
      });
      return;
    }

    this.log.info(
      { chatId: msg.chatId, sessionId: session.sessionId, claudeSessionId: session.claudeSessionId },
      "/btw: forking session",
    );

    const progress = new ProgressTracker(this.telegram!, msg.chatId, msg.messageId);
    progress.start();

    try {
      for await (const event of this.processManager.forkAndAsk(session, question)) {
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
            const chunks = splitMessage(finalText);
            if (progressMsgId) {
              await this.telegram!.editMessage(msg.chatId, progressMsgId, chunks[0]);
              for (const chunk of chunks.slice(1)) {
                await this.telegram!.send({ chatId: msg.chatId, text: chunk });
              }
            } else {
              for (let i = 0; i < chunks.length; i++) {
                await this.telegram!.send({
                  chatId: msg.chatId,
                  text: chunks[i],
                  ...(i === 0 ? { replyToMessageId: msg.messageId } : {}),
                });
              }
            }
          } else if (event.is_error) {
            const progressMsgId = progress.getMessageId();
            const errText = `btw error: ${event.result ?? "Unknown error"}`;
            if (progressMsgId) {
              await this.telegram!.editMessage(msg.chatId, progressMsgId, errText);
            } else {
              await this.telegram!.send({ chatId: msg.chatId, text: errText });
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
      await this.telegram!.send({ chatId: msg.chatId, text: `btw error: ${errMsg}` });
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
    await this.telegram!.send({
      chatId: msg.chatId,
      text: `New session started. (Session #${count})`,
    });
    await this.sessionManager.flush(msg.chatId);
  }

  private async handleSessionsCommand(msg: InboundMessage): Promise<void> {
    const index = parseInt(msg.text, 10);
    if (!isNaN(index)) {
      // /sessions N → switch to session #N
      const access = this.checkMessageAccess(msg);
      if (!access.allowed) return;
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
      return;
    }
    // /sessions → list with buttons
    await this.handleListSessions(msg);
  }

  private static readonly SESSIONS_PER_PAGE = 10;

  private async handleListSessions(msg: InboundMessage, page = 0): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const sessions = this.sessionManager.list(msg.chatId).reverse();
    if (sessions.length === 0) {
      await this.telegram!.send({ chatId: msg.chatId, text: "No sessions yet." });
      return;
    }

    const perPage = Gateway.SESSIONS_PER_PAGE;
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

    // Build inline keyboard: one row of session buttons, then nav row
    const sessionButtons = slice.map((s) => {
      return { text: `${s.sessionNum}`, callback_data: `sw:${msg.chatId}:${s.sessionNum}` };
    });
    // Split into rows of 5
    const buttonRows: Array<Array<{ text: string; callback_data: string }>> = [];
    for (let i = 0; i < sessionButtons.length; i += 5) {
      buttonRows.push(sessionButtons.slice(i, i + 5));
    }
    // Navigation row
    if (totalPages > 1) {
      const navRow: Array<{ text: string; callback_data: string }> = [];
      if (p > 0) navRow.push({ text: "◀ Prev", callback_data: `pg:${msg.chatId}:${p - 1}` });
      navRow.push({ text: `${p + 1}/${totalPages}`, callback_data: "noop" });
      if (p < totalPages - 1) navRow.push({ text: "Next ▶", callback_data: `pg:${msg.chatId}:${p + 1}` });
      buttonRows.push(navRow);
    }

    await this.telegram!.sendWithKeyboard(msg.chatId, text, buttonRows);
  }

  private async handleHelp(msg: InboundMessage): Promise<void> {
    const text = [
      "OpenClaude Commands:",
      "",
      "/new — Start a new session",
      "/btw <question> — Quick side question (non-blocking)",
      "/sessions [N] — List sessions or switch to #N",
      "/model [name] — Switch model (sonnet/opus/haiku)",
      "/effort [level] — Set thinking depth (low/medium/high/max)",
      "/stop — Interrupt current task",
      "/title [text] — Set session title (empty = auto-generate)",
      "/help — Show this help",
    ].join("\n");
    await this.telegram!.send({ chatId: msg.chatId, text });
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
      await this.telegram!.sendWithButtons(msg.chatId, "Select model:", [
        { text: "opus", data: "model:opus" },
        { text: "sonnet", data: "model:sonnet" },
        { text: "haiku", data: "model:haiku" },
      ]);
      return;
    }

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);
    if (!this.processManager.hasProcess(session.sessionId)) {
      await this.telegram!.send({ chatId: msg.chatId, text: `Model set to ${model}. Will apply on next message.` });
      return;
    }

    const sent = this.processManager.sendControl(session.sessionId, { subtype: "set_model", model });
    await this.telegram!.send({
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
      await this.telegram!.sendWithButtons(
        msg.chatId,
        "Select effort level:",
        valid.map((v) => ({ text: v, data: `effort:${v}` })),
      );
      return;
    }

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);
    if (!this.processManager.hasProcess(session.sessionId)) {
      await this.telegram!.send({ chatId: msg.chatId, text: `Effort set to ${level}. Will apply on next message.` });
      return;
    }

    const sent = this.processManager.sendControl(session.sessionId, {
      subtype: "apply_flag_settings",
      settings: { effortLevel: level },
    });
    await this.telegram!.send({
      chatId: msg.chatId,
      text: sent ? `Effort set to ${level}` : "No active process. Send a message first.",
    });
  }

  private async handleInterrupt(msg: InboundMessage): Promise<void> {
    const access = this.checkMessageAccess(msg);
    if (!access.allowed) return;

    const session = this.sessionManager.resolve(msg.chatId, msg.channelType);
    const sent = this.processManager.sendControl(session.sessionId, { subtype: "interrupt" });
    await this.telegram!.send({
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
      // /title <text> → use provided title
      this.sessionManager.update(session.sessionId, { title: userTitle.slice(0, 80) });
      await this.sessionManager.flush(msg.chatId);
      await this.telegram!.send({
        chatId: msg.chatId,
        text: `Session #${session.sessionNum} title set to: "${userTitle.slice(0, 80)}"`,
      });
    } else {
      // /title (no arg) → ask Claude Code to generate a title
      const messageText = "Generate a short title (under 30 characters, Chinese preferred) that summarizes this conversation. Reply with ONLY the title text, nothing else.";
      const progress = new ProgressTracker(this.telegram!, msg.chatId, msg.messageId);
      progress.start();
      try {
        let generatedTitle = "";
        for await (const event of this.processManager.sendMessage(session, messageText)) {
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
              await this.telegram!.editMessage(msg.chatId, progressMsgId, `Session #${session.sessionNum} title: "${title}"`);
            } else {
              await this.telegram!.send({
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

/** Format message with sender name, timestamp, reply/quote context, and group history */
function formatMessageWithMeta(msg: InboundMessage, sessionId?: string): string {
  const dt = new Date(msg.timestamp * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const ts = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;

  const lines: string[] = [];

  // Prepend recent group chat context (with per-session dedup if sessionId available)
  if (msg.isGroup) {
    const groupContext = sessionId
      ? getRecentGroupContextForSession(msg.chatId, sessionId, 20)
      : getRecentGroupContext(msg.chatId, 20);
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
      // Quote: user intentionally selected text — keep full content
      const quoteLines = msg.replyText.split("\n");
      lines.push(`> ${quoteName} (quoted): ${quoteLines[0]}`);
      for (let i = 1; i < quoteLines.length; i++) {
        lines.push(`> ${quoteLines[i]}`);
      }
    } else {
      // Reply: full message already in Claude's history — head…tail to save tokens
      const HEAD = 50;
      const TAIL = 50;
      const text = msg.replyText.replace(/\n/g, " ").trim();
      const summary = text.length <= HEAD + TAIL + 10
        ? text
        : `${text.slice(0, HEAD)}…${text.slice(-TAIL)}`;
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
