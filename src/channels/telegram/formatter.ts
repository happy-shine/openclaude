const TELEGRAM_MAX_LENGTH = 4096;

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

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

export function escapeMarkdownV2(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

/**
 * Convert markdown to Telegram HTML format.
 * Handles the subset of markdown that Claude typically outputs.
 */
export function markdownToHtml(text: string): string {
  // Escape HTML special chars first (but we'll unescape our own tags after)
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Process fenced code blocks first (``` ... ```)
  const codeBlocks: string[] = [];
  let out = text.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`);
    return `\x00CODE${idx}\x00`;
  });

  // Inline code `...`
  const inlineCodes: string[] = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.length;
    inlineCodes.push(`<code>${esc(code)}</code>`);
    return `\x00INLINE${idx}\x00`;
  });

  // Escape remaining HTML
  out = esc(out);

  // Headings → bold
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>");

  // Bold **text** or __text__
  out = out.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  out = out.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic *text* or _text_ (single, not double)
  out = out.replace(/\*([^*\n]+)\*/g, "<i>$1</i>");
  out = out.replace(/_([^_\n]+)_/g, "<i>$1</i>");

  // Restore placeholders
  out = out.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  out = out.replace(/\x00INLINE(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);

  return out;
}
