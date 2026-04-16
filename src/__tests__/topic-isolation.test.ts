import { describe, it, expect } from "vitest";
import { SessionManager } from "../sessions/manager.js";
import { getSessionKey, getStorageKey } from "../utils/keys.js";

describe("Topic Isolation Integration", () => {
  it("isolates sessions across different topics in same chat", () => {
    const mgr = new SessionManager();

    // Create sessions in two different topics
    const topic1Session = mgr.resolve("-100123", "telegram", true, "1");
    const topic2Session = mgr.resolve("-100123", "telegram", true, "456");

    // They should be different sessions
    expect(topic1Session.sessionId).not.toBe(topic2Session.sessionId);
    expect(topic1Session.threadId).toBe("1");
    expect(topic2Session.threadId).toBe("456");

    // Creating new session in topic1 shouldn't affect topic2
    mgr.createNew("-100123", "1");
    expect(mgr.list("-100123", "1")).toHaveLength(2);
    expect(mgr.list("-100123", "456")).toHaveLength(1);
  });

  it("generates correct storage keys", () => {
    expect(getStorageKey("-100123", "456")).toBe("-100123_456");
    expect(getStorageKey("-100123")).toBe("-100123");
    expect(getSessionKey("-100123", "456")).toBe("-100123:456");
    expect(getSessionKey("-100123")).toBe("-100123");
  });

  it("maintains backward compatibility with non-topic chats", () => {
    const mgr = new SessionManager();

    // Private chat (no threadId)
    const privateSession = mgr.resolve("123456", "telegram", false);
    expect(privateSession.threadId).toBeUndefined();

    // Regular group (no threadId)
    const groupSession = mgr.resolve("-100789", "telegram", true);
    expect(groupSession.threadId).toBeUndefined();
  });
});
