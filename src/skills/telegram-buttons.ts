/** Skill: teach Claude to present interactive buttons via <<option>> syntax */
export function getButtonSkill(): string {
  return `## Interactive Buttons

When presenting the user with a choice between 2–5 discrete options, wrap each option in double angle brackets on the last line(s) of your response:

<<Option A>> <<Option B>> <<Option C>>

These will be rendered as tappable inline buttons in Telegram. The user's tap will be sent back as their next message.

Rules:
- Only use for clear, finite choices (2–5 options)
- Keep labels short (under 20 characters)
- Place buttons on the last lines only — never mid-paragraph
- Never use inside code blocks
- Do not use for open-ended questions`;
}
