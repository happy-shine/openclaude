import { randomUUID } from "node:crypto";
import type { Session, ChatSessionState } from "./types.js";
import { SessionStore } from "./store.js";

export class SessionManager {
  private chats = new Map<string, ChatSessionState>();
  private store?: SessionStore;

  constructor(store?: SessionStore) {
    this.store = store;
  }

  loadAll(): void {
    if (!this.store) return;
    for (const chatId of this.store.listChatIds()) {
      const state = this.store.load(chatId);
      if (state) this.chats.set(chatId, state);
    }
  }

  resolve(chatId: string, channelType: string): Session {
    const state = this.chats.get(chatId);
    if (state) {
      const active = state.sessions.find((s) => s.sessionId === state.activeSessionId);
      if (active) return active;
    }
    return this.createFirst(chatId, channelType);
  }

  private createFirst(chatId: string, channelType: string): Session {
    const session: Session = {
      sessionId: randomUUID(),
      chatId,
      channelType,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      isActive: true,
      sessionNum: 1,
    };
    const state: ChatSessionState = {
      chatId,
      activeSessionId: session.sessionId,
      sessions: [session],
    };
    this.chats.set(chatId, state);
    return session;
  }

  createNew(chatId: string): Session {
    const state = this.chats.get(chatId);
    if (!state) throw new Error(`No sessions for chat ${chatId}`);

    for (const s of state.sessions) {
      s.isActive = false;
    }

    const maxNum = Math.max(...state.sessions.map((s) => s.sessionNum ?? 0));

    const session: Session = {
      sessionId: randomUUID(),
      chatId,
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

  switchTo(chatId: string, index: number): Session | null {
    const state = this.chats.get(chatId);
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

  list(chatId: string): Session[] {
    const state = this.chats.get(chatId);
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

  async flush(chatId: string): Promise<void> {
    if (!this.store) return;
    const state = this.chats.get(chatId);
    if (state) this.store.save(state);
  }

  async flushAll(): Promise<void> {
    if (!this.store) return;
    for (const [chatId] of this.chats) {
      await this.flush(chatId);
    }
  }
}
