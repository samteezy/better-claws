import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  WebhookAdapter,
  WebhookError,
} from "../../src/adapters/webhook/webhook-adapter.js";
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

function sign(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// Use a dynamic port range to avoid conflicts
let portCounter = 19100;
function nextPort(): number {
  return portCounter++;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("WebhookAdapter", () => {
  const adapters: WebhookAdapter[] = [];

  afterEach(async () => {
    for (const adapter of adapters) {
      await adapter.stop();
    }
    adapters.length = 0;
  });

  function makeAdapter(overrides?: Partial<{
    secret: string;
    port: number;
    path: string;
    logger: ReturnType<typeof createMockLogger>;
  }>) {
    const logger = overrides?.logger ?? createMockLogger();
    const port = overrides?.port ?? nextPort();
    const adapter = new WebhookAdapter({
      secret: overrides?.secret ?? "test-secret",
      port,
      logger,
      path: overrides?.path,
    });
    adapters.push(adapter);
    return { adapter, logger, port };
  }

  async function postWebhook(
    port: number,
    body: unknown,
    secret: string,
    options?: { path?: string; skipSignature?: boolean; badSignature?: boolean },
  ): Promise<{ status: number; body: unknown }> {
    const jsonBody = JSON.stringify(body);
    const path = options?.path ?? "/webhook";
    const url = `http://127.0.0.1:${port}${path}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (!options?.skipSignature) {
      headers["X-Webhook-Signature"] = options?.badSignature
        ? "sha256=0000000000000000000000000000000000000000000000000000000000000000"
        : sign(jsonBody, secret);
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: jsonBody,
    });

    const responseBody = await response.json();
    return { status: response.status, body: responseBody };
  }

  describe("constructor", () => {
    it("throws WebhookError if secret is empty", () => {
      assert.throws(
        () => makeAdapter({ secret: "" }),
        (err: unknown) =>
          err instanceof WebhookError && err.code === "MISSING_SECRET",
      );
    });

    it("creates successfully with valid secret", () => {
      const { adapter } = makeAdapter();
      assert.equal(adapter.id, "webhook");
      assert.equal(adapter.name, "Webhook");
    });
  });

  describe("start / stop", () => {
    it("starts HTTP server and logs", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();

      const startLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.ok(startLog);
      assert.equal(startLog["component"], "webhook");
    });

    it("stops HTTP server and logs", async () => {
      const { adapter, logger } = makeAdapter();
      await adapter.start();
      await adapter.stop();
      // Remove from tracking since we already stopped
      adapters.pop();

      const stopLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "stop",
      );
      assert.ok(stopLog);
    });
  });

  describe("webhook POST handling", () => {
    it("accepts valid signed request and calls callback", async () => {
      const { adapter, port } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));
      await adapter.start();

      const result = await postWebhook(port, {
        channelId: "ch-1",
        senderId: "user-1",
        text: "Hello webhook!",
      }, "test-secret");

      assert.equal(result.status, 200);
      assert.equal((result.body as Record<string, unknown>)["ok"], true);

      // Give callback a moment to fire
      await new Promise((r) => setTimeout(r, 20));

      assert.equal(received.length, 1);
      assert.equal(received[0]!.text, "Hello webhook!");
      assert.equal(received[0]!.channelId, "ch-1");
      assert.equal(received[0]!.senderId, "user-1");
      assert.equal(received[0]!.adapterId, "webhook");
    });

    it("rejects request with missing signature", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const result = await postWebhook(port, {
        channelId: "ch", senderId: "u", text: "test",
      }, "test-secret", { skipSignature: true });

      assert.equal(result.status, 401);
    });

    it("rejects request with invalid signature", async () => {
      const { adapter, port, logger } = makeAdapter();
      await adapter.start();

      const result = await postWebhook(port, {
        channelId: "ch", senderId: "u", text: "test",
      }, "test-secret", { badSignature: true });

      assert.equal(result.status, 401);

      const sigLog = logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "signature_invalid",
      );
      assert.ok(sigLog);
    });

    it("rejects request to wrong path", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const result = await postWebhook(port, {
        channelId: "ch", senderId: "u", text: "test",
      }, "test-secret", { path: "/wrong" });

      assert.equal(result.status, 404);
    });

    it("rejects request with missing required fields", async () => {
      const { adapter, port } = makeAdapter();
      await adapter.start();

      const result = await postWebhook(port, {
        channelId: "ch-1",
        // missing senderId and text
      }, "test-secret");

      assert.equal(result.status, 400);
    });

    it("uses custom path when configured", async () => {
      const { adapter, port } = makeAdapter({ path: "/custom/hook" });
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));
      await adapter.start();

      const result = await postWebhook(port, {
        channelId: "ch-1", senderId: "u-1", text: "custom path",
      }, "test-secret", { path: "/custom/hook" });

      assert.equal(result.status, 200);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(received.length, 1);
    });

    it("uses provided messageId and timestamp", async () => {
      const { adapter, port } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));
      await adapter.start();

      await postWebhook(port, {
        channelId: "ch-1",
        senderId: "u-1",
        text: "with metadata",
        messageId: "custom-id",
        timestamp: 1700000000000,
      }, "test-secret");

      await new Promise((r) => setTimeout(r, 20));

      assert.equal(received[0]!.id, "custom-id");
      assert.equal(received[0]!.timestamp, 1700000000000);
    });

    it("auto-generates messageId when not provided", async () => {
      const { adapter, port } = makeAdapter();
      const received: InboundMessage[] = [];
      adapter.onMessage((msg) => received.push(msg));
      await adapter.start();

      await postWebhook(port, {
        channelId: "ch-1", senderId: "u-1", text: "auto id",
      }, "test-secret");

      await new Promise((r) => setTimeout(r, 20));

      assert.ok(received[0]!.id.startsWith("wh-"));
    });

    it("logs inbound message", async () => {
      const { adapter, port, logger } = makeAdapter();
      adapter.onMessage(() => {});
      await adapter.start();

      await postWebhook(port, {
        channelId: "ch-1", senderId: "u-1", text: "logged",
      }, "test-secret");

      await new Promise((r) => setTimeout(r, 20));

      const inboundLog = logger.logs.find(
        (l) => l["eventType"] === "message:inbound" &&
          l["component"] === "webhook" &&
          (l["payload"] as Record<string, unknown>)["senderId"] === "u-1",
      );
      assert.ok(inboundLog);
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
