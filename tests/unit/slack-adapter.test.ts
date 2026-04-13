import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SlackAdapter,
  SlackError,
} from "../../src/adapters/slack/slack-adapter.js";
import type { InboundMessage } from "../../src/types.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { MockWebSocket } from "../helpers/mock-websocket.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  body: unknown;
}

function createMockFetch(
  handler: (url: string, body: unknown) => { ok: boolean; body?: unknown; status?: number },
) {
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let parsedBody: unknown = null;
    if (init?.body) {
      try {
        parsedBody = JSON.parse(init.body as string) as unknown;
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, body: parsedBody });

    const resp = handler(url, parsedBody);
    return {
      ok: resp.ok,
      status: resp.status ?? (resp.ok ? 200 : 400),
      json: async () => resp.body ?? {},
      text: async () => JSON.stringify(resp.body ?? {}),
    } as Response;
  };
  return { fn: fn as typeof fetch, calls };
}

function makeAdapter(overrides?: Partial<{
  token: string;
  appToken: string;
  fetchFn: typeof fetch;
  WebSocketCtor: typeof WebSocket;
  logger: ReturnType<typeof createMockLogger>;
}>) {
  MockWebSocket.instances = [];
  const logger = overrides?.logger ?? createMockLogger();

  const defaultFetch = createMockFetch((url) => {
    if (url.includes("auth.test")) {
      return { ok: true, body: { ok: true, user_id: "BOT123" } };
    }
    if (url.includes("connections.open")) {
      return { ok: true, body: { ok: true, url: "wss://mock-slack-ws/" } };
    }
    if (url.includes("chat.postMessage")) {
      return { ok: true, body: { ok: true } };
    }
    return { ok: true, body: { ok: true } };
  });

  const adapter = new SlackAdapter({
    token: overrides?.token ?? "xoxb-test-token",
    appToken: overrides?.appToken ?? "xapp-test-token",
    logger,
    fetchFn: overrides?.fetchFn ?? defaultFetch.fn,
    WebSocketCtor: (overrides?.WebSocketCtor ?? MockWebSocket) as unknown as typeof WebSocket,
  });
  return { adapter, logger, defaultFetchCalls: defaultFetch.calls };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("SlackAdapter", () => {
  describe("constructor", () => {
    it("throws SlackError if token is empty", () => {
      assert.throws(
        () => makeAdapter({ token: "" }),
        (err: unknown) =>
          err instanceof SlackError && err.code === "MISSING_TOKEN",
      );
    });

    it("throws SlackError if appToken is empty", () => {
      assert.throws(
        () => makeAdapter({ appToken: "" }),
        (err: unknown) =>
          err instanceof SlackError && err.code === "MISSING_APP_TOKEN",
      );
    });

    it("creates successfully with valid tokens", () => {
      const { adapter } = makeAdapter();
      assert.equal(adapter.id, "slack");
      assert.equal(adapter.name, "Slack");
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
      assert.ok(startLog);
      assert.equal(startLog["component"], "slack");
    });

    it("fetches bot user ID and opens Socket Mode on start", async () => {
      const { adapter, defaultFetchCalls } = makeAdapter();
      await adapter.start();
      await adapter.stop();

      const authCall = defaultFetchCalls.find((c) => c.url.includes("auth.test"));
      assert.ok(authCall, "should call auth.test");

      const connCall = defaultFetchCalls.find((c) => c.url.includes("connections.open"));
      assert.ok(connCall, "should call apps.connections.open");

      assert.equal(MockWebSocket.instances.length, 1);
      assert.equal(MockWebSocket.instances[0]!.url, "wss://mock-slack-ws/");
    });

    it("closes WebSocket on stop", async () => {
      const { adapter } = makeAdapter();
      await adapter.start();
      await adapter.stop();

      assert.ok(MockWebSocket.instances[0]!.closed);
    });
  });

  describe("send()", () => {
    it("sends message via chat.postMessage", async () => {
      const mock = createMockFetch((url) => {
        if (url.includes("auth.test")) return { ok: true, body: { ok: true, user_id: "BOT" } };
        if (url.includes("connections.open")) return { ok: true, body: { ok: true, url: "wss://x/" } };
        if (url.includes("chat.postMessage")) return { ok: true, body: { ok: true } };
        return { ok: true, body: { ok: true } };
      });
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await adapter.send("C123", { channelId: "C123", text: "Hello Slack!" });

      const postCall = mock.calls.find((c) => c.url.includes("chat.postMessage"));
      assert.ok(postCall);
      const body = postCall.body as Record<string, unknown>;
      assert.equal(body["channel"], "C123");
      assert.equal(body["text"], "Hello Slack!");
    });

    it("throws SlackError when API returns ok: false", async () => {
      const mock = createMockFetch((url) => {
        if (url.includes("auth.test")) return { ok: true, body: { ok: true, user_id: "BOT" } };
        if (url.includes("connections.open")) return { ok: true, body: { ok: true, url: "wss://x/" } };
        if (url.includes("chat.postMessage")) return { ok: true, body: { ok: false, error: "channel_not_found" } };
        return { ok: true, body: { ok: true } };
      });
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await assert.rejects(
        () => adapter.send("bad", { channelId: "bad", text: "test" }),
        (err: unknown) =>
          err instanceof SlackError && err.code === "API_ERROR",
      );
    });

    it("throws SlackError on network failure", async () => {
      const fn = (async () => { throw new Error("Network down"); }) as typeof fetch;
      const logger = createMockLogger();
      // Can't use makeAdapter here since start() would also fail
      const adapter = new SlackAdapter({
        token: "xoxb-test",
        appToken: "xapp-test",
        logger,
        fetchFn: fn,
        WebSocketCtor: MockWebSocket as unknown as typeof WebSocket,
      });

      await assert.rejects(
        () => adapter.send("ch", { channelId: "ch", text: "test" }),
        (err: unknown) =>
          err instanceof SlackError && err.code === "NETWORK_ERROR",
      );
    });
  });

  describe("Socket Mode message handling", () => {
    it("processes message events and calls callback", async () => {
      const { adapter } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      ws.simulateMessage({
        type: "events_api",
        envelope_id: "env-1",
        payload: {
          event: {
            type: "message",
            channel: "C123",
            user: "U456",
            text: "Hello from Slack!",
            ts: "1700000000.000000",
            event_ts: "1700000000.000001",
          },
        },
      });

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "Hello from Slack!");
      assert.equal(received[0]!.channelId, "C123");
      assert.equal(received[0]!.senderId, "U456");
      assert.equal(received[0]!.adapterId, "slack");

      await adapter.stop();
    });

    it("acknowledges envelope immediately", async () => {
      const { adapter } = makeAdapter();
      adapter.onMessage(() => {});
      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      ws.simulateMessage({
        type: "events_api",
        envelope_id: "env-42",
        payload: {
          event: {
            type: "message",
            channel: "C1",
            user: "U1",
            text: "test",
            ts: "1",
            event_ts: "1",
          },
        },
      });

      const ack = ws.sentMessages.find((m) => {
        const parsed = JSON.parse(m) as Record<string, unknown>;
        return parsed["envelope_id"] === "env-42";
      });
      assert.ok(ack, "should acknowledge envelope");

      await adapter.stop();
    });

    it("skips messages with subtypes", async () => {
      const { adapter } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      ws.simulateMessage({
        type: "events_api",
        envelope_id: "env-2",
        payload: {
          event: {
            type: "message",
            subtype: "message_changed",
            channel: "C1",
            user: "U1",
            text: "edited",
            ts: "1",
            event_ts: "1",
          },
        },
      });

      assert.equal(received.length, 0);

      await adapter.stop();
    });

    it("skips bot's own messages", async () => {
      const { adapter } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      // BOT123 is the mocked bot user ID
      ws.simulateMessage({
        type: "events_api",
        envelope_id: "env-3",
        payload: {
          event: {
            type: "message",
            channel: "C1",
            user: "BOT123",
            text: "I said this",
            ts: "1",
            event_ts: "1",
          },
        },
      });

      assert.equal(received.length, 0);

      await adapter.stop();
    });

    it("does not crash on malformed socket messages", async () => {
      const { adapter } = makeAdapter();
      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      ws.onmessage?.({ data: "not json at all" });
      // Should not throw

      await adapter.stop();
    });
  });

  describe("interface compliance", () => {
    it("implements all ChannelAdapter methods", () => {
      const { adapter } = makeAdapter();
      assert.equal(typeof adapter.start, "function");
      assert.equal(typeof adapter.stop, "function");
      assert.equal(typeof adapter.onMessage, "function");
      assert.equal(typeof adapter.send, "function");
    });
  });
});
