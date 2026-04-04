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
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"];
  if (config.claudeSessionId) {
    args.push("--resume", config.claudeSessionId);
  }
  args.push(...config.extraArgs);
  return { cmd: config.binary, args };
}

export function spawnClaude(config: SpawnConfig): ChildProcess {
  const { cmd, args } = buildSpawnArgs(config);
  return spawn(cmd, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.env.HOME ?? process.cwd(),
    env: { ...process.env },
  });
}

export function sendUserMessage(proc: ChildProcess, text: string): void {
  const msg = JSON.stringify({ type: "user", message: { role: "user", content: text } });
  proc.stdin!.write(msg + "\n");
}

export async function* readStreamEvents(proc: ChildProcess): AsyncGenerator<StreamEvent> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  for await (const line of rl) {
    const event = parseStreamEvent(line);
    if (event) yield event;
  }
}

export async function* readUntilResult(proc: ChildProcess): AsyncGenerator<StreamEvent> {
  const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  for await (const line of rl) {
    const event = parseStreamEvent(line);
    if (!event) continue;
    yield event;
    if (event.type === "result") return;
  }
}
