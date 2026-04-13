import { createErrorClass } from "../types.js";

export const CronParseError = createErrorClass("CronParseError", "cron-parser", "PARSE_ERROR");

/**
 * Minimal 5-field cron expression parser.
 * Fields: minute hour day-of-month month day-of-week
 *
 * Supported syntax per field:
 *   *        — any value
 *   N        — exact value
 *   N-M      — range (inclusive)
 *   * /N      — step (every N, written without space)
 *   N-M/S    — range with step
 *   N,M,O    — list
 *
 * No named months/days. No special characters (@yearly, etc.).
 */
export interface CronExpression {
  readonly minute: ReadonlySet<number>;
  readonly hour: ReadonlySet<number>;
  readonly dayOfMonth: ReadonlySet<number>;
  readonly month: ReadonlySet<number>;
  readonly dayOfWeek: ReadonlySet<number>;
  readonly raw: string;
}

interface FieldBounds {
  readonly min: number;
  readonly max: number;
}

const FIELD_BOUNDS: readonly FieldBounds[] = [
  { min: 0, max: 59 },  // minute
  { min: 0, max: 23 },  // hour
  { min: 1, max: 31 },  // day of month
  { min: 1, max: 12 },  // month
  { min: 0, max: 6 },   // day of week (0 = Sunday)
];

function parseField(field: string, bounds: FieldBounds): ReadonlySet<number> {
  const values = new Set<number>();

  for (const part of field.split(",")) {
    const trimmed = part.trim();

    // Step: */N or N-M/S
    const stepMatch = trimmed.match(/^(\*|(\d+)-(\d+))\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[4]!, 10);
      if (step <= 0) throw new CronParseError(`Invalid step value: ${step}`);

      let start: number;
      let end: number;

      if (stepMatch[1] === "*") {
        start = bounds.min;
        end = bounds.max;
      } else {
        start = parseInt(stepMatch[2]!, 10);
        end = parseInt(stepMatch[3]!, 10);
      }

      validateRange(start, end, bounds);
      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
      continue;
    }

    // Wildcard
    if (trimmed === "*") {
      for (let i = bounds.min; i <= bounds.max; i++) {
        values.add(i);
      }
      continue;
    }

    // Range: N-M
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1]!, 10);
      const end = parseInt(rangeMatch[2]!, 10);
      validateRange(start, end, bounds);
      for (let i = start; i <= end; i++) {
        values.add(i);
      }
      continue;
    }

    // Exact value
    const exactMatch = trimmed.match(/^\d+$/);
    if (exactMatch) {
      const val = parseInt(trimmed, 10);
      if (val < bounds.min || val > bounds.max) {
        throw new CronParseError(
          `Value ${val} out of range [${bounds.min}-${bounds.max}]`,
        );
      }
      values.add(val);
      continue;
    }

    throw new CronParseError(`Invalid cron field: "${trimmed}"`);
  }

  return values;
}

function validateRange(start: number, end: number, bounds: FieldBounds): void {
  if (start < bounds.min || start > bounds.max) {
    throw new CronParseError(`Range start ${start} out of bounds [${bounds.min}-${bounds.max}]`);
  }
  if (end < bounds.min || end > bounds.max) {
    throw new CronParseError(`Range end ${end} out of bounds [${bounds.min}-${bounds.max}]`);
  }
  if (start > end) {
    throw new CronParseError(`Invalid range: ${start}-${end}`);
  }
}

/** Parse a 5-field cron expression string. */
export function parseCron(expression: string): CronExpression {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new CronParseError(
      `Expected 5 fields (minute hour dom month dow), got ${fields.length}: "${expression}"`,
    );
  }

  return {
    minute: parseField(fields[0]!, FIELD_BOUNDS[0]!),
    hour: parseField(fields[1]!, FIELD_BOUNDS[1]!),
    dayOfMonth: parseField(fields[2]!, FIELD_BOUNDS[2]!),
    month: parseField(fields[3]!, FIELD_BOUNDS[3]!),
    dayOfWeek: parseField(fields[4]!, FIELD_BOUNDS[4]!),
    raw: expression.trim(),
  };
}

/** Check whether a Date matches a parsed cron expression. */
export function cronMatches(cron: CronExpression, date: Date): boolean {
  return (
    cron.minute.has(date.getMinutes()) &&
    cron.hour.has(date.getHours()) &&
    cron.dayOfMonth.has(date.getDate()) &&
    cron.month.has(date.getMonth() + 1) &&
    cron.dayOfWeek.has(date.getDay())
  );
}

/**
 * Compute the next Date (after `after`) that matches the cron expression.
 * Scans minute-by-minute up to a configurable limit (default: 366 days).
 */
export function nextMatch(
  cron: CronExpression,
  after: Date = new Date(),
  maxScanDays: number = 366,
): Date | null {
  // Start from the next minute boundary
  const candidate = new Date(after.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = after.getTime() + maxScanDays * 86_400_000;

  while (candidate.getTime() <= limit) {
    if (cronMatches(cron, candidate)) {
      return candidate;
    }

    // Skip ahead efficiently
    if (!cron.month.has(candidate.getMonth() + 1)) {
      // Skip to next month
      candidate.setMonth(candidate.getMonth() + 1, 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    if (!cron.dayOfMonth.has(candidate.getDate()) || !cron.dayOfWeek.has(candidate.getDay())) {
      // Skip to next day
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(0, 0, 0, 0);
      continue;
    }

    if (!cron.hour.has(candidate.getHours())) {
      // Skip to next hour
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
      continue;
    }

    // Just advance one minute
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  return null;
}
