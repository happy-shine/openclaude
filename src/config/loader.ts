import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { configSchema } from "./schema.js";
import type { GatewayConfig } from "./types.js";

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
    ?? resolve(process.env.HOME ?? "~", ".claude-gateway", "config.yaml");

  if (!existsSync(resolvedPath)) {
    throw new Error(`Config file not found: ${resolvedPath}`);
  }

  const content = readFileSync(resolvedPath, "utf-8");
  return parseConfig(content);
}

export function resolveDataDir(config: GatewayConfig): string {
  const dir = config.gateway.dataDir.replace(/^~/, process.env.HOME ?? "");
  return resolve(dir);
}
