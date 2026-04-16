/**
 * Composite key utilities for topic-aware session management.
 *
 * Session key format: "chatId:threadId" (for Map keys)
 * Storage key format: "chatId_threadId" (for file paths, Windows-safe)
 */

export function getSessionKey(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}:${threadId}` : chatId;
}

export function getStorageKey(chatId: string, threadId?: string): string {
  return threadId ? `${chatId}_${threadId}` : chatId;
}

export function parseSessionKey(key: string): { chatId: string; threadId?: string } {
  const idx = key.indexOf(":");
  if (idx === -1) return { chatId: key };
  return { chatId: key.slice(0, idx), threadId: key.slice(idx + 1) };
}
