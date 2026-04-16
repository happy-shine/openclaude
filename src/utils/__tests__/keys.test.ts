import { describe, it, expect } from "vitest";
import { getSessionKey, getStorageKey, parseSessionKey } from "../keys.js";

describe("key utilities", () => {
  describe("getSessionKey", () => {
    it("returns chatId when no threadId", () => {
      expect(getSessionKey("-100123")).toBe("-100123");
      expect(getSessionKey("-100123", undefined)).toBe("-100123");
    });

    it("returns composite key with threadId", () => {
      expect(getSessionKey("-100123", "456")).toBe("-100123:456");
    });
  });

  describe("getStorageKey", () => {
    it("returns chatId when no threadId", () => {
      expect(getStorageKey("-100123")).toBe("-100123");
    });

    it("returns underscore-separated key with threadId", () => {
      expect(getStorageKey("-100123", "456")).toBe("-100123_456");
    });
  });

  describe("parseSessionKey", () => {
    it("parses plain chatId", () => {
      const result = parseSessionKey("-100123");
      expect(result).toEqual({ chatId: "-100123" });
    });

    it("parses composite key", () => {
      const result = parseSessionKey("-100123:456");
      expect(result).toEqual({ chatId: "-100123", threadId: "456" });
    });

    it("handles chatId with negative sign", () => {
      const result = parseSessionKey("-100123:789");
      expect(result.chatId).toBe("-100123");
      expect(result.threadId).toBe("789");
    });
  });
});
