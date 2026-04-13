import { createErrorClass } from "../types.js";

export const RedactError = createErrorClass("RedactError", "redact", "REDACT_ERROR");

const REDACTION_PLACEHOLDER = "[REDACTED]";

/**
 * Patterns that match common secret formats.
 * Each entry: [pattern, replacer].  When `replacer` is a string the whole
 * match is swapped; when it is a function the function receives the match
 * and returns the replacement (useful for keeping surrounding context like
 * URL schemes).
 */
const SECRET_PATTERNS: readonly [RegExp, string | ((...args: string[]) => string)][] = [
  // AWS access key IDs
  [/AKIA[0-9A-Z]{16}/g, REDACTION_PLACEHOLDER],

  // GitHub tokens (classic & fine-grained)
  [/gh[pos]_[A-Za-z0-9_]{36,}/g, REDACTION_PLACEHOLDER],

  // Slack tokens
  [/xox[bpras]-[A-Za-z0-9-]+/g, REDACTION_PLACEHOLDER],

  // Bearer tokens in headers
  [/(Bearer\s+)[A-Za-z0-9\-._~+/]+=*/g, `$1${REDACTION_PLACEHOLDER}`],

  // Credentials in URLs  scheme://user:password@host
  [/(\/\/[^:/?#]+:)[^@]+(@)/g, `$1${REDACTION_PLACEHOLDER}$2`],

  // Generic key=value patterns (api_key, apiKey, api-key, secret, password, token)
  [
    /((?:api[_-]?key|apikey|secret|password|passwd|token|authorization)\s*[:=]\s*)(["']?)(\S+)\2/gi,
    (_match: string, prefix: string, quote: string, _value: string) =>
      `${prefix}${quote}${REDACTION_PLACEHOLDER}${quote}`,
  ],

  // Long hex strings (64+ chars) that look like secrets
  [/(?<=[=:\s"'])[0-9a-f]{64,}(?=["\s,}\]\n]|$)/gi, REDACTION_PLACEHOLDER],
];

/**
 * Scan `input` for common secret patterns and replace them with
 * `[REDACTED]`.  The function is pure and stateless.
 */
export function redactSecrets(input: string): string {
  let result = input;
  for (const [pattern, replacer] of SECRET_PATTERNS) {
    result =
      typeof replacer === "string"
        ? result.replace(pattern, replacer)
        : result.replace(pattern, replacer);
  }
  return result;
}

/**
 * Recursively redact keys in an object/array tree.
 * Caller supplies the key-matching predicate and optional placeholder string.
 */
export function redactObject(
  value: unknown,
  isSecret: (key: string) => boolean,
  placeholder: string = "[REDACTED]",
): unknown {
  if (Array.isArray(value)) {
    return value.map((v) => redactObject(v, isSecret, placeholder));
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (isSecret(key)) {
        result[key] = placeholder;
      } else {
        result[key] = redactObject(val, isSecret, placeholder);
      }
    }
    return result;
  }
  return value;
}
