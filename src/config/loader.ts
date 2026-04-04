import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema } from "./schema.js";
import type { GatewayConfig } from "./types.js";

const DEFAULT_CONFIG = `# OpenClaude Configuration
# Docs: https://github.com/happy-shine/openclaude

gateway:
  port: 18790
  dataDir: "~/.openclaude"
  logLevel: "info"

claude:
  binary: "claude"
  model: "sonnet"
  idleTimeoutMs: 600000
  maxProcesses: 10
  extraArgs: []

auth:
  defaultPolicy: "pairing"

channels:
  telegram:
    botToken: "\${TELEGRAM_BOT_TOKEN}"   # set env var or paste token here
    dmPolicy: "pairing"
    groupPolicy: "disabled"
    allowFrom: []
    groups: {}
`;

export function expandEnvVars(input: string): string {
  return input.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

export function parseConfig(yamlStr: string): GatewayConfig {
  const expanded = expandEnvVars(yamlStr);
  const raw = parseYaml(expanded);
  return configSchema.parse(raw) as GatewayConfig;
}

export function loadConfig(configPath?: string): GatewayConfig {
  const resolvedPath = configPath
    ?? resolve(process.env.HOME ?? "~", ".openclaude", "config.yaml");

  if (!existsSync(resolvedPath)) {
    // Auto-create default config
    mkdirSync(dirname(resolvedPath), { recursive: true });
    writeFileSync(resolvedPath, DEFAULT_CONFIG);
    console.log(`Created default config at ${resolvedPath}`);
    console.log(`Edit it to set your Telegram bot token, then run: openclaude gateway start`);
  }

  const content = readFileSync(resolvedPath, "utf-8");
  return parseConfig(content);
}

export function resolveDataDir(config: GatewayConfig): string {
  const dir = config.gateway.dataDir.replace(/^~/, process.env.HOME ?? "");
  return resolve(dir);
}
