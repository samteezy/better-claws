// ── Text utilities ───────────────────────────────────────────────────────────

/** Maximum inbound message length in characters. */
export const MAX_MESSAGE_LENGTH = 32_768;

/** Truncate a string to `max` characters. */
export function truncateMessage(text: string, max: number = MAX_MESSAGE_LENGTH): string {
  return text.length > max ? text.slice(0, max) : text;
}
