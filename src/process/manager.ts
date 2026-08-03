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
import { getTelegramFormatSkill } from "../skills/telegram-format.js";

export interface ProcessManagerConfig {
  binary: string;
  idleTimeoutMs: number;
  maxProcesses: number;
  extraArgs: string[];
  workspaceDir: string;
  apiPort: number;
  agentsDir: string;
}

/** Identity info injected into the Claude system prompt at spawn time */
export interface BotIdentity {
  /** Bot display name (e.g. "atri") */
  name: string;
  /** Telegram bot username without the leading @ (e.g. "atri65535_bot") */
  username: string;
  /** Other bots in the same group chat that can be @mentioned */
  peerBots?: Array<{ name: string; username: string }>;
  /**
   * Model identifier passed to the CLI (e.g. "claude-opus-4-7").
   * Used to tell the AI what backend it's actually running on,
   * overriding any hardcoded model name in the CLI's own system prompt.
   */
  model?: string;
}

export class ProcessManager {
  private processes = new Map<string, ClaudeProcess>();
  private config: ProcessManagerConfig;
  private log: Logger;

  constructor(config: ProcessManagerConfig, log: Logger) {
    this.config = config;
    this.log = log.child({ module: "process-manager" });
  }

  acquire(session: Session, botId: string, botExtraArgs?: string[], identity?: BotIdentity): ClaudeProcess {
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
      botId,
      `${safeChatId}_${session.sessionId}`,
    );
    mkdirSync(sessionDir, { recursive: true });

    // Compose system prompt: identity + SOUL.md + built-in skills
    const parts: string[] = [];

    // Bot identity (and peer-bot hints in group chats)
    if (identity) {
      const idLines: string[] = [`你是 ${identity.name}（@${identity.username}）。`];
      if (session.isGroup && identity.peerBots && identity.peerBots.length > 0) {
        const botList = identity.peerBots.map((b) => `@${b.username}（${b.name}）`).join("、");
        idLines.push(
          `本群可@的bot: ${botList}。只有以上列出的bot可以被@到，@其他任何bot都无效（消息不会送达）。除非用户明确要求bot间交流，否则不要主动@其他bot。`,
        );
      }

      // Model identity: override any hardcoded model name from the CLI's own
      // system prompt (e.g. "Claude Opus 4.7") so the bot doesn't lie about
      // what model it actually is. The CLI may be proxied to any backend.
      // We tell the bot the truth: it runs through OpenClaude, and the
      // configured model identifier is the best info we have.
      const modelHint = identity.model
        ? `, 当前配置的模型标识为 ${identity.model}`
        : "";
      idLines.push(
        `重要：当用户询问你的模型名称或版本时（如"你是什么模型""你的版本是什么"等），不要照搬系统提示词中可能出现的模型名称（如"Claude Opus"、"Sonnet"、"Haiku"等），因为那些可能是错误的。你应该回答：你通过 OpenClaude 网关运行${modelHint}，具体底层模型取决于网关的后端 API 配置。`,
      );

      parts.push(idLines.join("\n"));
    }

    // Load SOUL.md if it exists for this bot
    const soulPath = join(this.config.agentsDir, botId, "SOUL.md");
    if (existsSync(soulPath)) {
      try {
        const soul = readFileSync(soulPath, "utf-8").trim();
        if (soul) parts.push(soul);
      } catch {
        this.log.warn({ soulPath }, "Failed to read SOUL.md");
      }
    }

    // Built-in skills
    parts.push(getTelegramFileSkill(this.config.apiPort, session.chatId, botId, session.isGroup ?? false));
    parts.push(getSoulEditorSkill(this.config.apiPort, botId));
    parts.push(getButtonSkill());
    parts.push(getTelegramFormatSkill());
    if (session.isGroup) {
      parts.push(getChatHistorySkill(this.config.apiPort, session.chatId));
    }

    // Use per-bot extraArgs if provided, otherwise fall back to config defaults
    const baseArgs = botExtraArgs ?? this.config.extraArgs;
    const extraArgs = [
      ...baseArgs,
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

  async *sendMessage(session: Session, text: string, botId: string, botExtraArgs?: string[], identity?: BotIdentity): AsyncGenerator<StreamEvent> {
    let cp = this.acquire(session, botId, botExtraArgs, identity);
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

        cp = this.acquire(session, botId, botExtraArgs, identity);
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

  updateConfig(updates: Partial<ProcessManagerConfig>): void {
    this.config = { ...this.config, ...updates };
    this.log.info({ keys: Object.keys(updates) }, "Config updated (applies to new processes)");
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
  async *forkAndAsk(session: Session, question: string, botId: string): AsyncGenerator<StreamEvent> {
    if (!session.claudeSessionId) return;

    // Must match the main process's cwd for --resume to find the session
    const safeChatId = session.chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const cwd = join(this.config.workspaceDir, botId, `${safeChatId}_${session.sessionId}`);
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
