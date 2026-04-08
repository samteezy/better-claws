import { redactSecrets } from "./redact.js";

const DEFAULT_MAX_BYTES = 10_240; // 10 KB

/** Keys whose values should be redacted in JSON objects, matched case-insensitively. */
const SENSITIVE_KEYS = new Set([
  "password",
  "passwd",
  "token",
  "secret",
  "api_key",
  "apikey",
  "authorization",
  "access_token",
  "refresh_token",
]);

const REDACTED = "[REDACTED]";

export interface SanitizeOptions {
  /** Maximum byte length of the output. Defaults to 10 KB. */
  readonly maxBytes?: number;
}

/**
 * Sanitize tool output before it enters LLM context or logs.
 *
 * Pipeline:
 * 1. Strip sensitive JSON keys from structured output (while JSON is still valid)
 * 2. Redact known secret patterns (regex-based)
 * 3. Truncate to `maxBytes`
 */
export function sanitizeOutput(
  raw: string,
  options?: SanitizeOptions,
): string {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_BYTES;

  // Step 1: strip sensitive keys from JSON (while structure is intact)
  let result = stripSensitiveKeys(raw);

  // Step 2: regex-based secret redaction
  result = redactSecrets(result);

  // Step 3: truncate
  if (Buffer.byteLength(result, "utf-8") > maxBytes) {
    result = truncateToBytes(result, maxBytes);
  }

  return result;
}

/**
 * Attempt to parse as JSON, redact sensitive keys, and re-serialize.
 * If parsing fails (not JSON), return the input unchanged.
 */
function stripSensitiveKeys(input: string): string {
  try {
    const parsed: unknown = JSON.parse(input);
    if (typeof parsed === "object" && parsed !== null) {
      return JSON.stringify(redactObject(parsed));
    }
  } catch {
    // Not JSON — return as-is
  }
  return input;
}

function redactObject(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactObject);
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = REDACTED;
      } else {
        result[key] = redactObject(val);
      }
    }
    return result;
  }
  return value;
}

function truncateToBytes(input: string, maxBytes: number): string {
  const buf = Buffer.from(input, "utf-8");
  if (buf.length <= maxBytes) return input;
  // Slice to maxBytes, then decode back (may clip a multi-byte char)
  const sliced = buf.subarray(0, maxBytes).toString("utf-8");
  return sliced + "\n…[truncated]";
}
