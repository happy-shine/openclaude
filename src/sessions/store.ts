import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChatSessionState } from "./types.js";
import { getStorageKey } from "../utils/keys.js";

export class SessionStore {
  constructor(private baseDir: string) {}

  private pathFor(chatId: string, threadId?: string): string {
    const key = getStorageKey(chatId, threadId);
    return join(this.baseDir, `${key}.json`);
  }

  load(chatId: string, threadId?: string): ChatSessionState | null {
    const path = this.pathFor(chatId, threadId);
    if (!existsSync(path)) return null;
    const data = readFileSync(path, "utf-8");
    return JSON.parse(data) as ChatSessionState;
  }

  save(state: ChatSessionState): void {
    const path = this.pathFor(state.chatId, state.threadId);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, path);
  }

  listChatIds(): string[] {
    if (!existsSync(this.baseDir)) return [];
    return readdirSync(this.baseDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  }
}
