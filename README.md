# OpenClaude

A gateway that bridges chat platforms (Telegram, Discord, etc.) to [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI — turning Claude into an always-on chatbot with session management, access control, and file sharing.

```
Telegram ←→ OpenClaude Gateway ←→ Claude Code CLI (subprocess)
```

Each conversation spawns a real Claude Code process. Claude can read/write files, run commands, search the web — everything it can do in your terminal, now accessible from your phone.

## Features

- **Claude Code as engine** — not an API wrapper. Each session is a full Claude Code subprocess with tool use, file I/O, and bash access
- **Session management** — `/new`, `/switch`, `/sessions` commands. Multiple sessions per chat, each with its own workspace
- **Access control** — allowlist + pairing code flow. No strangers can use your bot
- **Group chat support** — responds to @mentions and replies in groups
- **File sharing** — upload files to Claude, Claude sends files back to you
- **SOUL.md personality** — customize your bot's personality per-bot. Claude can even edit its own SOUL via user instructions
- **Live progress** — pulsing status indicator shows what Claude is doing (thinking, reading, writing, running commands)
- **Daemon mode** — runs in background with log persistence, auto-restart on crash

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
channels:
  telegram:
    botToken: "123456:ABC-DEF..."   # from @BotFather
    dmPolicy: "pairing"             # pairing | open | allowlist | disabled
    groupPolicy: "disabled"         # disabled | open | allowlist
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

channels:
  telegram:
    botToken: "${TELEGRAM_BOT_TOKEN}"  # supports env var expansion
    dmPolicy: "pairing"       # DM access policy
    groupPolicy: "disabled"   # group access policy
    allowFrom: []             # pre-approved Telegram user IDs
    groups:                   # per-group config
      "-1001234567890":
        enabled: true
```

### Access Policies

| Policy | Behavior |
|--------|----------|
| `open` | Anyone can use the bot |
| `pairing` | New users get a pairing code, owner approves via CLI |
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

openclaude pairing list             List pending pairing requests
openclaude pairing approve <code>   Approve a pairing code

openclaude allow list [channel]     List allowed users
openclaude allow add <ch> <id>      Add user to allowlist
openclaude allow remove <ch> <id>   Remove user from allowlist

openclaude agent show               Show current SOUL.md
openclaude agent edit               Edit SOUL.md in $EDITOR
openclaude agent reset              Delete SOUL.md (reset personality)
openclaude agent path               Print SOUL.md file path
```

## Telegram Commands

| Command | Description |
|---------|-------------|
| `/new` | Start a new session |
| `/switch N` | Switch to session #N |
| `/sessions` | List all sessions |
| `/help` | Show help |

In groups, the bot responds when **@mentioned** or **replied to**.

## SOUL.md — Bot Personality

Customize your bot's personality by creating a `SOUL.md` file:

```bash
openclaude agent edit
```

Or let Claude edit it — tell your bot "from now on, speak like a pirate" and it will update its own SOUL.md.

Changes take effect on the next `/new` session.

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Telegram   │────→│  OpenClaude GW   │────→│  Claude Code    │
│   (grammY)   │←────│                  │←────│  CLI Process    │
└──────────────┘     │  - Session Mgr   │     │  (subprocess)   │
                     │  - Process Pool  │     │  - Tool use     │
                     │  - Access Ctrl   │     │  - File I/O     │
                     │  - Progress UI   │     │  - Bash access  │
                     │  - HTTP API      │     │  - Web search   │
                     └──────────────────┘     └─────────────────┘
```

**Data directory** (`~/.openclaude/`):

```
~/.openclaude/
├── config.yaml              # configuration
├── logs/gateway.log         # daemon logs
├── sessions/                # session state per chat
├── credentials/             # allowlists, pairing data
├── workspace/{botId}/       # per-session working directories
│   └── {chatId}_{sessionId}/
└── agents/{botId}/          # per-bot personality
    └── SOUL.md
```

## License

MIT
