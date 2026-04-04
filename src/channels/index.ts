import type { ChannelAdapter } from "./types.js";

const adapters = new Map<string, ChannelAdapter>();

export function registerAdapter(adapter: ChannelAdapter): void {
  adapters.set(adapter.type, adapter);
}

export function getAdapter(type: string): ChannelAdapter | undefined {
  return adapters.get(type);
}

export function getAllAdapters(): ChannelAdapter[] {
  return [...adapters.values()];
}
