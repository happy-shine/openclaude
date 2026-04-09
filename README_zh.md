# OpenClaude

将 Telegram 等聊天平台桥接到 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI 的网关——把 Claude 变成随时在线的聊天机器人，支持会话管理、访问控制和文件共享。

```
Telegram ←→ OpenClaude Gateway ←→ Claude Code CLI（子进程）
```

每个对话都会启动一个真实的 Claude Code 进程。Claude 可以读写文件、执行命令、搜索网页——凡是在终端能做的，现在手机上都能做。

[English](README.md)

## 功能特性

- **以 Claude Code 为引擎** — 不是 API 封装。每个会话都是独立的 Claude Code 子进程，支持工具调用、文件 I/O 和 bash
- **会话管理** — `/new`、`/sessions`（带内联按钮）。每个对话可有多个会话，各自独立工作区
- **`/btw` 旁路提问** — 并行提问，不打断当前会话
- **丰富的命令** — `/model`、`/effort`、`/stop`、`/cost`、`/context`、`/settings` 实时控制会话
- **内联按钮** — 会话选择器和选项以可点击的 Telegram 按钮形式呈现，过期按钮自动清除
- **访问控制** — 白名单 + 配对码流程，陌生人无法使用你的 Bot
- **群聊支持** — 响应 @提及和回复；自动注入带发言人、时间戳的消息历史供 Claude 参考
- **文件共享** — 向 Claude 上传文件，Claude 也可以发文件给你；回复附件自动转发
- **SOUL.md 人格定制** — 每个 Bot 可自定义人格，Claude 甚至可以根据用户指令自行修改 SOUL.md
- **实时进度** — 脉冲状态指示器显示 Claude 正在做什么（思考、读写文件、执行命令等）
- **守护进程模式** — 后台运行，持久化日志，崩溃自动重启

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
channels:
  telegram:
    botToken: "123456:ABC-DEF..."   # 从 @BotFather 获取
    dmPolicy: "pairing"             # pairing | open | allowlist | disabled
    groupPolicy: "disabled"         # disabled | open | allowlist
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

channels:
  telegram:
    botToken: "${TELEGRAM_BOT_TOKEN}"  # 支持环境变量展开
    dmPolicy: "pairing"       # 私聊访问策略
    groupPolicy: "disabled"   # 群聊访问策略
    allowFrom: []             # 预审批的 Telegram 用户 ID
    groups:                   # 群组配置
      "-1001234567890":
        enabled: true
```

### 访问策略

| 策略 | 行为 |
|------|------|
| `open` | 任何人都可以使用 |
| `pairing` | 新用户获得配对码，管理员通过 CLI 审批 |
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

openclaude pairing list            列出待审批的配对请求
openclaude pairing approve <code>  审批配对码

openclaude allow list [渠道]        列出白名单用户
openclaude allow add <渠道> <ID>    添加用户到白名单
openclaude allow remove <渠道> <ID> 从白名单移除用户

openclaude agent show              查看当前 SOUL.md
openclaude agent edit              用 $EDITOR 编辑 SOUL.md
openclaude agent reset             删除 SOUL.md（重置人格）
openclaude agent path              输出 SOUL.md 文件路径
```

## Telegram 命令

| 命令 | 说明 |
|------|------|
| `/new` | 开启新会话 |
| `/sessions` | 列出所有会话（带内联按钮选择器） |
| `/btw <问题>` | 旁路提问，不打断当前会话 |
| `/model [名称]` | 查看或切换模型（如 `opus`、`sonnet`） |
| `/effort [级别]` | 查看或设置思考力度 |
| `/stop` | 打断 Claude 当前的回复 |
| `/cost` | 查看当前会话费用 |
| `/context` | 查看上下文窗口使用情况 |
| `/settings` | 查看当前会话设置 |
| `/help` | 显示帮助 |

在群聊中，Bot 在被 **@提及** 或**被回复**时响应。

### `/btw` — 旁路提问

`/btw` 会 fork 当前 Claude 会话，并行回答一个快速问题，不会打断主对话。适合在 Claude 处理长任务时顺便问点别的。

```
/btw 法国的首都是哪里？
```

## 群聊支持

在群聊中，OpenClaude 会将近期消息历史（含发言人姓名和时间戳）注入 Claude 的上下文，让 Claude 知道谁说了什么。本地 HTTP 端点的聊天历史 API 也可供 Claude 进行更深层的查询。

## SOUL.md — Bot 人格定制

通过创建 `SOUL.md` 文件定制 Bot 的人格：

```bash
openclaude agent edit
```

也可以让 Claude 自己改——告诉 Bot "以后用海盗风格说话"，它会自动更新 SOUL.md。

修改在下一个 `/new` 会话生效。

## 架构

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Telegram   │────→│  OpenClaude GW   │────→│  Claude Code    │
│   (grammY)   │←────│                  │←────│  CLI 进程        │
└──────────────┘     │  - 会话管理       │     │  (子进程)        │
                     │  - 进程池         │     │  - 工具调用      │
                     │  - 访问控制       │     │  - 文件 I/O     │
                     │  - 进度显示       │     │  - Bash 执行    │
                     │  - HTTP API      │     │  - 网络搜索      │
                     └──────────────────┘     └─────────────────┘
```

**数据目录**（`~/.openclaude/`）：

```
~/.openclaude/
├── config.yaml              # 配置文件
├── logs/gateway.log         # 守护进程日志
├── sessions/                # 每个对话的会话状态
├── credentials/             # 白名单、配对数据
├── workspace/{botId}/       # 每个会话的工作目录
│   └── {chatId}_{sessionId}/
└── agents/{botId}/          # 每个 Bot 的人格文件
    └── SOUL.md
```

## 社区

本项目在 [LINUX DO](https://linux.do/) 社区分享。

## 许可证

MIT
