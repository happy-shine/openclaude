export interface GatewayConfig {
  gateway: {
    port: number;
    dataDir: string;
    logLevel: "debug" | "info" | "warn" | "error";
    logFormat: "pretty" | "json";
  };
  claude: {
    binary: string;
    idleTimeoutMs: number;
    maxProcesses: number;
    extraArgs: string[];
  };
  auth: {
    defaultPolicy: "open" | "pairing" | "allowlist" | "disabled";
  };
  channels: {
    telegram?: TelegramChannelConfig;
  };
}

export interface TelegramChannelConfig {
  botToken: string;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  groups: Record<string, TelegramGroupConfig>;
}

export interface TelegramGroupConfig {
  enabled: boolean;
  allowFrom?: string[];
}
