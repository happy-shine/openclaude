# PR Title
feat: Telegram Supergroup Topic 会话隔离支持

# PR Body

## 概述

为 OpenClaude 添加 Telegram Supergroup Topic 会话隔离功能。每个 Topic 现在都像独立的聊天一样运行，拥有自己的会话列表、工作空间和消息历史。

## 动机

在 Telegram Supergroup 中，Topics 功能允许用户将讨论组织成不同的主题。然而，之前的 OpenClaude 实现将整个 Supergroup 视为单一聊天，导致：

- 所有 Topic 共享相同的会话列表
- `/sessions` 命令显示所有 Topic 的会话，造成混淆
- Bot 回复可能出现在错误的 Topic 中
- 无法在不同 Topic 中进行独立的对话

## 解决方案

采用**复合键策略**实现完全隔离：

| 上下文 | 格式 | 示例 |
|--------|------|------|
| SessionManager Map | `chatId:threadId` | `-100123:456` |
| 文件存储路径 | `chatId_threadId` | `-100123_456` |
| Telegram API | 分离参数 | `chat_id` + `message_thread_id` |

## 主要变更

### 新增文件
- `src/utils/keys.ts` - 复合键生成工具函数
- `src/utils/__tests__/keys.test.ts` - 键工具单元测试
- `src/__tests__/topic-isolation.test.ts` - 集成测试

### 类型变更
- `Session` 接口添加 `threadId?: string`
- `ChatSessionState` 接口添加 `threadId?: string`
- `OutboundMessage` 接口添加 `threadId?: string`

### 核心模块更新

| 模块 | 变更说明 |
|------|----------|
| `SessionManager` | 所有方法支持可选 `threadId` 参数 |
| `SessionStore` | 使用复合键生成文件路径 |
| `MessageStore` | 按 Topic 隔离消息历史 |
| `TelegramAdapter` | `send()`, `sendTyping()`, `sendPhoto()`, `sendDocument()`, `sendWithKeyboard()` 传递 `message_thread_id` |
| `ProcessManager` | 按 Topic 隔离工作空间目录 |
| `BotInstance` | 所有处理器（包括回调处理器）传递 `threadId` |
| `Gateway` | Bot 中继保持 Topic 上下文 |
| `API Server` | `/api/chat-history` 和 `/api/send-file` 支持 `thread_id` 参数 |

## 向后兼容性

- **私聊**: 无 `threadId`，行为与之前完全相同
- **普通群组**: 无 `threadId`，行为与之前完全相同
- **无 Topics 的 Supergroup**: 无 `threadId`，行为与之前完全相同
- **现有数据**: 不迁移，新的 Topic 会话会创建新文件

## 文件存储结构

```
~/.openclaude/
├── sessions/{botId}/
│   ├── 123456.json              # 私聊
│   ├── -100789.json             # 普通群组
│   ├── -100456_1.json           # Supergroup General topic
│   └── -100456_789.json         # Supergroup topic #789
├── messages/
│   ├── 123456.jsonl             # 私聊消息
│   ├── -100456_1.jsonl          # Topic 1 消息
│   └── -100456_789.jsonl        # Topic 789 消息
└── workspace/{botId}/
    ├── 123456/                  # 私聊工作空间
    ├── -100456_1/               # Topic 1 工作空间（所有会话共享）
    └── -100456_789/             # Topic 789 工作空间
```

## 测试

### 自动化测试
- [x] 57/57 单元测试通过
- [x] 包含 3 个新的集成测试
- [x] TypeScript 构建成功

### 手动测试
- [x] 在不同 Topic 创建会话，验证隔离
- [x] `/sessions` 只显示当前 Topic 的会话
- [x] Bot 回复出现在正确的 Topic
- [ ] Bot-to-bot 中继保持在同一 Topic（待测试）

## 相关提交

```
fe8ba3d feat(topic-isolation): add composite key utilities
503c79d feat(topic-isolation): add threadId to Session and OutboundMessage types
02c5340 feat(topic-isolation): update SessionStore to use composite key
77b2513 feat(topic-isolation): update SessionManager with threadId support
76906ba feat(topic-isolation): update MessageStore with threadId support
5682e16 feat(topic-isolation): update TelegramAdapter and handlers with threadId support
57e6bb9 feat(topic-isolation): update skills to include thread_id parameter
54b15ca feat(topic-isolation): use composite key for workspace path
45b16d3 feat(topic-isolation): pass threadId through BotInstance handlers
c1d55c5 feat(topic-isolation): include threadId in bot relay
fd82d28 feat(topic-isolation): add thread_id parameter to API endpoints
3fd36bd test(topic-isolation): add integration tests
2a593e5 fix(topic-isolation): pass threadId to sendWithKeyboard for /sessions command
```

## 设计文档

详细设计规格请参阅：`docs/superpowers/specs/2026-04-15-topic-isolation-design.md`

---

🤖 Generated with [Claude Code](https://claude.com/claude-code)
