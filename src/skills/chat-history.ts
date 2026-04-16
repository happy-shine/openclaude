/**
 * Generates the system prompt skill that teaches Claude Code how to query
 * group chat history via the Gateway API.
 */
export function getChatHistorySkill(apiPort: number, chatId: string, threadId: string | undefined): string {
  const threadParam = threadId ? `&thread_id=${threadId}` : "";
  return `
## Reading Group Chat History

You can query the full group chat history to understand context, summarize discussions, or find specific messages.

### Query chat history

\`\`\`bash
curl -s "http://127.0.0.1:${apiPort}/api/chat-history?chat_id=${chatId}${threadParam}&since=2h&limit=100"
\`\`\`

### Parameters

| Parameter | Description | Examples |
|-----------|-------------|---------|
| \`chat_id\` | Chat ID (pre-filled) | \`${chatId}\` |
| \`thread_id\` | Topic/thread ID (optional) | If specified, limits query to this thread |
| \`since\` | Start time | \`30m\`, \`2h\`, \`1d\`, \`7d\`, \`2026-04-07\`, \`yesterday\` |
| \`until\` | End time | \`now\`, \`today\`, \`2026-04-08\` |
| \`limit\` | Max messages (default 100) | \`50\`, \`200\`, \`500\` |
| \`sender\` | Filter by sender name | \`Dr. Shine\`, \`á\` |
| \`search\` | Full-text search | \`量化\`, \`openclaude\` |

### Common use cases

- Summarize recent chat: \`?chat_id=${chatId}${threadParam}&since=2h\`
- What did someone say: \`?chat_id=${chatId}${threadParam}&since=1d&sender=á\`
- Find discussion about topic: \`?chat_id=${chatId}${threadParam}&since=7d&search=量化\`
- Yesterday's full chat: \`?chat_id=${chatId}${threadParam}&since=yesterday&until=today\`

### Response format

\`\`\`json
{
  "ok": true,
  "count": 42,
  "messages": [
    {"id": "123", "ts": 1712462400, "sender": "á", "senderId": "100", "text": "hello", "media": ["photo:AgXX..."]}
  ]
}
\`\`\`

The \`ts\` field is Unix timestamp in seconds. Media entries show type and Telegram file_id.

IMPORTANT: Use this API whenever the user asks about past group conversations, wants summaries, or references something said earlier. The recent context prepended to messages only covers the last few minutes — for anything older, use this API.
`.trim();
}
