import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCron,
  cronMatches,
  nextMatch,
  CronParseError,
} from "../../src/scheduler/cron-parser.js";

describe("parseCron()", () => {
  it("parses wildcard expression", () => {
    const cron = parseCron("* * * * *");
    assert.equal(cron.minute.size, 60);
    assert.equal(cron.hour.size, 24);
    assert.equal(cron.dayOfMonth.size, 31);
    assert.equal(cron.month.size, 12);
    assert.equal(cron.dayOfWeek.size, 7);
  });

  it("parses exact values", () => {
    const cron = parseCron("30 14 1 6 3");
    assert.deepEqual([...cron.minute], [30]);
    assert.deepEqual([...cron.hour], [14]);
    assert.deepEqual([...cron.dayOfMonth], [1]);
    assert.deepEqual([...cron.month], [6]);
    assert.deepEqual([...cron.dayOfWeek], [3]);
  });

  it("parses step expressions (*/N)", () => {
    const cron = parseCron("*/15 */6 * * *");
    assert.deepEqual([...cron.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
    assert.deepEqual([...cron.hour].sort((a, b) => a - b), [0, 6, 12, 18]);
  });

  it("parses range expressions (N-M)", () => {
    const cron = parseCron("0-5 9-17 * * *");
    assert.deepEqual([...cron.minute].sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
    assert.equal(cron.hour.size, 9); // 9 through 17
    assert.ok(cron.hour.has(9));
    assert.ok(cron.hour.has(17));
  });

  it("parses range with step (N-M/S)", () => {
    const cron = parseCron("0-30/10 * * * *");
    assert.deepEqual([...cron.minute].sort((a, b) => a - b), [0, 10, 20, 30]);
  });

  it("parses comma-separated lists", () => {
    const cron = parseCron("0,15,30,45 * * * *");
    assert.deepEqual([...cron.minute].sort((a, b) => a - b), [0, 15, 30, 45]);
  });

  it("parses weekday range (1-5 = Mon-Fri)", () => {
    const cron = parseCron("0 9 * * 1-5");
    assert.deepEqual([...cron.dayOfWeek].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  });

  it("preserves raw expression", () => {
    const cron = parseCron("  */5  *  *  *  *  ");
    assert.equal(cron.raw, "*/5  *  *  *  *");
  });

  it("throws on too few fields", () => {
    assert.throws(
      () => parseCron("* * *"),
      (err: unknown) => err instanceof CronParseError,
    );
  });

  it("throws on too many fields", () => {
    assert.throws(
      () => parseCron("* * * * * *"),
      (err: unknown) => err instanceof CronParseError,
    );
  });

  it("throws on out-of-range values", () => {
    assert.throws(
      () => parseCron("60 * * * *"), // minute max is 59
      (err: unknown) => err instanceof CronParseError,
    );
  });

  it("throws on invalid range (start > end)", () => {
    assert.throws(
      () => parseCron("30-10 * * * *"),
      (err: unknown) => err instanceof CronParseError,
    );
  });

  it("throws on invalid syntax", () => {
    assert.throws(
      () => parseCron("abc * * * *"),
      (err: unknown) => err instanceof CronParseError,
    );
  });

  it("throws on zero step", () => {
    assert.throws(
      () => parseCron("*/0 * * * *"),
      (err: unknown) => err instanceof CronParseError,
    );
  });
});

describe("cronMatches()", () => {
  it("matches every-minute wildcard", () => {
    const cron = parseCron("* * * * *");
    assert.ok(cronMatches(cron, new Date(2024, 0, 1, 12, 30)));
    assert.ok(cronMatches(cron, new Date(2024, 5, 15, 0, 0)));
  });

  it("matches specific minute and hour", () => {
    const cron = parseCron("30 14 * * *");
    assert.ok(cronMatches(cron, new Date(2024, 0, 1, 14, 30)));
    assert.ok(!cronMatches(cron, new Date(2024, 0, 1, 14, 31)));
    assert.ok(!cronMatches(cron, new Date(2024, 0, 1, 15, 30)));
  });

  it("matches step pattern", () => {
    const cron = parseCron("*/10 * * * *");
    assert.ok(cronMatches(cron, new Date(2024, 0, 1, 0, 0)));
    assert.ok(cronMatches(cron, new Date(2024, 0, 1, 0, 10)));
    assert.ok(cronMatches(cron, new Date(2024, 0, 1, 0, 20)));
    assert.ok(!cronMatches(cron, new Date(2024, 0, 1, 0, 5)));
  });

  it("matches day of week", () => {
    // 2024-01-01 is a Monday (day 1)
    const cron = parseCron("0 9 * * 1");
    assert.ok(cronMatches(cron, new Date(2024, 0, 1, 9, 0)));
    // 2024-01-02 is Tuesday (day 2)
    assert.ok(!cronMatches(cron, new Date(2024, 0, 2, 9, 0)));
  });

  it("matches specific month and day", () => {
    const cron = parseCron("0 0 25 12 *");
    assert.ok(cronMatches(cron, new Date(2024, 11, 25, 0, 0))); // Dec 25
    assert.ok(!cronMatches(cron, new Date(2024, 11, 24, 0, 0)));
  });
});

describe("nextMatch()", () => {
  it("finds the next matching minute", () => {
    const cron = parseCron("*/5 * * * *");
    const after = new Date(2024, 0, 1, 12, 2, 0);
    const next = nextMatch(cron, after);

    assert.ok(next);
    assert.equal(next.getMinutes(), 5);
    assert.equal(next.getHours(), 12);
  });

  it("finds the next hour boundary", () => {
    const cron = parseCron("0 * * * *");
    const after = new Date(2024, 0, 1, 12, 30, 0);
    const next = nextMatch(cron, after);

    assert.ok(next);
    assert.equal(next.getMinutes(), 0);
    assert.equal(next.getHours(), 13);
  });

  it("skips ahead to matching day of week", () => {
    // Next Monday from a Tuesday
    const cron = parseCron("0 9 * * 1");
    const tuesday = new Date(2024, 0, 2, 10, 0, 0); // Jan 2, 2024 = Tuesday
    const next = nextMatch(cron, tuesday);

    assert.ok(next);
    assert.equal(next.getDay(), 1); // Monday
    assert.equal(next.getHours(), 9);
    assert.equal(next.getMinutes(), 0);
  });

  it("returns null when no match within scan window", () => {
    // Feb 30 never exists
    const cron = parseCron("0 0 30 2 *");
    const result = nextMatch(cron, new Date(2024, 0, 1), 366);
    assert.equal(result, null);
  });

  it("seconds are zeroed out", () => {
    const cron = parseCron("* * * * *");
    const after = new Date(2024, 0, 1, 12, 30, 45);
    const next = nextMatch(cron, after);

    assert.ok(next);
    assert.equal(next.getSeconds(), 0);
    assert.equal(next.getMilliseconds(), 0);
  });
});
