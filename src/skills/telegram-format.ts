/**
 * Skill: teach Claude to format final replies as Telegram-flavored HTML
 * so the gateway can send them with parse_mode=HTML and render properly.
 */
export function getTelegramFormatSkill(): string {
  return `## Output Formatting (Telegram HTML)

Your final reply to the user is sent through Telegram with \`parse_mode=HTML\`. Output HTML directly — do NOT use Markdown syntax (no \`**bold**\`, \`#headings\`, \`- lists\`, triple-backtick fences, or tables). The gateway passes your text through verbatim.

### Supported tags (only these — anything else will fail to parse)

| Tag | Use for |
|-----|---------|
| \`<b>text</b>\` | bold |
| \`<i>text</i>\` | italic |
| \`<u>text</u>\` | underline |
| \`<s>text</s>\` | strikethrough |
| \`<code>text</code>\` | inline code (monospace, tap-to-copy) |
| \`<pre>text</pre>\` | code block |
| \`<pre><code class="language-python">text</code></pre>\` | code block with syntax hint |
| \`<a href="URL">text</a>\` | link |
| \`<tg-spoiler>text</tg-spoiler>\` | spoiler (hidden until tapped) |
| \`<blockquote>text</blockquote>\` | quote block |

### Escaping rules

Inside text content (between tags), escape these three characters:
- \`<\` → \`&lt;\`
- \`>\` → \`&gt;\`
- \`&\` → \`&amp;\`

Inside \`<code>\` and \`<pre>\`, escape the same three. Everything else (including \`.\`, \`!\`, \`(\`, \`_\`, etc.) is literal — no escaping needed.

### Layout conventions (no native support → use these)

- **Headings**: wrap in \`<b>\` and put on its own line (Telegram has no \`<h1>\`).
- **Lists**: plain text with \`•\` or \`-\` + space at line start. Nested lists: indent with spaces.
- **Tables**: put the whole table inside a single \`<pre>\` block with spaces for column alignment (monospace font will keep columns aligned).
- **Horizontal rule**: a line of em-dashes like \`———————\` (no native \`<hr>\`).
- **Paragraph spacing**: use blank lines.

### Example of a well-formed reply

\`\`\`
<b>Analysis complete</b>

Found 3 issues in the authentication flow:

• <b>Token expiry</b>: refresh is not triggered on 401
• <b>CSRF check</b>: missing on the <code>/logout</code> endpoint
• <b>Rate limit</b>: login accepts unbounded attempts

Example fix for the token refresh:

<pre><code class="language-typescript">if (response.status === 401) {
  await refreshToken();
  return retry(request);
}</code></pre>

See the <a href="https://example.com/docs">auth docs</a> for context.
\`\`\`

### Rules

- Do NOT wrap your entire reply in \`<pre>\` unless it genuinely is one code block.
- Do NOT use tags not in the table above (\`<h1>\`, \`<div>\`, \`<table>\`, \`<ul>\`, \`<li>\`, \`<br>\`, etc. will break rendering).
- Do NOT mix Markdown and HTML — if you output \`**bold**\` it will show literally as asterisks.
- Nesting is allowed (e.g. \`<b><i>bold italic</i></b>\`) but keep it shallow.
- If unsure whether content needs a tag, leave it plain — plain text always renders.`;
}
