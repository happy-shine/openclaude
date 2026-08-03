/**
 * Persistent message store for group chat history.
 *
 * Uses JSONL (one JSON object per line) for append-only, crash-safe persistence.
 * Each chat gets its own file: {dataDir}/messages/{chatId}.jsonl
 *
 * Supports:
 * - Append messages from any source (group chat silent ingest)
 * - Query by time range, sender, keyword, limit
 * - Per-session read cursors (peek recent N unread for passive injection)
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface StoredMessage {
  /** Telegram message_id (unique within chat) */
  id: string;
  /** Unix timestamp (seconds) */
  ts: number;
  /** Sender display name */
  sender: string;
  /** Sender user ID */
  senderId: string;
  /** Text content */
  text: string;
  /** Media references: "photo:file_id", "document:file_id:filename", etc. */
  media?: string[];
}

export interface MessageQueryOptions {
  chatId: string;
  /** Start time (epoch ms) */
  since?: number;
  /** End time (epoch ms) */
  until?: number;
  /** Max messages to return */
  limit?: number;
  /** Filter by sender name (case-insensitive substring) */
  sender?: string;
  /** Full-text search (case-insensitive substring) */
  search?: string;
}

const DEDUP_WINDOW = 500;

export class MessageStore {
  private dir: string;
  /** Per-session cursors: sessionId → last seen message id */
  private cursors = new Map<string, string>();
  /**
   * Recent message ids per chat for deduplication. The gateway may run multiple
   * bots in the same group, and Telegram fans each update out to every bot, so
   * the same messageId can arrive at `append` more than once.
   */
  private recentIds = new Map<string, Set<string>>();

  /** Advance a session's cursor to a specific message id (e.g. after bot sends a reply) */
  advanceCursor(sessionId: string, messageId: string): void {
    this.cursors.set(sessionId, messageId);
  }

  /**
   * Advance a session's cursor to the latest message in a chat.
   * Call this when creating a new session via /new to prevent
   * old-session context from bleeding into the new session.
   */
  advanceCursorToLatest(chatId: string, sessionId: string): void {
    const latest = this.getRecent(chatId, 1);
    if (latest.length > 0) {
      this.cursors.set(sessionId, latest[0].id);
    }
  }

  constructor(dataDir: string) {
    this.dir = join(dataDir, "messages");
    mkdirSync(this.dir, { recursive: true });
  }

  /** Append a message to the chat's JSONL file (deduplicated by messageId) */
  append(chatId: string, msg: StoredMessage): void {
    let ids = this.recentIds.get(chatId);
    if (!ids) {
      ids = new Set<string>();
      for (const m of this.getRecent(chatId, DEDUP_WINDOW)) ids.add(m.id);
      this.recentIds.set(chatId, ids);
    }
    if (ids.has(msg.id)) return;

    const filePath = this.chatFile(chatId);
    appendFileSync(filePath, JSON.stringify(msg) + "\n", "utf-8");
    ids.add(msg.id);

    // Rebuild from file when the set grows large, so memory stays bounded.
    if (ids.size > DEDUP_WINDOW * 2) {
      const fresh = new Set<string>();
      for (const m of this.getRecent(chatId, DEDUP_WINDOW)) fresh.add(m.id);
      this.recentIds.set(chatId, fresh);
    }
  }

  /** Query messages with filters */
  query(opts: MessageQueryOptions): StoredMessage[] {
    const filePath = this.chatFile(opts.chatId);
    if (!existsSync(filePath)) return [];

    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    let messages: StoredMessage[] = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as StoredMessage);
      } catch {
        // skip malformed lines
      }
    }

    // Apply filters
    if (opts.since != null) {
      const sinceSec = opts.since / 1000;
      messages = messages.filter((m) => m.ts >= sinceSec);
    }
    if (opts.until != null) {
      const untilSec = opts.until / 1000;
      messages = messages.filter((m) => m.ts <= untilSec);
    }
    if (opts.sender) {
      const s = opts.sender.toLowerCase();
      messages = messages.filter((m) => m.sender.toLowerCase().includes(s));
    }
    if (opts.search) {
      const q = opts.search.toLowerCase();
      messages = messages.filter((m) => m.text.toLowerCase().includes(q));
    }

    // Apply limit (take last N)
    const limit = opts.limit ?? 200;
    if (messages.length > limit) {
      messages = messages.slice(-limit);
    }

    return messages;
  }

  /** Get recent messages for passive context injection (last N messages) */
  getRecent(chatId: string, count: number): StoredMessage[] {
    const filePath = this.chatFile(chatId);
    if (!existsSync(filePath)) return [];

    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    // Read from end for efficiency
    const result: StoredMessage[] = [];
    const start = Math.max(0, lines.length - count);
    for (let i = start; i < lines.length; i++) {
      try {
        result.push(JSON.parse(lines[i]) as StoredMessage);
      } catch {
        // skip
      }
    }
    return result;
  }

  /**
   * Get recent messages for context injection, deduplicating via per-session cursor.
   * Returns only messages newer than the session's last seen message.
   * Falls back to last `fallback` messages if no cursor exists yet.
   */
  getRecentSince(chatId: string, sessionId: string, fallback: number): StoredMessage[] {
    const filePath = this.chatFile(chatId);
    if (!existsSync(filePath)) return [];

    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    const messages: StoredMessage[] = [];
    for (const line of lines) {
      try {
        messages.push(JSON.parse(line) as StoredMessage);
      } catch {
        // skip
      }
    }

    if (messages.length === 0) return [];

    const cursorId = this.cursors.get(sessionId);

    // Update cursor to latest message
    this.cursors.set(sessionId, messages[messages.length - 1].id);

    if (!cursorId) {
      // No cursor yet — return last N as fallback
      return messages.slice(-fallback);
    }

    // Find cursor position and return everything after it
    const cursorIdx = messages.findIndex((m) => m.id === cursorId);
    if (cursorIdx === -1) {
      // Cursor message was compacted away — return last N
      return messages.slice(-fallback);
    }

    const newMessages = messages.slice(cursorIdx + 1);
    if (newMessages.length === 0) return [];

    // Cap at reasonable amount to avoid huge context
    return newMessages.slice(-50);
  }

  /** Compact a chat file: keep only last N messages (run periodically) */
  compact(chatId: string, keepLast: number = 5000): void {
    const filePath = this.chatFile(chatId);
    if (!existsSync(filePath)) return;

    const raw = readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());

    if (lines.length <= keepLast) return;

    const kept = lines.slice(-keepLast);
    const tmp = filePath + ".tmp";
    writeFileSync(tmp, kept.join("\n") + "\n", "utf-8");
    renameSync(tmp, filePath);
  }

  private chatFile(chatId: string): string {
    const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.dir, `${safe}.jsonl`);
  }
}
