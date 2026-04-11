/**
 * Generates the system prompt skill that teaches Claude how to send files
 * back to the Telegram user, and how to retrieve previously shared files.
 */
export function getTelegramFileSkill(apiPort: number, chatId: string, botId: string, isGroup: boolean): string {
  const parts: string[] = [];

  parts.push(`
## Sending Files to User (Telegram Gateway)

You are running inside a Telegram Gateway. The user is chatting with you via Telegram.

When the user asks you to create a file and send it to them, or when you produce any file output (code files, images, documents, etc.):

1. Write the file to the current working directory (or any absolute path)
2. Send it to the user by running this curl command:

\`\`\`bash
curl -s -X POST "http://127.0.0.1:${apiPort}/api/send-file?chat_id=${chatId}&file_path=$(pwd)/FILENAME"
\`\`\`

Replace FILENAME with the actual file name. You MUST use the absolute path.

Examples:
- To send a Python file you just wrote:
  \`curl -s -X POST "http://127.0.0.1:${apiPort}/api/send-file?chat_id=${chatId}&file_path=$(pwd)/quicksort.py"\`
- To send an image:
  \`curl -s -X POST "http://127.0.0.1:${apiPort}/api/send-file?chat_id=${chatId}&file_path=/absolute/path/to/image.png"\`

The API will return \`{"ok":true}\` on success.

IMPORTANT: Always use this method to send files. Do NOT try to use email, external services, or any other method.`);

  parts.push(`
## Retrieving Previously Shared Files

When a user references a file they sent earlier (e.g. "my file above", "that document", "the photo I sent"), and you don't already have the file in the current message attachments:

1. **Check current attachments first** — the file may already be downloaded in your workspace \`downloads/\` directory.

2. **If not found, query chat history** to find the file_id:

\`\`\`bash
curl -s "http://127.0.0.1:${apiPort}/api/chat-history?chat_id=${chatId}&since=1d&limit=50"
\`\`\`

Look for entries with a \`media\` field. Media entries use the format:
- \`photo:FILE_ID\`
- \`document:FILE_ID:FILENAME\`

3. **Download the file** using the file_id:

\`\`\`bash
curl -s -X POST "http://127.0.0.1:${apiPort}/api/download-file?bot_id=${botId}&file_id=FILE_ID&dest_dir=$(pwd)/downloads"
\`\`\`

Returns \`{"ok":true,"path":"/abs/path/to/downloaded/file"}\` on success. Then read the file at the returned path.

### Example workflow

User says: "What does that PDF I sent say?"

1. Check \`downloads/\` for existing files
2. If not found, query chat history: \`curl -s "http://127.0.0.1:${apiPort}/api/chat-history?chat_id=${chatId}&since=1d&search=PDF&limit=20"\`
3. Find the media entry: \`"media": ["document:BQACAgU....:report.pdf"]\`
4. Download: \`curl -s -X POST "http://127.0.0.1:${apiPort}/api/download-file?bot_id=${botId}&file_id=BQACAgU....&dest_dir=$(pwd)/downloads"\`
5. Read the downloaded file and answer the question`);

  return parts.join("\n\n---\n\n").trim();
}
