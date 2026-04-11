export interface AccessCheckInput {
  senderId: string;
  chatId: string;
  isGroup: boolean;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  groupPolicy: "open" | "pairing" | "allowlist" | "disabled";
  allowFrom: string[];
  groups: Record<string, { enabled: boolean; allowFrom?: string[] }>;
}

export interface AccessCheckResult {
  allowed: boolean;
  reason?: "dm_disabled" | "not_in_allowlist" | "needs_pairing" | "group_disabled" | "group_not_configured" | "group_sender_blocked" | "needs_group_pairing";
}

export interface PairingRequest {
  senderId: string;
  senderName: string;
  channelType: string;
  chatId: string;
  code: string;
  createdAt: number;
  expiresAt: number;
}
