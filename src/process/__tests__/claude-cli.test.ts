import { describe, it, expect } from "vitest";
import { parseStreamEvent, buildSpawnArgs } from "../claude-cli.js";

describe("parseStreamEvent", () => {
  it("parses system init event", () => {
    const line = JSON.stringify({ type: "system", subtype: "init", session_id: "abc-123", model: "claude-sonnet-4-6" });
    const event = parseStreamEvent(line);
    expect(event).not.toBeNull();
    expect(event!.type).toBe("system");
    expect(event!.session_id).toBe("abc-123");
  });

  it("parses result event", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", result: "Hello!", session_id: "abc-123", is_error: false });
    const event = parseStreamEvent(line);
    expect(event!.type).toBe("result");
  });

  it("returns null for invalid JSON", () => {
    expect(parseStreamEvent("not json")).toBeNull();
  });

  it("returns null for empty line", () => {
    expect(parseStreamEvent("")).toBeNull();
  });
});

describe("buildSpawnArgs", () => {
  it("builds args for new session", () => {
    const args = buildSpawnArgs({ binary: "claude", extraArgs: [] });
    expect(args.cmd).toBe("claude");
    expect(args.args).toContain("-p");
    expect(args.args).toContain("--input-format");
    expect(args.args).toContain("stream-json");
    expect(args.args).toContain("--output-format");
    expect(args.args).toContain("stream-json");
    expect(args.args).toContain("--verbose");
  });

  it("builds args for resume session", () => {
    const args = buildSpawnArgs({ binary: "claude", extraArgs: [], claudeSessionId: "sess-123" });
    expect(args.args).toContain("--resume");
    expect(args.args).toContain("--session-id");
    expect(args.args).toContain("sess-123");
  });

  it("includes extra args", () => {
    const args = buildSpawnArgs({ binary: "/usr/local/bin/claude", extraArgs: ["--model", "opus"] });
    expect(args.cmd).toBe("/usr/local/bin/claude");
    expect(args.args).toContain("--model");
    expect(args.args).toContain("opus");
  });
});
