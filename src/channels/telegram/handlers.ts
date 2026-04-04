import type { Bot, Context } from "grammy";
import type { InboundMessage, MessageHandler, CommandHandler, Attachment } from "../types.js";
import type { Logger } from "pino";

/** Buffer for collecting media group messages that arrive as separate updates */
const mediaGroupBuffers = new Map<string, {
  messages: Array<{ msg: InboundMessage; attachments: Attachment[] }>;
  timer: ReturnType<typeof setTimeout>;
  text: string;
}>();

const MEDIA_GROUP_WAIT_MS = 500;

export function registerHandlers(
  bot: Bot,
  messageHandler: MessageHandler | undefined,
  commandHandlers: Map<string, CommandHandler>,
  log: Logger,
): void {
  for (const [cmd, handler] of commandHandlers) {
    bot.command(cmd, async (ctx) => {
      const msg = contextToInbound(ctx);
      if (!msg) return;
      const text = ctx.message?.text ?? "";
      const spaceIdx = text.indexOf(" ");
      msg.text = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";
      await handler(msg);
    });
  }

  bot.on("message:text", async (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    if (!messageHandler) return;
    const msg = contextToInbound(ctx);
    if (!msg) return;

    if (msg.isGroup) {
      const result = checkGroupMention(ctx, msg, ctx.message.text);
      if (!result) return;
      msg.text = result;
    }

    await messageHandler(msg);
  });

  bot.on("message:photo", async (ctx) => {
    if (!messageHandler) return;
    const msg = contextToInbound(ctx);
    if (!msg) return;

    const caption = ctx.message.caption ?? "";

    if (msg.isGroup) {
      const result = checkGroupMention(ctx, msg, caption);
      if (result === null) return;
      msg.text = result;
    } else {
      msg.text = caption;
    }

    const photo = ctx.message.photo;
    const largest = photo[photo.length - 1];
    const attachment: Attachment = { type: "photo", fileId: largest.file_id };

    const mediaGroupId = ctx.message.media_group_id;
    if (mediaGroupId) {
      bufferMediaGroup(mediaGroupId, msg, [attachment], msg.text, messageHandler, log);
    } else {
      msg.attachments = [attachment];
      await messageHandler(msg);
    }
  });

  bot.on("message:document", async (ctx) => {
    if (!messageHandler) return;
    const msg = contextToInbound(ctx);
    if (!msg) return;

    const caption = ctx.message.caption ?? "";

    if (msg.isGroup) {
      const result = checkGroupMention(ctx, msg, caption);
      // For media groups, allow through even without mention —
      // the caption (with @mention) is only on the first message
      const mediaGroupId = ctx.message.media_group_id;
      if (result === null && !mediaGroupId) return;
      msg.text = result ?? "";
    } else {
      msg.text = caption;
    }

    const doc = ctx.message.document;
    const attachment: Attachment = {
      type: "document",
      fileId: doc.file_id,
      fileName: doc.file_name,
      mimeType: doc.mime_type,
    };

    const mediaGroupId = ctx.message.media_group_id;
    if (mediaGroupId) {
      bufferMediaGroup(mediaGroupId, msg, [attachment], msg.text, messageHandler, log);
    } else {
      msg.attachments = [attachment];
      await messageHandler(msg);
    }
  });
}

/**
 * Check if the bot is mentioned or replied-to in a group message.
 * Returns the cleaned text (with @mention stripped) or null if not targeted.
 */
function checkGroupMention(ctx: Context, msg: InboundMessage, text: string): string | null {
  const botUsername = ctx.me.username;
  const isReplyToBot = ctx.message?.reply_to_message?.from?.id === ctx.me.id;
  const isMentioned = botUsername && text.includes(`@${botUsername}`);

  if (!isMentioned && !isReplyToBot) return null;

  if (isMentioned && botUsername) {
    return text.replace(new RegExp(`@${botUsername}`, "gi"), "").trim();
  }
  return text;
}

/**
 * Buffer media group messages and flush them as a single InboundMessage
 * after a short delay (Telegram sends each file as a separate update).
 */
function bufferMediaGroup(
  mediaGroupId: string,
  msg: InboundMessage,
  attachments: Attachment[],
  text: string,
  handler: MessageHandler,
  log: Logger,
): void {
  const existing = mediaGroupBuffers.get(mediaGroupId);

  if (existing) {
    existing.messages.push({ msg, attachments });
    // Keep the non-empty text (caption is usually only on the first message)
    if (text && !existing.text) existing.text = text;
    return;
  }

  const buffer = {
    messages: [{ msg, attachments }],
    text,
    timer: setTimeout(async () => {
      mediaGroupBuffers.delete(mediaGroupId);
      const buf = buffer;

      if (buf.messages.length === 0) return;

      // Use the first message as the base, merge all attachments
      const base = buf.messages[0].msg;
      base.text = buf.text;
      base.attachments = buf.messages.flatMap((m) => m.attachments);

      // In groups: if none of the messages had a valid @mention/reply,
      // the text will be empty and we should check if we should skip
      if (base.isGroup && !buf.text && !base.replyToMessageId) {
        log.debug({ mediaGroupId }, "Media group in group without mention, skipping");
        return;
      }

      log.info(
        { mediaGroupId, fileCount: base.attachments.length },
        "Processing media group",
      );
      await handler(base);
    }, MEDIA_GROUP_WAIT_MS),
  };

  mediaGroupBuffers.set(mediaGroupId, buffer);
}

function contextToInbound(ctx: Context): InboundMessage | null {
  const msg = ctx.message;
  if (!msg) return null;

  const chatId = String(msg.chat.id);
  const senderId = String(msg.from?.id ?? "unknown");
  const senderName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(" ") || "Unknown";

  return {
    channelType: "telegram",
    chatId,
    senderId,
    senderName,
    messageId: String(msg.message_id),
    text: msg.text ?? "",
    isGroup: msg.chat.type === "group" || msg.chat.type === "supergroup",
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    replyToMessageId: msg.reply_to_message?.message_id ? String(msg.reply_to_message.message_id) : undefined,
    raw: msg,
  };
}
