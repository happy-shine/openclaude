import { describe, it, expect } from "vitest";
import { parseConfig, expandEnvVars } from "../loader.js";

describe("expandEnvVars", () => {
  it("expands ${VAR} references", () => {
    process.env.TEST_TOKEN = "abc123";
    expect(expandEnvVars("token: ${TEST_TOKEN}")).toBe("token: abc123");
    delete process.env.TEST_TOKEN;
  });

  it("leaves unset vars as empty string", () => {
    expect(expandEnvVars("${NONEXISTENT_VAR}")).toBe("");
  });
});

describe("parseConfig", () => {
  it("parses valid config yaml string", () => {
    const yaml = `
gateway:
  logLevel: info
claude:
  binary: claude
  idleTimeoutMs: 600000
  maxProcesses: 10
auth:
  defaultPolicy: pairing
channels:
  telegram:
    botToken: "test-token"
    dmPolicy: pairing
    groupPolicy: disabled
    allowFrom: []
    groups: {}
`;
    const cfg = parseConfig(yaml);
    expect(cfg.gateway.logLevel).toBe("info");
    expect(cfg.channels!.telegram.botToken).toBe("test-token");
    expect(cfg.auth.defaultPolicy).toBe("pairing");
  });

  it("rejects invalid config", () => {
    expect(() => parseConfig("gateway: 123")).toThrow();
  });

  it("applies defaults for optional fields", () => {
    const yaml = `
channels:
  telegram:
    botToken: "tok"
`;
    const cfg = parseConfig(yaml);
    expect(cfg.gateway.logLevel).toBe("info");
    expect(cfg.claude.idleTimeoutMs).toBe(600000);
    expect(cfg.channels!.telegram.dmPolicy).toBe("pairing");
  });
});
