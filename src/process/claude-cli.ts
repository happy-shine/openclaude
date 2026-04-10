import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { ChildProcess } from "node:child_process";
import type { StreamEvent, SpawnConfig } from "./types.js";

export function parseStreamEvent(line: string): StreamEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as StreamEvent;
  } catch {
    return null;
  }
}

export function buildSpawnArgs(config: SpawnConfig): { cmd: string; args: string[] } {
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions"];
  if (config.claudeSessionId) {
    args.push("--resume", config.claudeSessionId);
  }
  args.push(...config.extraArgs);
  return { cmd: config.binary, args };
}

export function spawnClaude(config: SpawnConfig, cwd: string): ChildProcess {
  const { cmd, args } = buildSpawnArgs(config);
  return spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd,
    env: { ...process.env },
  });
}

export function sendUserMessage(proc: ChildProcess, text: string): void {
  const msg = JSON.stringify({ type: "user", message: { role: "user", content: text } });
  proc.stdin!.write(msg + "\n");
}

/** Send a control_request to the Claude process via stdin */
export function sendControlRequest(proc: ChildProcess, request: Record<string, unknown>): void {
  const msg = JSON.stringify({
    type: "control_request",
    request_id: `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    request,
  });
  proc.stdin!.write(msg + "\n");
}

export async function* readStreamEvents(proc: ChildProcess): AsyncGenerator<StreamEvent> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const event = parseStreamEvent(line);
      if (event) yield event;
    }
  } finally {
    rl.close();
  }
}

export async function* readUntilResult(proc: ChildProcess): AsyncGenerator<StreamEvent> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const event = parseStreamEvent(line);
      if (!event) continue;
      yield event;
      if (event.type === "result") return;
    }
  } finally {
    rl.close();
  }
}
