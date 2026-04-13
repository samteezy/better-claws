import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SignalAdapter,
  SignalError,
} from "../../src/adapters/signal/signal-adapter.js";
import type { InboundMessage } from "../../src/types.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  body: unknown;
}

function createMockFetch(
  responses: Array<{ ok: boolean; status: number; result?: unknown }>,
) {
  let callIndex = 0;
  const calls: FetchCall[] = [];
  const fn = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    calls.push({
      url,
      body: init?.body ? (JSON.parse(init.body as string) as unknown) : null,
    });
    const resp = responses[callIndex] ?? { ok: true, status: 200, result: [] };
    callIndex++;
    return {
      json: async () => resp.result ?? {},
      status: resp.status,
      ok: resp.ok,
    } as Response;
  };
  return { fn: fn as typeof fetch, calls };
}

function makeSignalEnvelope(
  sourceNumber: string,
  message: string,
  timestamp: number,
  overrides?: {
    groupId?: string;
    sourceName?: string;
    noMessage?: boolean;
  },
) {
  if (overrides?.noMessage) {
    return {
      source: sourceNumber,
      sourceNumber,
      timestamp,
    };
  }

  const dataMessage: Record<string, unknown> = {
    message: message ?? null,
    timestamp,
  };

  if (overrides?.groupId) {
    dataMessage["groupInfo"] = {
      groupId: overrides.groupId,
      type: "v2",
    };
  }

  return {
    source: sourceNumber,
    sourceNumber,
    sourceName: overrides?.sourceName ?? "Sender",
    dataMessage,
    timestamp,
  };
}

function makeSignalReceiveItem(
  sourceNumber: string,
  message: string,
  timestamp: number,
  overrides?: {
    groupId?: string;
    sourceName?: string;
    noMessage?: boolean;
  },
) {
  return {
    envelope: makeSignalEnvelope(
      sourceNumber,
      message,
      timestamp,
      overrides,
    ),
    account: "+15551234567",
  };
}

function makeAdapter(
  overrides?: Partial<{
    apiUrl: string;
    number: string;
    pollingIntervalMs: number;
    pollingTimeoutSecs: number;
    fetchFn: typeof fetch;
    logger: ReturnType<typeof createMockLogger>;
  }>,
) {
  const logger = overrides?.logger ?? createMockLogger();
  const adapter = new SignalAdapter({
    apiUrl: overrides?.apiUrl ?? "http://localhost:8080",
    number: overrides?.number ?? "+15551234567",
    pollingIntervalMs: overrides?.pollingIntervalMs ?? 50,
    pollingTimeoutSecs: overrides?.pollingTimeoutSecs ?? 1,
    logger,
    fetchFn: overrides?.fetchFn,
  });
  return { adapter, logger };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SignalAdapter", () => {
  describe("constructor", () => {
    it("throws SignalError with MISSING_CONFIG if apiUrl is empty", () => {
      assert.throws(
        () =>
          makeAdapter({
            apiUrl: "",
          }),
        (err: unknown) =>
          err instanceof SignalError && err.code === "MISSING_CONFIG",
      );
    });

    it("throws SignalError with MISSING_CONFIG if number is empty", () => {
      assert.throws(
        () =>
          makeAdapter({
            number: "",
          }),
        (err: unknown) =>
          err instanceof SignalError && err.code === "MISSING_CONFIG",
      );
    });

    it("creates successfully with valid config", () => {
      const { adapter } = makeAdapter({
        apiUrl: "http://localhost:8080",
        number: "+15551234567",
      });
      assert.equal(adapter.id, "signal");
      assert.equal(adapter.name, "Signal");
    });

    it("strips trailing slashes from apiUrl", () => {
      const mock = createMockFetch([{ ok: true, status: 200, result: [] }]);
      const { adapter } = makeAdapter({
        apiUrl: "http://localhost:8080///",
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
      });
      adapter.onMessage(() => {});

      // Start and immediately stop to trigger one poll
      void adapter.start();

      // Give the first poll a chance to run
      setTimeout(() => {
        void adapter.stop();
      }, 30);

      // Check that the URL doesn't have double slashes at the end
      setTimeout(() => {
        if (mock.calls.length > 0) {
          const firstUrl = mock.calls[0]!.url;
          assert.ok(
            !firstUrl.includes("http://localhost:8080///"),
            "apiUrl should have trailing slashes stripped",
          );
        }
      }, 80);
    });
  });

  describe("start / stop", () => {
    it("logs start event with action and pollingIntervalMs", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();
      await adapter.stop();

      const startLog = logger.logs.find(
        (l) =>
          (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.ok(startLog, "should log start event");
      assert.equal(startLog["eventType"], "config:change");
      assert.equal(startLog["component"], "signal");
      const payload = startLog["payload"] as Record<string, unknown>;
      assert.equal(typeof payload["pollingIntervalMs"], "number");
    });

    it("logs stop event", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();
      await adapter.stop();

      const stopLog = logger.logs.find(
        (l) =>
          (l["payload"] as Record<string, unknown>)["action"] === "stop",
      );
      assert.ok(stopLog, "should log stop event");
      assert.equal(stopLog["eventType"], "config:change");
    });
  });

  describe("send()", () => {
    it("sends DM via POST /v2/send with correct parameters", async () => {
      const mock = createMockFetch([{ ok: true, status: 200, result: {} }]);
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await adapter.send("+15559876543", {
        channelId: "+15559876543",
        text: "Hello Signal!",
      });

      assert.equal(mock.calls.length, 1);
      assert.ok(mock.calls[0]!.url.includes("/v2/send"));
      const body = mock.calls[0]!.body as Record<string, unknown>;
      assert.equal(body["number"], "+15551234567");
      assert.deepEqual(body["recipients"], ["+15559876543"]);
      assert.equal(body["message"], "Hello Signal!");
    });

    it("sends group message by stripping group: prefix", async () => {
      const mock = createMockFetch([{ ok: true, status: 200, result: {} }]);
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await adapter.send("group:abc123xyz", {
        channelId: "group:abc123xyz",
        text: "Group message",
      });

      assert.equal(mock.calls.length, 1);
      const body = mock.calls[0]!.body as Record<string, unknown>;
      assert.deepEqual(body["recipients"], ["abc123xyz"]);
      assert.equal(body["message"], "Group message");
    });

    it("throws SignalError with NETWORK_ERROR on fetch failure", async () => {
      const fn = (async () => {
        throw new Error("Connection refused");
      }) as typeof fetch;
      const { adapter } = makeAdapter({ fetchFn: fn });

      await assert.rejects(
        () =>
          adapter.send("+15559876543", {
            channelId: "+15559876543",
            text: "test",
          }),
        (err: unknown) =>
          err instanceof SignalError && err.code === "NETWORK_ERROR",
      );
    });

    it("throws SignalError with API_ERROR on non-ok response", async () => {
      const mock = createMockFetch([
        { ok: false, status: 400, result: { error: "Invalid number" } },
      ]);
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await assert.rejects(
        () =>
          adapter.send("+15559876543", {
            channelId: "+15559876543",
            text: "test",
          }),
        (err: unknown) =>
          err instanceof SignalError && err.code === "API_ERROR",
      );
    });

    it("throws SignalError with INVALID_RESPONSE on bad JSON", async () => {
      const fn = (async () => ({
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
        status: 200,
        ok: true,
      })) as unknown as typeof fetch;
      const { adapter } = makeAdapter({ fetchFn: fn });

      await assert.rejects(
        () =>
          adapter.send("+15559876543", {
            channelId: "+15559876543",
            text: "test",
          }),
        (err: unknown) =>
          err instanceof SignalError && err.code === "INVALID_RESPONSE",
      );
    });
  });

  describe("polling and message processing", () => {
    it("processes valid DM envelope and calls onMessage callback", async () => {
      const item = makeSignalReceiveItem("+15559876543", "hi there", 1700000000);
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
      });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "hi there");
      assert.equal(received[0]!.channelId, "+15559876543");
      assert.equal(received[0]!.senderId, "+15559876543");
      assert.equal(received[0]!.adapterId, "signal");
      assert.equal(received[0]!.timestamp, 1700000000);
    });

    it("processes valid group envelope with group: prefix", async () => {
      const item = makeSignalReceiveItem("+15559876543", "group msg", 1700000001, {
        groupId: "groupabc123",
      });
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
      });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 1);
      assert.equal(received[0]!.channelId, "group:groupabc123");
      assert.equal(received[0]!.text, "group msg");
    });

    it("skips envelopes without dataMessage", async () => {
      const item = {
        envelope: {
          source: "+15559876543",
          sourceNumber: "+15559876543",
          timestamp: 1700000000,
        },
        account: "+15551234567",
      };
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
      });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 0);
    });

    it("skips envelopes with null message", async () => {
      const item = makeSignalReceiveItem(
        "+15559876543",
        "",
        1700000000,
        { noMessage: true },
      );
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
      });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 0);
    });

    it("skips self-messages (source === bot number)", async () => {
      const item = makeSignalReceiveItem(
        "+15551234567",
        "self message",
        1700000000,
      );
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({
        number: "+15551234567",
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
      });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 0);
    });

    it("logs inbound messages with correct payload", async () => {
      const item = makeSignalReceiveItem("+15559876543", "test msg", 1700000002, {
        sourceName: "Alice Smith",
      });
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const logger = createMockLogger();
      const { adapter } = makeAdapter({
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
        logger,
      });
      adapter.onMessage(() => {});

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      const inboundLog = logger.logs.find(
        (l) => l["eventType"] === "message:inbound",
      );
      assert.ok(inboundLog);
      const payload = inboundLog["payload"] as Record<string, unknown>;
      assert.equal(payload["messageId"], 1700000002);
      assert.equal(payload["channelId"], "+15559876543");
      assert.equal(payload["senderId"], "+15559876543");
      assert.equal(payload["senderName"], "Alice Smith");
      assert.equal(payload["textLength"], 8);
    });

    it("does not crash if no callback registered", async () => {
      const item = makeSignalReceiveItem(
        "+15559876543",
        "orphan msg",
        1700000003,
      );
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
      });

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();
    });

    it("logs polling errors without crashing", async () => {
      let callCount = 0;
      const fn = (async () => {
        callCount++;
        if (callCount === 1) throw new Error("Temporary network failure");
        return {
          json: async () => ({ result: [] }),
          status: 200,
          ok: true,
        };
      }) as unknown as typeof fetch;

      const logger = createMockLogger();
      const { adapter } = makeAdapter({
        fetchFn: fn,
        pollingIntervalMs: 10,
        logger,
      });

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await adapter.stop();

      const errorLog = logger.logs.find(
        (l) =>
          (l["payload"] as Record<string, unknown>)["action"] === "poll_error",
      );
      assert.ok(errorLog, "should log polling error");
    });

    it("stores raw envelope in InboundMessage", async () => {
      const item = makeSignalReceiveItem(
        "+15559876543",
        "raw test",
        1700000004,
      );
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
      });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 1);
      assert.deepEqual(received[0]!.raw, item);
    });
  });

  describe("receiveMessages API call", () => {
    it("calls correct URL with encoded number and timeout", async () => {
      const mock = createMockFetch([
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({
        number: "+15551234567",
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
        pollingTimeoutSecs: 15,
      });

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 40));
      await adapter.stop();

      assert.ok(mock.calls.length >= 1);
      const firstCall = mock.calls[0]!.url;
      assert.ok(
        firstCall.includes("/v1/receive/"),
        "should use /v1/receive endpoint",
      );
      assert.ok(
        firstCall.includes("%2B15551234567"),
        "should URL-encode the phone number",
      );
      assert.ok(
        firstCall.includes("timeout=15"),
        "should include timeout parameter",
      );
    });

    it("handles 204 No Content response", async () => {
      const mock = createMockFetch([
        { ok: true, status: 204, result: undefined },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
      });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      // Should not crash with 204
      assert.equal(received.length, 0);
    });
  });

  describe("interface compliance", () => {
    it("has correct id and name properties", () => {
      const { adapter } = makeAdapter();
      assert.equal(adapter.id, "signal");
      assert.equal(adapter.name, "Signal");
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
