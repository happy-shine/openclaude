import { randomUUID } from "node:crypto";
import type { Session, ChatSessionState } from "./types.js";
import { SessionStore } from "./store.js";
import { getSessionKey } from "../utils/keys.js";

export class SessionManager {
  private chats = new Map<string, ChatSessionState>();
  private store?: SessionStore;

  constructor(store?: SessionStore) {
    this.store = store;
  }

  loadAll(): void {
    if (!this.store) return;
    for (const key of this.store.listChatIds()) {
      // Parse composite key (chatId_threadId format from storage)
      let chatId: string;
      let threadId: string | undefined;

      // For negative chatIds like "-100123_456", we need to find the right underscore
      if (key.startsWith("-")) {
        // Find underscore that's not at position 0
        const underscoreIdx = key.indexOf("_", 1);
        if (underscoreIdx === -1) {
          chatId = key;
        } else {
          chatId = key.slice(0, underscoreIdx);
          threadId = key.slice(underscoreIdx + 1);
        }
      } else {
        const idx = key.indexOf("_");
        if (idx === -1) {
          chatId = key;
        } else {
          chatId = key.slice(0, idx);
          threadId = key.slice(idx + 1);
        }
      }

      const state = this.store.load(chatId, threadId);
      if (state) {
        const sessionKey = getSessionKey(chatId, threadId);
        this.chats.set(sessionKey, state);
      }
    }
  }

  resolve(chatId: string, channelType: string, isGroup?: boolean, threadId?: string): Session {
    const key = getSessionKey(chatId, threadId);
    const state = this.chats.get(key);
    if (state) {
      const active = state.sessions.find((s) => s.sessionId === state.activeSessionId);
      if (active) {
        // Backfill isGroup for sessions created before this field existed
        if (active.isGroup === undefined && isGroup !== undefined) {
          active.isGroup = isGroup;
        }
        return active;
      }
    }
    return this.createFirst(chatId, channelType, isGroup, threadId);
  }

  private createFirst(chatId: string, channelType: string, isGroup?: boolean, threadId?: string): Session {
    const session: Session = {
      sessionId: randomUUID(),
      chatId,
      threadId,
      channelType,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      isActive: true,
      sessionNum: 1,
      isGroup,
    };
    const state: ChatSessionState = {
      chatId,
      threadId,
      activeSessionId: session.sessionId,
      sessions: [session],
    };
    const key = getSessionKey(chatId, threadId);
    this.chats.set(key, state);
    return session;
  }

  createNew(chatId: string, threadId?: string): Session {
    const key = getSessionKey(chatId, threadId);
    const state = this.chats.get(key);
    if (!state) throw new Error(`No sessions for chat ${key}`);

    for (const s of state.sessions) {
      s.isActive = false;
    }

    const maxNum = Math.max(...state.sessions.map((s) => s.sessionNum ?? 0));

    const session: Session = {
      sessionId: randomUUID(),
      chatId,
      threadId,
      channelType: state.sessions[0].channelType,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      isActive: true,
      sessionNum: maxNum + 1,
    };

    state.sessions.push(session);
    state.activeSessionId = session.sessionId;
    return session;
  }

  switchTo(chatId: string, index: number, threadId?: string): Session | null {
    const key = getSessionKey(chatId, threadId);
    const state = this.chats.get(key);
    if (!state) return null;

    const target = state.sessions[index - 1];
    if (!target) return null;

    for (const s of state.sessions) {
      s.isActive = false;
    }
    target.isActive = true;
    state.activeSessionId = target.sessionId;
    return target;
  }

  list(chatId: string, threadId?: string): Session[] {
    const key = getSessionKey(chatId, threadId);
    const state = this.chats.get(key);
    return state ? [...state.sessions] : [];
  }

  update(sessionId: string, patch: Partial<Pick<Session, "title" | "claudeSessionId" | "lastActiveAt">>): void {
    for (const state of this.chats.values()) {
      const session = state.sessions.find((s) => s.sessionId === sessionId);
      if (session) {
        Object.assign(session, patch);
        return;
      }
    }
  }

  async flush(chatId: string, threadId?: string): Promise<void> {
    if (!this.store) return;
    const key = getSessionKey(chatId, threadId);
    const state = this.chats.get(key);
    if (state) this.store.save(state);
  }

  async flushAll(): Promise<void> {
    if (!this.store) return;
    for (const state of this.chats.values()) {
      this.store.save(state);
    }
  }
}
