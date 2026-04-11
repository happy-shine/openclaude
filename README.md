# OpenClaude

A gateway that bridges chat platforms (Telegram, Discord, etc.) to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI — turning Claude into an always-on chatbot with session management, access control, and file sharing.

```
Telegram ←→ OpenClaude Gateway ←→ Claude Code CLI (subprocess)
```

Each conversation spawns a real Claude Code process. Claude can read/write files, run commands, search the web — everything it can do in your terminal, now accessible from your phone.

[中文文档](README_zh.md)

## Features

- **Claude Code as engine** — not an API wrapper. Each session is a full Claude Code subprocess with tool use, file I/O, and bash access
- **Multi-bot support** — run multiple bots on a single gateway, each with independent config, personality, and access control
- **Bot-to-bot relay** — bots can @mention each other in group chats; the gateway routes messages internally without relying on Telegram's bot-to-bot delivery
- **Session management** — `/new`, `/sessions` with inline buttons. Multiple sessions per chat, each with its own workspace
- **`/btw` side questions** — ask a non-blocking question in parallel without interrupting the current session
- **Rich commands** — `/model`, `/effort`, `/stop` for live session control
- **Inline buttons** — session picker and choices rendered as tappable Telegram buttons; stale buttons auto-removed
- **Access control** — allowlist + pairing code flow for both DMs and groups. No strangers can use your bot
- **Group chat support** — responds to @mentions and replies; full message history (including bot replies) with sender/timestamp context injected into Claude
- **File sharing** — upload files to Claude, Claude sends files back to you; reply attachments forwarded. Claude can also retrieve previously shared files via chat history
- **SOUL.md personality** — customize your bot's personality per-bot. Claude can even edit its own SOUL via user instructions
- **Live progress** — pulsing status indicator shows what Claude is doing (thinking, reading, writing, running commands)
- **Daemon mode** — runs in background with log persistence, auto-restart on crash
- **Hot-reload** — config changes (including adding/removing bots) are picked up without restart

## Prerequisites

- **Node.js** >= 22
- **Claude Code CLI** installed and authenticated (`npm install -g @anthropic-ai/claude-code`, then `claude` to authenticate)
- **Telegram Bot Token** from [@BotFather](https://t.me/BotFather)

## Install

```bash
git clone https://github.com/happy-shine/openclaude.git
cd openclaude
npm install
npm run build
npm link        # makes `openclaude` available globally
```

## Quick Start

**1. Create config**

```bash
mkdir -p ~/.openclaude
cp config.example.yaml ~/.openclaude/config.yaml
```

Edit `~/.openclaude/config.yaml` and set your bot token:

```yaml
bots:
  - name: "mybot"
    token: "123456:ABC-DEF..."   # from @BotFather
    auth:
      dmPolicy: "pairing"       # pairing | open | allowlist | disabled
      groupPolicy: "pairing"    # pairing | open | allowlist | disabled
```

**2. Start the gateway**

```bash
openclaude gateway start          # background daemon
openclaude gateway start -f       # foreground (for debugging)
```

**3. Pair your account**

Message your bot on Telegram. It will reply with a pairing code. Approve it:

```bash
openclaude pairing list
openclaude pairing approve <code>
```

Done. Start chatting with Claude via Telegram.

## Configuration

Full config example (`config.example.yaml`):

```yaml
gateway:
  port: 18790                 # local API port (for file sending)
  dataDir: "~/.openclaude"
  logLevel: "info"            # debug | info | warn | error

claude:
  binary: "claude"            # path to claude CLI
  model: "sonnet"             # sonnet | opus | haiku | full model ID
  idleTimeoutMs: 600000       # kill idle processes after 10min
  maxProcesses: 10            # max concurrent Claude processes
  extraArgs: []               # additional CLI flags

auth:
  defaultPolicy: "pairing"    # default policy for new bots

bots:
  - name: "assistant"
    token: "${TELEGRAM_BOT_TOKEN}"  # supports env var expansion
    auth:
      dmPolicy: "pairing"          # DM access policy
      groupPolicy: "pairing"       # group access policy
      allowFrom: []                # pre-approved Telegram user IDs
      groups:                      # per-group config
        "-1001234567890":
          enabled: true
  - name: "helper"
    token: "another-bot-token"
    auth:
      dmPolicy: "pairing"
      groupPolicy: "disabled"
```

### Access Policies

| Policy | Behavior |
|--------|----------|
| `open` | Anyone can use the bot |
| `pairing` | New users/groups get a pairing code, owner approves via CLI |
| `allowlist` | Only pre-approved user IDs |
| `disabled` | Channel disabled |

## CLI Reference

```
openclaude gateway start [options]  Start the gateway
  -f, --foreground                    Run in foreground
  -c, --config <path>                 Config file path
  -v, --verbose                       Debug logging
openclaude gateway stop             Stop the running gateway
openclaude gateway restart          Restart the gateway
openclaude gateway status           Check if gateway is running
openclaude gateway logs [-f] [-n 50] Tail gateway logs

openclaude bot list                 List all configured bots
openclaude bot add <token> [--name] Add a bot (auto-detects username via Telegram API)
openclaude bot remove <name>        Remove a bot from config

openclaude pairing list             List pending pairing requests
openclaude pairing approve <code>   Approve a pairing code (auto-detects which bot)

openclaude group list               List configured groups
openclaude group add <chatId>       Add a group to allowlist
openclaude group remove <chatId>    Remove a group
openclaude group approve <code>     Approve a group pairing code
openclaude group disable <chatId>   Disable a group without removing

openclaude allow list [channel]     List allowed users
openclaude allow add <ch> <id>      Add user to allowlist
openclaude allow remove <ch> <id>   Remove user from allowlist

openclaude bot soul show            Show current SOUL.md
openclaude bot soul edit            Edit SOUL.md in $EDITOR
openclaude bot soul reset           Delete SOUL.md (reset personality)
openclaude bot soul path            Print SOUL.md file path
```

All `pairing`, `group`, `allow`, and `bot soul` commands support `--bot <name>` to target a specific bot. When only one bot is configured, the flag is optional.

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/sessions` | List all sessions with inline picker buttons |
| `/btw <question>` | Ask a side question without interrupting the current session |
| `/model [name]` | Show or set the model (e.g. `opus`, `sonnet`) |
| `/effort [level]` | Show or set effort level |
| `/stop` | Interrupt Claude's current response |
| `/help` | Show help |

In groups, the bot responds when **@mentioned** or **replied to**.

### `/btw` — Non-blocking Side Questions

`/btw` forks the current Claude session to answer a quick question in parallel — without interrupting the main conversation. Useful for asking something while Claude is still working on a longer task.

```
/btw what's the capital of France?
```

## Multi-Bot

Run multiple bots on a single gateway. Each bot has its own personality, access control, and session state, but they share the same Claude process pool.

```bash
openclaude bot add 123456:ABC-DEF      # auto-detects name from Telegram
openclaude bot add 789012:GHI-JKL --name helper
openclaude bot list
```

Adding or removing bots triggers a hot-reload — no gateway restart needed.

### Bot-to-Bot Relay

In group chats, when one bot's reply contains `@another_bot`, the gateway automatically relays the message internally. This works even though Telegram doesn't deliver bot-to-bot messages natively.

Each bot knows which other bots are in the gateway and will only @mention them when the user explicitly asks for bot-to-bot interaction.

## Group Chat

In group chats, OpenClaude records all messages (including bot replies) to a persistent chat history. Claude can query this history via a local HTTP endpoint for context about past conversations.

Groups can be authorized via pairing (bot sends a code, owner approves) or pre-configured in `config.yaml`.

## SOUL.md — Bot Personality

Customize your bot's personality by creating a `SOUL.md` file:

```bash
openclaude bot soul edit
```

Or let Claude edit it — tell your bot "from now on, speak like a pirate" and it will update its own SOUL.md.

Changes take effect on the next `/new` session.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Telegram   │────→│  OpenClaude GW   │────→│  Claude Code    │
│   (grammY)   │←────│                  │←────│  CLI Process    │
└──────────────┘     │  - Multi-bot     │     │  (subprocess)   │
                     │  - Bot Relay     │     │  - Tool use     │
                     │  - Session Mgr   │     │  - File I/O     │
                     │  - Process Pool  │     │  - Bash access  │
                     │  - Access Ctrl   │     │  - Web search   │
                     │  - Progress UI   │     └─────────────────┘
                     │  - HTTP API      │
                     │  - Chat History  │
                     └──────────────────┘
```

**Data directory** (`~/.openclaude/`):

```
~/.openclaude/
├── config.yaml              # configuration
├── logs/gateway.log         # daemon logs
├── sessions/                # session state per chat
├── credentials/             # allowlists, pairing data, runtime groups
├── messages/                # persistent group chat history (JSONL)
├── workspace/{botId}/       # per-session working directories
│   └── {chatId}_{sessionId}/
└── agents/{botId}/          # per-bot personality
    └── SOUL.md
```

## Community

This project is shared with the [LINUX DO](https://linux.do/) community.

## License

MIT
