import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TelegramAdapter,
  TelegramError,
} from "../../src/adapters/telegram/telegram-adapter.js";
import type { InboundMessage } from "../../src/types.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  body: unknown;
}

function createMockFetch(
  responses: Array<{ ok: boolean; result?: unknown; description?: string; error_code?: number }>,
) {
  let callIndex = 0;
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      body: init?.body ? JSON.parse(init.body as string) as unknown : null,
    });
    const resp = responses[callIndex] ?? { ok: true, result: [] };
    callIndex++;
    return {
      json: async () => resp,
      status: resp.ok ? 200 : 400,
    } as Response;
  };
  return { fn: fn as typeof fetch, calls };
}

function makeTelegramUpdate(
  updateId: number,
  overrides?: {
    text?: string;
    chatId?: number;
    fromId?: number;
    firstName?: string;
    lastName?: string;
    noFrom?: boolean;
    noMessage?: boolean;
  },
) {
  if (overrides?.noMessage) {
    return { update_id: updateId };
  }
  const msg: Record<string, unknown> = {
    message_id: updateId * 10,
    chat: { id: overrides?.chatId ?? 12345, type: "private" },
    date: 1700000000,
  };
  if (overrides?.text !== undefined) {
    msg["text"] = overrides.text;
  } else {
    msg["text"] = "hello";
  }
  if (!overrides?.noFrom) {
    msg["from"] = {
      id: overrides?.fromId ?? 99,
      first_name: overrides?.firstName ?? "John",
      ...(overrides?.lastName ? { last_name: overrides.lastName } : {}),
    };
  }
  return { update_id: updateId, message: msg };
}

function makeAdapter(
  overrides?: Partial<{
    token: string;
    pollingIntervalMs: number;
    pollingTimeoutSecs: number;
    fetchFn: typeof fetch;
    logger: ReturnType<typeof createMockLogger>;
  }>,
) {
  const logger = overrides?.logger ?? createMockLogger();
  const adapter = new TelegramAdapter({
    token: overrides?.token ?? "test-token-123",
    pollingIntervalMs: overrides?.pollingIntervalMs ?? 50,
    pollingTimeoutSecs: overrides?.pollingTimeoutSecs ?? 1,
    logger,
    fetchFn: overrides?.fetchFn,
  });
  return { adapter, logger };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("TelegramAdapter", () => {
  describe("constructor", () => {
    it("throws TelegramError if token is empty", () => {
      assert.throws(
        () => makeAdapter({ token: "" }),
        (err: unknown) =>
          err instanceof TelegramError && err.code === "MISSING_TOKEN",
      );
    });

    it("creates successfully with valid token", () => {
      const { adapter } = makeAdapter({ token: "valid-token" });
      assert.equal(adapter.id, "telegram");
      assert.equal(adapter.name, "Telegram");
    });
  });

  describe("start / stop", () => {
    it("logs start event", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();
      await adapter.stop();

      const startLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.ok(startLog, "should log start event");
      assert.equal(startLog["eventType"], "config:change");
    });

    it("logs stop event", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();
      await adapter.stop();

      const stopLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "stop",
      );
      assert.ok(stopLog, "should log stop event");
    });
  });

  describe("send()", () => {
    it("calls sendMessage API with correct parameters", async () => {
      const mock = createMockFetch([{ ok: true, result: {} }]);
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await adapter.send("12345", { channelId: "12345", text: "Hello!" });

      assert.equal(mock.calls.length, 1);
      assert.ok(mock.calls[0]!.url.includes("/sendMessage"));
      assert.ok(mock.calls[0]!.url.includes("test-token-123"));
      const body = mock.calls[0]!.body as Record<string, unknown>;
      assert.equal(body["chat_id"], "12345");
      assert.equal(body["text"], "Hello!");
    });

    it("throws TelegramError when API returns ok: false", async () => {
      const mock = createMockFetch([
        { ok: false, description: "Chat not found", error_code: 400 },
      ]);
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await assert.rejects(
        () => adapter.send("bad", { channelId: "bad", text: "test" }),
        (err: unknown) =>
          err instanceof TelegramError && err.code === "API_ERROR",
      );
    });

    it("throws TelegramError on network failure", async () => {
      const fn = (async () => {
        throw new Error("Network down");
      }) as typeof fetch;
      const { adapter } = makeAdapter({ fetchFn: fn });

      await assert.rejects(
        () => adapter.send("123", { channelId: "123", text: "test" }),
        (err: unknown) =>
          err instanceof TelegramError && err.code === "NETWORK_ERROR",
      );
    });

    it("throws TelegramError on invalid JSON response", async () => {
      const fn = (async () => ({
        json: async () => { throw new SyntaxError("bad json"); },
        status: 200,
      })) as unknown as typeof fetch;
      const { adapter } = makeAdapter({ fetchFn: fn });

      await assert.rejects(
        () => adapter.send("123", { channelId: "123", text: "test" }),
        (err: unknown) =>
          err instanceof TelegramError && err.code === "INVALID_RESPONSE",
      );
    });
  });

  describe("polling and message processing", () => {
    it("processes updates and calls onMessage callback", async () => {
      const update = makeTelegramUpdate(1, { text: "hi there", chatId: 555, fromId: 42, firstName: "Alice" });
      const mock = createMockFetch([
        { ok: true, result: [update] },
        { ok: true, result: [] },
      ]);

      const { adapter } = makeAdapter({ fetchFn: mock.fn, pollingIntervalMs: 10 });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "hi there");
      assert.equal(received[0]!.channelId, "555");
      assert.equal(received[0]!.senderId, "42");
      assert.equal(received[0]!.adapterId, "telegram");
      assert.equal(received[0]!.timestamp, 1700000000 * 1000);
    });

    it("skips updates with no text", async () => {
      const updateNoText = { update_id: 1, message: { message_id: 10, chat: { id: 1, type: "private" }, date: 1700000000 } };
      const mock = createMockFetch([
        { ok: true, result: [updateNoText] },
        { ok: true, result: [] },
      ]);

      const { adapter } = makeAdapter({ fetchFn: mock.fn, pollingIntervalMs: 10 });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 0);
    });

    it("skips updates with no message", async () => {
      const mock = createMockFetch([
        { ok: true, result: [makeTelegramUpdate(1, { noMessage: true })] },
        { ok: true, result: [] },
      ]);

      const { adapter } = makeAdapter({ fetchFn: mock.fn, pollingIntervalMs: 10 });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 0);
    });

    it("handles missing from field", async () => {
      const update = makeTelegramUpdate(1, { noFrom: true });
      const mock = createMockFetch([
        { ok: true, result: [update] },
        { ok: true, result: [] },
      ]);

      const { adapter } = makeAdapter({ fetchFn: mock.fn, pollingIntervalMs: 10 });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 1);
      assert.equal(received[0]!.senderId, "unknown");
    });

    it("builds senderName from first and last name", async () => {
      const update = makeTelegramUpdate(1, { firstName: "Jane", lastName: "Doe" });
      const mock = createMockFetch([
        { ok: true, result: [update] },
        { ok: true, result: [] },
      ]);

      const logger = createMockLogger();
      const { adapter } = makeAdapter({ fetchFn: mock.fn, pollingIntervalMs: 10, logger });
      adapter.onMessage(() => {});

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      const inboundLog = logger.logs.find(
        (l) => l["eventType"] === "message:inbound" && (l["payload"] as Record<string, unknown>)["senderName"],
      );
      assert.ok(inboundLog);
      assert.equal((inboundLog["payload"] as Record<string, unknown>)["senderName"], "Jane Doe");
    });

    it("tracks lastUpdateId for offset", async () => {
      const mock = createMockFetch([
        { ok: true, result: [makeTelegramUpdate(100)] },
        { ok: true, result: [] },
        { ok: true, result: [] },
      ]);

      const { adapter } = makeAdapter({ fetchFn: mock.fn, pollingIntervalMs: 10 });
      adapter.onMessage(() => {});

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await adapter.stop();

      assert.ok(mock.calls.length >= 2, `expected at least 2 calls, got ${mock.calls.length}`);
      const secondCallBody = mock.calls[1]!.body as Record<string, unknown>;
      assert.equal(secondCallBody["offset"], 101);
    });

    it("stores raw update in InboundMessage", async () => {
      const update = makeTelegramUpdate(1);
      const mock = createMockFetch([
        { ok: true, result: [update] },
        { ok: true, result: [] },
      ]);

      const { adapter } = makeAdapter({ fetchFn: mock.fn, pollingIntervalMs: 10 });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 1);
      assert.deepEqual(received[0]!.raw, update);
    });

    it("does not crash if no callback registered", async () => {
      const mock = createMockFetch([
        { ok: true, result: [makeTelegramUpdate(1)] },
        { ok: true, result: [] },
      ]);

      const { adapter } = makeAdapter({ fetchFn: mock.fn, pollingIntervalMs: 10 });

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();
    });

    it("logs polling errors without crashing", async () => {
      let callCount = 0;
      const fn = (async () => {
        callCount++;
        if (callCount === 1) throw new Error("Temporary failure");
        return {
          json: async () => ({ ok: true, result: [] }),
          status: 200,
        };
      }) as unknown as typeof fetch;

      const logger = createMockLogger();
      const { adapter } = makeAdapter({ fetchFn: fn, pollingIntervalMs: 10, logger });

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await adapter.stop();

      const errorLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "poll_error",
      );
      assert.ok(errorLog, "should log polling error");
    });
  });

  describe("getUpdates API call", () => {
    it("sends correct parameters", async () => {
      const mock = createMockFetch([
        { ok: true, result: [] },
      ]);

      const { adapter } = makeAdapter({
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
        pollingTimeoutSecs: 15,
      });

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 40));
      await adapter.stop();

      assert.ok(mock.calls.length >= 1);
      const body = mock.calls[0]!.body as Record<string, unknown>;
      assert.equal(body["timeout"], 15);
      assert.deepEqual(body["allowed_updates"], ["message"]);
      assert.ok(mock.calls[0]!.url.includes("/getUpdates"));
    });
  });

  describe("interface compliance", () => {
    it("has correct id and name", () => {
      const { adapter } = makeAdapter();
      assert.equal(adapter.id, "telegram");
      assert.equal(adapter.name, "Telegram");
    });

    it("implements all ChannelAdapter methods", () => {
      const { adapter } = makeAdapter();
      assert.equal(typeof adapter.start, "function");
      assert.equal(typeof adapter.stop, "function");
      assert.equal(typeof adapter.onMessage, "function");
      assert.equal(typeof adapter.send, "function");
    });
  });
});
