import { describe, it, expect, beforeEach } from "vitest";
import { SessionManager } from "../manager.js";

describe("SessionManager", () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager();
  });

  it("auto-creates first session on resolve", () => {
    const s = mgr.resolve("chat1", "telegram");
    expect(s.chatId).toBe("chat1");
    expect(s.isActive).toBe(true);
    expect(s.channelType).toBe("telegram");
  });

  it("returns same active session on repeated resolve", () => {
    const s1 = mgr.resolve("chat1", "telegram");
    const s2 = mgr.resolve("chat1", "telegram");
    expect(s1.sessionId).toBe(s2.sessionId);
  });

  it("creates new session and deactivates old", () => {
    const s1 = mgr.resolve("chat1", "telegram");
    const s2 = mgr.createNew("chat1");
    expect(s2.isActive).toBe(true);
    expect(s2.sessionId).not.toBe(s1.sessionId);
    const all = mgr.list("chat1");
    const old = all.find((s) => s.sessionId === s1.sessionId);
    expect(old?.isActive).toBe(false);
  });

  it("switches between sessions", () => {
    mgr.resolve("chat1", "telegram");
    mgr.createNew("chat1");
    mgr.createNew("chat1");
    const switched = mgr.switchTo("chat1", 1);
    expect(switched).not.toBeNull();
    expect(switched!.isActive).toBe(true);
    const all = mgr.list("chat1");
    expect(all.filter((s) => s.isActive)).toHaveLength(1);
  });

  it("returns null for invalid switch index", () => {
    mgr.resolve("chat1", "telegram");
    expect(mgr.switchTo("chat1", 99)).toBeNull();
  });

  it("lists sessions in creation order", () => {
    mgr.resolve("chat1", "telegram");
    mgr.createNew("chat1");
    mgr.createNew("chat1");
    const all = mgr.list("chat1");
    expect(all).toHaveLength(3);
    expect(all[0].createdAt).toBeLessThanOrEqual(all[1].createdAt);
  });

  it("assigns incrementing sessionNum", () => {
    const s1 = mgr.resolve("chat1", "telegram");
    expect(s1.sessionNum).toBe(1);
    const s2 = mgr.createNew("chat1");
    expect(s2.sessionNum).toBe(2);
    const s3 = mgr.createNew("chat1");
    expect(s3.sessionNum).toBe(3);
  });

  it("updates session fields", () => {
    const s = mgr.resolve("chat1", "telegram");
    mgr.update(s.sessionId, { title: "My chat", claudeSessionId: "claude-123" });
    const updated = mgr.resolve("chat1", "telegram");
    expect(updated.title).toBe("My chat");
    expect(updated.claudeSessionId).toBe("claude-123");
  });
});

describe("SessionManager with threadId", () => {
  let mgr: SessionManager;

  beforeEach(() => {
    mgr = new SessionManager();
  });

  it("isolates sessions by threadId", () => {
    const s1 = mgr.resolve("chat1", "telegram", true, "thread1");
    const s2 = mgr.resolve("chat1", "telegram", true, "thread2");
    expect(s1.sessionId).not.toBe(s2.sessionId);
    expect(s1.threadId).toBe("thread1");
    expect(s2.threadId).toBe("thread2");
  });

  it("returns same session for same chatId+threadId", () => {
    const s1 = mgr.resolve("chat1", "telegram", true, "thread1");
    const s2 = mgr.resolve("chat1", "telegram", true, "thread1");
    expect(s1.sessionId).toBe(s2.sessionId);
  });

  it("lists only sessions for specific threadId", () => {
    mgr.resolve("chat1", "telegram", true, "thread1");
    mgr.createNew("chat1", "thread1");
    mgr.resolve("chat1", "telegram", true, "thread2");

    const thread1Sessions = mgr.list("chat1", "thread1");
    const thread2Sessions = mgr.list("chat1", "thread2");

    expect(thread1Sessions).toHaveLength(2);
    expect(thread2Sessions).toHaveLength(1);
  });

  it("switches sessions within same threadId", () => {
    mgr.resolve("chat1", "telegram", true, "thread1");
    mgr.createNew("chat1", "thread1");
    const switched = mgr.switchTo("chat1", 1, "thread1");
    expect(switched).not.toBeNull();
    expect(switched!.threadId).toBe("thread1");
  });

  it("returns null when switching in wrong threadId", () => {
    mgr.resolve("chat1", "telegram", true, "thread1");
    mgr.createNew("chat1", "thread1");
    const switched = mgr.switchTo("chat1", 1, "thread2");
    expect(switched).toBeNull();
  });
});
