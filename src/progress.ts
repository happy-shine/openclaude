import type { TelegramAdapter } from "./channels/telegram/adapter.js";

const TICK_INTERVAL = 3000; // setInterval rate (keeps glyph animation responsive)

// Adaptive flush interval — exponential decay curve (capacitor charging)
// Smoothly ramps from MIN to MAX with time constant TAU.
//   t=0s → 3s,  t=30s → 5s,  t=60s → 7s,  t=2min → 10s,  t=5min+ → ~15s
const FLUSH_MIN = 3_000;
const FLUSH_MAX = 15_000;
const FLUSH_TAU = 120_000; // 63% of the way to max at 2 minutes

function getFlushInterval(elapsedMs: number): number {
  return FLUSH_MIN + (FLUSH_MAX - FLUSH_MIN) * (1 - Math.exp(-elapsedMs / FLUSH_TAU));
}

// Ported from Claude Code: src/components/Spinner/utils.ts — getDefaultCharacters()
// Grows then shrinks like a breathing pulse: · ✢ ✳ ✶ ✻ ✽ ✽ ✻ ✶ ✳ ✢ ·
// U+2733 (✳) is rendered as emoji in Telegram, so skip it
const GLYPH_FRAMES = ["·", "✢", "✶", "✻", "✽", "✽", "✻", "✶", "✢", "·"];

const TOOL_ICONS: Record<string, string> = {
  Read: "↓",
  Write: "↑",
  Edit: "δ",
  Bash: "$",
  Glob: "⊕",
  Grep: "⊕",
  Agent: "◇",
  WebSearch: "⊙",
  WebFetch: "⊙",
};

// Ported from Claude Code: src/constants/spinnerVerbs.ts
const SPINNER_VERBS = [
  "Accomplishing", "Architecting", "Baking", "Beaming", "Beboppin'",
  "Billowing", "Bootstrapping", "Brewing", "Calculating", "Cascading",
  "Cerebrating", "Channeling", "Choreographing", "Churning", "Clauding",
  "Coalescing", "Cogitating", "Combobulating", "Composing", "Computing",
  "Concocting", "Contemplating", "Cooking", "Crafting", "Creating",
  "Crunching", "Crystallizing", "Cultivating", "Deliberating", "Ebbing",
  "Elucidating", "Enchanting", "Envisioning", "Fermenting", "Finagling",
  "Flambéing", "Flowing", "Forging", "Forming", "Frolicking",
  "Gallivanting", "Generating", "Germinating", "Grooving", "Harmonizing",
  "Hatching", "Hyperspacing", "Ideating", "Imagining", "Improvising",
  "Incubating", "Inferring", "Infusing", "Kneading", "Levitating",
  "Manifesting", "Marinating", "Meandering", "Metamorphosing", "Moonwalking",
  "Mulling", "Musing", "Noodling", "Nucleating", "Orbiting",
  "Orchestrating", "Percolating", "Philosophising", "Pondering", "Processing",
  "Propagating", "Puzzling", "Reticulating", "Ruminating", "Sautéing",
  "Simmering", "Sketching", "Spinning", "Sprouting", "Sublimating",
  "Swirling", "Synthesizing", "Tempering", "Thinking", "Tinkering",
  "Transmuting", "Undulating", "Unfurling", "Vibing", "Wandering",
  "Whirring", "Whisking", "Working", "Zigzagging",
];

function randomVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];
}

export class ProgressTracker {
  private telegram: TelegramAdapter;
  private chatId: string;
  private replyToMessageId?: string;

  private messageId: string | null = null;
  private completed: string[] = [];
  private currentLabel = "";
  private currentIcon = "";
  private phaseStart = Date.now();
  private globalStart = Date.now();
  private glyphIdx = 0;
  private verb = randomVerb();
  private lastFlush = 0;
  private flushing = false;
  private buffer = "";
  private flushTimer?: ReturnType<typeof setInterval>;
  private done = false;
  private pendingFlush: Promise<void> = Promise.resolve();

  constructor(telegram: TelegramAdapter, chatId: string, replyToMessageId?: string) {
    this.telegram = telegram;
    this.chatId = chatId;
    this.replyToMessageId = replyToMessageId;
  }

  /** Start periodic auto-flush (for updates during long tool execution) */
  start(): void {
    this.flushTimer = setInterval(() => {
      this.pendingFlush = this.flush().catch(() => {});
    }, TICK_INTERVAL);
  }

  /** Stop auto-flush */
  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /** Mark tracking as complete — stops timer, awaits any in-flight flush */
  async finish(): Promise<void> {
    this.done = true;
    this.stop();
    this.finishCurrent();
    // Wait for any in-flight timer-fired flush to complete,
    // so the caller's subsequent sendOrEdit is guaranteed to be last.
    await this.pendingFlush;
  }

  /** Mark thinking phase started */
  startThinking(): void {
    this.finishCurrent();
    this.currentLabel = "Thinking";
    this.currentIcon = "💭";
    this.phaseStart = Date.now();
  }

  /** Mark tool execution started */
  startTool(name: string, detail?: string): void {
    this.finishCurrent();
    this.currentIcon = TOOL_ICONS[name] ?? "🔧";
    this.currentLabel = detail ? `${name}: ${detail}` : name;
    this.phaseStart = Date.now();
  }

  /** Append response text to buffer */
  appendText(text: string): void {
    this.buffer += text;
  }

  /** Get accumulated response text */
  getBuffer(): string {
    return this.buffer;
  }

  /** Get the message ID used for display */
  getMessageId(): string | null {
    return this.messageId;
  }

  /** Periodic flush — debounced + locked to prevent concurrent edits */
  async flush(): Promise<void> {
    if (this.done || this.flushing) return;
    const now = Date.now();
    const interval = getFlushInterval(now - this.globalStart);
    if (now - this.lastFlush < interval) return;

    this.flushing = true;
    try {
      const display = this.buildDisplay();
      if (!display) return;
      await this.sendOrEdit(display);
      this.lastFlush = now;
      // Keep typing indicator alive during tool execution
      if (this.currentLabel) {
        await this.telegram.sendTyping(this.chatId).catch(() => {});
      }
    } finally {
      this.flushing = false;
    }
  }

  /** Force send/edit with specific text, returns message ID */
  async sendOrEdit(text: string): Promise<string> {
    const truncated = text.slice(0, 4096);
    if (!this.messageId) {
      this.messageId = await this.telegram.send({
        chatId: this.chatId,
        text: truncated,
        replyToMessageId: this.replyToMessageId,
      });
    } else {
      await this.telegram.editMessage(this.chatId, this.messageId, truncated);
    }
    return this.messageId;
  }

  private finishCurrent(): void {
    if (this.currentLabel) {
      const elapsed = formatDuration(Date.now() - this.phaseStart);
      this.completed.push(`✓ ${this.currentIcon} ${this.currentLabel} (${elapsed})`);
    }
    this.currentLabel = "";
    this.currentIcon = "";
  }

  private buildDisplay(): string | null {
    const hasActivity = this.currentLabel || this.completed.length > 0;

    // No active tools and buffer has text — pure response mode
    if (this.buffer.length > 0 && !this.currentLabel) {
      return this.buffer.slice(0, 4096);
    }

    // Build status display
    const lines: string[] = [];

    // Pulsing glyph + fixed verb header (Claude Code style)
    this.glyphIdx = (this.glyphIdx + 1) % GLYPH_FRAMES.length;
    const glyph = GLYPH_FRAMES[this.glyphIdx];
    const totalElapsed = formatDuration(Date.now() - this.globalStart);
    lines.push(`${glyph} ${this.verb}… (${totalElapsed})`);

    // Completed steps
    for (const step of this.completed.slice(-6)) {
      lines.push(step);
    }

    // Current activity
    if (this.currentLabel) {
      const elapsed = formatDuration(Date.now() - this.phaseStart);
      lines.push(`  ↳ ${this.currentIcon} ${this.currentLabel} (${elapsed})`);
    }

    // Show latest buffer text snippet below status (truncated)
    if (this.buffer.length > 0) {
      lines.push("");
      const preview = this.buffer.length > 200
        ? "…" + this.buffer.slice(-200)
        : this.buffer;
      lines.push(preview);
    }

    const display = lines.join("\n");
    return display.slice(0, 4096) || null;
  }
}

/** Extract a brief detail string from tool input */
export function getToolDetail(name: string, input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const inp = input as Record<string, unknown>;
  try {
    switch (name) {
      case "Read":
        return shortPath(inp.file_path as string);
      case "Write":
        return shortPath(inp.file_path as string);
      case "Edit":
        return shortPath(inp.file_path as string);
      case "Bash":
        return truncate(String(inp.command ?? ""), 50);
      case "Glob":
        return String(inp.pattern ?? "");
      case "Grep":
        return truncate(String(inp.pattern ?? ""), 40);
      case "Agent":
        return truncate(String(inp.description ?? inp.prompt ?? ""), 40);
      default:
        return "";
    }
  } catch {
    return "";
  }
}

function shortPath(p: string | undefined): string {
  if (!p) return "";
  const parts = p.split("/");
  return parts.length > 2 ? `.../${parts.slice(-2).join("/")}` : p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}
