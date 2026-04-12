import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageRouter } from "../../src/router/message-router.js";
import type {
  InboundMessage,
  LlmResponse,
  LlmStreamChunk,
  ToolDescriptor,
  ToolHandler,
  ToolResult,
  ChatMessage,
  GateDecision,
  ExecutionContext,
  GrantScope,
  ChannelAdapter,
  OutboundMessage,
} from "../../src/types.js";
import type { SessionManager } from "../../src/sessions/session-manager.js";
import type { LlmClient } from "../../src/llm/llm-client.js";
import type { ToolRegistry } from "../../src/tools/registry.js";
import type { CapabilityGate } from "../../src/tools/capability-gate.js";
import type { ToolExecutor } from "../../src/tools/executor.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { SecretManager } from "../../src/secrets/secret-manager.js";
import type { BetterClawsConfig } from "../../src/types.js";
import type { SessionCompactor } from "../../src/sessions/compactor.js";
import type { PromptBuilder } from "../../src/prompt/prompt-builder.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// ── Mocks ──────────────────────────────────────────────────────────────────

function createMockLogger() {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    log(e: Record<string, unknown>) {
      logs.push(e);
    },
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger & { logs: typeof logs };
}

function createMockSecretManager() {
  return {
    projectForTool(_allowedKeys: readonly string[], _sessionId: string, _toolName: string) {
      return new Map<string, string>();
    },
    register() {},
    get(_key: string) {
      return "";
    },
    has(_key: string) {
      return false;
    },
    keys() {
      return [];
    },
    revoke(_key: string) {
      return false;
    },
  } as unknown as SecretManager;
}

const TEST_CONFIG: BetterClawsConfig = {
  gateway: { host: "127.0.0.1", port: 18700 },
  llm: {
    baseUrl: "http://localhost:11434/v1",
    apiKey: "",
    model: "test",
    maxTokens: 1024,
    temperature: 0.7,
  },
  adapters: {},
  security: {
    defaultCapabilityPolicy: "deny",
    sandboxTimeout: 30000,
    stripEnvironment: true,
    allowPersistentGrants: false,
  },
  memory: {
    maxLongTermEntries: 2000,
    confidenceDecayRate: 0.01,
    staleThreshold: 0.2,
    curationIntervalMinutes: 60,
    curationEnabled: true,
    workingMemoryBudgetChars: 8192,
  },
  logging: { directory: "data/logs", redactSensitive: true, retentionDays: 90 },
};

function createMockSessionManager() {
  const appendedEntries: unknown[] = [];
  return {
    appendedEntries,
    async getOrCreate(adapterId: string, channelId: string, senderId: string) {
      return {
        id: `${adapterId}:${channelId}:${senderId}`,
        logPath: "/tmp/test.jsonl",
        state: { lastActivityAt: Date.now(), capabilityGrants: new Map() },
      };
    },
    async appendToLog(_sessionId: string, entry: unknown) {
      appendedEntries.push(entry);
    },
    async getHistory() {
      return [] as ChatMessage[];
    },
    getGrants() {
      return new Map<string, GrantScope>();
    },
    async close() {},
  } as unknown as SessionManager & { appendedEntries: unknown[] };
}

interface ControllableLlmClient extends LlmClient {
  callCount: number;
  capturedMessages: ChatMessage[][];
  responses: LlmResponse[];
  currentStreamDeferred: ReturnType<typeof deferred<LlmStreamChunk>> | null;
  pushResponse(r: LlmResponse): void;
  setStreamDeferred(def: ReturnType<typeof deferred<LlmStreamChunk>>): void;
}

function createMockLlmClient(): ControllableLlmClient {
  const responses: LlmResponse[] = [];
  let callCount = 0;
  const capturedMessages: ChatMessage[][] = [];
  let streamDeferred: ReturnType<typeof deferred<LlmStreamChunk>> | null = null;

  const defaultResponse: LlmResponse = {
    message: { role: "assistant", content: "Default response" },
    usage: { promptTokens: 10, completionTokens: 5 },
    raw: {},
  };

  return {
    responses,
    get callCount() {
      return callCount;
    },
    get capturedMessages() {
      return capturedMessages;
    },
    get currentStreamDeferred() {
      return streamDeferred;
    },
    pushResponse(r: LlmResponse) {
      responses.push(r);
    },
    setStreamDeferred(def: ReturnType<typeof deferred<LlmStreamChunk>>) {
      streamDeferred = def;
    },
    async chat(messages: readonly ChatMessage[], _tools?: unknown): Promise<LlmResponse> {
      callCount++;
      capturedMessages.push([...messages]);
      return responses.shift() ?? defaultResponse;
    },
    async *chatStream(messages: readonly ChatMessage[], _tools?: unknown): AsyncGenerator<LlmStreamChunk> {
      callCount++;
      capturedMessages.push([...messages]);

      if (streamDeferred) {
        yield await streamDeferred.promise;
        return;
      }

      const resp = responses.shift() ?? defaultResponse;
      if (resp.message.content) {
        yield { delta: resp.message.content, done: false };
      }
      yield { delta: "", done: true };
    },
  } as unknown as ControllableLlmClient;
}

function createMockToolRegistry() {
  const descriptors: ToolDescriptor[] = [];
  const handlers = new Map<string, ToolHandler>();
  return {
    getDescriptors() {
      return descriptors;
    },
    getDescriptor(name: string) {
      return descriptors.find((d) => d.name === name);
    },
    getHandler(name: string) {
      return handlers.get(name);
    },
    getPolicy() {
      return "auto" as const;
    },
    registerTool(d: ToolDescriptor, h: ToolHandler) {
      descriptors.push(d);
      handlers.set(d.name, h);
    },
  } as unknown as ToolRegistry & { registerTool(d: ToolDescriptor, h: ToolHandler): void };
}

function createMockCapabilityGate() {
  const decisions = new Map<string, GateDecision>();
  return {
    check(td: ToolDescriptor) {
      return decisions.get(td.name) ?? { allowed: true, reason: "Test allow", missingCapabilities: [] };
    },
    allowTool(name: string) {
      decisions.set(name, { allowed: true, reason: "Test allow", missingCapabilities: [] });
    },
    denyTool(name: string, reason: string) {
      decisions.set(name, { allowed: false, reason, missingCapabilities: [] });
    },
  } as unknown as CapabilityGate & { allowTool(n: string): void; denyTool(n: string, r: string): void };
}

function createMockExecutor() {
  return {
    async execute(_handler: ToolHandler, _params: Record<string, unknown>, _ctx: ExecutionContext): Promise<ToolResult> {
      return { success: true, output: { result: "test output" }, durationMs: 100 };
    },
  } as unknown as ToolExecutor;
}

function createMockCompactor() {
  return {
    async compact(_sessionId: string) {
      return { compressedTurnCount: 2, summaryLength: 50 };
    },
  } as unknown as SessionCompactor;
}

function createMockPromptBuilder() {
  let estimatedTokens = 100;
  return {
    build(input: Record<string, unknown>) {
      const history = (input["history"] ?? []) as Array<{ role: string; content: string }>;
      const systemMessage = { role: "system" as const, content: "mock-system-prompt" };
      return {
        messages: [systemMessage, ...history],
        estimatedTokens,
        truncatedCount: 0,
      };
    },
  } as unknown as PromptBuilder;
}

interface MockAdapter extends ChannelAdapter {
  onMessageCallback: ((msg: InboundMessage) => void) | null;
  sentMessages: Array<{ channelId: string; message: OutboundMessage }>;
  triggerMessage(msg: InboundMessage): void;
}

function createMockAdapter(id: string = "test-adapter"): MockAdapter {
  let onMessageCallback: ((msg: InboundMessage) => void) | null = null;
  const sentMessages: Array<{ channelId: string; message: OutboundMessage }> = [];

  return {
    id,
    name: "Test Adapter",
    async start() {},
    async stop() {},
    onMessage(callback: (msg: InboundMessage) => void) {
      onMessageCallback = callback;
    },
    async send(channelId: string, message: OutboundMessage) {
      sentMessages.push({ channelId, message });
    },
    get onMessageCallback() {
      return onMessageCallback;
    },
    get sentMessages() {
      return sentMessages;
    },
    triggerMessage(msg: InboundMessage) {
      if (!onMessageCallback) {
        throw new Error("onMessage callback not registered");
      }
      onMessageCallback(msg);
    },
  } as unknown as MockAdapter;
}

function makeInbound(text: string, overrides?: Partial<InboundMessage>): InboundMessage {
  return {
    id: "msg-1",
    adapterId: "test-adapter",
    channelId: "channel-123",
    senderId: "sender-456",
    text,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("MessageRouter message queueing", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "message-queue-test-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createRouter(overrides?: {
    logger?: ReturnType<typeof createMockLogger>;
    sessionManager?: ReturnType<typeof createMockSessionManager>;
    llmClient?: ControllableLlmClient;
    toolRegistry?: ReturnType<typeof createMockToolRegistry>;
    capabilityGate?: ReturnType<typeof createMockCapabilityGate>;
    executor?: ReturnType<typeof createMockExecutor>;
    compactor?: ReturnType<typeof createMockCompactor>;
    promptBuilder?: ReturnType<typeof createMockPromptBuilder>;
  }) {
    const logger = overrides?.logger ?? createMockLogger();
    const sessionManager = overrides?.sessionManager ?? createMockSessionManager();
    const llmClient = overrides?.llmClient ?? createMockLlmClient();
    const toolRegistry = overrides?.toolRegistry ?? createMockToolRegistry();
    const capabilityGate = overrides?.capabilityGate ?? createMockCapabilityGate();
    const executor = overrides?.executor ?? createMockExecutor();
    const compactor = overrides?.compactor ?? createMockCompactor();
    const promptBuilder = overrides?.promptBuilder ?? createMockPromptBuilder();
    const secretManager = createMockSecretManager();

    return new MessageRouter({
      logger,
      sessionManager,
      llmClient,
      toolRegistry,
      capabilityGate,
      executor,
      secretManager,
      config: TEST_CONFIG,
      compactor,
      promptBuilder,
    });
  }

  function waitForCondition(checkFn: () => boolean, timeoutMs: number = 1000): Promise<void> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (checkFn()) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 10);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error("waitForCondition timed out"));
      }, timeoutMs);
    });
  }

  it("processes messages immediately when queue is idle", async () => {
    const llmClient = createMockLlmClient();
    llmClient.pushResponse({
      message: { role: "assistant", content: "response" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    const router = createRouter({ llmClient });
    const adapter = createMockAdapter();

    router.registerAdapter(adapter);

    const msg = makeInbound("hello");
    adapter.triggerMessage(msg);

    // Wait for response to be sent back
    await waitForCondition(() => adapter.sentMessages.length >= 1);

    assert.ok(adapter.sentMessages.length >= 1);
  });

  it("queues messages when response is active (streaming)", async () => {
    const llmClient = createMockLlmClient();
    const router = createRouter({ llmClient });
    const adapter = createMockAdapter();

    // Set up controllable stream
    const streamDeferred1 = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDeferred1);
    llmClient.pushResponse({
      message: { role: "assistant", content: "response2" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    router.registerAdapter(adapter);

    const msg1 = makeInbound("first");
    adapter.triggerMessage(msg1);

    // Give stream a moment to start
    await new Promise((resolve) => setTimeout(resolve, 50));

    const sentBeforeQueue = adapter.sentMessages.length;

    // Queue second message while first is streaming
    const msg2 = makeInbound("second");
    adapter.triggerMessage(msg2);

    // Give a moment to verify nothing sent yet
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Should not have sent response for second message yet
    assert.equal(adapter.sentMessages.length, sentBeforeQueue);

    // Resolve stream to complete first message and trigger queue processing
    streamDeferred1.resolve({ delta: "response", done: true });

    // Wait for second message (merged) to complete
    await waitForCondition(() => adapter.sentMessages.length > sentBeforeQueue);

    assert.ok(adapter.sentMessages.length > sentBeforeQueue);
  });

  it("merges queued messages when active response completes", async () => {
    const llmClient = createMockLlmClient();
    const sessionManager = createMockSessionManager();
    const router = createRouter({ llmClient, sessionManager });
    const adapter = createMockAdapter();

    const streamDeferred1 = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDeferred1);
    llmClient.pushResponse({
      message: { role: "assistant", content: "response1" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });
    llmClient.pushResponse({
      message: { role: "assistant", content: "response-merged" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    router.registerAdapter(adapter);

    // Send first message
    const msg1 = makeInbound("first");
    adapter.triggerMessage(msg1);

    await new Promise((resolve) => setTimeout(resolve, 30));

    const callsBeforeQueue = llmClient.callCount;

    // Queue multiple messages while first is processing
    const msg2 = makeInbound("second");
    adapter.triggerMessage(msg2);

    const msg3 = makeInbound("third");
    adapter.triggerMessage(msg3);

    // Verify they're queued (no new LLM call yet)
    assert.equal(llmClient.callCount, callsBeforeQueue);

    // Complete first message — this should trigger merge and new LLM call
    streamDeferred1.resolve({ delta: "response1", done: true });

    // Wait for the merged message LLM call to happen
    await waitForCondition(() => llmClient.callCount > callsBeforeQueue);

    // Verify a new LLM call was made (the merge)
    assert.ok(llmClient.callCount > callsBeforeQueue);

    // Verify the merged message was logged to the session with "second\nthird"
    const inboundEntries = sessionManager.appendedEntries.filter(
      (e) => (e as Record<string, unknown>).type === "inbound",
    ) as Array<{ type: string; message: InboundMessage }>;
    const mergedEntry = inboundEntries.find((e) => e.message.text === "second\nthird");
    assert.ok(mergedEntry, "merged inbound entry with 'second\\nthird' should be logged to session");
  });

  it("/stop message bypasses queue and is processed immediately", async () => {
    const llmClient = createMockLlmClient();
    const router = createRouter({ llmClient });
    const adapter = createMockAdapter();

    const streamDeferred = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDeferred);
    llmClient.pushResponse({
      message: { role: "assistant", content: "stopped" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    router.registerAdapter(adapter);

    const msg1 = makeInbound("processing");
    adapter.triggerMessage(msg1);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Queue a message
    const msg2 = makeInbound("queued");
    adapter.triggerMessage(msg2);

    // Send /stop — should be processed even though msg2 is queued
    const stopMsg = makeInbound("/stop");
    adapter.triggerMessage(stopMsg);

    // /stop should result in immediate response (Stopped. or Nothing to stop.)
    await waitForCondition(() => adapter.sentMessages.length >= 1);

    const lastSent = adapter.sentMessages[adapter.sentMessages.length - 1];
    assert.ok(lastSent);
    assert.ok(lastSent.message.text.includes("Stopped") || lastSent.message.text.includes("Nothing to stop"));
  });

  it("/stop clears pending queue", async () => {
    const llmClient = createMockLlmClient();
    const router = createRouter({ llmClient });
    const adapter = createMockAdapter();

    const streamDeferred = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDeferred);
    llmClient.pushResponse({
      message: { role: "assistant", content: "response1" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    router.registerAdapter(adapter);

    // Start first message
    const msg1 = makeInbound("first");
    adapter.triggerMessage(msg1);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Queue messages
    const msg2 = makeInbound("queued1");
    adapter.triggerMessage(msg2);

    const msg3 = makeInbound("queued2");
    adapter.triggerMessage(msg3);

    // Send /stop to clear queue
    const stopMsg = makeInbound("/stop");
    adapter.triggerMessage(stopMsg);

    // Wait for /stop response
    await waitForCondition(() => adapter.sentMessages.length >= 1);

    // Capture LLM call count after /stop
    const callsAfterStop = llmClient.callCount;

    // Resolve first message (the deferred response)
    streamDeferred.resolve({ delta: "response", done: true });

    // Wait a moment to see if any additional LLM calls are made (they shouldn't be)
    await new Promise((resolve) => setTimeout(resolve, 100));

    // No new LLM calls should have been made because /stop cleared msg2 and msg3
    // If they weren't cleared, they would be merged and cause a new LLM call
    assert.equal(llmClient.callCount, callsAfterStop);
  });

  it("separate channels maintain independent queues", async () => {
    const llmClient = createMockLlmClient();
    const router = createRouter({ llmClient });
    const adapter = createMockAdapter();

    const streamDef1 = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDef1);
    llmClient.pushResponse({
      message: { role: "assistant", content: "resp2" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });
    llmClient.pushResponse({
      message: { role: "assistant", content: "resp3" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    router.registerAdapter(adapter);

    // Send message to channel 1
    const msg1a = makeInbound("ch1-msg1", { channelId: "channel-1" });
    adapter.triggerMessage(msg1a);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Queue message on channel 1
    const msg1b = makeInbound("ch1-msg2", { channelId: "channel-1" });
    adapter.triggerMessage(msg1b);

    // Send message to channel 2 (different channel) — should start immediately
    const streamDef2 = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDef2);
    const msg2a = makeInbound("ch2-msg1", { channelId: "channel-2" });
    adapter.triggerMessage(msg2a);

    // Both messages are now processing in parallel
    // Resolve ch2's stream
    streamDef2.resolve({ delta: "ch2 response", done: true });

    // Wait for ch2 response to complete
    await waitForCondition(() => llmClient.capturedMessages.length >= 2);

    assert.ok(llmClient.capturedMessages.length >= 2);
  });

  it("separate senders maintain independent queues", async () => {
    const llmClient = createMockLlmClient();
    const router = createRouter({ llmClient });
    const adapter = createMockAdapter();

    const streamDef1 = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDef1);
    llmClient.pushResponse({
      message: { role: "assistant", content: "resp2" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });
    llmClient.pushResponse({
      message: { role: "assistant", content: "resp3" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    router.registerAdapter(adapter);

    // Send message from sender 1
    const msg1a = makeInbound("s1-msg1", { senderId: "sender-1" });
    adapter.triggerMessage(msg1a);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Queue message from sender 1
    const msg1b = makeInbound("s1-msg2", { senderId: "sender-1" });
    adapter.triggerMessage(msg1b);

    // Send message from sender 2 (different sender, same channel) — should start immediately
    const streamDef2 = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDef2);
    const msg2a = makeInbound("s2-msg1", { senderId: "sender-2" });
    adapter.triggerMessage(msg2a);

    // Both are now processing in parallel
    streamDef2.resolve({ delta: "s2 response", done: true });

    // Wait for sender 2 to complete
    await waitForCondition(() => llmClient.capturedMessages.length >= 2);

    assert.ok(llmClient.capturedMessages.length >= 2);
  });

  it("only /stop bypasses queue, other commands don't", async () => {
    const llmClient = createMockLlmClient();
    const router = createRouter({ llmClient });
    const adapter = createMockAdapter();

    const streamDef = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDef);
    llmClient.pushResponse({
      message: { role: "assistant", content: "response2" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    router.registerAdapter(adapter);

    const msg1 = makeInbound("processing");
    adapter.triggerMessage(msg1);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Send /help (not /stop) — should be queued
    const msg2 = makeInbound("/help");
    adapter.triggerMessage(msg2);

    const sentBeforeResolve = adapter.sentMessages.length;

    // Resolve stream
    streamDef.resolve({ delta: "response", done: true });

    // Wait for queued message to process
    await waitForCondition(() => adapter.sentMessages.length > sentBeforeResolve);

    // /help should have been queued and processed as normal message
    assert.ok(adapter.sentMessages.length > sentBeforeResolve);
  });

  it("handles /stop with whitespace correctly", async () => {
    const llmClient = createMockLlmClient();
    const router = createRouter({ llmClient });
    const adapter = createMockAdapter();

    const streamDef = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDef);
    llmClient.pushResponse({
      message: { role: "assistant", content: "response1" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    router.registerAdapter(adapter);

    const msg1 = makeInbound("processing");
    adapter.triggerMessage(msg1);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Queue a message
    const msg2 = makeInbound("queued");
    adapter.triggerMessage(msg2);

    // /stop with whitespace should still work (trims the text)
    const stopMsg = makeInbound("  /stop  ");
    adapter.triggerMessage(stopMsg);

    // Wait for /stop response
    await waitForCondition(() => adapter.sentMessages.length >= 1);

    // Capture LLM call count after /stop
    const callsAfterStop = llmClient.callCount;

    streamDef.resolve({ delta: "response", done: true });

    // Wait a moment
    await new Promise((resolve) => setTimeout(resolve, 100));

    // No new LLM calls should have been made because /stop cleared the queue
    assert.equal(llmClient.callCount, callsAfterStop);
  });

  it("maintains queue per adapter:channel:sender combination", async () => {
    const llmClient = createMockLlmClient();
    const router = createRouter({ llmClient });
    const adapter1 = createMockAdapter("adapter-1");
    const adapter2 = createMockAdapter("adapter-2");

    const streamDef1 = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDef1);
    llmClient.pushResponse({
      message: { role: "assistant", content: "resp1" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });
    llmClient.pushResponse({
      message: { role: "assistant", content: "resp2" },
      usage: { promptTokens: 10, completionTokens: 5 },
      raw: {},
    });

    router.registerAdapter(adapter1);
    router.registerAdapter(adapter2);

    // Adapter 1 sends message
    const msg1a = makeInbound("a1-msg1", { adapterId: "adapter-1" });
    adapter1.triggerMessage(msg1a);

    await new Promise((resolve) => setTimeout(resolve, 30));

    // Queue on adapter 1
    const msg1b = makeInbound("a1-msg2", { adapterId: "adapter-1" });
    adapter1.triggerMessage(msg1b);

    // Adapter 2 sends (independent queue) — should process immediately
    const streamDef2 = deferred<LlmStreamChunk>();
    llmClient.setStreamDeferred(streamDef2);
    const msg2a = makeInbound("a2-msg1", { adapterId: "adapter-2" });
    adapter2.triggerMessage(msg2a);

    // Both are now processing in parallel
    streamDef2.resolve({ delta: "resp2", done: true });

    // Wait for adapter 2 to complete
    await waitForCondition(() => adapter2.sentMessages.length >= 1);

    assert.ok(adapter2.sentMessages.length >= 1);
  });
});
