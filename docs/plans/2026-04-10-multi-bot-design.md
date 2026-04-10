# Multi-Bot Support Design

## Overview

OpenClaude gateway supports multiple Telegram bots in a single daemon process. Gateway and bots are 1:N — one process, one shared port, one shared Claude process pool, multiple independent bot identities.

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Config structure | Single YAML, `bots` array with inheritance | One file to manage, bot configs inherit top-level defaults |
| Process pool | Shared across all bots | Better resource utilization, gateway is just a forwarding layer |
| API server | Single port, `bot_id` in route params | Simpler than multi-port, consistent with shared architecture |
| Daemon model | Single process for all bots | Node.js async I/O handles multiple polling loops fine, saves memory |
| Group chat | Shared — multiple bots can be in same group | MessageStore is per-chatId, cursors are per-session, natural isolation |
| Backward compat | Auto-convert old `channels.telegram` to single-bot `bots` array | Zero-effort migration for existing users |

## Configuration

```yaml
gateway:
  port: 18790
  dataDir: ~/.openclaude
  logLevel: info

claude:                          # defaults — bots inherit these
  binary: claude
  model: sonnet
  idleTimeoutMs: 600000
  maxProcesses: 10
  extraArgs: []

auth:                            # default auth policy
  defaultPolicy: pairing

bots:
  - name: ATRI
    token: ${ATRI_BOT_TOKEN}
    model: opus                  # overrides claude.model
    auth:
      dmPolicy: pairing
      groupPolicy: open
      groups:
        "-1003691068764":
          allowFrom: ["all"]

  - name: Assistant
    token: ${ASSISTANT_BOT_TOKEN}
    # model: inherits "sonnet" from claude.model
    auth:
      dmPolicy: allowlist
      allowFrom: ["123456"]
```

### Inheritance Rules

Each bot config is merged with top-level defaults:
- `model`: bot-level overrides `claude.model`
- `auth`: bot-level overrides `auth.defaultPolicy`
- `extraArgs`: bot-level appends to `claude.extraArgs`
- Everything else: bot-level wins if specified, else top-level default

### Backward Compatibility

If `bots` array is absent but `channels.telegram` exists, auto-convert:

```typescript
if (!config.bots && config.channels?.telegram) {
  config.bots = [{
    name: "default",
    token: config.channels.telegram.botToken,
    auth: { /* map from channels.telegram policies */ },
  }]
}
```

## Architecture

```
Gateway
├── config: GatewayConfig
├── apiServer: ApiServer              single port, routes include bot_id
├── processManager: ProcessManager    shared pool, maxProcesses global
├── messageStore: MessageStore        per-chatId, shared across bots
├── bots: Map<botId, BotInstance>
│
└── BotInstance
    ├── botId: string                 extracted from token
    ├── name: string                  display name from config
    ├── config: ResolvedBotConfig     merged with defaults
    ├── telegram: TelegramAdapter     own grammY Bot instance
    ├── sessionManager: SessionManager own sessions
    ├── pairingManager: PairingManager own credentials
    └── chatQueues: Map<string, Promise<void>>
```

### Responsibility Split

**Gateway (container):**
- Load config, resolve bot inheritance
- Create shared resources (ProcessManager, ApiServer, MessageStore)
- Instantiate BotInstance per bot config
- Start/stop lifecycle, config hot reload
- Daemon management (PID lock, signal handling)

**BotInstance (per-bot logic):**
- Telegram polling via own TelegramAdapter
- Message handling (current Gateway.handleMessage moves here)
- Command handling (/new, /sessions, /model, /btw, etc.)
- Session management via own SessionManager
- Auth checks (access control, pairing, allowlists)
- System prompt assembly (SOUL.md, skills, send-file curl with own botId)

### Shared Resources

**ProcessManager:**
- Already uses `botId` for workspace path: `workspace/{botId}/{chatId}_{sessionId}`
- No structural change needed — BotInstance passes its botId when calling `acquire()`
- Global `maxProcesses` cap across all bots
- Eviction policy: oldest idle process regardless of which bot owns it

**MessageStore:**
- Stored per-chatId: `messages/{chatId}.jsonl`
- Multiple bots in same group each record their own outbound messages
- Cursor tracking is per-session (already isolated)
- Bot messages include sender info for attribution

**ApiServer:**
- Single port, routes carry `bot_id`:
  - `POST /api/send-file?bot_id=xxx&chat_id=yyy&file_path=zzz`
  - `GET /api/soul?bot_id=xxx`
  - `GET /api/chat-history?chat_id=yyy&since=2h`
- ApiServer holds reference to `bots` map to find correct TelegramAdapter for sending
- Chat history endpoint is bot-agnostic (shared MessageStore)

## Storage Layout

```
~/.openclaude/
├── config.yaml                          single config, bots array
├── gateway.lock                         single daemon PID
├── logs/
│   └── gateway.log                      unified log (prefixed with bot name)
├── sessions/
│   └── {botId}/
│       └── {chatId}/
│           └── state.json               sessions for this bot+chat
├── workspace/
│   └── {botId}/
│       └── {chatId}_{sessionId}/        Claude working directory
├── agents/
│   └── {botId}/
│       └── SOUL.md                      per-bot personality
├── credentials/
│   └── {botId}/
│       ├── telegram-pairing.json        per-bot pairing
│       └── telegram-allowFrom.json      per-bot allowlist
└── messages/
    └── {chatId}.jsonl                   shared group chat history
```

Key change: `sessions/` and `credentials/` gain `{botId}/` prefix. `workspace/` and `agents/` already have it.

## System Prompt Changes

Each bot's Claude process gets its own `send-file` curl with correct `bot_id`:

```bash
curl -s -X POST "http://127.0.0.1:18790/api/send-file?bot_id={botId}&chat_id={chatId}&file_path=..."
```

SOUL.md path already per-bot: `agents/{botId}/SOUL.md`.

## Error Handling

- One bot's Telegram polling failure doesn't affect others (each TelegramAdapter has independent retry)
- Process pool exhaustion affects all bots (shared pool) — evict oldest idle regardless of bot
- Config validation: duplicate bot tokens rejected at startup
- Bot token format validation before creating BotInstance

## CLI Changes

```bash
openclaude start          # starts daemon with all bots
openclaude stop           # stops daemon (all bots)
openclaude restart        # restarts daemon
openclaude status         # shows all bots and their status
```

No per-bot start/stop — single daemon manages all.
