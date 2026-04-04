import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ClaudeProcess, StreamEvent } from "./types.js";
import type { Session } from "../sessions/types.js";
import { spawnClaude, sendUserMessage, readUntilResult } from "./claude-cli.js";

export interface ProcessManagerConfig {
  binary: string;
  idleTimeoutMs: number;
  maxProcesses: number;
  extraArgs: string[];
  workspaceDir: string;
  botId: string;
}

export class ProcessManager {
  private processes = new Map<string, ClaudeProcess>();
  private config: ProcessManagerConfig;
  private log: Logger;

  constructor(config: ProcessManagerConfig, log: Logger) {
    this.config = config;
    this.log = log.child({ module: "process-manager" });
  }

  acquire(session: Session): ClaudeProcess {
    const existing = this.processes.get(session.sessionId);
    if (existing && !existing.process.killed) {
      this.resetIdleTimer(session.sessionId);
      return existing;
    }

    if (this.processes.size >= this.config.maxProcesses) {
      this.evictOldest();
    }

    // Build per-session workspace: {workspaceDir}/{botId}/{chatId}_{sessionNum}
    const safeChatId = session.chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const sessionDir = join(
      this.config.workspaceDir,
      this.config.botId,
      `${safeChatId}_${session.sessionNum ?? 1}`,
    );
    mkdirSync(sessionDir, { recursive: true });

    const proc = spawnClaude({
      binary: this.config.binary,
      extraArgs: this.config.extraArgs,
      claudeSessionId: session.claudeSessionId,
    }, sessionDir);

    const cp: ClaudeProcess = {
      sessionId: session.sessionId,
      claudeSessionId: session.claudeSessionId,
      process: proc,
      busy: false,
      lastActiveAt: Date.now(),
    };

    proc.on("exit", (code) => {
      this.log.info({ sessionId: session.sessionId, code, pid: proc.pid }, "Claude process exited");
      // Only delete from map if this is still the current process for this session
      const current = this.processes.get(session.sessionId);
      if (current && current.process === proc) {
        this.processes.delete(session.sessionId);
      }
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.log.warn({ sessionId: session.sessionId }, `claude stderr: ${text}`);
    });

    this.processes.set(session.sessionId, cp);
    this.scheduleIdle(session.sessionId);
    this.log.info({ sessionId: session.sessionId, pid: proc.pid }, "Spawned Claude process");
    return cp;
  }

  async *sendMessage(session: Session, text: string): AsyncGenerator<StreamEvent> {
    let cp = this.acquire(session);
    cp.busy = true;
    cp.lastActiveAt = Date.now();
    this.clearIdleTimer(session.sessionId);

    sendUserMessage(cp.process, text);

    try {
      let gotEvents = false;
      for await (const event of readUntilResult(cp.process)) {
        gotEvents = true;
        yield event;
      }

      // If process exited without producing any events and had a claudeSessionId,
      // the resume likely failed. Retry without resume (fresh session).
      if (!gotEvents && session.claudeSessionId) {
        this.log.warn({ sessionId: session.sessionId }, "Resume failed, retrying as new session");
        const savedClaudeId = session.claudeSessionId;
        session.claudeSessionId = undefined;
        this.processes.delete(session.sessionId);

        cp = this.acquire(session);
        cp.busy = true;
        this.clearIdleTimer(session.sessionId);
        sendUserMessage(cp.process, text);

        yield* readUntilResult(cp.process);

        // Restore claudeSessionId reference so caller can update it from init event
        session.claudeSessionId = savedClaudeId;
      }
    } finally {
      cp.busy = false;
      cp.lastActiveAt = Date.now();
      this.scheduleIdle(session.sessionId);
    }
  }

  private scheduleIdle(sessionId: string): void {
    const cp = this.processes.get(sessionId);
    if (!cp) return;
    this.clearIdleTimer(sessionId);
    cp.idleTimer = setTimeout(() => {
      if (!cp.busy) {
        this.log.info({ sessionId }, "Idle timeout, killing process");
        this.kill(sessionId);
      }
    }, this.config.idleTimeoutMs);
  }

  private clearIdleTimer(sessionId: string): void {
    const cp = this.processes.get(sessionId);
    if (cp?.idleTimer) {
      clearTimeout(cp.idleTimer);
      cp.idleTimer = undefined;
    }
  }

  private resetIdleTimer(sessionId: string): void {
    this.clearIdleTimer(sessionId);
    this.scheduleIdle(sessionId);
  }

  private kill(sessionId: string): void {
    const cp = this.processes.get(sessionId);
    if (!cp) return;
    this.clearIdleTimer(sessionId);
    cp.process.kill("SIGTERM");
    setTimeout(() => {
      if (!cp.process.killed) cp.process.kill("SIGKILL");
    }, 5000);
    this.processes.delete(sessionId);
  }

  private evictOldest(): void {
    let oldest: ClaudeProcess | null = null;
    for (const cp of this.processes.values()) {
      if (cp.busy) continue;
      if (!oldest || cp.lastActiveAt < oldest.lastActiveAt) oldest = cp;
    }
    if (oldest) {
      this.log.info({ sessionId: oldest.sessionId }, "Evicting oldest idle process");
      this.kill(oldest.sessionId);
    }
  }

  async shutdown(): Promise<void> {
    this.log.info("Shutting down all Claude processes");
    for (const id of [...this.processes.keys()]) {
      this.kill(id);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
  }

  getRunningCount(): number {
    return this.processes.size;
  }
}
