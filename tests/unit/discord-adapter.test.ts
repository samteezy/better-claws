import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DiscordAdapter,
  DiscordError,
} from "../../src/adapters/discord/discord-adapter.js";
import type { InboundMessage } from "../../src/types.js";
import { createMockLogger } from "../helpers/mock-logger.js";
import { MockWebSocket } from "../helpers/mock-websocket.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

interface FetchCall {
  url: string;
  body: unknown;
  headers: Record<string, string>;
}

function createMockFetch(
  responses: Array<{ ok: boolean; body?: unknown; status?: number }>,
) {
  let callIndex = 0;
  const calls: FetchCall[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      body: init?.body ? JSON.parse(init.body as string) as unknown : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const resp = responses[callIndex] ?? { ok: true, body: {} };
    callIndex++;
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
  fetchFn: typeof fetch;
  WebSocketCtor: typeof WebSocket;
  logger: ReturnType<typeof createMockLogger>;
}>) {
  MockWebSocket.instances = [];
  const logger = overrides?.logger ?? createMockLogger();
  const adapter = new DiscordAdapter({
    token: overrides?.token ?? "test-discord-token",
    logger,
    fetchFn: overrides?.fetchFn,
    WebSocketCtor: (overrides?.WebSocketCtor ?? MockWebSocket) as unknown as typeof WebSocket,
    gatewayUrl: "wss://mock-gateway/",
  });
  return { adapter, logger };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("DiscordAdapter", () => {
  describe("constructor", () => {
    it("throws DiscordError if token is empty", () => {
      assert.throws(
        () => makeAdapter({ token: "" }),
        (err: unknown) =>
          err instanceof DiscordError && err.code === "MISSING_TOKEN",
      );
    });

    it("creates successfully with valid token", () => {
      const { adapter } = makeAdapter();
      assert.equal(adapter.id, "discord");
      assert.equal(adapter.name, "Discord");
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
      assert.equal(startLog["component"], "discord");
    });

    it("logs stop event", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();
      await adapter.stop();

      const stopLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "stop",
      );
      assert.ok(stopLog);
    });

    it("connects to gateway WebSocket on start", async () => {
      const { adapter } = makeAdapter();
      await adapter.start();

      assert.equal(MockWebSocket.instances.length, 1);
      assert.equal(MockWebSocket.instances[0]!.url, "wss://mock-gateway/");

      await adapter.stop();
    });

    it("closes WebSocket on stop", async () => {
      const { adapter } = makeAdapter();
      await adapter.start();
      await adapter.stop();

      assert.ok(MockWebSocket.instances[0]!.closed);
    });
  });

  describe("send()", () => {
    it("sends message via Discord REST API", async () => {
      const mock = createMockFetch([{ ok: true, body: { id: "123" } }]);
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await adapter.send("channel-1", { channelId: "channel-1", text: "Hello Discord!" });

      assert.equal(mock.calls.length, 1);
      assert.ok(mock.calls[0]!.url.includes("/channels/channel-1/messages"));
      assert.equal((mock.calls[0]!.body as Record<string, unknown>)["content"], "Hello Discord!");
      assert.ok(mock.calls[0]!.headers["Authorization"]?.startsWith("Bot "));
    });

    it("throws DiscordError when API returns error", async () => {
      const mock = createMockFetch([
        { ok: false, body: { message: "Unknown Channel" }, status: 404 },
      ]);
      const { adapter } = makeAdapter({ fetchFn: mock.fn });

      await assert.rejects(
        () => adapter.send("bad", { channelId: "bad", text: "test" }),
        (err: unknown) =>
          err instanceof DiscordError && err.code === "API_ERROR",
      );
    });

    it("throws DiscordError on network failure", async () => {
      const fn = (async () => { throw new Error("Network down"); }) as typeof fetch;
      const { adapter } = makeAdapter({ fetchFn: fn });

      await assert.rejects(
        () => adapter.send("ch", { channelId: "ch", text: "test" }),
        (err: unknown) =>
          err instanceof DiscordError && err.code === "NETWORK_ERROR",
      );
    });
  });

  describe("gateway message handling", () => {
    it("sends IDENTIFY after receiving HELLO", async () => {
      const { adapter } = makeAdapter();
      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      ws.simulateMessage({ op: 10, d: { heartbeat_interval: 45000 } });

      // Should have sent identify
      const identifyMsg = ws.sentMessages.find((m) => {
        const parsed = JSON.parse(m) as Record<string, unknown>;
        return parsed["op"] === 2;
      });
      assert.ok(identifyMsg, "should send IDENTIFY after HELLO");

      const parsed = JSON.parse(identifyMsg!) as Record<string, unknown>;
      const d = parsed["d"] as Record<string, unknown>;
      assert.equal(d["token"], "test-discord-token");

      await adapter.stop();
    });

    it("sends heartbeats on interval", async () => {
      const { adapter } = makeAdapter();
      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      // Send HELLO with very short heartbeat interval
      ws.simulateMessage({ op: 10, d: { heartbeat_interval: 50 } });

      await new Promise((r) => setTimeout(r, 120));
      await adapter.stop();

      const heartbeats = ws.sentMessages.filter((m) => {
        const parsed = JSON.parse(m) as Record<string, unknown>;
        return parsed["op"] === 1;
      });
      assert.ok(heartbeats.length >= 1, "should send at least one heartbeat");
    });

    it("processes MESSAGE_CREATE dispatch and calls callback", async () => {
      const { adapter } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      ws.simulateMessage({
        op: 0, t: "MESSAGE_CREATE", s: 1,
        d: {
          id: "msg-1",
          channel_id: "ch-100",
          author: { id: "user-42", username: "Alice", discriminator: "0001" },
          content: "Hello from Discord!",
          timestamp: "2024-01-01T00:00:00.000Z",
        },
      });

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "Hello from Discord!");
      assert.equal(received[0]!.channelId, "ch-100");
      assert.equal(received[0]!.senderId, "user-42");
      assert.equal(received[0]!.adapterId, "discord");

      await adapter.stop();
    });

    it("skips messages with no content", async () => {
      const { adapter } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));

      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      ws.simulateMessage({
        op: 0, t: "MESSAGE_CREATE", s: 1,
        d: {
          id: "msg-1",
          channel_id: "ch-100",
          author: { id: "user-42", username: "Alice", discriminator: "0001" },
          content: "",
          timestamp: "2024-01-01T00:00:00.000Z",
        },
      });

      assert.equal(received.length, 0);

      await adapter.stop();
    });

    it("handles READY event and logs bot user", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      ws.simulateMessage({
        op: 0, t: "READY", s: 1,
        d: {
          session_id: "sess-123",
          user: { id: "bot-id", username: "BetterClaws", discriminator: "0000" },
        },
      });

      const readyLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "ready",
      );
      assert.ok(readyLog);
      assert.equal((readyLog["payload"] as Record<string, unknown>)["botUser"], "BetterClaws");

      await adapter.stop();
    });

    it("does not crash on malformed gateway messages", async () => {
      const { adapter } = makeAdapter();
      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      ws.onmessage?.({ data: "not json" });
      // Should not throw

      await adapter.stop();
    });

    it("tracks sequence numbers", async () => {
      const { adapter } = makeAdapter();
      await adapter.start();

      const ws = MockWebSocket.instances[0]!;
      // Send HELLO first to start heartbeats
      ws.simulateMessage({ op: 10, d: { heartbeat_interval: 30000 } });
      // Send dispatch with sequence
      ws.simulateMessage({ op: 0, t: "READY", s: 5, d: { session_id: "s", user: { id: "b", username: "b", discriminator: "0" } } });

      // Next heartbeat should include sequence number 5
      ws.simulateMessage({ op: 10, d: { heartbeat_interval: 50 } });
      await new Promise((r) => setTimeout(r, 80));

      const heartbeats = ws.sentMessages.filter((m) => {
        const parsed = JSON.parse(m) as Record<string, unknown>;
        return parsed["op"] === 1;
      });
      assert.ok(heartbeats.length >= 1);
      const lastHeartbeat = JSON.parse(heartbeats[heartbeats.length - 1]!) as Record<string, unknown>;
      assert.equal(lastHeartbeat["d"], 5);

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
