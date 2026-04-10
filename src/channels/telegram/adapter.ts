import { Bot, type Context } from "grammy";
import type { Logger } from "pino";
import type { ChannelAdapter, OutboundMessage, MessageHandler, CommandHandler } from "../types.js";
import type { MessageStore } from "../../sessions/message-store.js";
import { createBot } from "./bot.js";
import { registerHandlers } from "./handlers.js";
import { splitMessage } from "./formatter.js";
import { writeFileSync, mkdirSync, createReadStream } from "node:fs";
import { join } from "node:path";
import { InputFile } from "grammy";

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram";
  private bot: Bot;
  private log: Logger;
  private token: string;
  private messageHandler?: MessageHandler;
  private commandHandlers = new Map<string, CommandHandler>();
  private callbackHandlers = new Map<string, (ctx: Context) => Promise<void>>();
  private stopped = false;
  private messageStore?: MessageStore;
  private botName: string;

  constructor(token: string, log: Logger) {
    this.token = token;
    this.log = log.child({ module: "telegram" });
    this.bot = createBot(token, this.log);
    this.botName = "Bot";
  }

  /** Inject MessageStore so outbound messages are recorded for chat history */
  setMessageStore(store: MessageStore, botName?: string): void {
    this.messageStore = store;
    if (botName) this.botName = botName;
  }

  /** Record an outbound message to the store and advance all session cursors for this chat */
  private recordOutbound(chatId: string, messageId: string, text: string): void {
    if (!this.messageStore) return;
    // Only record for group chats (negative chat IDs in Telegram)
    if (!chatId.startsWith("-")) return;
    this.messageStore.append(chatId, {
      id: messageId,
      ts: Math.floor(Date.now() / 1000),
      sender: this.botName,
      senderId: this.token.split(":")[0],
      text,
    });
  }

  /** Advance a session's cursor past our own reply so it's not re-injected as context */
  advanceCursorForSession(sessionId: string, messageId: string): void {
    this.messageStore?.advanceCursor(sessionId, messageId);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  /** Register a callback handler for a given prefix (e.g. "sw", "pg", "model") */
  onCallback(prefix: string, handler: (ctx: Context) => Promise<void>): void {
    this.callbackHandlers.set(prefix, handler);
  }

  /** Look up a registered callback handler by prefix */
  getCallbackHandler(prefix: string): ((ctx: Context) => Promise<void>) | undefined {
    return this.callbackHandlers.get(prefix);
  }

  async start(): Promise<void> {
    registerHandlers(this.bot, this.messageHandler, this.commandHandlers, this.log, this.callbackHandlers);

    // Register commands with Telegram so they show in the menu
    const commands = [
      { command: "new", description: "Start a new session" },
      { command: "btw", description: "Quick side question without interrupting current work" },
      { command: "sessions", description: "List sessions or switch (e.g. /sessions 2)" },
      { command: "title", description: "Set session title (empty = auto)" },
      { command: "model", description: "Switch model (sonnet/opus/haiku)" },
      { command: "effort", description: "Set thinking depth (low/medium/high/max)" },
      { command: "stop", description: "Interrupt current task" },
      { command: "help", description: "Show help" },
    ];
    // Register for both default (DM) and group scopes
    await this.bot.api.setMyCommands(commands);
    await this.bot.api.setMyCommands(commands, {
      scope: { type: "all_group_chats" },
    });

    this.startPollingWithRetry();
  }

  private startPollingWithRetry(): void {
    if (this.stopped) return;

    this.bot.start({
      drop_pending_updates: true,
      onStart: (info) => {
        this.log.info({ username: info.username }, "Telegram bot started polling");
      },
    }).catch((err) => {
      if (this.stopped) return;
      const msg = err instanceof Error ? err.message : String(err);
      this.log.error({ error: msg }, "Telegram polling crashed, restarting in 5s...");

      setTimeout(() => {
        if (this.stopped) return;
        this.log.info("Recreating bot and restarting polling...");
        this.bot = createBot(this.token, this.log);
        registerHandlers(this.bot, this.messageHandler, this.commandHandlers, this.log, this.callbackHandlers);
        this.startPollingWithRetry();
      }, 5000);
    });
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.log.info("Stopping Telegram bot");
    await this.bot.stop();
  }

  async send(msg: OutboundMessage): Promise<string> {
    const chunks = splitMessage(msg.text);
    let lastMessageId = "";
    for (let i = 0; i < chunks.length; i++) {
      const sent = await this.bot.api.sendMessage(Number(msg.chatId), chunks[i], {
        ...(i === 0 && msg.replyToMessageId
          ? { reply_parameters: { message_id: Number(msg.replyToMessageId) } }
          : {}),
      });
      lastMessageId = String(sent.message_id);
      this.recordOutbound(msg.chatId, String(sent.message_id), chunks[i]);
    }
    return lastMessageId;
  }

  async editMessage(chatId: string, messageId: string, text: string, buttons?: string[]): Promise<void> {
    const truncated = text.slice(0, 4096);
    try {
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), truncated, {
        ...(buttons && buttons.length > 0
          ? { reply_markup: { inline_keyboard: buildButtonRows(buttons) } }
          : {}),
      });
    } catch (err: unknown) {
      if (err instanceof Error && !err.message?.includes("message is not modified")) throw err;
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), "typing");
  }

  /** Send a photo from local path */
  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendPhoto(Number(chatId), new InputFile(filePath), {
      caption,
    });
  }

  /** Send a document from local path */
  async sendDocument(chatId: string, filePath: string, caption?: string): Promise<void> {
    await this.bot.api.sendDocument(Number(chatId), new InputFile(filePath), {
      caption,
    });
  }

  /** Delete a message */
  async deleteMessage(chatId: string, messageId: string): Promise<void> {
    try {
      await this.bot.api.deleteMessage(Number(chatId), Number(messageId));
    } catch {
      // ignore — message may already be deleted or too old
    }
  }

  /** Remove inline keyboard from a message */
  async removeButtons(chatId: string, messageId: string): Promise<void> {
    try {
      await this.bot.api.editMessageReplyMarkup(Number(chatId), Number(messageId), {
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      // ignore — message may have been deleted or already has no buttons
    }
  }

  /** Send a message with a custom inline keyboard layout */
  async sendWithKeyboard(chatId: string, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>): Promise<string> {
    const truncated = text.slice(0, 4096);
    const sent = await this.bot.api.sendMessage(Number(chatId), truncated, {
      reply_markup: { inline_keyboard: keyboard },
    });
    return String(sent.message_id);
  }

  /** Edit a message's text and inline keyboard */
  async editMessageWithKeyboard(chatId: string, messageId: string, text: string, keyboard: Array<Array<{ text: string; callback_data: string }>>): Promise<void> {
    const truncated = text.slice(0, 4096);
    try {
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), truncated, {
        reply_markup: { inline_keyboard: keyboard },
      });
    } catch (err: unknown) {
      if (err instanceof Error && !err.message?.includes("message is not modified")) throw err;
    }
  }

  /** Send a message with inline keyboard buttons */
  async sendWithButtons(chatId: string, text: string, buttons: (string | { text: string; data: string })[], replyToMessageId?: string): Promise<string> {
    const truncated = text.slice(0, 4096);
    const sent = await this.bot.api.sendMessage(Number(chatId), truncated, {
      ...(replyToMessageId
        ? { reply_parameters: { message_id: Number(replyToMessageId) } }
        : {}),
      reply_markup: { inline_keyboard: buildButtonRows(buttons) },
    });
    this.recordOutbound(chatId, String(sent.message_id), truncated);
    return String(sent.message_id);
  }

  /** Download a Telegram file to local disk, return local path */
  async downloadFile(fileId: string, destDir: string, fileName?: string): Promise<string> {
    const file = await this.bot.api.getFile(fileId);
    const filePath = file.file_path;
    if (!filePath) throw new Error("Telegram returned no file_path");

    const url = `https://api.telegram.org/file/bot${this.token}/${filePath}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to download: ${resp.status}`);

    const buffer = Buffer.from(await resp.arrayBuffer());
    const ext = filePath.includes(".") ? filePath.slice(filePath.lastIndexOf(".")) : "";
    const localName = fileName ?? `${fileId.slice(0, 12)}${ext}`;
    const localPath = join(destDir, localName);

    mkdirSync(destDir, { recursive: true });
    writeFileSync(localPath, buffer);
    return localPath;
  }
}

/** Build inline keyboard rows: ≤3 buttons → single row, >3 → one per row */
function buildButtonRows(buttons: (string | { text: string; data: string })[]): Array<Array<{ text: string; callback_data: string }>> {
  const items = buttons.map((b) =>
    typeof b === "string"
      ? { text: b, callback_data: b.slice(0, 64) }
      : { text: b.text, callback_data: b.data.slice(0, 64) },
  );
  if (items.length <= 3) return [items];
  return items.map((item) => [item]);
}
