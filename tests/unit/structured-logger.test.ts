import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { LogEntry } from "../../src/types.js";

function getTodayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

async function withTempLogger(
  opts: { redactSensitive: boolean },
  fn: (logger: StructuredLogger, dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "bc-logger-"));
  const logger = new StructuredLogger({ directory: dir, redactSensitive: opts.redactSensitive });
  try {
    await fn(logger, dir);
  } finally {
    await logger.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function readLogLines(dir: string): Promise<LogEntry[]> {
  const filePath = join(dir, `${getTodayDateString()}.jsonl`);
  const content = await readFile(filePath, "utf-8");
  return content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LogEntry);
}

describe("StructuredLogger", () => {
  describe("basic logging", () => {
    it("writes valid JSONL to date-named file", async () => {
      await withTempLogger({ redactSensitive: false }, async (logger, dir) => {
        logger.log({
          sessionId: "session-123",
          eventType: "message:inbound",
          component: "router",
          payload: { text: "hello" },
        });
        await logger.flush();

        const entries = await readLogLines(dir);
        assert.equal(entries.length, 1);
        assert.equal(entries[0]!.sessionId, "session-123");
        assert.equal(entries[0]!.eventType, "message:inbound");
        assert.equal(entries[0]!.component, "router");
        assert.deepEqual(entries[0]!.payload, { text: "hello" });
        assert.ok(entries[0]!.timestamp);
      });
    });

    it("appends multiple entries to the same file", async () => {
      await withTempLogger({ redactSensitive: false }, async (logger, dir) => {
        logger.log({
          sessionId: "session-1",
          eventType: "message:inbound",
          component: "router",
          payload: { msg: "first" },
        });
        logger.log({
          sessionId: "session-2",
          eventType: "message:outbound",
          component: "router",
          payload: { msg: "second" },
        });
        await logger.flush();

        const entries = await readLogLines(dir);
        assert.equal(entries.length, 2);
        assert.equal(entries[0]!.sessionId, "session-1");
        assert.equal(entries[1]!.sessionId, "session-2");
      });
    });

    it("includes timestamp in ISO format", async () => {
      await withTempLogger({ redactSensitive: false }, async (logger, dir) => {
        const before = new Date();
        logger.log({
          sessionId: "session-123",
          eventType: "message:inbound",
          component: "router",
          payload: {},
        });
        const after = new Date();
        await logger.flush();

        const entries = await readLogLines(dir);
        const ts = new Date(entries[0]!.timestamp);
        assert.ok(ts >= before);
        assert.ok(ts <= after);
        assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(entries[0]!.timestamp));
      });
    });

    it("handles null sessionId", async () => {
      await withTempLogger({ redactSensitive: false }, async (logger, dir) => {
        logger.log({
          sessionId: null,
          eventType: "config:change",
          component: "config",
          payload: { key: "value" },
        });
        await logger.flush();

        const entries = await readLogLines(dir);
        assert.equal(entries[0]!.sessionId, null);
      });
    });
  });

  describe("redaction", () => {
    it("redacts apiKey when redactSensitive is true", async () => {
      await withTempLogger({ redactSensitive: true }, async (logger, dir) => {
        logger.log({
          sessionId: "s",
          eventType: "llm:request",
          component: "llm",
          payload: { model: "gpt-4", apiKey: "sk-123", temperature: 0.7 },
        });
        await logger.flush();

        const entries = await readLogLines(dir);
        assert.equal(entries[0]!.payload["apiKey"], "[REDACTED]");
        assert.equal(entries[0]!.payload["model"], "gpt-4");
      });
    });

    it("redacts token, secret, password, authorization, credential", async () => {
      await withTempLogger({ redactSensitive: true }, async (logger, dir) => {
        logger.log({
          sessionId: "s",
          eventType: "message:inbound",
          component: "test",
          payload: {
            token: "t",
            secret: "s",
            password: "p",
            authorization: "a",
            credential: "c",
            safe: "ok",
          },
        });
        await logger.flush();

        const entries = await readLogLines(dir);
        const p = entries[0]!.payload;
        assert.equal(p["token"], "[REDACTED]");
        assert.equal(p["secret"], "[REDACTED]");
        assert.equal(p["password"], "[REDACTED]");
        assert.equal(p["authorization"], "[REDACTED]");
        assert.equal(p["credential"], "[REDACTED]");
        assert.equal(p["safe"], "ok");
      });
    });

    it("is case-insensitive for sensitive keys", async () => {
      await withTempLogger({ redactSensitive: true }, async (logger, dir) => {
        logger.log({
          sessionId: "s",
          eventType: "message:inbound",
          component: "test",
          payload: { APIKey: "x", Token: "x", PASSWORD: "x" },
        });
        await logger.flush();

        const entries = await readLogLines(dir);
        assert.equal(entries[0]!.payload["APIKey"], "[REDACTED]");
        assert.equal(entries[0]!.payload["Token"], "[REDACTED]");
        assert.equal(entries[0]!.payload["PASSWORD"], "[REDACTED]");
      });
    });

    it("recursively redacts nested objects", async () => {
      await withTempLogger({ redactSensitive: true }, async (logger, dir) => {
        logger.log({
          sessionId: "s",
          eventType: "message:inbound",
          component: "test",
          payload: {
            outer: "public",
            nested: { apiKey: "secret", deep: { password: "secret", user: "john" } },
          },
        });
        await logger.flush();

        const entries = await readLogLines(dir);
        const nested = entries[0]!.payload["nested"] as Record<string, unknown>;
        assert.equal(nested["apiKey"], "[REDACTED]");
        const deep = nested["deep"] as Record<string, unknown>;
        assert.equal(deep["password"], "[REDACTED]");
        assert.equal(deep["user"], "john");
      });
    });

    it("does not redact when redactSensitive is false", async () => {
      await withTempLogger({ redactSensitive: false }, async (logger, dir) => {
        logger.log({
          sessionId: "s",
          eventType: "message:inbound",
          component: "test",
          payload: { apiKey: "sk-123", token: "t123" },
        });
        await logger.flush();

        const entries = await readLogLines(dir);
        assert.equal(entries[0]!.payload["apiKey"], "sk-123");
        assert.equal(entries[0]!.payload["token"], "t123");
      });
    });
  });

  describe("directory auto-creation", () => {
    it("creates directory if it does not exist", async () => {
      const base = await mkdtemp(join(tmpdir(), "bc-logger-"));
      const nested = join(base, "nested", "log", "dir");
      const logger = new StructuredLogger({ directory: nested, redactSensitive: false });
      try {
        logger.log({
          sessionId: "s",
          eventType: "message:inbound",
          component: "test",
          payload: { text: "test" },
        });
        await logger.flush();

        const filePath = join(nested, `${getTodayDateString()}.jsonl`);
        const content = await readFile(filePath, "utf-8");
        assert.ok(content.length > 0);
      } finally {
        await logger.close();
        await rm(base, { recursive: true, force: true });
      }
    });
  });

  describe("flush and close", () => {
    it("flush drains all pending writes", async () => {
      await withTempLogger({ redactSensitive: false }, async (logger, dir) => {
        for (let i = 1; i <= 3; i++) {
          logger.log({
            sessionId: `s-${i}`,
            eventType: "message:inbound",
            component: "router",
            payload: { num: i },
          });
        }
        await logger.flush();

        const entries = await readLogLines(dir);
        assert.equal(entries.length, 3);
        assert.equal(entries[0]!.payload["num"], 1);
        assert.equal(entries[2]!.payload["num"], 3);
      });
    });

    it("flush returns immediately when queue is empty", async () => {
      await withTempLogger({ redactSensitive: false }, async (logger) => {
        await logger.flush(); // should not throw or hang
      });
    });

    it("close() also flushes", async () => {
      await withTempLogger({ redactSensitive: false }, async (logger, dir) => {
        logger.log({
          sessionId: "s",
          eventType: "message:inbound",
          component: "router",
          payload: { action: "close" },
        });
        await logger.close();

        const entries = await readLogLines(dir);
        assert.equal(entries[0]!.payload["action"], "close");
      });
    });
  });

  describe("event types", () => {
    it("logs all event types correctly", async () => {
      await withTempLogger({ redactSensitive: false }, async (logger, dir) => {
        const eventTypes = [
          "message:inbound", "message:outbound", "llm:request", "llm:response",
          "tool:invoke", "gate:decision", "executor:start", "executor:result",
          "executor:timeout", "memory:read", "memory:write", "memory:curation",
          "session:create", "session:idle", "config:change",
        ] as const;

        for (const eventType of eventTypes) {
          logger.log({
            sessionId: "s",
            eventType,
            component: "test",
            payload: { event: eventType },
          });
        }
        await logger.flush();

        const entries = await readLogLines(dir);
        assert.equal(entries.length, eventTypes.length);
        for (let i = 0; i < entries.length; i++) {
          assert.equal(entries[i]!.eventType, eventTypes[i]);
        }
      });
    });
  });
});
