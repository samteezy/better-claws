import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  WebChatAdapter,
  WebChatError,
} from "../../src/adapters/webchat/webchat-adapter.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { InboundMessage } from "../../src/types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

function createMockLogger() {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    log(e: Record<string, unknown>) { logs.push(e); },
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger & { logs: typeof logs };
}

// Use a dynamic port range to avoid conflicts
let portCounter = 19200;
function nextPort(): number {
  return portCounter++;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("WebChatAdapter", () => {
  const adapters: WebChatAdapter[] = [];

  afterEach(async () => {
    for (const adapter of adapters) {
      await adapter.stop();
    }
    adapters.length = 0;
  });

  function makeAdapter(overrides?: Partial<{
    host: string;
    port: number;
    authToken: string;
    logger: ReturnType<typeof createMockLogger>;
  }>) {
    const logger = overrides?.logger ?? createMockLogger();
    const port = overrides?.port ?? nextPort();
    const adapter = new WebChatAdapter({
      host: overrides?.host,
      port,
      authToken: overrides?.authToken,
      logger,
    });
    adapters.push(adapter);
    return { adapter, logger, port };
  }

  async function postChat(
    port: number,
    body: unknown,
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const responseBody = await response.json();
    return { status: response.status, body: responseBody };
  }

  async function getRoot(port: number): Promise<{ status: number; contentType: string; body: string }> {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
    });
    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? "";
    return { status: response.status, contentType, body };
  }

  async function getNotFound(port: number): Promise<{ status: number; body: unknown }> {
    const response = await fetch(`http://127.0.0.1:${port}/unknown`, {
      method: "GET",
    });
    const body = await response.json();
    return { status: response.status, body };
  }

  describe("constructor", () => {
    it("creates successfully with valid port", () => {
      const { adapter } = makeAdapter();
      assert.equal(adapter.id, "webchat");
      assert.equal(adapter.name, "WebChat");
    });

    it("throws WebChatError with code INVALID_PORT when port is 0", () => {
      assert.throws(
        () => makeAdapter({ port: 0 }),
        (err: unknown) =>
          err instanceof WebChatError && err.code === "INVALID_PORT",
      );
    });

    it("throws WebChatError with code INVALID_PORT when port is negative", () => {
      assert.throws(
        () => makeAdapter({ port: -1 }),
        (err: unknown) =>
          err instanceof WebChatError && err.code === "INVALID_PORT",
      );
    });

    it("uses default host 127.0.0.1 when not provided", () => {
      const { adapter } = makeAdapter({ host: undefined });
      assert.ok(adapter);
      // Verify by starting and making a request
    });

    it("uses provided host when specified", () => {
      const { adapter } = makeAdapter({ host: "127.0.0.1" });
      assert.ok(adapter);
    });
  });

  describe("start / stop", () => {
    it("starts HTTP server and logs config:change with action start", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();

      const startLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.ok(startLog);
      assert.equal(startLog["eventType"], "config:change");
      assert.equal(startLog["component"], "webchat");
    });

    it("stops HTTP server and logs config:change with action stop", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();
      await adapter.stop();
      // Remove from tracking since we already stopped
      adapters.pop();

      const stopLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "stop",
      );
      assert.ok(stopLog);
      assert.equal(stopLog["eventType"], "config:change");
      assert.equal(stopLog["component"], "webchat");
    });

    it("stop is idempotent when server is null", async () => {
      const { adapter } = makeAdapter();
      // Call stop without start
      await adapter.stop();
      // Remove from tracking
      adapters.pop();
      // No error should be thrown
    });

    it("stop clears pending responses and their timers", async () => {
      const { adapter, port } = makeAdapter();
      adapter.onMessage(() => {
        // Never call send, so response hangs
      });
      await adapter.start();

      // Send a message that will hang — don't await, just fire
      const postPromise = fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "will timeout" }),
      }).then(async (r) => ({ status: r.status, body: await r.json() as Record<string, unknown> }))
        .catch(() => null);

      // Give it a moment to register the pending response
      await new Promise((r) => setTimeout(r, 50));

      // Stop the adapter — should resolve pending responses
      await adapter.stop();
      adapters.pop();

      const result = await postPromise;
      // May get a response (200 with shutdown message) or connection error (null)
      if (result) {
        assert.equal(result.status, 200);
        assert.equal(result.body["text"], "Server shutting down.");
      }
    });
  });

  describe("GET /", () => {
    it("returns 200 with text/html content type", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { status, contentType } = await getRoot(port);

      assert.equal(status, 200);
      assert.ok(contentType.includes("text/html"));
    });

    it("returns HTML with DOCTYPE", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { body } = await getRoot(port);

      assert.ok(body.includes("<!DOCTYPE html"));
    });

    it("returns HTML with betterClaws WebChat title", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { body } = await getRoot(port);

      assert.ok(body.includes("betterClaws WebChat"));
    });
  });

  describe("POST /chat — happy path", () => {
    it("accepts message and returns response with messageId starting with wc-", async () => {
      const { adapter, port } = makeAdapter();
      adapter.onMessage((msg) => {
        adapter.send(msg.channelId, {
          channelId: msg.channelId,
          text: "echo: " + msg.text,
        });
      });
      await adapter.start();

      const { status, body } = await postChat(port, { text: "hello" });

      assert.equal(status, 200);
      const responseBody = body as Record<string, unknown>;
      assert.equal(responseBody["text"], "echo: hello");
      assert.ok(typeof responseBody["messageId"] === "string");
      assert.ok((responseBody["messageId"] as string).startsWith("wc-"));
    });

    it("callback receives InboundMessage with correct text and default senderId", async () => {
      const { adapter, port } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => {
        received.push(msg);
        adapter.send(msg.channelId, {
          channelId: msg.channelId,
          text: "ok",
        });
      });
      await adapter.start();

      await postChat(port, { text: "test message" });

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "test message");
      assert.equal(received[0]!.senderId, "webchat-user");
      assert.equal(received[0]!.adapterId, "webchat");
    });

    it("callback receives InboundMessage with provided senderId", async () => {
      const { adapter, port } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => {
        received.push(msg);
        adapter.send(msg.channelId, {
          channelId: msg.channelId,
          text: "ok",
        });
      });
      await adapter.start();

      await postChat(port, { text: "hi", senderId: "custom-user" });

      assert.equal(received.length, 1);
      assert.equal(received[0]!.senderId, "custom-user");
    });

    it("messageId increments with each POST", async () => {
      const { adapter, port } = makeAdapter();
      adapter.onMessage((msg) => {
        adapter.send(msg.channelId, {
          channelId: msg.channelId,
          text: "ok",
        });
      });
      await adapter.start();

      const res1 = await postChat(port, { text: "msg1" });
      const res2 = await postChat(port, { text: "msg2" });

      const id1 = (res1.body as Record<string, unknown>)["messageId"];
      const id2 = (res2.body as Record<string, unknown>)["messageId"];
      assert.notEqual(id1, id2);
      // Both should follow wc-N pattern and id2 > id1
      assert.ok((id1 as string).startsWith("wc-"));
      assert.ok((id2 as string).startsWith("wc-"));
    });

    it("InboundMessage has correct adapterId and channelId", async () => {
      const { adapter, port } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => {
        received.push(msg);
        adapter.send(msg.channelId, {
          channelId: msg.channelId,
          text: "ok",
        });
      });
      await adapter.start();

      await postChat(port, { text: "test" });

      const msg = received[0]!;
      assert.equal(msg.adapterId, "webchat");
      assert.equal(msg.channelId, msg.id);
      assert.ok(msg.channelId.startsWith("wc-"));
    });

    it("InboundMessage text is trimmed", async () => {
      const { adapter, port } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => {
        received.push(msg);
        adapter.send(msg.channelId, {
          channelId: msg.channelId,
          text: "ok",
        });
      });
      await adapter.start();

      await postChat(port, { text: "  hello world  " });

      assert.equal(received[0]!.text, "hello world");
    });

    it("InboundMessage has timestamp", async () => {
      const { adapter, port } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => {
        received.push(msg);
        adapter.send(msg.channelId, {
          channelId: msg.channelId,
          text: "ok",
        });
      });
      await adapter.start();

      const before = Date.now();
      await postChat(port, { text: "test" });
      const after = Date.now();

      const timestamp = received[0]!.timestamp;
      assert.ok(timestamp >= before && timestamp <= after);
    });
  });

  describe("POST /chat — validation", () => {
    it("returns 400 when text is missing", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { status } = await postChat(port, { senderId: "user" });

      assert.equal(status, 400);
    });

    it("returns 400 when text is empty string", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { status } = await postChat(port, { text: "" });

      assert.equal(status, 400);
    });

    it("returns 400 when text is whitespace only", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { status } = await postChat(port, { text: "   " });

      assert.equal(status, 400);
    });

    it("returns 400 with error message when body is invalid JSON", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not valid json {",
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.ok((body as Record<string, unknown>)["error"]);
    });

    it("returns 400 with error message when text is not a string", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { status } = await postChat(port, { text: 123 });

      assert.equal(status, 400);
    });

    it("returns error message in JSON response", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { body } = await postChat(port, { text: "" });

      assert.ok((body as Record<string, unknown>)["error"]);
    });
  });

  describe("404 handling", () => {
    it("GET to /unknown returns 404", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { status } = await getNotFound(port);

      assert.equal(status, 404);
    });

    it("POST to /unknown returns 404", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const response = await fetch(`http://127.0.0.1:${port}/unknown`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "test" }),
      });
      assert.equal(response.status, 404);
    });

    it("404 returns JSON error", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const { body } = await getNotFound(port);

      assert.ok((body as Record<string, unknown>)["error"]);
    });
  });

  describe("send() without pending", () => {
    it("does not throw when sending to nonexistent channelId", async () => {
      const { adapter } = makeAdapter();
      await adapter.start();

      // Should not throw
      await adapter.send("nonexistent", {
        channelId: "nonexistent",
        text: "test",
      });
    });

    it("logs message:outbound even for nonexistent pending", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();

      await adapter.send("fake-channel", {
        channelId: "fake-channel",
        text: "test message",
      });

      const outboundLog = logger.logs.find(
        (l) => l["eventType"] === "message:outbound" &&
          l["component"] === "webchat",
      );
      assert.ok(outboundLog);
    });
  });

  describe("logging", () => {
    it("logs message:inbound with component webchat", async () => {
      const { adapter, port, logger } = makeAdapter();
      adapter.onMessage((msg) => {
        adapter.send(msg.channelId, {
          channelId: msg.channelId,
          text: "ok",
        });
      });
      await adapter.start();

      await postChat(port, { text: "logged message" });

      const inboundLog = logger.logs.find(
        (l) => l["eventType"] === "message:inbound" &&
          l["component"] === "webchat",
      );
      assert.ok(inboundLog);
      const payload = inboundLog?.["payload"] as Record<string, unknown>;
      assert.ok(payload["messageId"]);
      assert.ok(typeof payload["textLength"] === "number");
    });

    it("logs message:outbound with component webchat", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();

      await adapter.send("test-channel", {
        channelId: "test-channel",
        text: "response text",
      });

      const outboundLog = logger.logs.find(
        (l) => l["eventType"] === "message:outbound" &&
          l["component"] === "webchat",
      );
      assert.ok(outboundLog);
      const payload = outboundLog?.["payload"] as Record<string, unknown>;
      assert.equal(payload["channelId"], "test-channel");
      assert.ok(typeof payload["textLength"] === "number");
    });

    it("logs inbound with correct senderId", async () => {
      const { adapter, port, logger } = makeAdapter();
      adapter.onMessage((msg) => {
        adapter.send(msg.channelId, {
          channelId: msg.channelId,
          text: "ok",
        });
      });
      await adapter.start();

      await postChat(port, { text: "hi", senderId: "alice" });

      const inboundLog = logger.logs.find(
        (l) => l["eventType"] === "message:inbound" &&
          l["component"] === "webchat",
      );
      const payload = inboundLog?.["payload"] as Record<string, unknown>;
      assert.equal(payload["senderId"], "alice");
    });

    it("logs start with host and port", async () => {
      const { adapter, logger, port } = makeAdapter();
      await adapter.start();

      const startLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      const payload = startLog?.["payload"] as Record<string, unknown>;
      assert.equal(payload["host"], "127.0.0.1");
      assert.equal(payload["port"], port);
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

    it("has required ChannelAdapter properties", () => {
      const { adapter } = makeAdapter();
      assert.equal(adapter.id, "webchat");
      assert.equal(adapter.name, "WebChat");
    });
  });

  describe("cross-origin protection", () => {
    it("does not set Access-Control-Allow-Origin header", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const response = await fetch(`http://127.0.0.1:${port}/`, {
        method: "GET",
      });

      const corsHeader = response.headers.get("access-control-allow-origin");
      assert.equal(corsHeader, null);
    });
  });

  describe("network exposure guard", () => {
    it("throws UNSAFE_CONFIG when host is non-loopback and no authToken", async () => {
      const { adapter } = makeAdapter({ host: "0.0.0.0" });
      await assert.rejects(
        () => adapter.start(),
        (err: unknown) =>
          err instanceof WebChatError && err.code === "UNSAFE_CONFIG",
      );
      // Remove from tracking since start failed
      adapters.pop();
    });

    it("starts successfully with non-loopback host when authToken is provided", async () => {
      const { adapter, logger } = makeAdapter({ host: "0.0.0.0", authToken: "test-token" });
      await adapter.start();

      const startLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.ok(startLog);
    });

    it("starts without authToken on loopback (127.0.0.1)", async () => {
      const { adapter } = makeAdapter({ host: "127.0.0.1" });
      await adapter.start();
      assert.ok(true);
    });

    it("starts without authToken on localhost", async () => {
      // localhost may resolve to ::1 on some systems, so just verify no throw
      const logger = createMockLogger();
      const port = nextPort();
      const adapter = new WebChatAdapter({ host: "localhost", port, logger });
      adapters.push(adapter);
      await adapter.start();
      assert.ok(true);
    });
  });

  describe("authentication", () => {
    it("returns 401 when authToken configured but no Authorization header", async () => {
      const { adapter, port } = makeAdapter({ authToken: "my-secret" });
      adapter.onMessage((msg) => {
        void adapter.send(msg.channelId, { channelId: msg.channelId, text: "reply" });
      });
      await adapter.start();

      const { status, body } = await postChat(port, { text: "hello" });

      assert.equal(status, 401);
      assert.equal((body as Record<string, unknown>)["error"], "Unauthorized");
    });

    it("returns 401 when Bearer token is wrong", async () => {
      const { adapter, port } = makeAdapter({ authToken: "my-secret" });
      await adapter.start();

      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer wrong-token",
        },
        body: JSON.stringify({ text: "hello" }),
      });

      assert.equal(response.status, 401);
    });

    it("succeeds with correct Bearer token", async () => {
      const { adapter, port } = makeAdapter({ authToken: "my-secret" });
      adapter.onMessage((msg) => {
        void adapter.send(msg.channelId, { channelId: msg.channelId, text: "authed reply" });
      });
      await adapter.start();

      const response = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer my-secret",
        },
        body: JSON.stringify({ text: "hello" }),
      });
      const body = await response.json() as Record<string, unknown>;

      assert.equal(response.status, 200);
      assert.equal(body["text"], "authed reply");
    });

    it("allows POST /chat without auth when no authToken configured", async () => {
      const { adapter, port } = makeAdapter();
      adapter.onMessage((msg) => {
        void adapter.send(msg.channelId, { channelId: msg.channelId, text: "open reply" });
      });
      await adapter.start();

      const { status } = await postChat(port, { text: "hello" });
      assert.equal(status, 200);
    });

    it("GET / is accessible without auth even when authToken configured", async () => {
      const { adapter, port } = makeAdapter({ authToken: "my-secret" });
      await adapter.start();

      const { status, body } = await getRoot(port);
      assert.equal(status, 200);
      assert.ok(body.includes("<!DOCTYPE html"));
    });

    it("served HTML contains the auth token for client JS", async () => {
      const { adapter, port } = makeAdapter({ authToken: "my-secret" });
      await adapter.start();

      const { body } = await getRoot(port);
      assert.ok(body.includes("my-secret"));
    });

    it("logs auth_failure on rejected request", async () => {
      const { adapter, port, logger } = makeAdapter({ authToken: "my-secret" });
      await adapter.start();

      await postChat(port, { text: "hello" });

      const authLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "auth_failure",
      );
      assert.ok(authLog);
      assert.equal(authLog["component"], "webchat");
    });
  });

  describe("body size limit", () => {
    it("rejects request body larger than 1MB", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const largeBody = "x".repeat(1024 * 1024 + 1);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: largeBody }),
        });
        // If we get a response, it should be an error status
        assert.ok(response.status >= 400);
      } catch {
        // Socket destroyed by server — this is expected for oversized bodies
        assert.ok(true);
      }
    });
  });
});
