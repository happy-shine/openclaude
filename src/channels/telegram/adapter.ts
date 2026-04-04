import { Bot } from "grammy";
import type { Logger } from "pino";
import type { ChannelAdapter, OutboundMessage, MessageHandler, CommandHandler } from "../types.js";
import { createBot } from "./bot.js";
import { registerHandlers } from "./handlers.js";
import { splitMessage } from "./formatter.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram";
  private bot: Bot;
  private log: Logger;
  private token: string;
  private messageHandler?: MessageHandler;
  private commandHandlers = new Map<string, CommandHandler>();
  private stopped = false;

  constructor(token: string, log: Logger) {
    this.token = token;
    this.log = log.child({ module: "telegram" });
    this.bot = createBot(token, this.log);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onCommand(command: string, handler: CommandHandler): void {
    this.commandHandlers.set(command, handler);
  }

  async start(): Promise<void> {
    registerHandlers(this.bot, this.messageHandler, this.commandHandlers, this.log);

    // Register commands with Telegram so they show in the menu
    await this.bot.api.setMyCommands([
      { command: "new", description: "Start a new session" },
      { command: "switch", description: "Switch to a session (e.g. /switch 2)" },
      { command: "sessions", description: "List all sessions" },
      { command: "help", description: "Show help" },
    ]);

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
        registerHandlers(this.bot, this.messageHandler, this.commandHandlers, this.log);
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
    }
    return lastMessageId;
  }

  async editMessage(chatId: string, messageId: string, text: string): Promise<void> {
    const truncated = text.slice(0, 4096);
    try {
      await this.bot.api.editMessageText(Number(chatId), Number(messageId), truncated);
    } catch (err: unknown) {
      if (err instanceof Error && !err.message?.includes("message is not modified")) throw err;
    }
  }

  async sendTyping(chatId: string): Promise<void> {
    await this.bot.api.sendChatAction(Number(chatId), "typing");
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
