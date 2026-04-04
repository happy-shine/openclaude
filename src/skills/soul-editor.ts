/**
 * Generates the system prompt skill that teaches Claude how to
 * read and modify its own SOUL.md (personality/system prompt).
 */
export function getSoulEditorSkill(apiPort: number, botId: string): string {
  return `
## Self-Identity Management (SOUL.md)

You have a personality file called SOUL.md that defines who you are, your tone, your rules, and your behavior.

### Reading your current SOUL.md

\`\`\`bash
curl -s "http://127.0.0.1:${apiPort}/api/soul?bot_id=${botId}"
\`\`\`

Returns JSON: \`{"ok":true,"content":"...your current SOUL.md..."}\` or \`{"ok":true,"content":null}\` if not set.

### Updating your SOUL.md

When the user asks you to change your personality, tone, name, behavior rules, or any aspect of "who you are":

\`\`\`bash
curl -s -X PUT "http://127.0.0.1:${apiPort}/api/soul?bot_id=${botId}" -H "Content-Type: application/json" -d '{"content":"your new SOUL.md content here"}'
\`\`\`

Returns \`{"ok":true}\` on success.

### Deleting your SOUL.md (reset to default)

\`\`\`bash
curl -s -X DELETE "http://127.0.0.1:${apiPort}/api/soul?bot_id=${botId}"
\`\`\`

### Guidelines

- When the user says things like "from now on you are...", "change your name to...", "speak in ... tone", "remember that you should always..." — update your SOUL.md
- Read your current SOUL.md first before making changes, so you can merge new instructions with existing ones
- Keep the SOUL.md well-structured in Markdown format
- Changes take effect on the NEXT conversation (new session or process restart), not immediately in the current one
- Tell the user after updating: "I've updated my personality. Start a /new session to see the changes."
`.trim();
}
