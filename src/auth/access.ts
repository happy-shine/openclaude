import type { AccessCheckInput, AccessCheckResult } from "./types.js";

export function checkAccess(input: AccessCheckInput): AccessCheckResult {
  if (input.isGroup) return checkGroupAccess(input);
  return checkDmAccess(input);
}

function checkDmAccess(input: AccessCheckInput): AccessCheckResult {
  switch (input.dmPolicy) {
    case "disabled": return { allowed: false, reason: "dm_disabled" };
    case "open": return { allowed: true };
    case "allowlist":
      return input.allowFrom.includes(input.senderId)
        ? { allowed: true }
        : { allowed: false, reason: "not_in_allowlist" };
    case "pairing":
      return input.allowFrom.includes(input.senderId)
        ? { allowed: true }
        : { allowed: false, reason: "needs_pairing" };
  }
}

function checkGroupAccess(input: AccessCheckInput): AccessCheckResult {
  switch (input.groupPolicy) {
    case "disabled": return { allowed: false, reason: "group_disabled" };
    case "open": return { allowed: true };
    case "pairing": {
      const groupConfig = input.groups[input.chatId];
      if (!groupConfig || !groupConfig.enabled) return { allowed: false, reason: "needs_group_pairing" };
      if (!groupConfig.allowFrom || groupConfig.allowFrom.length === 0) return { allowed: true };
      return groupConfig.allowFrom.includes(input.senderId)
        ? { allowed: true }
        : { allowed: false, reason: "group_sender_blocked" };
    }
    case "allowlist": {
      const groupConfig = input.groups[input.chatId];
      if (!groupConfig || !groupConfig.enabled) return { allowed: false, reason: "group_not_configured" };
      if (!groupConfig.allowFrom || groupConfig.allowFrom.length === 0) return { allowed: true };
      return groupConfig.allowFrom.includes(input.senderId)
        ? { allowed: true }
        : { allowed: false, reason: "group_sender_blocked" };
    }
  }
}
