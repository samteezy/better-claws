import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SignalAdapter,
  SignalError,
} from "../../src/adapters/signal/signal-adapter.js";
import type { InboundMessage } from "../../src/types.js";
import { createMockLogger } from "../helpers/mock-logger.js";

// ── Mock WebSocket ────────────────────────────────────────────────────────────

class MockWebSocket {
  readonly url: string;
  readyState: number = 0;

  onopen: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onmessage: ((this: WebSocket, ev: MessageEvent) => unknown) | null = null;
  onerror: ((this: WebSocket, ev: Event) => unknown) | null = null;
  onclose: ((this: WebSocket, ev: CloseEvent) => unknown) | null = null;

  closed = false;

  constructor(url: string) {
    this.url = url;
  }

  close(): void {
    this.readyState = 3;
    this.closed = true;
    if (this.onclose) {
      this.onclose.call(this as unknown as WebSocket, { code: 1000, reason: "" } as CloseEvent);
    }
  }

  simulateOpen(): void {
    this.readyState = 1;
    if (this.onopen) {
      this.onopen.call(this as unknown as WebSocket, new Event("open"));
    }
  }

  simulateMessage(data: unknown): void {
    if (this.onmessage) {
      this.onmessage.call(
        this as unknown as WebSocket,
        { data: JSON.stringify(data) } as MessageEvent,
      );
    }
  }

  simulateError(message?: string): void {
    if (this.onerror) {
      const ev = new Event("error") as Event & { message?: string };
      if (message !== undefined) ev.message = message;
      this.onerror.call(this as unknown as WebSocket, ev);
    }
  }

  simulateClose(code = 1006, reason = ""): void {
    this.readyState = 3;
    if (this.onclose) {
      this.onclose.call(this as unknown as WebSocket, { code, reason } as CloseEvent);
    }
  }

  simulateRawMessage(data: string): void {
    if (this.onmessage) {
      this.onmessage.call(this as unknown as WebSocket, { data } as MessageEvent);
    }
  }
}

function createMockWsFactory() {
  const instances: MockWebSocket[] = [];
  const factory = (url: string): WebSocket => {
    const ws = new MockWebSocket(url);
    instances.push(ws);
    return ws as unknown as WebSocket;
  };
  return { factory, instances };
}

// ── Mock fetch ────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEnvelope(
  sourceNumber: string,
  message: string,
  timestamp: number,
  overrides?: { groupId?: string; sourceName?: string; noMessage?: boolean },
) {
  if (overrides?.noMessage) {
    return { envelope: { source: sourceNumber, sourceNumber, timestamp } };
  }

  const dataMessage: Record<string, unknown> = { message, timestamp };
  if (overrides?.groupId) {
    dataMessage["groupInfo"] = { groupId: overrides.groupId, type: "v2" };
  }

  return {
    envelope: {
      source: sourceNumber,
      sourceNumber,
      sourceName: overrides?.sourceName ?? "Sender",
      dataMessage,
      timestamp,
    },
  };
}

function makeAdapter(
  overrides?: Partial<{
    apiUrl: string;
    number: string;
    mode: "http" | "websocket";
    pollingIntervalMs: number;
    pollingTimeoutSecs: number;
    fetchFn: typeof fetch;
    wsFactory: (url: string) => WebSocket;
    logger: ReturnType<typeof createMockLogger>;
  }>,
) {
  const logger = overrides?.logger ?? createMockLogger();
  const wsMock = createMockWsFactory();
  const adapter = new SignalAdapter({
    apiUrl: overrides?.apiUrl ?? "http://localhost:8080",
    number: overrides?.number ?? "+15551234567",
    mode: overrides?.mode ?? "http",
    pollingIntervalMs: overrides?.pollingIntervalMs ?? 50,
    pollingTimeoutSecs: overrides?.pollingTimeoutSecs ?? 1,
    logger,
    fetchFn: overrides?.fetchFn,
    wsFactory: overrides?.wsFactory ?? wsMock.factory,
  });
  return { adapter, logger, wsMock };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("SignalAdapter", () => {
  describe("constructor", () => {
    it("throws SignalError with MISSING_CONFIG if apiUrl is empty", () => {
      assert.throws(
        () => makeAdapter({ apiUrl: "" }),
        (err: unknown) =>
          err instanceof SignalError && err.code === "MISSING_CONFIG",
      );
    });

    it("throws SignalError with MISSING_CONFIG if number is empty", () => {
      assert.throws(
        () => makeAdapter({ number: "" }),
        (err: unknown) =>
          err instanceof SignalError && err.code === "MISSING_CONFIG",
      );
    });

    it("creates successfully with valid config", () => {
      const { adapter } = makeAdapter();
      assert.equal(adapter.id, "signal");
      assert.equal(adapter.name, "Signal");
    });
  });

  describe("start / stop", () => {
    it("logs start event with mode", async () => {
      const { adapter, logger } = makeAdapter({ mode: "http" });
      await adapter.start();
      await adapter.stop();

      const startLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.ok(startLog, "should log start event");
      assert.equal(startLog["eventType"], "config:change");
      const payload = startLog["payload"] as Record<string, unknown>;
      assert.equal(payload["mode"], "http");
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

    it("sends group message with group. prefix on recipient", async () => {
      const mock = createMockFetch([{ ok: true, status: 200, result: {} }]);
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await adapter.send("group:abc123xyz", {
        channelId: "group:abc123xyz",
        text: "Group message",
      });

      const body = mock.calls[0]!.body as Record<string, unknown>;
      const expected = "group." + Buffer.from("abc123xyz", "utf8").toString("base64");
      assert.deepEqual(body["recipients"], [expected]);
    });

    it("throws SignalError with NETWORK_ERROR on fetch failure", async () => {
      const fn = (async () => { throw new Error("Connection refused"); }) as typeof fetch;
      const { adapter } = makeAdapter({ fetchFn: fn });

      await assert.rejects(
        () => adapter.send("+15559876543", { channelId: "+15559876543", text: "test" }),
        (err: unknown) => err instanceof SignalError && err.code === "NETWORK_ERROR",
      );
    });

    it("throws SignalError with API_ERROR on non-ok response", async () => {
      const mock = createMockFetch([
        { ok: false, status: 400, result: { error: "Invalid number" } },
      ]);
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await assert.rejects(
        () => adapter.send("+15559876543", { channelId: "+15559876543", text: "test" }),
        (err: unknown) => err instanceof SignalError && err.code === "API_ERROR",
      );
    });

    it("throws SignalError with INVALID_RESPONSE on bad JSON", async () => {
      const fn = (async () => ({
        json: async () => { throw new SyntaxError("Unexpected token"); },
        status: 200,
        ok: true,
      })) as unknown as typeof fetch;
      const { adapter } = makeAdapter({ fetchFn: fn });

      await assert.rejects(
        () => adapter.send("+15559876543", { channelId: "+15559876543", text: "test" }),
        (err: unknown) => err instanceof SignalError && err.code === "INVALID_RESPONSE",
      );
    });
  });

  describe("HTTP mode (polling)", () => {
    it("polls the correct URL with encoded number and timeout", async () => {
      const mock = createMockFetch([
        { ok: true, status: 200, result: [] },
        { ok: true, status: 200, result: [] },
      ]);
      const { adapter } = makeAdapter({
        mode: "http",
        number: "+15551234567",
        fetchFn: mock.fn,
        pollingIntervalMs: 10,
        pollingTimeoutSecs: 5,
      });

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 40));
      await adapter.stop();

      const pollCalls = mock.calls.filter((c) => c.url.includes("/v1/receive/"));
      assert.ok(pollCalls.length >= 1);
      const url = pollCalls[0]!.url;
      assert.ok(url.includes("%2B15551234567"), "should URL-encode the phone number");
      assert.ok(url.includes("timeout=5"), "should pass pollingTimeoutSecs as timeout");
    });

    it("processes a DM received via polling", async () => {
      const item = makeEnvelope("+15559876543", "hi there", 1700000000);
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({ mode: "http", fetchFn: mock.fn, pollingIntervalMs: 10 });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "hi there");
      assert.equal(received[0]!.channelId, "+15559876543");
    });

    it("processes a group message received via polling", async () => {
      const item = makeEnvelope("+15559876543", "group msg", 1700000001, { groupId: "grp123" });
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);

      const { adapter } = makeAdapter({ mode: "http", fetchFn: mock.fn, pollingIntervalMs: 10 });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();

      assert.equal(received.length, 1);
      assert.equal(received[0]!.channelId, "group:grp123");
    });

    it("handles 204 No Content without crashing", async () => {
      const mock = createMockFetch([
        { ok: true, status: 204, result: undefined },
        { ok: true, status: 200, result: [] },
      ]);
      const { adapter } = makeAdapter({ mode: "http", fetchFn: mock.fn, pollingIntervalMs: 10 });
      adapter.onMessage(() => {});

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 80));
      await adapter.stop();
    });

    it("logs poll_error without crashing on network failure", async () => {
      let callCount = 0;
      const fn = (async (input: string | URL | Request) => {
        const url = typeof input === "string" ? input : (input instanceof URL ? input.href : input.url);
        if (url.includes("/v1/receive/") && callCount++ === 0) {
          throw new Error("Temporary failure");
        }
        return { json: async () => [], status: 200, ok: true } as Response;
      }) as typeof fetch;

      const logger = createMockLogger();
      const { adapter } = makeAdapter({ mode: "http", fetchFn: fn, pollingIntervalMs: 10, logger });

      await adapter.start();
      await new Promise((resolve) => setTimeout(resolve, 120));
      await adapter.stop();

      const errLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "poll_error",
      );
      assert.ok(errLog, "should log poll_error");
    });

    it("skips self-messages in HTTP mode", async () => {
      const item = makeEnvelope("+15551234567", "self", 1700000000);
      const mock = createMockFetch([
        { ok: true, status: 200, result: [item] },
        { ok: true, status: 200, result: [] },
      ]);
      const { adapter } = makeAdapter({
        mode: "http",
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
  });

  describe("WebSocket mode", () => {
    it("connects to ws:// URL with encoded phone number", async () => {
      const wsMock = createMockWsFactory();
      const { adapter } = makeAdapter({ mode: "websocket", number: "+15551234567", wsFactory: wsMock.factory });

      await adapter.start();

      assert.equal(wsMock.instances.length, 1);
      const url = wsMock.instances[0]!.url;
      assert.ok(url.startsWith("ws://"), "should use ws:// scheme");
      assert.ok(url.includes("/v1/receive/"), "should use /v1/receive path");
      assert.ok(url.includes("%2B15551234567"), "should URL-encode the phone number");

      await adapter.stop();
    });

    it("strips trailing slashes from apiUrl before building ws:// URL", () => {
      const wsMock = createMockWsFactory();
      const { adapter } = makeAdapter({ mode: "websocket", apiUrl: "http://localhost:8080///", wsFactory: wsMock.factory });

      void adapter.start();
      void adapter.stop();

      assert.ok(wsMock.instances.length >= 1);
      const url = wsMock.instances[0]!.url;
      assert.ok(url.startsWith("ws://"), "should use ws:// scheme");
      assert.ok(!url.includes("///"), "should not have triple slashes");
    });

    it("processes a DM received over WebSocket", async () => {
      const { adapter, wsMock } = makeAdapter({ mode: "websocket" });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      wsMock.instances[0]!.simulateOpen();
      wsMock.instances[0]!.simulateMessage(makeEnvelope("+15559876543", "hi there", 1700000000));

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "hi there");
      assert.equal(received[0]!.channelId, "+15559876543");
      assert.equal(received[0]!.senderId, "+15559876543");
      assert.equal(received[0]!.adapterId, "signal");
      assert.equal(received[0]!.timestamp, 1700000000);

      await adapter.stop();
    });

    it("processes a group message received over WebSocket", async () => {
      const { adapter, wsMock } = makeAdapter({ mode: "websocket" });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      wsMock.instances[0]!.simulateMessage(
        makeEnvelope("+15559876543", "group msg", 1700000001, { groupId: "groupabc123" }),
      );

      assert.equal(received.length, 1);
      assert.equal(received[0]!.channelId, "group:groupabc123");

      await adapter.stop();
    });

    it("skips self-messages in WebSocket mode", async () => {
      const { adapter, wsMock } = makeAdapter({ mode: "websocket", number: "+15551234567" });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      wsMock.instances[0]!.simulateMessage(makeEnvelope("+15551234567", "self", 1700000000));

      assert.equal(received.length, 0);
      await adapter.stop();
    });

    it("silently ignores non-JSON WebSocket messages", async () => {
      const { adapter, wsMock } = makeAdapter({ mode: "websocket" });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      const ws = wsMock.instances[0]!;
      if (ws.onmessage) {
        ws.onmessage.call(ws as unknown as WebSocket, { data: "not json {{" } as MessageEvent);
      }

      assert.equal(received.length, 0);
      await adapter.stop();
    });

    it("logs ws_connected on open", async () => {
      const logger = createMockLogger();
      const { adapter, wsMock } = makeAdapter({ mode: "websocket", logger });

      await adapter.start();
      wsMock.instances[0]!.simulateOpen();

      const connLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "ws_connected",
      );
      assert.ok(connLog, "should log ws_connected");

      await adapter.stop();
    });

    it("logs ws_error on WebSocket error", async () => {
      const logger = createMockLogger();
      const { adapter, wsMock } = makeAdapter({ mode: "websocket", logger });

      await adapter.start();
      wsMock.instances[0]!.simulateError();

      const errLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "ws_error",
      );
      assert.ok(errLog, "should log ws_error");

      await adapter.stop();
    });

    it("includes error detail in ws_error payload", async () => {
      const logger = createMockLogger();
      const { adapter, wsMock } = makeAdapter({ mode: "websocket", logger });

      await adapter.start();
      wsMock.instances[0]!.simulateError("connect ECONNREFUSED 127.0.0.1:8080");

      const errLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "ws_error",
      );
      assert.ok(errLog);
      const payload = errLog["payload"] as Record<string, unknown>;
      assert.equal(typeof payload["error"], "string");
      assert.ok(
        (payload["error"] as string).includes("ECONNREFUSED"),
        `expected error to include ECONNREFUSED, got: ${String(payload["error"])}`,
      );

      await adapter.stop();
    });

    it("logs ws_connecting with the resolved url before opening", async () => {
      const logger = createMockLogger();
      const { adapter } = makeAdapter({
        mode: "websocket",
        number: "+15551234567",
        logger,
      });

      await adapter.start();

      const connectingLog = logger.logs.find(
        (l) =>
          (l["payload"] as Record<string, unknown>)["action"] === "ws_connecting",
      );
      assert.ok(connectingLog, "should log ws_connecting");
      const payload = connectingLog["payload"] as Record<string, unknown>;
      assert.equal(typeof payload["url"], "string");
      assert.ok((payload["url"] as string).startsWith("ws://"));
      assert.ok((payload["url"] as string).includes("%2B15551234567"));

      await adapter.stop();
    });

    it("includes code and reason in ws_closed payload", async () => {
      const logger = createMockLogger();
      const { adapter, wsMock } = makeAdapter({
        mode: "websocket",
        pollingIntervalMs: 10,
        logger,
      });

      await adapter.start();
      wsMock.instances[0]!.simulateClose(1006, "abnormal closure");
      await new Promise((resolve) => setTimeout(resolve, 30));

      const closeLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "ws_closed",
      );
      assert.ok(closeLog);
      const payload = closeLog["payload"] as Record<string, unknown>;
      assert.equal(payload["code"], 1006);
      assert.equal(payload["reason"], "abnormal closure");

      await adapter.stop();
    });

    it("logs ws_message_unrecognized for JSON without an envelope", async () => {
      const logger = createMockLogger();
      const { adapter, wsMock } = makeAdapter({ mode: "websocket", logger });
      adapter.onMessage(() => {});

      await adapter.start();
      wsMock.instances[0]!.simulateRawMessage(
        JSON.stringify({ jsonrpc: "2.0", method: "receive", params: { foo: 1 } }),
      );

      const unrecognized = logger.logs.find(
        (l) =>
          (l["payload"] as Record<string, unknown>)["action"] ===
          "ws_message_unrecognized",
      );
      assert.ok(unrecognized, "should log ws_message_unrecognized");
      const payload = unrecognized["payload"] as Record<string, unknown>;
      assert.equal(typeof payload["sample"], "string");
      assert.ok((payload["sample"] as string).includes("jsonrpc"));

      await adapter.stop();
    });

    it("reconnects after WebSocket closes", async () => {
      const wsMock = createMockWsFactory();
      const { adapter } = makeAdapter({
        mode: "websocket",
        pollingIntervalMs: 10,
        wsFactory: wsMock.factory,
      });

      await adapter.start();
      assert.equal(wsMock.instances.length, 1);

      wsMock.instances[0]!.simulateClose();
      await new Promise((resolve) => setTimeout(resolve, 50));

      assert.ok(wsMock.instances.length >= 2, "should create a new connection after close");

      await adapter.stop();
    });

    it("doubles reconnect delay on repeated closes", async () => {
      const logger = createMockLogger();
      const wsMock = createMockWsFactory();
      const { adapter } = makeAdapter({
        mode: "websocket",
        pollingIntervalMs: 10,
        wsFactory: wsMock.factory,
        logger,
      });

      await adapter.start();

      wsMock.instances[0]!.simulateClose();
      await new Promise((resolve) => setTimeout(resolve, 50));

      wsMock.instances[1]!.simulateClose();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const closeLogs = logger.logs.filter(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "ws_closed",
      );
      assert.ok(closeLogs.length >= 2);
      const d1 = (closeLogs[0]!["payload"] as Record<string, unknown>)["reconnectDelayMs"] as number;
      const d2 = (closeLogs[1]!["payload"] as Record<string, unknown>)["reconnectDelayMs"] as number;
      assert.ok(d2 > d1, `second delay (${d2}) should exceed first (${d1})`);

      await adapter.stop();
    });

    it("resets reconnect delay after successful open", async () => {
      const logger = createMockLogger();
      const wsMock = createMockWsFactory();
      const { adapter } = makeAdapter({
        mode: "websocket",
        pollingIntervalMs: 10,
        wsFactory: wsMock.factory,
        logger,
      });

      await adapter.start();
      wsMock.instances[0]!.simulateClose(); // close without open — delay doubles
      await new Promise((resolve) => setTimeout(resolve, 50));

      wsMock.instances[1]!.simulateOpen(); // open resets delay
      wsMock.instances[1]!.simulateClose();
      await new Promise((resolve) => setTimeout(resolve, 100));

      const closeLogs = logger.logs.filter(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "ws_closed",
      );
      assert.ok(closeLogs.length >= 2);
      const d1 = (closeLogs[0]!["payload"] as Record<string, unknown>)["reconnectDelayMs"] as number;
      const d2 = (closeLogs[1]!["payload"] as Record<string, unknown>)["reconnectDelayMs"] as number;
      assert.ok(d2 <= d1, `delay after open reset (${d2}) should not exceed pre-reset (${d1})`);

      await adapter.stop();
    });

    it("does not reconnect after stop()", async () => {
      const wsMock = createMockWsFactory();
      const { adapter } = makeAdapter({
        mode: "websocket",
        pollingIntervalMs: 10,
        wsFactory: wsMock.factory,
      });

      await adapter.start();
      await adapter.stop();

      const countAfterStop = wsMock.instances.length;
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(wsMock.instances.length, countAfterStop, "no new connections after stop");
    });
  });

  describe("shared message processing (both modes)", () => {
    it("skips envelopes without dataMessage", async () => {
      const { adapter, wsMock } = makeAdapter({ mode: "websocket" });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();
      wsMock.instances[0]!.simulateMessage({
        envelope: { source: "+15559876543", timestamp: 1700000000 },
      });

      assert.equal(received.length, 0);
      await adapter.stop();
    });

    it("logs inbound message with correct payload", async () => {
      const logger = createMockLogger();
      const { adapter, wsMock } = makeAdapter({ mode: "websocket", logger });
      adapter.onMessage(() => {});

      await adapter.start();
      wsMock.instances[0]!.simulateMessage(
        makeEnvelope("+15559876543", "test msg", 1700000002, { sourceName: "Alice" }),
      );

      const inboundLog = logger.logs.find(
        (l) =>
          l["eventType"] === "message:inbound" &&
          !["ws_error", "ws_closed"].includes(
            (l["payload"] as Record<string, unknown>)["action"] as string,
          ),
      );
      assert.ok(inboundLog);
      const payload = inboundLog["payload"] as Record<string, unknown>;
      assert.equal(payload["messageId"], 1700000002);
      assert.equal(payload["senderName"], "Alice");
      assert.equal(payload["textLength"], 8);

      await adapter.stop();
    });

    it("stores raw envelope in InboundMessage", async () => {
      const { adapter, wsMock } = makeAdapter({ mode: "websocket" });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      const msg = makeEnvelope("+15559876543", "raw test", 1700000004);
      await adapter.start();
      wsMock.instances[0]!.simulateMessage(msg);

      assert.equal(received.length, 1);
      assert.deepEqual(received[0]!.raw, msg);

      await adapter.stop();
    });

    it("does not crash if no callback registered", async () => {
      const { adapter, wsMock } = makeAdapter({ mode: "websocket" });

      await adapter.start();
      wsMock.instances[0]!.simulateMessage(makeEnvelope("+15559876543", "orphan", 1700000003));

      await adapter.stop();
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
