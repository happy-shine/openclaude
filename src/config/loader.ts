import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema } from "./schema.js";
import type { GatewayConfig, ResolvedBotConfig, BotConfig } from "./types.js";

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

/**
 * Resolve bot configurations from the config.
 *
 * Priority:
 * 1. If `config.bots` exists and has items, use those.
 * 2. Else if `config.channels?.telegram` exists, convert to a single-bot array (backward compat).
 * 3. Merge each bot with top-level defaults (model, extraArgs, auth).
 * 4. Extract botId from token.
 * 5. Validate no duplicate tokens.
 */
export function resolveBots(config: GatewayConfig): ResolvedBotConfig[] {
  const defaultPolicy = config.auth.defaultPolicy;
  const defaultModel = config.claude.model;
  const defaultExtraArgs = config.claude.extraArgs;

  let bots: BotConfig[];

  if (config.bots && config.bots.length > 0) {
    // Use the new bots array
    bots = config.bots;
  } else if (config.channels?.telegram) {
    // Backward compat: convert legacy channels.telegram to a single BotConfig
    const tg = config.channels.telegram;
    bots = [
      {
        name: "telegram",
        token: tg.botToken,
        auth: {
          dmPolicy: tg.dmPolicy,
          groupPolicy: tg.groupPolicy,
          allowFrom: tg.allowFrom,
          groups: tg.groups,
        },
      },
    ];
  } else {
    return [];
  }

  // Check for duplicate tokens
  const seenTokens = new Set<string>();
  for (const bot of bots) {
    if (seenTokens.has(bot.token)) {
      throw new Error(`Duplicate bot token found for bot "${bot.name}"`);
    }
    seenTokens.add(bot.token);
  }

  return bots.map((bot) => {
    const botId = bot.token.split(":")[0];

    // Resolve dmPolicy: bot auth > top-level defaultPolicy (mapped to dm-compatible value)
    const dmPolicy = bot.auth?.dmPolicy ?? defaultPolicy;

    // Resolve groupPolicy: bot auth > "disabled" default
    // Note: defaultPolicy "pairing" is not valid for groupPolicy, so default to "disabled"
    const groupPolicy =
      bot.auth?.groupPolicy ??
      (defaultPolicy === "open" || defaultPolicy === "allowlist" || defaultPolicy === "disabled"
        ? defaultPolicy
        : "disabled");

    return {
      name: bot.name,
      token: bot.token,
      botId,
      model: bot.model ?? defaultModel,
      extraArgs: bot.extraArgs ?? defaultExtraArgs,
      dmPolicy,
      groupPolicy,
      allowFrom: bot.auth?.allowFrom ?? [],
      groups: bot.auth?.groups ?? {},
    };
  });
}
