# Multi-Bot Support Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Support multiple Telegram bots in a single openclaude daemon, with shared process pool, shared API port, and per-bot sessions/auth/personality.

**Architecture:** Single Gateway container manages N BotInstance objects. Each BotInstance owns a TelegramAdapter, SessionManager, and PairingManager. ProcessManager, ApiServer, and MessageStore are shared. Config uses `bots` array with inheritance from top-level defaults.

**Tech Stack:** TypeScript, grammY, Zod, pino, Node.js HTTP server

**Design Doc:** `docs/plans/2026-04-10-multi-bot-design.md`

---

### Task 1: Add BotConfig type and update config schema

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/config/loader.ts`

**Step 1: Update types.ts — add BotConfig, update GatewayConfig**

```typescript
// src/config/types.ts — full rewrite

export interface GatewayConfig {
  gateway: {
    port: number;
    dataDir: string;
    logLevel: "debug" | "info" | "warn" | "error";
    logFormat: "pretty" | "json";
  };
  claude: {
    binary: string;
    model?: string;
    idleTimeoutMs: number;
    maxProcesses: number;
    extraArgs: string[];
  };
  auth: {
    defaultPolicy: "open" | "pairing" | "allowlist" | "disabled";
  };
  // Legacy single-bot config — auto-converted to bots[] at load time
  channels?: {
    telegram?: TelegramChannelConfig;
  };
  // New multi-bot config
  bots: BotConfig[];
}

export interface BotConfig {
  name: string;
  token: string;
  model?: string;           // overrides claude.model
  extraArgs?: string[];     // appends to claude.extraArgs
  auth?: {
    dmPolicy?: "open" | "pairing" | "allowlist" | "disabled";
    groupPolicy?: "open" | "allowlist" | "disabled";
    allowFrom?: string[];
    groups?: Record<string, TelegramGroupConfig>;
  };
}

/** Fully resolved bot config after merging with defaults */
export interface ResolvedBotConfig {
  name: string;
  token: string;
  botId: string;
  model?: string;
  extraArgs: string[];
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  groups: Record<string, TelegramGroupConfig>;
}

// Keep for backward compat parsing
export interface TelegramChannelConfig {
  botToken: string;
  dmPolicy: "open" | "pairing" | "allowlist" | "disabled";
  groupPolicy: "open" | "allowlist" | "disabled";
  allowFrom: string[];
  groups: Record<string, TelegramGroupConfig>;
}

export interface TelegramGroupConfig {
  enabled: boolean;
  allowFrom?: string[];
}
```

**Step 2: Update schema.ts — add botSchema, keep legacy channelsSchema**

Add `botSchema` Zod object and make `bots` an optional array in `configSchema`. Keep `channels` for backward compat.

```typescript
const botSchema = z.object({
  name: z.string().min(1),
  token: z.string().min(1),
  model: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  auth: z.object({
    dmPolicy: z.enum(["open", "pairing", "allowlist", "disabled"]).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    groups: z.record(z.string(), telegramGroupSchema).optional(),
  }).optional(),
});

export const configSchema = z.object({
  gateway: gatewaySchema.default(gatewaySchema.parse({})),
  claude: claudeSchema.default(claudeSchema.parse({})),
  auth: authSchema.default(authSchema.parse({})),
  channels: channelsSchema.optional(),  // legacy
  bots: z.array(botSchema).optional(),  // new
});
```

**Step 3: Update loader.ts — add resolveBots() for inheritance + backward compat**

Add `resolveBots(config: GatewayConfig): ResolvedBotConfig[]` that:
1. If `bots` exists, merge each with top-level defaults
2. If no `bots` but `channels.telegram` exists, convert to single-bot array
3. Validate no duplicate tokens
4. Extract botId from each token

```typescript
export function resolveBots(config: GatewayConfig): ResolvedBotConfig[] {
  let bots: BotConfig[] = config.bots ?? [];

  // Backward compat: convert legacy channels.telegram to bots[]
  if (bots.length === 0 && config.channels?.telegram) {
    const tg = config.channels.telegram;
    bots = [{
      name: "default",
      token: tg.botToken,
      auth: {
        dmPolicy: tg.dmPolicy,
        groupPolicy: tg.groupPolicy,
        allowFrom: tg.allowFrom,
        groups: tg.groups,
      },
    }];
  }

  // Merge with defaults and resolve
  const resolved = bots.map((bot): ResolvedBotConfig => {
    const botId = bot.token.split(":")[0];
    return {
      name: bot.name,
      token: bot.token,
      botId,
      model: bot.model ?? config.claude.model,
      extraArgs: [...config.claude.extraArgs, ...(bot.extraArgs ?? [])],
      dmPolicy: bot.auth?.dmPolicy ?? config.auth.defaultPolicy as any ?? "pairing",
      groupPolicy: bot.auth?.groupPolicy ?? "disabled",
      allowFrom: bot.auth?.allowFrom ?? [],
      groups: bot.auth?.groups ?? {},
    };
  });

  // Validate no duplicate tokens
  const tokens = new Set<string>();
  for (const bot of resolved) {
    if (tokens.has(bot.token)) {
      throw new Error(`Duplicate bot token for "${bot.name}"`);
    }
    tokens.add(bot.token);
  }

  return resolved;
}
```

**Step 4: Update DEFAULT_CONFIG template**

Update the default config.yaml template to use the new `bots` format.

**Step 5: Commit**

```bash
git add src/config/types.ts src/config/schema.ts src/config/loader.ts
git commit -m "feat: add BotConfig type, multi-bot schema, resolveBots with backward compat"
```

---

### Task 2: Create BotInstance class

**Files:**
- Create: `src/bot-instance.ts`

**Step 1: Create BotInstance**

Extract per-bot logic from Gateway into a new BotInstance class. This class holds:
- Its own TelegramAdapter, SessionManager, PairingManager
- Reference to shared ProcessManager, MessageStore, ApiServer
- All command handlers (moved from Gateway)
- Message handling pipeline (moved from Gateway)

```typescript
// src/bot-instance.ts

import type { Logger } from "pino";
import type { ResolvedBotConfig, GatewayConfig } from "./config/types.js";
import type { InboundMessage } from "./channels/types.js";
import type { StreamEvent } from "./process/types.js";
import { TelegramAdapter } from "./channels/telegram/adapter.js";
import { SessionManager } from "./sessions/manager.js";
import { SessionStore } from "./sessions/store.js";
import { ProcessManager } from "./process/manager.js";
import { MessageStore } from "./sessions/message-store.js";
import { PairingManager } from "./auth/pairing.js";
import { checkAccess } from "./auth/access.js";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";

export class BotInstance {
  readonly botId: string;
  readonly name: string;
  readonly config: ResolvedBotConfig;
  readonly telegram: TelegramAdapter;
  private sessionManager: SessionManager;
  private pairingManager: PairingManager;
  private processManager: ProcessManager;  // shared
  private messageStore: MessageStore;       // shared
  private log: Logger;
  private dataDir: string;
  private allowFrom: Set<string>;
  private lastButtonMsg = new Map<string, string>();
  private chatQueues = new Map<string, Promise<void>>();

  constructor(opts: {
    botConfig: ResolvedBotConfig;
    gatewayConfig: GatewayConfig;
    processManager: ProcessManager;
    messageStore: MessageStore;
    dataDir: string;
    log: Logger;
  }) {
    this.config = opts.botConfig;
    this.botId = opts.botConfig.botId;
    this.name = opts.botConfig.name;
    this.processManager = opts.processManager;
    this.messageStore = opts.messageStore;
    this.dataDir = opts.dataDir;
    this.log = opts.log.child({ bot: this.name });

    // Per-bot session storage: sessions/{botId}/
    const sessionStore = new SessionStore(join(this.dataDir, "sessions", this.botId));
    this.sessionManager = new SessionManager(sessionStore);

    // Per-bot credentials: credentials/{botId}/
    const credDir = join(this.dataDir, "credentials", this.botId);
    mkdirSync(credDir, { recursive: true });
    this.pairingManager = new PairingManager(join(credDir, "telegram-pairing.json"));
    this.allowFrom = this.loadAllowFrom();

    this.telegram = new TelegramAdapter(opts.botConfig.token, this.log);
  }

  // ... move all handlers from Gateway:
  // handleMessage, handleNewSession, handleBtw, handleSessionsCommand,
  // handleHelp, handleModel, handleEffort, handleInterrupt, handleTitle,
  // checkMessageAccess, enqueueChat, loadAllowFrom, saveAllowFrom,
  // handleListSessions, etc.
}
```

The key difference: instead of `this.config.channels.telegram!` for auth, use `this.config` (ResolvedBotConfig) directly. Instead of extracting botId from token each time, use `this.botId`.

**Step 2: Move handleMessage and all command handlers from Gateway**

Copy the full implementation of these methods from `gateway.ts` into `BotInstance`, updating references:
- `this.config.channels.telegram!` → `this.config` (ResolvedBotConfig fields)
- `this.config.channels.telegram!.botToken.split(":")[0]` → `this.botId`
- Keep `this.processManager` and `this.messageStore` as shared references

**Step 3: Add start() and stop() to BotInstance**

```typescript
async start(): Promise<void> {
  this.sessionManager.loadAll();
  this.telegram.setMessageStore(this.messageStore);

  // Register commands
  this.telegram.onCommand("new", (msg) => this.handleNewSession(msg));
  this.telegram.onCommand("btw", (msg) => this.handleBtw(msg));
  this.telegram.onCommand("sessions", (msg) => this.handleSessionsCommand(msg));
  this.telegram.onCommand("help", (msg) => this.handleHelp(msg));
  this.telegram.onCommand("model", (msg) => this.handleModel(msg));
  this.telegram.onCommand("effort", (msg) => this.handleEffort(msg));
  this.telegram.onCommand("stop", (msg) => this.handleInterrupt(msg));
  this.telegram.onCommand("title", (msg) => this.handleTitle(msg));

  // Register callback handlers (session picker, model selector, etc.)
  // ... (move from Gateway.start())

  this.telegram.onMessage((msg) => this.enqueueChat(msg));
  await this.telegram.start();
  this.log.info("Bot started");
}

async stop(): Promise<void> {
  await this.telegram.stop();
  await this.sessionManager.flushAll();
  this.log.info("Bot stopped");
}
```

**Step 4: Commit**

```bash
git add src/bot-instance.ts
git commit -m "feat: create BotInstance class with per-bot handlers"
```

---

### Task 3: Refactor ProcessManager for multi-bot

**Files:**
- Modify: `src/process/manager.ts`

**Step 1: Change ProcessManager to accept botId per-call instead of per-constructor**

Currently `botId` is in `ProcessManagerConfig` and set once at construction. For shared pool, we need `botId` passed per `acquire()` call.

```typescript
// ProcessManagerConfig: remove botId field

// acquire() signature change:
acquire(session: Session, botId: string, botExtraArgs?: string[]): ClaudeProcess

// The botId is used for:
// 1. workspace path: join(workspaceDir, botId, `${safeChatId}_${sessionId}`)
// 2. SOUL.md path: join(agentsDir, botId, "SOUL.md")
// 3. System prompt assembly (apiPort + botId for send-file curl)
```

The key change: `acquire()` takes `botId` and bot-specific `extraArgs` (including model override) as parameters instead of reading from config.

**Step 2: Update forkAndAsk similarly**

```typescript
forkAndAsk(session, question, botId, botExtraArgs): Promise<string>
```

**Step 3: Update system prompt assembly**

The `send-file` curl in system prompt needs `bot_id` parameter:
```
curl -s -X POST "http://127.0.0.1:{port}/api/send-file?bot_id={botId}&chat_id={chatId}&file_path=..."
```

The SOUL API curl also needs correct bot_id:
```
curl -s "http://127.0.0.1:{port}/api/soul?bot_id={botId}"
```

**Step 4: Commit**

```bash
git add src/process/manager.ts
git commit -m "feat: ProcessManager accepts botId per-call for shared pool"
```

---

### Task 4: Refactor ApiServer for multi-bot routing

**Files:**
- Modify: `src/api/server.ts`

**Step 1: Change ApiServerConfig to accept bot lookup instead of single adapter**

```typescript
export interface ApiServerConfig {
  port: number;
  getBotTelegram: (botId: string) => TelegramAdapter | undefined;  // replaces single telegram
  dataDir: string;
  log: Logger;
  messageStore?: MessageStore;
  allowedChatIds?: Set<string>;
  onReloadConfig?: () => { ok: boolean; changes: string[] };
}
```

**Step 2: Update send-file and send-message handlers**

Extract `bot_id` from query params, look up the correct TelegramAdapter:

```typescript
// In send-file handler:
const botId = url.searchParams.get("bot_id");
const telegram = botId ? this.config.getBotTelegram(botId) : undefined;
if (!telegram) {
  res.writeHead(400); res.end(JSON.stringify({ ok: false, error: "invalid bot_id" }));
  return;
}
// Use this telegram adapter to send
```

**Step 3: Update allowedChatIds to be union of all bots' groups**

```typescript
updateAllowedChatIds(chatIds: Set<string>): void  // already exists, call with union
```

**Step 4: Commit**

```bash
git add src/api/server.ts
git commit -m "feat: ApiServer routes by bot_id to correct TelegramAdapter"
```

---

### Task 5: Refactor Gateway as container

**Files:**
- Modify: `src/gateway.ts`

**Step 1: Strip per-bot logic, keep container logic**

Gateway becomes thin:

```typescript
export class Gateway {
  private config: GatewayConfig;
  private log: Logger;
  private processManager: ProcessManager;
  private apiServer?: ApiServer;
  private messageStore: MessageStore;
  private bots = new Map<string, BotInstance>();
  private dataDir: string;
  private configPath: string;
  private configWatcher?: FSWatcher;

  constructor(config: GatewayConfig, log: Logger, configPath?: string) {
    this.config = config;
    this.log = log;
    this.dataDir = resolveDataDir(config);
    this.configPath = configPath ?? join(this.dataDir, "config.yaml");

    this.messageStore = new MessageStore(this.dataDir);
    setMessageStore(this.messageStore);

    const workspaceDir = join(this.dataDir, "workspace");
    const agentsDir = join(this.dataDir, "agents");
    mkdirSync(workspaceDir, { recursive: true });
    mkdirSync(agentsDir, { recursive: true });

    // Shared process manager (no botId — it's per-call now)
    this.processManager = new ProcessManager({
      binary: config.claude.binary,
      idleTimeoutMs: config.claude.idleTimeoutMs,
      maxProcesses: config.claude.maxProcesses,
      extraArgs: config.claude.extraArgs,
      workspaceDir,
      apiPort: config.gateway.port,
      agentsDir,
    }, log);

    // Create BotInstance per resolved bot config
    const resolvedBots = resolveBots(config);
    for (const botConfig of resolvedBots) {
      const bot = new BotInstance({
        botConfig,
        gatewayConfig: config,
        processManager: this.processManager,
        messageStore: this.messageStore,
        dataDir: this.dataDir,
        log,
      });
      this.bots.set(bot.botId, bot);
    }
  }

  async start(): Promise<void> {
    this.log.info(`Starting gateway with ${this.bots.size} bot(s)...`);

    // Start all bots
    for (const bot of this.bots.values()) {
      await bot.start();
      this.log.info({ bot: bot.name, botId: bot.botId }, "Bot started");
    }

    // Start shared API server
    const allGroupChatIds = new Set<string>();
    for (const bot of this.bots.values()) {
      for (const chatId of Object.keys(bot.config.groups)) {
        allGroupChatIds.add(chatId);
      }
    }

    this.apiServer = new ApiServer({
      port: this.config.gateway.port,
      getBotTelegram: (botId) => this.bots.get(botId)?.telegram,
      dataDir: this.dataDir,
      log: this.log,
      messageStore: this.messageStore,
      allowedChatIds: allGroupChatIds,
      onReloadConfig: () => this.reloadConfig(),
    });
    await this.apiServer.start();

    this.setupConfigWatcher();
    this.log.info("Gateway started");
  }

  async stop(): Promise<void> {
    this.log.info("Stopping gateway...");
    this.configWatcher?.close();
    await this.apiServer?.stop();
    for (const bot of this.bots.values()) {
      await bot.stop();
    }
    await this.processManager.shutdown();
    this.log.info("Gateway stopped");
  }

  // reloadConfig() — update shared ProcessManager config,
  // refresh allowFrom for each bot, update allowedChatIds
}
```

**Step 2: Move callback registration (onCallback) into BotInstance**

The `onCallback("sw", ...)`, `onCallback("pg", ...)`, `onCallback("model", ...)`, `onCallback("effort", ...)` calls currently in `Gateway.start()` need to move into `BotInstance.start()`. Each bot's TelegramAdapter has its own callback handlers.

Note: `onCallback` is currently a module-level function from `handlers.ts`. It needs to become per-adapter or accept a botId discriminator. Check if grammY callbacks are per-bot instance (they should be, since each Bot instance has its own `bot.callbackQuery()` handler).

**Step 3: Update reloadConfig() for multi-bot**

```typescript
reloadConfig(): { ok: boolean; changes: string[] } {
  const newConfig = loadConfig(this.configPath);
  const changes: string[] = [];
  // Update shared ProcessManager config
  // Refresh each bot's allowFrom
  // Note: adding/removing bots at runtime is out of scope for v1
  // — just update existing bots' config
  return { ok: true, changes };
}
```

**Step 4: Commit**

```bash
git add src/gateway.ts
git commit -m "refactor: Gateway becomes container for BotInstance objects"
```

---

### Task 6: Fix callback handler scoping

**Files:**
- Modify: `src/channels/telegram/handlers.ts`

**Step 1: Investigate current onCallback implementation**

Currently `onCallback` is a module-level function. For multi-bot, each bot's grammY instance needs its own callback handlers. Either:
- A) Make `onCallback` accept a bot/adapter reference
- B) Move callback registration into TelegramAdapter as a method

Option B is cleaner — add `onCallback(prefix, handler)` method to TelegramAdapter.

**Step 2: Move onCallback into TelegramAdapter**

```typescript
// In TelegramAdapter:
onCallback(prefix: string, handler: (ctx: any) => Promise<void>): void {
  this.callbackHandlers.set(prefix, handler);
}
```

Register in `start()`:
```typescript
this.bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  const prefix = data.split(":")[0];
  const handler = this.callbackHandlers.get(prefix);
  if (handler) await handler(ctx);
  await ctx.answerCallbackQuery();
});
```

**Step 3: Update BotInstance to use adapter.onCallback()**

Replace `onCallback("sw", ...)` with `this.telegram.onCallback("sw", ...)`.

**Step 4: Commit**

```bash
git add src/channels/telegram/handlers.ts src/channels/telegram/adapter.ts src/bot-instance.ts
git commit -m "refactor: move callback handlers into TelegramAdapter for per-bot scoping"
```

---

### Task 7: Update session storage paths

**Files:**
- Modify: `src/sessions/store.ts` (if needed)

**Step 1: Verify SessionStore is path-based**

SessionStore takes a directory path in its constructor. BotInstance already passes `join(dataDir, "sessions", botId)`. If SessionStore just reads/writes to the given directory, no changes needed — the per-bot path is handled at construction.

**Step 2: Migrate existing sessions (if needed)**

For backward compat, if sessions exist at `sessions/{chatId}/` (old path), they should be found under the default bot's `sessions/{botId}/{chatId}/`. Add a one-time migration in Gateway or document manual migration.

Simple approach: if `sessions/{botId}/` is empty but `sessions/` has chat dirs directly, move them.

**Step 3: Commit**

```bash
git add src/sessions/store.ts
git commit -m "feat: session storage scoped by botId with migration"
```

---

### Task 8: Update CLI commands for multi-bot

**Files:**
- Modify: `src/index.ts`

**Step 1: Update agent commands with --bot flag**

```bash
openclaude agent show --bot ATRI    # show SOUL.md for ATRI
openclaude agent show               # if single bot, use that; if multiple, list bots
```

Add `--bot <name>` option to agent subcommands. Resolve bot by name from config.

**Step 2: Update pairing/allowlist commands with --bot flag**

```bash
openclaude pairing list --bot ATRI
openclaude allow add 123456 --bot ATRI
```

Credentials paths become `credentials/{botId}/telegram-pairing.json` and `credentials/{botId}/telegram-allowFrom.json`.

**Step 3: Update status command to show all bots**

```bash
openclaude gateway status
# Output:
# Gateway running (PID 12345)
# Bots:
#   ATRI (8502335976) — 3 active sessions
#   Assistant (1234567890) — 1 active session
```

**Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat: CLI commands support --bot flag for multi-bot"
```

---

### Task 9: Update default config template

**Files:**
- Modify: `src/config/loader.ts`

**Step 1: Update DEFAULT_CONFIG to use bots[] format**

```yaml
bots:
  - name: "my-bot"
    token: "${TELEGRAM_BOT_TOKEN}"   # set env var or paste token here
```

Keep it minimal — single bot in the default template.

**Step 2: Commit**

```bash
git add src/config/loader.ts
git commit -m "feat: default config uses bots[] format"
```

---

### Task 10: Integration test — two bots in one gateway

**Files:**
- Create: test script or manual test procedure

**Step 1: Create test config with two bots**

```yaml
gateway:
  port: 18790
  dataDir: ~/.openclaude

claude:
  binary: claude
  model: sonnet
  maxProcesses: 10

bots:
  - name: ATRI
    token: ${ATRI_BOT_TOKEN}
    model: opus
    auth:
      groupPolicy: open
      groups:
        "-1003691068764":
          allowFrom: ["all"]

  - name: TestBot
    token: ${TEST_BOT_TOKEN}
    auth:
      dmPolicy: open
```

**Step 2: Verify**

1. Both bots come online and respond to `/help`
2. Both bots have separate sessions (send message to each, `/sessions` shows different lists)
3. SOUL.md is per-bot (`/api/soul?bot_id=XXX` returns different content)
4. Send-file works with correct bot_id routing
5. Shared group: both bots in same group, each reads chat history independently
6. Process pool is shared: check that processes from both bots count toward maxProcesses
7. Config hot reload works

**Step 3: Commit**

```bash
git commit -m "feat: multi-bot support complete"
```

---

## Task Dependency Graph

```
Task 1 (Config types/schema)
  ↓
Task 2 (BotInstance class)  ←  Task 3 (ProcessManager refactor)
  ↓                              ↓
Task 5 (Gateway refactor)  ←  Task 4 (ApiServer refactor)
  ↓
Task 6 (Callback scoping)
  ↓
Task 7 (Session paths)
  ↓
Task 8 (CLI commands)
  ↓
Task 9 (Default config)
  ↓
Task 10 (Integration test)
```

Tasks 1, 3, 4 can be done in parallel. Task 2 depends on Task 1. Task 5 depends on 2, 3, 4. Tasks 6-9 are sequential after 5. Task 10 is final verification.
