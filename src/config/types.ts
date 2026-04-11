export interface GatewayConfig {
  gateway: {
    port: number;
    dataDir: string;
    logLevel: "debug" | "info" | "warn" | "error";
    logFormat: "pretty" | "json";
  };
  claude: {
    binary: string;
    model?: string;
    idleTimeoutMs: number;
    maxProcesses: number;
    extraArgs: string[];
  };
  auth: {
    defaultPolicy: "open" | "pairing" | "allowlist" | "disabled";
  };
  channels?: {
    telegram?: TelegramChannelConfig;
  };
  bots?: BotConfig[];
}

export interface BotConfig {
  name: string;
  token: string;
  model?: string;
  extraArgs?: string[];
  auth?: {
    dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
    groupPolicy?: "open" | "pairing" | "allowlist" | "disabled";
    allowFrom?: string[];
    groups?: Record<string, TelegramGroupConfig>;
  };
}

export interface ResolvedBotConfig {
  name: string;
  token: string;
  botId: string;
  model?: string;
  extraArgs: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  groupPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groups: Record<string, TelegramGroupConfig>;
}

export interface TelegramChannelConfig {
  botToken: string;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  groupPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groups: Record<string, TelegramGroupConfig>;
}

export interface TelegramGroupConfig {
  enabled: boolean;
  allowFrom?: string[];
}
