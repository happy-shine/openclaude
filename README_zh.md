# OpenClaude

将 Telegram 等聊天平台桥接到 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 的网关——把 Claude 变成随时在线的聊天机器人，支持会话管理、访问控制和文件共享。

```
Telegram ←→ OpenClaude Gateway ←→ Claude Code CLI（子进程）
```

每个对话都会启动一个真实的 Claude Code 进程。Claude 可以读写文件、执行命令、搜索网页——凡是在终端能做的，现在手机上都能做。

[English](README.md)

## 功能特性

- **以 Claude Code 为引擎** — 不是 API 封装。每个会话都是独立的 Claude Code 子进程，支持工具调用、文件 I/O 和 bash
- **多 Bot 支持** — 一个 gateway 同时运行多个 Bot，各自独立配置、人格和访问控制
- **Bot 间中继** — 群聊中 Bot 可以互相 @mention，gateway 在内部路由消息，不依赖 Telegram 的 bot-to-bot 消息投递
- **会话管理** — `/new`、`/sessions`（带内联按钮）。每个对话可有多个会话，各自独立工作区
- **`/btw` 旁路提问** — 并行提问，不打断当前会话
- **丰富的命令** — `/model`、`/effort`、`/stop` 实时控制会话
- **内联按钮** — 会话选择器和选项以可点击的 Telegram 按钮形式呈现，过期按钮自动清除
- **访问控制** — 白名单 + 配对码流程，支持私聊和群组。陌生人无法使用你的 Bot
- **群聊支持** — 响应 @提及和回复；完整消息记录（包括 Bot 回复）带发言人、时间戳上下文注入 Claude
- **文件共享** — 向 Claude 上传文件，Claude 也可以发文件给你；回复附件自动转发。Claude 还能通过聊天记录找回之前发送的文件
- **SOUL.md 人格定制** — 每个 Bot 可自定义人格，Claude 甚至可以根据用户指令自行修改 SOUL.md
- **实时进度** — 脉冲状态指示器显示 Claude 正在做什么（思考、读写文件、执行命令等）
- **守护进程模式** — 后台运行，持久化日志，崩溃自动重启
- **热重载** — 配置变更（包括增删 Bot）无需重启即可生效

## 前置要求

- **Node.js** >= 22
- **Claude Code CLI** 已安装并登录（`npm install -g @anthropic-ai/claude-code`，然后运行 `claude` 登录）
- **Telegram Bot Token**，从 [@BotFather](https://t.me/BotFather) 获取

## 安装

```bash
git clone https://github.com/happy-shine/openclaude.git
cd openclaude
npm install
npm run build
npm link        # 将 `openclaude` 注册为全局命令
```

## 快速开始

**1. 创建配置文件**

```bash
mkdir -p ~/.openclaude
cp config.example.yaml ~/.openclaude/config.yaml
```

编辑 `~/.openclaude/config.yaml`，填入 Bot Token：

```yaml
bots:
  - name: "mybot"
    token: "123456:ABC-DEF..."   # 从 @BotFather 获取
    auth:
      dmPolicy: "pairing"       # pairing | open | allowlist | disabled
      groupPolicy: "pairing"    # pairing | open | allowlist | disabled
```

**2. 启动网关**

```bash
openclaude gateway start          # 后台守护进程
openclaude gateway start -f       # 前台运行（调试用）
```

**3. 配对账号**

在 Telegram 给 Bot 发消息，Bot 会回复一个配对码，用 CLI 审批：

```bash
openclaude pairing list
openclaude pairing approve <配对码>
```

完成。开始在 Telegram 上和 Claude 对话。

## 配置说明

完整配置示例（`config.example.yaml`）：

```yaml
gateway:
  port: 18790                 # 本地 API 端口（用于文件发送）
  dataDir: "~/.openclaude"
  logLevel: "info"            # debug | info | warn | error

claude:
  binary: "claude"            # claude CLI 路径
  model: "sonnet"             # sonnet | opus | haiku | 完整模型 ID
  idleTimeoutMs: 600000       # 空闲 10 分钟后终止进程
  maxProcesses: 10            # 最大并发 Claude 进程数
  extraArgs: []               # 附加 CLI 参数

auth:
  defaultPolicy: "pairing"    # 新 Bot 的默认策略

bots:
  - name: "assistant"
    token: "${TELEGRAM_BOT_TOKEN}"  # 支持环境变量展开
    auth:
      dmPolicy: "pairing"          # 私聊访问策略
      groupPolicy: "pairing"       # 群聊访问策略
      allowFrom: []                # 预审批的 Telegram 用户 ID
      groups:                      # 群组配置
        "-1001234567890":
          enabled: true
  - name: "helper"
    token: "another-bot-token"
    auth:
      dmPolicy: "pairing"
      groupPolicy: "disabled"
```

### 访问策略

| 策略 | 行为 |
|------|------|
| `open` | 任何人都可以使用 |
| `pairing` | 新用户/群组获得配对码，管理员通过 CLI 审批 |
| `allowlist` | 仅允许预审批的用户 ID |
| `disabled` | 禁用该渠道 |

## CLI 参考

```
openclaude gateway start [选项]    启动网关
  -f, --foreground                   前台运行
  -c, --config <路径>                指定配置文件
  -v, --verbose                      调试日志
openclaude gateway stop            停止运行中的网关
openclaude gateway restart         重启网关
openclaude gateway status          查看网关运行状态
openclaude gateway logs [-f] [-n 50]  查看网关日志

openclaude bot list                列出所有已配置的 Bot
openclaude bot add <token> [--name] 添加 Bot（自动通过 Telegram API 获取用户名）
openclaude bot remove <name>       从配置中移除 Bot

openclaude pairing list            列出待审批的配对请求
openclaude pairing approve <code>  审批配对码（自动识别对应 Bot）

openclaude group list              列出已配置的群组
openclaude group add <chatId>      添加群组到白名单
openclaude group remove <chatId>   移除群组
openclaude group approve <code>    审批群组配对码
openclaude group disable <chatId>  禁用群组（不删除）

openclaude allow list [渠道]       列出白名单用户
openclaude allow add <渠道> <ID>   添加用户到白名单
openclaude allow remove <渠道> <ID> 从白名单移除用户

openclaude bot soul show           查看当前 SOUL.md
openclaude bot soul edit           用 $EDITOR 编辑 SOUL.md
openclaude bot soul reset          删除 SOUL.md（重置人格）
openclaude bot soul path           输出 SOUL.md 文件路径
```

所有 `pairing`、`group`、`allow` 和 `bot soul` 命令都支持 `--bot <name>` 指定目标 Bot。只有一个 Bot 时可省略。

## Telegram 命令

| 命令 | 说明 |
|------|------|
| `/new` | 开启新会话 |
| `/sessions` | 列出所有会话（带内联按钮选择器） |
| `/btw <问题>` | 旁路提问，不打断当前会话 |
| `/model [名称]` | 查看或切换模型（如 `opus`、`sonnet`） |
| `/effort [级别]` | 查看或设置思考力度 |
| `/stop` | 打断 Claude 当前的回复 |
| `/help` | 显示帮助 |

在群聊中，Bot 在被 **@提及** 或**被回复**时响应。

### `/btw` — 旁路提问

`/btw` 会 fork 当前 Claude 会话，并行回答一个快速问题，不会打断主对话。适合在 Claude 处理长任务时顺便问点别的。

```
/btw 法国的首都是哪里？
```

## 多 Bot 支持

一个 gateway 可以同时运行多个 Bot。每个 Bot 有独立的人格、访问控制和会话状态，但共享同一个 Claude 进程池。

```bash
openclaude bot add 123456:ABC-DEF      # 自动从 Telegram 获取名称
openclaude bot add 789012:GHI-JKL --name helper
openclaude bot list
```

增删 Bot 会触发热重载，无需重启 gateway。

### Bot 间中继

在群聊中，当一个 Bot 的回复包含 `@另一个Bot` 时，gateway 会自动在内部中继消息。即使 Telegram 不支持 bot-to-bot 消息投递，Bot 间也能正常对话。

每个 Bot 知道 gateway 中有哪些其他 Bot，且仅在用户明确要求 Bot 间交流时才会 @mention 其他 Bot。

## 群聊支持

在群聊中，OpenClaude 会将所有消息（包括 Bot 回复）记录到持久化的聊天历史中。Claude 可以通过本地 HTTP 端点查询历史记录，了解过去的对话上下文。

群组可以通过配对码审批（Bot 发码，管理员审批）或在 `config.yaml` 中预配置。

## SOUL.md — Bot 人格定制

通过创建 `SOUL.md` 文件定制 Bot 的人格：

```bash
openclaude bot soul edit
```

也可以让 Claude 自己改——告诉 Bot "以后用海盗风格说话"，它会自动更新 SOUL.md。

修改在下一个 `/new` 会话生效。

## 架构

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Telegram   │────→│  OpenClaude GW   │────→│  Claude Code    │
│   (grammY)   │←────│                  │←────│  CLI 进程        │
└──────────────┘     │  - 多 Bot 支持    │     │  (子进程)        │
                     │  - Bot 间中继     │     │  - 工具调用      │
                     │  - 会话管理       │     │  - 文件 I/O     │
                     │  - 进程池         │     │  - Bash 执行    │
                     │  - 访问控制       │     │  - 网络搜索      │
                     │  - 进度显示       │     └─────────────────┘
                     │  - HTTP API      │
                     │  - 聊天记录       │
                     └──────────────────┘
```

**数据目录**（`~/.openclaude/`）：

```
~/.openclaude/
├── config.yaml              # 配置文件
├── logs/gateway.log         # 守护进程日志
├── sessions/                # 每个对话的会话状态
├── credentials/             # 白名单、配对数据、运行时群组
├── messages/                # 持久化群聊记录（JSONL）
├── workspace/{botId}/       # 每个会话的工作目录
│   └── {chatId}_{sessionId}/
└── agents/{botId}/          # 每个 Bot 的人格文件
    └── SOUL.md
```

## 社区

本项目在 [LINUX DO](https://linux.do/) 社区分享。

## 许可证

MIT
