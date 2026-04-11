import { convert } from "telegram-markdown-v2";

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Convert standard Markdown (as Claude outputs) to Telegram MarkdownV2.
 * Falls back to escaping all special chars if the converter throws.
 */
export function toMarkdownV2(text: string): string {
  try {
    return convert(text);
  } catch {
    return escapeMarkdownV2(text);
  }
}

export function splitMessage(text: string, maxLength = TELEGRAM_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf("\n", maxLength);
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      splitIdx = remaining.lastIndexOf(" ", maxLength);
    }
    if (splitIdx === -1 || splitIdx < maxLength * 0.5) {
      splitIdx = maxLength;
    }

    // Don't split in the middle of a MarkdownV2 escape sequence (\X)
    if (splitIdx > 0 && remaining[splitIdx - 1] === "\\") {
      splitIdx--;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/** Truncate text without breaking MarkdownV2 escape sequences */
export function truncateV2(text: string, maxLength = TELEGRAM_MAX_LENGTH): string {
  if (text.length <= maxLength) return text;
  let idx = maxLength;
  if (idx > 0 && text[idx - 1] === "\\") idx--;
  return text.slice(0, idx);
}

export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
