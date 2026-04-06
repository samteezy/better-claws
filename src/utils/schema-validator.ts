import type { JsonSchema } from "../types.js";
import { BetterClawsError } from "../types.js";

export class SchemaValidationError extends BetterClawsError {
  readonly errors: readonly string[];
  constructor(message: string, errors: readonly string[]) {
    super(message, "schema-validator", "VALIDATION_FAILED");
    this.name = "SchemaValidationError";
    this.errors = errors;
  }
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
}

/**
 * Validate `value` against a minimal JSON Schema (`type`, `properties`,
 * `required`, `items`, `enum`).  Returns a result with all collected
 * errors keyed by JSON-path.
 */
export function validateSchema(
  value: unknown,
  schema: JsonSchema,
): ValidationResult {
  const errors: string[] = [];
  validate(value, schema, "", errors);
  return { valid: errors.length === 0, errors };
}

// ── Internal recursive validator ──────────────────────────────────────────────

function validate(
  value: unknown,
  schema: JsonSchema,
  path: string,
  errors: string[],
): void {
  const loc = path || "root";

  // enum check (independent of type)
  if (schema.enum !== undefined) {
    const matched = schema.enum.some(
      (e) => JSON.stringify(e) === JSON.stringify(value),
    );
    if (!matched) {
      errors.push(`${loc}: value must be one of [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}]`);
    }
  }

  if (schema.type === undefined) {
    // No type constraint — nothing more to check beyond enum.
    return;
  }

  // type check
  if (!matchesType(value, schema.type)) {
    errors.push(`${loc}: expected ${schema.type}, got ${describeValue(value)}`);
    return; // no point inspecting children if type is wrong
  }

  // object-specific checks
  if (schema.type === "object" && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    // required
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          errors.push(`${path ? `${path}.` : ""}${key}: required property missing`);
        }
      }
    }

    // properties
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in obj) {
          validate(obj[key], propSchema, path ? `${path}.${key}` : key, errors);
        }
      }
    }
  }

  // array-specific checks
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validate(value[i], schema.items, `${path}[${i}]`, errors);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    default:
      return true; // unknown type — permissive
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
