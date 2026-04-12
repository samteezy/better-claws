import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ConfirmationBroker } from "../../src/router/confirmation-broker.js";
import type { ChannelAdapter, ToolCall } from "../../src/types.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

function createMockLogger() {
  const calls: Array<{
    sessionId: string | null;
    eventType: string;
    component: string;
    payload: Record<string, unknown>;
  }> = [];
  return {
    calls,
    log(entry: {
      sessionId: string | null;
      eventType: string;
      component: string;
      payload: Record<string, unknown>;
    }): void {
      calls.push(entry);
    },
    async flush(): Promise<void> {},
    async close(): Promise<void> {},
  } as unknown as StructuredLogger & { calls: typeof calls };
}

function createMockAdapter() {
  const sent: Array<{ channelId: string; text: string }> = [];
  return {
    sent,
    id: "test-adapter",
    name: "test",
    async start() {},
    async stop() {},
    onMessage() {},
    async send(channelId: string, msg: { text: string }) {
      sent.push({ channelId, text: msg.text });
    },
  } as unknown as ChannelAdapter & { sent: typeof sent };
}

function createToolCall(name = "file-write"): ToolCall {
  return {
    id: "tc-1",
    type: "function",
    function: {
      name,
      arguments: '{"path":"/tmp/test.txt","content":"hello"}',
    },
  };
}

const KEY = "adp-1:ch-1:usr-1";

/** Let the microtask queue flush so awaits inside requestAndWait complete. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("ConfirmationBroker", () => {
  let broker: ConfirmationBroker;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    logger = createMockLogger();
    broker = new ConfirmationBroker(logger, 200);
  });

  // ── requestAndWait ──────────────────────────────────────────────────────

  describe("requestAndWait", () => {
    it("sends confirmation prompt via adapter", async () => {
      const adapter = createMockAdapter();
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "file-write", createToolCall());

      await tick();
      assert.equal(adapter.sent.length, 1);
      assert.equal(adapter.sent[0]!.channelId, "ch-1");
      assert.ok(adapter.sent[0]!.text.includes("file-write"));
      assert.ok(adapter.sent[0]!.text.includes("confirmation"));

      broker.resolve(KEY, "yes");
      await promise;
    });

    it("formats prompt with tool parameters", async () => {
      const adapter = createMockAdapter();
      const tc: ToolCall = {
        id: "tc-2",
        type: "function",
        function: { name: "shell", arguments: '{"command":"ls -la"}' },
      };
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "shell", tc);

      await tick();
      assert.ok(adapter.sent[0]!.text.includes("shell"));
      assert.ok(adapter.sent[0]!.text.includes("command"));
      assert.ok(adapter.sent[0]!.text.includes("ls -la"));

      broker.resolve(KEY, "no");
      await promise;
    });

    it("formats prompt gracefully when arguments are not valid JSON", async () => {
      const adapter = createMockAdapter();
      const tc: ToolCall = {
        id: "tc-3",
        type: "function",
        function: { name: "test-tool", arguments: "not valid json" },
      };
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "test-tool", tc);

      await tick();
      assert.ok(adapter.sent[0]!.text.includes("test-tool"));
      assert.ok(adapter.sent[0]!.text.includes("not valid json"));

      broker.resolve(KEY, "yes");
      await promise;
    });

    it("logs confirmation:request event", async () => {
      const adapter = createMockAdapter();
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "file-write", createToolCall());

      await tick();
      const reqLog = logger.calls.find((c) => c.eventType === "confirmation:request");
      assert.ok(reqLog);
      assert.equal(reqLog!.component, "confirmation");
      assert.equal(reqLog!.payload["tool"], "file-write");

      broker.resolve(KEY, "yes");
      await promise;
    });

    it("logs confirmation:result event on resolution", async () => {
      const adapter = createMockAdapter();
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "file-write", createToolCall());

      await tick();
      broker.resolve(KEY, "yes");
      await promise;

      const resLog = logger.calls.find((c) => c.eventType === "confirmation:result");
      assert.ok(resLog);
      assert.equal(resLog!.payload["verdict"], "allow");
      assert.equal(resLog!.payload["reason"], "user approved");
      assert.equal(typeof resLog!.payload["durationMs"], "number");
    });
  });

  // ── Reply parsing ───────────────────────────────────────────────────────

  describe("resolve — verdict parsing", () => {
    async function assertVerdict(reply: string, expectedVerdict: string): Promise<void> {
      const adapter = createMockAdapter();
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall());
      await tick();
      broker.resolve(KEY, reply);
      const result = await promise;
      assert.equal(result.verdict, expectedVerdict, `"${reply}" should produce "${expectedVerdict}"`);
    }

    it('"yes" → allow', () => assertVerdict("yes", "allow"));
    it('"YES" → allow (case-insensitive)', () => assertVerdict("YES", "allow"));
    it('"y" → allow', () => assertVerdict("y", "allow"));
    it('"Y" → allow', () => assertVerdict("Y", "allow"));
    it('"  yes  " → allow (whitespace trimmed)', () => assertVerdict("  yes  ", "allow"));

    it('"yes always" → allow-session', () => assertVerdict("yes always", "allow-session"));
    it('"YES ALWAYS" → allow-session', () => assertVerdict("YES ALWAYS", "allow-session"));
    it('"always" → allow-session', () => assertVerdict("always", "allow-session"));
    it('"ALWAYS" → allow-session', () => assertVerdict("ALWAYS", "allow-session"));

    it('"no" → deny', () => assertVerdict("no", "deny"));
    it('"NO" → deny', () => assertVerdict("NO", "deny"));
    it('"maybe later" → deny', () => assertVerdict("maybe later", "deny"));
    it('"" → deny', () => assertVerdict("", "deny"));

    it("returns true on successful resolve", async () => {
      const adapter = createMockAdapter();
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall());
      await tick();
      assert.equal(broker.resolve(KEY, "yes"), true);
      await promise;
    });

    it("returns false for unknown key", () => {
      assert.equal(broker.resolve("bogus:key:here", "yes"), false);
    });
  });

  // ── Timeout ─────────────────────────────────────────────────────────────

  describe("timeout", () => {
    it("auto-denies on timeout", async () => {
      const shortBroker = new ConfirmationBroker(logger, 50);
      const adapter = createMockAdapter();
      const result = await shortBroker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall());

      assert.equal(result.verdict, "deny");
      assert.equal(result.reason, "timeout");
    });

    it("logs timeout as confirmation:result", async () => {
      const shortBroker = new ConfirmationBroker(logger, 50);
      const adapter = createMockAdapter();
      await shortBroker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall());

      const resLog = logger.calls.find((c) => c.eventType === "confirmation:result");
      assert.ok(resLog);
      assert.equal(resLog!.payload["reason"], "timeout");
    });

    it("resolve returns false after timeout fires", async () => {
      const shortBroker = new ConfirmationBroker(logger, 50);
      const adapter = createMockAdapter();
      await shortBroker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall());

      assert.equal(shortBroker.resolve(KEY, "yes"), false);
    });
  });

  // ── Abort signal ────────────────────────────────────────────────────────

  describe("abort signal", () => {
    it("denies on abort", async () => {
      const adapter = createMockAdapter();
      const controller = new AbortController();
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall(), controller.signal);

      await tick();
      controller.abort();
      const result = await promise;

      assert.equal(result.verdict, "deny");
      assert.equal(result.reason, "aborted");
    });

    it("denies immediately on pre-aborted signal", async () => {
      const adapter = createMockAdapter();
      const controller = new AbortController();
      controller.abort();

      const result = await broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall(), controller.signal);
      assert.equal(result.verdict, "deny");
      assert.equal(result.reason, "aborted");
    });

    it("does not fire abort listener after already resolved", async () => {
      const adapter = createMockAdapter();
      const controller = new AbortController();
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall(), controller.signal);

      await tick();
      broker.resolve(KEY, "yes");
      const result = await promise;
      assert.equal(result.verdict, "allow");

      // Abort after resolution — should not throw or affect state
      controller.abort();
    });
  });

  // ── hasPending ──────────────────────────────────────────────────────────

  describe("hasPending", () => {
    it("returns true while waiting", async () => {
      const adapter = createMockAdapter();
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall());
      await tick();

      assert.equal(broker.hasPending(KEY), true);

      broker.resolve(KEY, "yes");
      await promise;
    });

    it("returns false after resolve", async () => {
      const adapter = createMockAdapter();
      const promise = broker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall());
      await tick();

      broker.resolve(KEY, "yes");
      await promise;
      assert.equal(broker.hasPending(KEY), false);
    });

    it("returns false after timeout", async () => {
      const shortBroker = new ConfirmationBroker(logger, 50);
      const adapter = createMockAdapter();
      await shortBroker.requestAndWait(adapter, "ch-1", "usr-1", "adp-1", "tool", createToolCall());

      assert.equal(shortBroker.hasPending(KEY), false);
    });

    it("returns false for non-existent key", () => {
      assert.equal(broker.hasPending("bogus:key:here"), false);
    });
  });

  // ── cancelAll ───────────────────────────────────────────────────────────

  describe("cancelAll", () => {
    it("cancels all pending confirmations", async () => {
      const a1 = createMockAdapter();
      const a2 = createMockAdapter();
      const tc = createToolCall();

      const p1 = broker.requestAndWait(a1, "ch-1", "usr-1", "adp-1", "tool", tc);
      const p2 = broker.requestAndWait(a2, "ch-2", "usr-2", "adp-2", "tool", tc);
      await tick();

      broker.cancelAll();

      const r1 = await p1;
      const r2 = await p2;
      assert.equal(r1.verdict, "deny");
      assert.equal(r1.reason, "cancelled");
      assert.equal(r2.verdict, "deny");
      assert.equal(r2.reason, "cancelled");
    });

    it("with filterFn only cancels matching entries", async () => {
      const a1 = createMockAdapter();
      const a2 = createMockAdapter();
      const tc = createToolCall();

      const p1 = broker.requestAndWait(a1, "ch-1", "usr-1", "adp-1", "tool", tc);
      const p2 = broker.requestAndWait(a2, "ch-2", "usr-2", "adp-2", "tool", tc);
      await tick();

      broker.cancelAll((key) => key.startsWith("adp-1"));

      const r1 = await p1;
      assert.equal(r1.verdict, "deny");
      assert.equal(broker.hasPending("adp-2:ch-2:usr-2"), true);

      broker.resolve("adp-2:ch-2:usr-2", "yes");
      const r2 = await p2;
      assert.equal(r2.verdict, "allow");
    });

    it("does nothing when no pending confirmations", () => {
      broker.cancelAll(); // should not throw
    });
  });

  // ── Key generation ──────────────────────────────────────────────────────

  describe("key generation", () => {
    it("constructs key as adapterId:channelId:senderId", async () => {
      const adapter = createMockAdapter();
      const promise = broker.requestAndWait(adapter, "my-channel", "my-sender", "my-adapter", "tool", createToolCall());
      await tick();

      assert.equal(broker.hasPending("my-adapter:my-channel:my-sender"), true);

      broker.resolve("my-adapter:my-channel:my-sender", "yes");
      await promise;
    });
  });

  // ── Multiple concurrent ─────────────────────────────────────────────────

  describe("multiple concurrent confirmations", () => {
    it("handles three independent confirmations", async () => {
      const tc = createToolCall();
      const p1 = broker.requestAndWait(createMockAdapter(), "ch-1", "usr-1", "adp-1", "tool1", tc);
      const p2 = broker.requestAndWait(createMockAdapter(), "ch-2", "usr-2", "adp-2", "tool2", tc);
      const p3 = broker.requestAndWait(createMockAdapter(), "ch-3", "usr-3", "adp-3", "tool3", tc);
      await tick();

      broker.resolve("adp-1:ch-1:usr-1", "yes");
      broker.resolve("adp-2:ch-2:usr-2", "no");
      broker.resolve("adp-3:ch-3:usr-3", "always");

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(r1.verdict, "allow");
      assert.equal(r2.verdict, "deny");
      assert.equal(r3.verdict, "allow-session");
    });
  });
});
