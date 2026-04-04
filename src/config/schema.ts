import { z } from "zod";

const telegramGroupSchema = z.object({
  enabled: z.boolean().default(true),
  allowFrom: z.array(z.string()).optional(),
});

const telegramChannelSchema = z.object({
  botToken: z.string().min(1, "botToken is required"),
  dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).default("pairing"),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).default("disabled"),
  allowFrom: z.array(z.string()).default([]),
  groups: z.record(z.string(), telegramGroupSchema).default({}),
});

const gatewaySchema = z.object({
  port: z.number().int().positive().default(18790),
  dataDir: z.string().default("~/.openclaude"),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
  logFormat: z.enum(["pretty", "json"]).default("pretty"),
});

const claudeSchema = z.object({
  binary: z.string().default("claude"),
  model: z.string().optional(),
  idleTimeoutMs: z.number().int().positive().default(600000),
  maxProcesses: z.number().int().positive().default(10),
  extraArgs: z.array(z.string()).default([]),
});

const authSchema = z.object({
  defaultPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).default("pairing"),
});

const channelsSchema = z.object({
  telegram: telegramChannelSchema.optional(),
});

export const configSchema = z.object({
  gateway: gatewaySchema.default(gatewaySchema.parse({})),
  claude: claudeSchema.default(claudeSchema.parse({})),
  auth: authSchema.default(authSchema.parse({})),
  channels: channelsSchema.default(channelsSchema.parse({})),
});
