import type { Bot } from "grammy";
import type { Logger } from "pino";
import type { ChannelAdapter, OutboundMessage, MessageHandler, CommandHandler } from "../types.js";
import { createBot } from "./bot.js";
import { registerHandlers } from "./handlers.js";
import { splitMessage } from "./formatter.js";

export class TelegramAdapter implements ChannelAdapter {
  readonly type = "telegram";
  private bot: Bot;
  private log: Logger;
  private messageHandler?: MessageHandler;
  private commandHandlers = new Map<string, CommandHandler>();

  constructor(token: string, log: Logger) {
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
    this.bot.start({
      drop_pending_updates: true,
      onStart: (info) => {
        this.log.info({ username: info.username }, "Telegram bot started polling");
      },
    }).catch((err) => {
      this.log.error({ error: err instanceof Error ? err.message : String(err) }, "Telegram polling crashed");
    });
  }

  async stop(): Promise<void> {
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
}
