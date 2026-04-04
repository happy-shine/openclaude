import type { ChildProcess } from "node:child_process";

export interface StreamEvent {
  type: string;
  subtype?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  message?: { role: string; content: unknown };
  event?: unknown;
  [key: string]: unknown;
}

export interface ClaudeProcess {
  sessionId: string;
  claudeSessionId?: string;
  process: ChildProcess;
  busy: boolean;
  lastActiveAt: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export interface SpawnConfig {
  binary: string;
  extraArgs: string[];
  claudeSessionId?: string;
}
