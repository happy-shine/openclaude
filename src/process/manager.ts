import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "pino";
import type { ClaudeProcess, StreamEvent } from "./types.js";
import type { Session } from "../sessions/types.js";
import { spawnClaude, sendUserMessage, sendControlRequest, readUntilResult, readStreamEvents } from "./claude-cli.js";
import { spawn } from "node:child_process";
import { getTelegramFileSkill } from "../skills/telegram-file.js";
import { getSoulEditorSkill } from "../skills/soul-editor.js";
import { getButtonSkill } from "../skills/telegram-buttons.js";
import { getChatHistorySkill } from "../skills/chat-history.js";

export interface ProcessManagerConfig {
  binary: string;
  idleTimeoutMs: number;
  maxProcesses: number;
  extraArgs: string[];
  workspaceDir: string;
  botId: string;
  apiPort: number;
  agentsDir: string;
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

    // Build per-session workspace: {workspaceDir}/{botId}/{chatId}_{sessionId}
    // Uses the gateway's own sessionId (stable from creation, never changes).
    // claudeSessionId mapping lives in sessions/state.json — no need to encode it in the path.
    const safeChatId = session.chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const sessionDir = join(
      this.config.workspaceDir,
      this.config.botId,
      `${safeChatId}_${session.sessionId}`,
    );
    mkdirSync(sessionDir, { recursive: true });

    // Compose system prompt: SOUL.md + built-in skills
    const parts: string[] = [];

    // Load SOUL.md if it exists for this bot
    const soulPath = join(this.config.agentsDir, this.config.botId, "SOUL.md");
    if (existsSync(soulPath)) {
      try {
        const soul = readFileSync(soulPath, "utf-8").trim();
        if (soul) parts.push(soul);
      } catch {
        this.log.warn({ soulPath }, "Failed to read SOUL.md");
      }
    }

    // Built-in skills
    parts.push(getTelegramFileSkill(this.config.apiPort, session.chatId));
    parts.push(getSoulEditorSkill(this.config.apiPort, this.config.botId));
    parts.push(getButtonSkill());
    if (session.isGroup) {
      parts.push(getChatHistorySkill(this.config.apiPort, session.chatId));
    }

    const extraArgs = [
      ...this.config.extraArgs,
      "--append-system-prompt", parts.join("\n\n---\n\n"),
    ];

    const proc = spawnClaude({
      binary: this.config.binary,
      extraArgs,
      claudeSessionId: session.claudeSessionId,
    }, sessionDir);

    const cp: ClaudeProcess = {
      sessionId: session.sessionId,
      claudeSessionId: session.claudeSessionId,
      process: proc,
      busy: false,
      lastActiveAt: Date.now(),
      workspaceDir: sessionDir,
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

  getWorkspaceDir(sessionId: string): string | undefined {
    return this.processes.get(sessionId)?.workspaceDir;
  }

  /** Send a control_request to a running session's Claude process (fire-and-forget) */
  sendControl(sessionId: string, request: Record<string, unknown>): boolean {
    const cp = this.processes.get(sessionId);
    if (!cp || cp.process.killed) return false;
    sendControlRequest(cp.process, request);
    return true;
  }

  /** Send a control_request and wait for the response from stdout */
  async sendControlAndWait(sessionId: string, request: Record<string, unknown>, timeoutMs = 5000): Promise<Record<string, unknown> | null> {
    const cp = this.processes.get(sessionId);
    if (!cp || cp.process.killed) return null;

    const requestId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const msg = JSON.stringify({ type: "control_request", request_id: requestId, request });
    cp.process.stdin!.write(msg + "\n");

    return new Promise((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);

      const onData = (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            if (parsed.type === "control_response" && parsed.response?.request_id === requestId) {
              cleanup();
              resolve(parsed.response as Record<string, unknown>);
            }
          } catch {}
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        cp.process.stdout?.off("data", onData);
      };

      cp.process.stdout?.on("data", onData);
    });
  }

  /** Check if a session has a running process */
  hasProcess(sessionId: string): boolean {
    const cp = this.processes.get(sessionId);
    return !!cp && !cp.process.killed;
  }

  /** Check if a session's process is currently busy */
  isBusy(sessionId: string): boolean {
    return this.processes.get(sessionId)?.busy ?? false;
  }

  /**
   * Fork a session and ask a one-shot question without blocking the main process.
   * Uses --resume + --fork-session to share prompt cache.
   * Returns an async generator of stream events (same as sendMessage).
   */
  async *forkAndAsk(session: Session, question: string): AsyncGenerator<StreamEvent> {
    if (!session.claudeSessionId) return;

    // Must match the main process's cwd for --resume to find the session
    const safeChatId = session.chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const cwd = join(this.config.workspaceDir, this.config.botId, `${safeChatId}_${session.sessionId}`);
    mkdirSync(cwd, { recursive: true });

    const args = [
      "-p",
      "--verbose",
      "--output-format", "stream-json",
      "--resume", session.claudeSessionId,
      "--fork-session",
      "--permission-mode", "bypassPermissions",
      question,
    ];

    this.log.info(
      { sessionId: session.sessionId, claudeSessionId: session.claudeSessionId },
      "Forking session for /btw side question",
    );

    const proc = spawn(this.config.binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      cwd,
      env: { ...process.env },
    });

    proc.stderr?.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) this.log.warn("btw stderr: " + text);
    });

    yield* readUntilResult(proc);
  }
}
