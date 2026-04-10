import type { Bot, Context } from "grammy";
import type { InboundMessage, MessageHandler, CommandHandler, Attachment } from "../types.js";
import type { Logger } from "pino";
import type { MessageStore, StoredMessage } from "../../sessions/message-store.js";

/** Buffer for collecting media group messages that arrive as separate updates */
const mediaGroupBuffers = new Map<string, {
  messages: Array<{ msg: InboundMessage; attachments: Attachment[] }>;
  timer: ReturnType<typeof setTimeout>;
  text: string;
}>();

const MEDIA_GROUP_WAIT_MS = 500;

/** System callback handlers — keyed by prefix before ':' (e.g. "sw", "pg") */
const callbackHandlers = new Map<string, (ctx: Context) => Promise<void>>();

/** Register a system callback handler for a given prefix */
export function onCallback(prefix: string, handler: (ctx: Context) => Promise<void>): void {
  callbackHandlers.set(prefix, handler);
}

/** Message store instance, set via setMessageStore() */
let messageStore: MessageStore | undefined;

/** Set the persistent message store (called from gateway.ts) */
export function setMessageStore(store: MessageStore): void {
  messageStore = store;
}

/** Record a group message — persists to MessageStore if available, otherwise no-op */
function recordGroupMessage(chatId: string, msg: {
  messageId: string;
  senderName: string;
  senderId: string;
  text: string;
  timestamp: number;
  media?: string[];
}): void {
  if (!messageStore) return;
  messageStore.append(chatId, {
    id: msg.messageId,
    ts: msg.timestamp,
    sender: msg.senderName,
    senderId: msg.senderId,
    text: msg.text,
    media: msg.media,
  });
}

/** Get recent group messages formatted as context string (peek, not drain) */
export function getRecentGroupContext(chatId: string, count: number = 20): string {
  if (!messageStore) return "";
  const messages = messageStore.getRecent(chatId, count);
  if (messages.length === 0) return "";
  return formatMessages(messages);
}

/**
 * Get group context with per-session deduplication.
 * Only returns messages the session hasn't seen yet.
 */
export function getRecentGroupContextForSession(chatId: string, sessionId: string, fallback: number = 20): string {
  if (!messageStore) return "";
  const messages = messageStore.getRecentSince(chatId, sessionId, fallback);
  if (messages.length === 0) return "";
  return formatMessages(messages);
}

function formatMessages(messages: import("../../sessions/message-store.js").StoredMessage[]): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const lines = messages.map((m) => {
    const dt = new Date(m.ts * 1000);
    const ts = `${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
    return `[${ts}] ${m.sender}: ${m.text}`;
  });
  return lines.join("\n");
}

export function registerHandlers(
  bot: Bot,
  messageHandler: MessageHandler | undefined,
  commandHandlers: Map<string, CommandHandler>,
  log: Logger,
  adapterCallbackHandlers?: Map<string, (ctx: Context) => Promise<void>>,
): void {
  for (const [cmd, handler] of commandHandlers) {
    bot.command(cmd, (ctx) => {
      const msg = contextToInbound(ctx);
      if (!msg) return;
      const text = ctx.message?.text ?? "";
      const spaceIdx = text.indexOf(" ");
      msg.text = spaceIdx > 0 ? text.slice(spaceIdx + 1).trim() : "";
      handler(msg).catch((err: unknown) => {
        log.error({ error: err instanceof Error ? err.message : String(err), cmd }, "Command handler failed");
      });
    });
  }

  bot.on("message:text", (ctx) => {
    if (ctx.message.text.startsWith("/")) return;
    if (!messageHandler) return;
    const msg = contextToInbound(ctx);
    if (!msg) return;

    if (msg.isGroup) {
      const result = checkGroupMention(ctx, msg, ctx.message.text);
      if (!result) {
        // Not targeted at bot — silently record for group context
        recordGroupMessage(msg.chatId, {
          messageId: msg.messageId,
          senderName: msg.senderName,
          senderId: msg.senderId,
          text: ctx.message.text,
          timestamp: msg.timestamp,
        });
        return;
      }
      msg.text = result;
    }

    messageHandler(msg).catch((err: unknown) => {
      log.error({ error: err instanceof Error ? err.message : String(err) }, "Message handler failed");
    });
  });

  bot.on("message:photo", (ctx) => {
    if (!messageHandler) return;
    const msg = contextToInbound(ctx);
    if (!msg) return;

    const caption = ctx.message.caption ?? "";

    if (msg.isGroup) {
      const result = checkGroupMention(ctx, msg, caption);
      if (result === null) {
        const photo = ctx.message.photo;
        const largest = photo[photo.length - 1];
        recordGroupMessage(msg.chatId, {
          messageId: msg.messageId,
          senderName: msg.senderName,
          senderId: msg.senderId,
          text: caption ? `[Photo] ${caption}` : "[Photo]",
          timestamp: msg.timestamp,
          media: [`photo:${largest.file_id}`],
        });
        return;
      }
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
      messageHandler(msg).catch((err: unknown) => {
        log.error({ error: err instanceof Error ? err.message : String(err) }, "Photo handler failed");
      });
    }
  });

  // --- Inline button callback ---
  bot.on("callback_query:data", async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (!data) return;

    // Check adapter-level callback handlers first (per-bot), then module-level fallback
    const prefix = data.split(":")[0];
    const systemHandler = adapterCallbackHandlers?.get(prefix) ?? callbackHandlers.get(prefix);
    if (systemHandler) {
      await ctx.answerCallbackQuery();
      await systemHandler(ctx);
      return;
    }

    if (!messageHandler) return;

    await ctx.answerCallbackQuery();

    // Edit message: show selection, remove buttons
    try {
      const orig = ctx.callbackQuery.message;
      if (orig && "text" in orig) {
        await ctx.editMessageText(orig.text + `\n\n→ ${data}`, {
          reply_markup: { inline_keyboard: [] },
        });
      }
    } catch {
      // ignore edit failures
    }

    // Route as regular user message
    const chat = ctx.callbackQuery.message?.chat;
    const from = ctx.callbackQuery.from;
    if (!chat) return;

    const msg: InboundMessage = {
      channelType: "telegram",
      chatId: String(chat.id),
      senderId: String(from.id),
      senderName: [from.first_name, from.last_name].filter(Boolean).join(" ") || "Unknown",
      messageId: String(ctx.callbackQuery.message?.message_id ?? ""),
      text: data,
      isGroup: chat.type === "group" || chat.type === "supergroup",
      timestamp: Math.floor(Date.now() / 1000),
      raw: ctx.callbackQuery,
    };

    messageHandler(msg).catch((err: unknown) => {
      log.error({ error: err instanceof Error ? err.message : String(err) }, "Callback handler failed");
    });
  });

  bot.on("message:document", (ctx) => {
    if (!messageHandler) return;
    const msg = contextToInbound(ctx);
    if (!msg) return;

    const caption = ctx.message.caption ?? "";

    if (msg.isGroup) {
      const result = checkGroupMention(ctx, msg, caption);
      // For media groups, allow through even without mention —
      // the caption (with @mention) is only on the first message
      const mediaGroupId = ctx.message.media_group_id;
      if (result === null && !mediaGroupId) {
        const doc = ctx.message.document;
        const fileName = doc?.file_name;
        recordGroupMessage(msg.chatId, {
          messageId: msg.messageId,
          senderName: msg.senderName,
          senderId: msg.senderId,
          text: caption
            ? `[File: ${fileName ?? "document"}] ${caption}`
            : `[File: ${fileName ?? "document"}]`,
          timestamp: msg.timestamp,
          media: doc ? [`document:${doc.file_id}:${fileName ?? ""}`] : undefined,
        });
        return;
      }
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
      messageHandler(msg).catch((err: unknown) => {
        log.error({ error: err instanceof Error ? err.message : String(err) }, "Document handler failed");
      });
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
    timer: setTimeout(() => {
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
      handler(base).catch((err: unknown) => {
        log.error({ error: err instanceof Error ? err.message : String(err) }, "Media group handler failed");
      });
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

  const reply = msg.reply_to_message;
  let replyText: string | undefined;
  let replySenderName: string | undefined;
  let replyIsQuote = false;
  const replyAttachments: Attachment[] = [];
  if (reply) {
    replySenderName = [reply.from?.first_name, reply.from?.last_name].filter(Boolean).join(" ") || undefined;

    // Prefer explicit quote text (user selected specific text) over full message
    const quoteText = (msg as unknown as Record<string, unknown>).quote as { text?: string } | undefined;
    if (quoteText?.text) {
      replyText = quoteText.text;
      replyIsQuote = true;
    } else {
      // Full reply message text/caption
      replyText = reply.text ?? reply.caption ?? undefined;
    }

    // Extract media from reply message so gateway can download them
    const r = reply as unknown as Record<string, unknown>;
    if (r.photo) {
      const photos = r.photo as Array<{ file_id: string }>;
      const largest = photos[photos.length - 1];
      if (largest) {
        replyAttachments.push({ type: "photo", fileId: largest.file_id });
      }
      if (!replyText) replyText = "[Photo]";
    }
    if (r.document) {
      const doc = r.document as { file_id: string; file_name?: string; mime_type?: string };
      replyAttachments.push({
        type: "document",
        fileId: doc.file_id,
        fileName: doc.file_name,
        mimeType: doc.mime_type,
      });
      if (!replyText) replyText = doc.file_name ? `[File: ${doc.file_name}]` : "[Document]";
    }
    if (r.video) {
      const vid = r.video as { file_id: string };
      replyAttachments.push({ type: "video", fileId: vid.file_id });
      if (!replyText) replyText = "[Video]";
    }
    if (r.voice) {
      const voice = r.voice as { file_id: string; mime_type?: string };
      replyAttachments.push({ type: "voice", fileId: voice.file_id, mimeType: voice.mime_type });
      if (!replyText) replyText = "[Voice message]";
    }
    if (r.audio) {
      const audio = r.audio as { file_id: string; file_name?: string; mime_type?: string };
      replyAttachments.push({
        type: "audio",
        fileId: audio.file_id,
        fileName: audio.file_name,
        mimeType: audio.mime_type,
      });
      if (!replyText) replyText = "[Audio]";
    }
    if (!replyText) {
      if (r.sticker) {
        const sticker = r.sticker as { emoji?: string };
        replyText = sticker.emoji ? `[Sticker ${sticker.emoji}]` : "[Sticker]";
      } else if (r.animation) {
        replyText = "[GIF]";
      }
    }
  }

  return {
    channelType: "telegram",
    chatId,
    senderId,
    senderName,
    messageId: String(msg.message_id),
    text: msg.text ?? "",
    isGroup: msg.chat.type === "group" || msg.chat.type === "supergroup",
    timestamp: msg.date,
    threadId: msg.message_thread_id ? String(msg.message_thread_id) : undefined,
    replyToMessageId: reply?.message_id ? String(reply.message_id) : undefined,
    replyText,
    replySenderName,
    replyIsQuote,
    replyAttachments: replyAttachments.length > 0 ? replyAttachments : undefined,
    raw: msg,
  };
}
