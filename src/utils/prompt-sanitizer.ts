import { BetterClawsError } from "../types.js";

export class SanitizerError extends BetterClawsError {
  constructor(message: string, code: string) {
    super(message, "sanitizer", code);
    this.name = "SanitizerError";
  }
}

const DEFAULT_MAX_LENGTH = 2000;

/**
 * Patterns that indicate prompt-injection attempts when they appear at
 * the start of a line (case-insensitive).
 */
const INJECTION_LINE_PATTERNS: readonly RegExp[] = [
  /^system\s*:/i,
  /^<\|system\|>/i,
  /^\[INST\]/i,
  /^<<SYS>>/i,
  /^###\s*System/i,
  /^You are now\b/i,
  /^New instructions\s*:/i,
  /^Forget everything\b/i,
];

/**
 * Substrings that indicate injection attempts regardless of position
 * (case-insensitive).
 */
const INJECTION_SUBSTRING_PATTERNS: readonly RegExp[] = [
  /ignore (?:all )?(?:previous|prior|above) instructions/i,
  /disregard (?:all )?(?:previous|prior|above)/i,
];

/**
 * Sanitize memory content before injecting it into an LLM prompt.
 *
 * - Truncates to `maxLength` characters.
 * - Prefixes lines that match known prompt-injection patterns with
 *   `[SANITIZED]` so the content is neutered but preserved for debugging.
 *
 * Raw storage is NOT modified — sanitization happens at prompt-assembly
 * time so the original data remains available.
 */
export function sanitizeMemoryContent(
  content: string,
  maxLength: number = DEFAULT_MAX_LENGTH,
): string {
  let text = content;

  // Truncate
  if (text.length > maxLength) {
    text = text.slice(0, maxLength) + "... [truncated]";
  }

  // Sanitize line-by-line
  const lines = text.split("\n");
  const sanitized = lines.map((line) => {
    for (const pattern of INJECTION_LINE_PATTERNS) {
      if (pattern.test(line)) {
        return `[SANITIZED] ${line}`;
      }
    }
    for (const pattern of INJECTION_SUBSTRING_PATTERNS) {
      if (pattern.test(line)) {
        return `[SANITIZED] ${line}`;
      }
    }
    return line;
  });

  return sanitized.join("\n");
}

/**
 * Wrap sanitized content in clearly-delimited boundaries so the LLM can
 * distinguish recalled data from system instructions.
 */
export function wrapMemoryBlock(label: string, content: string): string {
  return `<<<RECALLED_DATA:${label}>>>\n${content}\n<<<END_RECALLED_DATA>>>`;
}
