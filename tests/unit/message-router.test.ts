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
  ToolCall,
  ChatMessage,
  GateDecision,
  ExecutionContext,
  GrantScope,
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

// ── Mocks ─────────────────────────────────────────────────────────────────────

function createMockLogger() {
  const logs: Array<Record<string, unknown>> = [];
  return { logs, log(e: Record<string, unknown>) { logs.push(e); }, async flush() {}, async close() {} } as unknown as StructuredLogger & { logs: typeof logs };
}

function createMockSecretManager() {
  return {
    projectForTool(_allowedKeys: readonly string[], _sessionId: string, _toolName: string) {
      return new Map<string, string>();
    },
    register() {},
    get(_key: string) { return ""; },
    has(_key: string) { return false; },
    keys() { return []; },
    revoke(_key: string) { return false; },
  } as unknown as SecretManager;
}

const TEST_CONFIG: BetterClawsConfig = {
  gateway: { host: "127.0.0.1", port: 18700 },
  llm: { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "test", maxTokens: 1024, temperature: 0.7 },
  adapters: {},
  security: { defaultCapabilityPolicy: "deny", sandboxTimeout: 30000, stripEnvironment: true, allowPersistentGrants: false },
  memory: { maxLongTermEntries: 2000, confidenceDecayRate: 0.01, staleThreshold: 0.2, curationIntervalMinutes: 60, curationEnabled: true },
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
    async getHistory() { return [] as ChatMessage[]; },
    getGrants() { return new Map<string, GrantScope>(); },
    async close() {},
  } as unknown as SessionManager & { appendedEntries: unknown[] };
}

function createMockLlmClient() {
  const responses: LlmResponse[] = [];
  let callCount = 0;
  const capturedMessages: ChatMessage[][] = [];
  const capturedOptions: Array<Record<string, unknown>> = [];

  const defaultResponse: LlmResponse = {
    message: { role: "assistant", content: "Default response" },
    usage: { promptTokens: 10, completionTokens: 5 },
    raw: {},
  };

  return {
    get callCount() { return callCount; },
    get capturedMessages() { return capturedMessages; },
    get capturedOptions() { return capturedOptions; },
    pushResponse(r: LlmResponse) { responses.push(r); },
    async chat(messages: readonly ChatMessage[], _tools?: unknown, options?: Record<string, unknown>) {
      callCount++;
      capturedMessages.push([...messages]);
      if (options) capturedOptions.push(options);
      return responses.shift() ?? defaultResponse;
    },
    async *chatStream(messages: readonly ChatMessage[], _tools?: unknown, options?: Record<string, unknown>): AsyncGenerator<LlmStreamChunk> {
      callCount++;
      capturedMessages.push([...messages]);
      if (options) capturedOptions.push(options);
      const resp = responses.shift() ?? defaultResponse;
      // Emit content as a single text delta
      if (resp.message.content) {
        yield { delta: resp.message.content, done: false };
      }
      // Emit tool calls as deltas
      if (resp.message.tool_calls && resp.message.tool_calls.length > 0) {
        for (let i = 0; i < resp.message.tool_calls.length; i++) {
          const tc = resp.message.tool_calls[i]!;
          yield {
            delta: "",
            toolCallDeltas: [{
              index: i,
              id: tc.id,
              type: tc.type,
              function: { name: tc.function.name, arguments: tc.function.arguments },
            }],
            done: false,
          };
        }
      }
      // Final done chunk
      yield { delta: "", done: true };
    },
  } as unknown as LlmClient & {
    callCount: number;
    capturedMessages: ChatMessage[][];
    capturedOptions: Array<Record<string, unknown>>;
    pushResponse(r: LlmResponse): void;
  };
}

function createMockToolRegistry() {
  const descriptors: ToolDescriptor[] = [];
  const handlers = new Map<string, ToolHandler>();
  return {
    getDescriptors() { return descriptors; },
    getDescriptor(name: string) { return descriptors.find(d => d.name === name); },
    getHandler(name: string) { return handlers.get(name); },
    getPolicy() { return "auto" as const; },
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

function makeInbound(text: string): InboundMessage {
  return {
    id: "msg-1",
    adapterId: "telegram",
    channelId: "chat-123",
    senderId: "user-456",
    text,
    timestamp: Date.now(),
  };
}

function makeToolCall(name: string, args: string = "{}"): ToolCall {
  return { id: "call-1", type: "function", function: { name, arguments: args } };
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
  let lastInput: Record<string, unknown> | null = null;
  return {
    build(input: Record<string, unknown>) {
      lastInput = input;
      const history = (input["history"] ?? []) as Array<{ role: string; content: string }>;
      const systemMessage = { role: "system" as const, content: "mock-system-prompt" };
      return {
        messages: [systemMessage, ...history],
        estimatedTokens,
        truncatedCount: 0,
      };
    },
    setEstimatedTokens(tokens: number) {
      estimatedTokens = tokens;
    },
    getLastInput() {
      return lastInput;
    },
  } as unknown as PromptBuilder & { setEstimatedTokens(tokens: number): void; getLastInput(): Record<string, unknown> | null };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("MessageRouter", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "message-router-test-"));
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  function createRouter(overrides?: {
    logger?: ReturnType<typeof createMockLogger>;
    sessionManager?: ReturnType<typeof createMockSessionManager>;
    llmClient?: ReturnType<typeof createMockLlmClient>;
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
    const compactor = overrides?.compactor;
    const promptBuilder = overrides?.promptBuilder ?? createMockPromptBuilder();

    const router = new MessageRouter({
      sessionManager: sessionManager as unknown as SessionManager,
      llmClient: llmClient as unknown as LlmClient,
      toolRegistry: toolRegistry as unknown as ToolRegistry,
      capabilityGate: capabilityGate as unknown as CapabilityGate,
      executor: executor as unknown as ToolExecutor,
      secretManager: createMockSecretManager(),
      logger: logger as unknown as StructuredLogger,
      config: TEST_CONFIG,
      compactor: compactor as unknown as SessionCompactor,
      promptBuilder: promptBuilder as unknown as PromptBuilder,
    });

    return { router, logger, sessionManager, llmClient, toolRegistry, capabilityGate, executor, compactor, promptBuilder };
  }

  describe("handleMessage() — text response", () => {
    it("returns outbound message when LLM returns text", async () => {
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "Hello there!" },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });

      const { router } = createRouter({ llmClient });
      const response = await router.handleMessage(makeInbound("Hello"));

      assert.equal(response.text, "Hello there!");
      assert.equal(response.channelId, "chat-123");
    });

    it("logs message:inbound and message:outbound events", async () => {
      const logger = createMockLogger();
      const { router } = createRouter({ logger });
      await router.handleMessage(makeInbound("Test"));

      assert.ok(logger.logs.some(l => (l as Record<string, unknown>)["eventType"] === "message:inbound"));
      assert.ok(logger.logs.some(l => (l as Record<string, unknown>)["eventType"] === "message:outbound"));
    });

    it("returns error message on LLM exception", async () => {
      const llmClient = createMockLlmClient();
      (llmClient as unknown as Record<string, unknown>)["chatStream"] = async function*() { throw new Error("LLM down"); };

      const { router } = createRouter({ llmClient });
      const response = await router.handleMessage(makeInbound("Test"));

      assert.ok(response.text.includes("something went wrong"));
    });
  });

  describe("Tool call flow", () => {
    it("processes tool call and feeds result back to LLM", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "test-tool", description: "test", parameters: { type: "object" }, capabilities: [] },
        { async execute() { return { success: true, output: { msg: "executed" }, durationMs: 50 }; } },
      );

      const llmClient = createMockLlmClient();
      // First response: tool call
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("test-tool")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      // Second response: final text after tool result
      llmClient.pushResponse({
        message: { role: "assistant", content: "Tool result processed" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const { router } = createRouter({ llmClient, toolRegistry });
      const response = await router.handleMessage(makeInbound("Run tool"));

      assert.equal(response.text, "Tool result processed");
      assert.equal(llmClient.callCount, 2);
    });

    it("handles denied tool with error in tool result", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "restricted", description: "test", parameters: { type: "object" }, capabilities: ["fs:write"] },
        { async execute() { return { success: true, output: {}, durationMs: 50 }; } },
      );

      const capabilityGate = createMockCapabilityGate();
      capabilityGate.denyTool("restricted", "Missing fs:write");

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("restricted")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "Tool was denied" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const { router } = createRouter({ llmClient, toolRegistry, capabilityGate });
      const response = await router.handleMessage(makeInbound("Write file"));

      // The second LLM call should have received a tool message with denial info
      const secondCall = llmClient.capturedMessages[1];
      assert.ok(secondCall);
      const toolMsg = secondCall.find(m => m.role === "tool");
      assert.ok(toolMsg);
      assert.ok(toolMsg.content.includes("denied"));
      assert.equal(response.text, "Tool was denied");
    });

    it("handles unknown tool gracefully", async () => {
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("nonexistent")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "Tool not found" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const { router } = createRouter({ llmClient });
      await router.handleMessage(makeInbound("Call unknown"));

      const secondCall = llmClient.capturedMessages[1];
      assert.ok(secondCall);
      const toolMsg = secondCall.find(m => m.role === "tool");
      assert.ok(toolMsg, "should have received tool result message");
      assert.ok(toolMsg.content.includes("Unknown tool"));
    });

    it("handles invalid tool arguments gracefully", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "test-tool", description: "test", parameters: { type: "object" }, capabilities: [] },
        { async execute() { return { success: true, output: {}, durationMs: 50 }; } },
      );

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("test-tool", "invalid json {")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "Bad args handled" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const { router } = createRouter({ llmClient, toolRegistry });
      await router.handleMessage(makeInbound("Bad args"));

      const secondCall = llmClient.capturedMessages[1];
      assert.ok(secondCall);
      const toolMsg = secondCall.find(m => m.role === "tool");
      assert.ok(toolMsg, "should have received tool result message");
      assert.ok(toolMsg.content.includes("Invalid JSON"));
    });

    it("appends tool result to session log", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "test-tool", description: "test", parameters: { type: "object" }, capabilities: [] },
        { async execute() { return { success: true, output: { r: "ok" }, durationMs: 50 }; } },
      );

      const sessionManager = createMockSessionManager();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("test-tool")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "Done" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const { router } = createRouter({ llmClient, toolRegistry, sessionManager });
      await router.handleMessage(makeInbound("Run tool"));

      const toolResultEntry = sessionManager.appendedEntries.find(
        e => (e as Record<string, unknown>)["type"] === "toolResult",
      );
      assert.ok(toolResultEntry, "should append tool result to log");
      const entry = toolResultEntry as Record<string, unknown>;
      assert.equal(entry["toolName"], "test-tool");
      assert.ok((entry["result"] as Record<string, unknown>)["success"]);
    });
  });

  describe("Max iteration limit", () => {
    it("prevents infinite tool call loops", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "loop-tool", description: "loops", parameters: { type: "object" }, capabilities: [] },
        { async execute() { return { success: true, output: {}, durationMs: 50 }; } },
      );

      const llmClient = createMockLlmClient();
      // Push 12 tool-call responses (more than the 10 iteration limit)
      for (let i = 0; i < 12; i++) {
        llmClient.pushResponse({
          message: { role: "assistant", content: "", tool_calls: [makeToolCall("loop-tool")] },
          usage: { promptTokens: 20, completionTokens: 15 },
          raw: {},
        });
      }

      const { router } = createRouter({ llmClient, toolRegistry });
      await router.handleMessage(makeInbound("Loop"));

      // Should have stopped after MAX_TOOL_ITERATIONS (10) + 1 initial = 11 calls max
      // The last response will be a tool_call response but iteration limit stops the loop
      // The router returns the last response content (empty string from tool_call response)
      assert.ok(llmClient.callCount <= 11, `should limit iterations, had ${llmClient.callCount} calls`);
    });
  });

  describe("Tool invocation logging", () => {
    it("logs tool:invoke event", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "logged-tool", description: "test", parameters: { type: "object" }, capabilities: [] },
        { async execute() { return { success: true, output: {}, durationMs: 50 }; } },
      );

      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("logged-tool")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "Done" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const { router } = createRouter({ logger, llmClient, toolRegistry });
      await router.handleMessage(makeInbound("Invoke tool"));

      const toolInvokeLog = logger.logs.find(
        l => (l as Record<string, unknown>)["eventType"] === "tool:invoke" &&
             ((l as Record<string, unknown>)["payload"] as Record<string, unknown>)["tool"] === "logged-tool",
      );
      assert.ok(toolInvokeLog, "should log tool:invoke event");
    });
  });

  describe("command handling", () => {
    it("/new archives session and returns archive message", async () => {
      const sessionManager = createMockSessionManager();
      let closeCalled = false;
      (sessionManager as unknown as Record<string, unknown>)["close"] = async () => {
        closeCalled = true;
      };

      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });
      const response = await router.handleMessage(makeInbound("/new"));

      assert.equal(response.text, "Session archived. Starting fresh.");
      assert.equal(closeCalled, true, "should call sessionManager.close()");
      assert.ok(!sessionManager.appendedEntries.some(
        (e) => (e as Record<string, unknown>).type === "inbound"
      ), "should not append inbound message for /new command");
    });

    it("/reset destroys session and returns destroy message", async () => {
      const sessionManager = createMockSessionManager();
      let destroyCalled = false;
      (sessionManager as unknown as Record<string, unknown>)["destroy"] = async () => {
        destroyCalled = true;
      };

      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });
      const response = await router.handleMessage(makeInbound("/reset"));

      assert.equal(response.text, "Session wiped. Starting fresh.");
      assert.equal(destroyCalled, true, "should call sessionManager.destroy()");
      assert.ok(!sessionManager.appendedEntries.some(
        (e) => (e as Record<string, unknown>).type === "inbound"
      ), "should not append inbound message for /reset command");
    });

    it("/new and /reset do not append their message to session log", async () => {
      const sessionManager = createMockSessionManager();
      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });

      // Test /new
      await router.handleMessage(makeInbound("/new"));
      assert.ok(!sessionManager.appendedEntries.some(
        (e) => (e as Record<string, unknown>).type === "inbound"
      ), "/new should not append to log");

      // Clear for next test
      sessionManager.appendedEntries.length = 0;

      // Test /reset
      await router.handleMessage(makeInbound("/reset"));
      assert.ok(!sessionManager.appendedEntries.some(
        (e) => (e as Record<string, unknown>).type === "inbound"
      ), "/reset should not append to log");
    });

    it("/compact returns error when compactor not provided", async () => {
      const llmClient = createMockLlmClient();
      const { router } = createRouter({ llmClient, compactor: undefined });

      const response = await router.handleMessage(makeInbound("/compact"));

      assert.equal(response.text, "Compaction is not configured.");
    });

    it("/compact returns 'nothing to compact' when compressor returns zero", async () => {
      const sessionManager = createMockSessionManager();
      const llmClient = createMockLlmClient();
      const compactor = createMockCompactor();
      (compactor as unknown as Record<string, unknown>).compact = async () => ({
        compressedTurnCount: 0,
        summaryLength: 0,
      });

      const { router } = createRouter({ sessionManager, llmClient, compactor });
      const response = await router.handleMessage(makeInbound("/compact"));

      assert.equal(response.text, "Nothing to compact yet.");
      assert.ok(sessionManager.appendedEntries.some(
        (e) => (e as Record<string, unknown>).type === "outbound"
      ), "should append reply to log");
    });

    it("/compact returns status message with turn count", async () => {
      const sessionManager = createMockSessionManager();
      const llmClient = createMockLlmClient();
      const compactor = createMockCompactor();

      const { router } = createRouter({ sessionManager, llmClient, compactor });
      const response = await router.handleMessage(makeInbound("/compact"));

      assert.ok(response.text.includes("Compaction complete"));
      assert.ok(response.text.includes("Summarised 2 turns"));
      assert.ok(response.text.includes("50 chars"));
    });

    it("/compact appends reply to session log on success", async () => {
      const sessionManager = createMockSessionManager();
      const llmClient = createMockLlmClient();
      const compactor = createMockCompactor();

      const { router } = createRouter({ sessionManager, llmClient, compactor });
      await router.handleMessage(makeInbound("/compact"));

      const outboundEntries = sessionManager.appendedEntries.filter(
        (e) => (e as Record<string, unknown>).type === "outbound"
      );
      assert.ok(outboundEntries.length > 0, "should append outbound reply");
    });

    it("/fork (no arg) forks current session and returns confirmation", async () => {
      const sessionManager = createMockSessionManager();
      let closeCalled = false;
      let forkCalled = false;
      (sessionManager as unknown as Record<string, unknown>)["readRawLog"] = async (sessionId: string) => {
        if (sessionId === "telegram:chat-123:user-456") {
          return "log content";
        }
        return null;
      };
      (sessionManager as unknown as Record<string, unknown>)["close"] = async () => {
        closeCalled = true;
      };
      (sessionManager as unknown as Record<string, unknown>)["fork"] = async (_sourceId: string, _adapterId: string, _channelId: string, _senderId: string) => {
        forkCalled = true;
        return {
          id: "forked-session-id",
          logPath: "/tmp/forked.jsonl",
          state: { lastActivityAt: Date.now(), capabilityGrants: new Map() },
        };
      };

      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });
      const response = await router.handleMessage(makeInbound("/fork"));

      assert.ok(response.text.includes("Forked session"), "response should mention forking");
      assert.ok(response.text.includes("History preserved"), "response should mention history preservation");
      assert.equal(closeCalled, true, "should call sessionManager.close()");
      assert.equal(forkCalled, true, "should call sessionManager.fork()");
    });

    it("/fork <sessionId> forks specific session by ID", async () => {
      const sessionManager = createMockSessionManager();
      let forkSourceId: string | null = null;
      (sessionManager as unknown as Record<string, unknown>)["readRawLog"] = async (sessionId: string) => {
        if (sessionId === "target-session-123") {
          return "log content from target";
        }
        return null;
      };
      (sessionManager as unknown as Record<string, unknown>)["close"] = async () => {};
      (sessionManager as unknown as Record<string, unknown>)["fork"] = async (sourceId: string, _adapterId: string, _channelId: string, _senderId: string) => {
        forkSourceId = sourceId;
        return {
          id: "new-forked-id",
          logPath: "/tmp/new-forked.jsonl",
          state: { lastActivityAt: Date.now(), capabilityGrants: new Map() },
        };
      };

      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });
      const response = await router.handleMessage(makeInbound("/fork target-session-123"));

      assert.equal(forkSourceId, "target-session-123", "should fork from specified session ID");
      assert.ok(response.text.includes("Forked session"), "response should mention forking");
      assert.ok(response.text.includes("History preserved"), "response should confirm history preservation");
    });

    it("/fork <invalidid> with nonexistent session returns not found error", async () => {
      const sessionManager = createMockSessionManager();
      (sessionManager as unknown as Record<string, unknown>)["readRawLog"] = async () => null;

      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });
      const response = await router.handleMessage(makeInbound("/fork invalidid"));

      assert.equal(response.text, 'Session "invalidid" not found.');
    });

    it("/fork does not append inbound message to session log", async () => {
      const sessionManager = createMockSessionManager();
      (sessionManager as unknown as Record<string, unknown>)["readRawLog"] = async () => "log content";
      (sessionManager as unknown as Record<string, unknown>)["close"] = async () => {};
      (sessionManager as unknown as Record<string, unknown>)["fork"] = async () => ({
        id: "forked-id",
        logPath: "/tmp/forked.jsonl",
        state: { lastActivityAt: Date.now(), capabilityGrants: new Map() },
      });

      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });
      await router.handleMessage(makeInbound("/fork"));

      assert.ok(!sessionManager.appendedEntries.some(
        (e) => (e as Record<string, unknown>).type === "inbound"
      ), "/fork should not append inbound message to log");
    });

    it("/sessions lists user's sessions", async () => {
      const sessionManager = createMockSessionManager();
      (sessionManager as unknown as Record<string, unknown>)["listForSender"] = async () => [
        {
          sessionId: "a1b2c3d4e5f60001",
          adapterId: "telegram",
          channelId: "chat-456",
          createdAt: new Date("2026-04-01").getTime(),
          lastActivityAt: Date.now(),
          archived: false,
          preview: "Latest message preview",
        },
        {
          sessionId: "d4e5f6a7b8c90002",
          adapterId: "discord",
          channelId: "channel-789",
          createdAt: new Date("2026-04-05").getTime(),
          lastActivityAt: Date.now(),
          archived: true,
          preview: "Some old conversation",
        },
      ];

      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });
      const response = await router.handleMessage(makeInbound("/sessions"));

      assert.ok(response.text.includes("Sessions:"), "response should contain 'Sessions:' header");
      assert.ok(response.text.includes("a1b2c3d4"), "response should contain first session ID");
      assert.ok(response.text.includes("d4e5f6a7"), "response should contain second session ID");
      assert.ok(response.text.includes("active"), "response should show active status");
      assert.ok(response.text.includes("archived"), "response should show archived status");
    });

    it("/sessions returns 'No sessions found' when user has no sessions", async () => {
      const sessionManager = createMockSessionManager();
      (sessionManager as unknown as Record<string, unknown>)["listForSender"] = async () => [];

      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });
      const response = await router.handleMessage(makeInbound("/sessions"));

      assert.equal(response.text, "No sessions found.");
    });

    it("/sessions does not append inbound message to session log", async () => {
      const sessionManager = createMockSessionManager();
      (sessionManager as unknown as Record<string, unknown>)["listForSender"] = async () => [];

      const llmClient = createMockLlmClient();

      const { router } = createRouter({ sessionManager, llmClient });
      await router.handleMessage(makeInbound("/sessions"));

      assert.ok(!sessionManager.appendedEntries.some(
        (e) => (e as Record<string, unknown>).type === "inbound"
      ), "/sessions should not append inbound message to log");
    });
  });

  describe("auto-compaction", () => {
    it("does not trigger when compaction not configured", async () => {
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "Response" },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      });

      const configWithoutCompaction: BetterClawsConfig = {
        ...TEST_CONFIG,
        compaction: undefined,
      };

      const router = new MessageRouter({
        sessionManager: createMockSessionManager() as unknown as SessionManager,
        llmClient: llmClient as unknown as LlmClient,
        toolRegistry: createMockToolRegistry() as unknown as ToolRegistry,
        capabilityGate: createMockCapabilityGate() as unknown as CapabilityGate,
        executor: createMockExecutor() as unknown as ToolExecutor,
        secretManager: createMockSecretManager(),
        logger: createMockLogger() as unknown as StructuredLogger,
        config: configWithoutCompaction,
        promptBuilder: createMockPromptBuilder() as unknown as PromptBuilder,
      });

      await router.handleMessage(makeInbound("Test"));

      // LLM should be called once (no auto-compaction)
      assert.equal(llmClient.callCount, 1);
    });

    it("does not trigger when config.compaction.enabled is false", async () => {
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "Response" },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      });

      const configDisabled: BetterClawsConfig = {
        ...TEST_CONFIG,
        compaction: {
          enabled: false,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 100,
        },
      };

      const router = new MessageRouter({
        sessionManager: createMockSessionManager() as unknown as SessionManager,
        llmClient: llmClient as unknown as LlmClient,
        toolRegistry: createMockToolRegistry() as unknown as ToolRegistry,
        capabilityGate: createMockCapabilityGate() as unknown as CapabilityGate,
        executor: createMockExecutor() as unknown as ToolExecutor,
        secretManager: createMockSecretManager(),
        logger: createMockLogger() as unknown as StructuredLogger,
        config: configDisabled,
        promptBuilder: createMockPromptBuilder() as unknown as PromptBuilder,
      });

      await router.handleMessage(makeInbound("Test"));

      assert.equal(llmClient.callCount, 1);
    });

    it("does not trigger when estimatedTokens <= tokenBudget - reserveTokens", async () => {
      const promptBuilder = createMockPromptBuilder();
      promptBuilder.setEstimatedTokens(256); // Well under 1024 - 512 = 512

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "Response" },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      });

      const compactor = createMockCompactor();
      (compactor as unknown as Record<string, unknown>).compactCalled = false;
      (compactor as unknown as Record<string, unknown>).compact = async () => {
        (compactor as unknown as Record<string, unknown>).compactCalled = true;
        return { compressedTurnCount: 0, summaryLength: 0 };
      };

      const { router } = createRouter({
        llmClient,
        compactor,
        promptBuilder,
      });

      await router.handleMessage(makeInbound("Test"));

      assert.equal((compactor as unknown as Record<string, unknown>).compactCalled, false);
    });

    it("triggers compaction when estimatedTokens > tokenBudget - reserveTokens", async () => {
      const promptBuilder = createMockPromptBuilder();
      promptBuilder.setEstimatedTokens(800); // Exceeds 1024 - 512 = 512

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "Response" },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      });

      const compactor = createMockCompactor();
      let compactCalled = false;
      (compactor as unknown as Record<string, unknown>).compact = async () => {
        compactCalled = true;
        return { compressedTurnCount: 3, summaryLength: 100 };
      };

      const configWithCompaction: BetterClawsConfig = {
        ...TEST_CONFIG,
        compaction: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 100,
        },
      };

      const router = new MessageRouter({
        sessionManager: createMockSessionManager() as unknown as SessionManager,
        llmClient: llmClient as unknown as LlmClient,
        toolRegistry: createMockToolRegistry() as unknown as ToolRegistry,
        capabilityGate: createMockCapabilityGate() as unknown as CapabilityGate,
        executor: createMockExecutor() as unknown as ToolExecutor,
        secretManager: createMockSecretManager(),
        logger: createMockLogger() as unknown as StructuredLogger,
        config: configWithCompaction,
        compactor: compactor as unknown as SessionCompactor,
        promptBuilder: promptBuilder as unknown as PromptBuilder,
      });

      await router.handleMessage(makeInbound("Test"));

      assert.equal(compactCalled, true);
    });

    it("re-fetches history after auto-compaction", async () => {
      const sessionManager = createMockSessionManager();
      const originalGetHistory = sessionManager.getHistory;
      let getHistoryCalls = 0;

      (sessionManager as unknown as Record<string, unknown>).getHistory = async (sessionId: string) => {
        getHistoryCalls++;
        return originalGetHistory(sessionId);
      };

      const promptBuilder = createMockPromptBuilder();
      promptBuilder.setEstimatedTokens(800);

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "Response" },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      });

      const compactor = createMockCompactor();

      const configWithCompaction: BetterClawsConfig = {
        ...TEST_CONFIG,
        compaction: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 100,
        },
      };

      const router = new MessageRouter({
        sessionManager: sessionManager as unknown as SessionManager,
        llmClient: llmClient as unknown as LlmClient,
        toolRegistry: createMockToolRegistry() as unknown as ToolRegistry,
        capabilityGate: createMockCapabilityGate() as unknown as CapabilityGate,
        executor: createMockExecutor() as unknown as ToolExecutor,
        secretManager: createMockSecretManager(),
        logger: createMockLogger() as unknown as StructuredLogger,
        config: configWithCompaction,
        compactor: compactor as unknown as SessionCompactor,
        promptBuilder: promptBuilder as unknown as PromptBuilder,
      });

      await router.handleMessage(makeInbound("Test"));

      // getHistory should be called twice: once for auto-compaction check, once after compact
      assert.ok(getHistoryCalls >= 2, `getHistory called ${getHistoryCalls} times`);
    });

    it("swallows compaction errors and continues with LLM response", async () => {
      const promptBuilder = createMockPromptBuilder();
      promptBuilder.setEstimatedTokens(800);

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "Response after failed compact" },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      });

      const compactor = createMockCompactor();
      (compactor as unknown as Record<string, unknown>).compact = async () => {
        throw new Error("Compaction failed");
      };

      const logger = createMockLogger();
      const configWithCompaction: BetterClawsConfig = {
        ...TEST_CONFIG,
        compaction: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 100,
        },
      };

      const router = new MessageRouter({
        sessionManager: createMockSessionManager() as unknown as SessionManager,
        llmClient: llmClient as unknown as LlmClient,
        toolRegistry: createMockToolRegistry() as unknown as ToolRegistry,
        capabilityGate: createMockCapabilityGate() as unknown as CapabilityGate,
        executor: createMockExecutor() as unknown as ToolExecutor,
        secretManager: createMockSecretManager(),
        logger: logger as unknown as StructuredLogger,
        config: configWithCompaction,
        compactor: compactor as unknown as SessionCompactor,
        promptBuilder: promptBuilder as unknown as PromptBuilder,
      });

      const response = await router.handleMessage(makeInbound("Test"));

      // Should still return the LLM response despite compaction error
      assert.equal(response.text, "Response after failed compact");

      // Error should be logged
      const errorLog = logger.logs.find(
        (l) => (l as Record<string, unknown>).eventType === "session:compaction" &&
               ((l as Record<string, unknown>).payload as Record<string, unknown>).success === false
      );
      assert.ok(errorLog, "should log compaction error");
    });
  });

  describe("getCurrentDateTime — timezone config", () => {
    it("includes configured timezone in currentDateTime", async () => {
      const promptBuilder = createMockPromptBuilder();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "OK" },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      });

      const configWithTz: BetterClawsConfig = {
        ...TEST_CONFIG,
        systemContext: { timezone: "America/New_York" },
      };

      const router = new MessageRouter({
        sessionManager: createMockSessionManager() as unknown as SessionManager,
        llmClient: llmClient as unknown as LlmClient,
        toolRegistry: createMockToolRegistry() as unknown as ToolRegistry,
        capabilityGate: createMockCapabilityGate() as unknown as CapabilityGate,
        executor: createMockExecutor() as unknown as ToolExecutor,
        secretManager: createMockSecretManager(),
        logger: createMockLogger() as unknown as StructuredLogger,
        config: configWithTz,
        promptBuilder: promptBuilder as unknown as PromptBuilder,
      });

      await router.handleMessage(makeInbound("Test"));
      const input = promptBuilder.getLastInput();
      assert.ok(input);
      const dt = input["currentDateTime"] as string;
      assert.ok(dt.includes("(America/New_York)"), `expected timezone in: ${dt}`);
    });

    it("defaults to UTC when no timezone configured", async () => {
      const promptBuilder = createMockPromptBuilder();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "OK" },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      });

      const { router } = createRouter({ promptBuilder, llmClient });
      await router.handleMessage(makeInbound("Test"));
      const input = promptBuilder.getLastInput();
      assert.ok(input);
      const dt = input["currentDateTime"] as string;
      assert.ok(dt.includes("(UTC)"), `expected UTC in: ${dt}`);
    });

    it("formats date as YYYY-MM-DD HH:MM:SS", async () => {
      const promptBuilder = createMockPromptBuilder();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "OK" },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      });

      const { router } = createRouter({ promptBuilder, llmClient });
      await router.handleMessage(makeInbound("Test"));
      const input = promptBuilder.getLastInput();
      const dt = input!["currentDateTime"] as string;
      assert.match(dt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \(.+\)$/);
    });
  });

  describe("Auto-grant blocklist (security hardening)", () => {
    const blockedCapabilities = [
      { capability: "fs:write", toolName: "write-tool", desc: "writes", label: "Write" },
      { capability: "exec:shell", toolName: "shell-tool", desc: "shell", label: "Shell" },
      { capability: "exec:subprocess", toolName: "subprocess-tool", desc: "subprocess", label: "Subprocess" },
      { capability: "net:outbound", toolName: "net-tool", desc: "network", label: "Network" },
    ] as const;

    for (const { capability, toolName, desc, label } of blockedCapabilities) {
      it(`denies ${capability} even when in autoGrantCapabilities`, async () => {
        const toolRegistry = createMockToolRegistry();
        toolRegistry.registerTool(
          { name: toolName, description: desc, parameters: { type: "object" }, capabilities: [capability] },
          { async execute() { return { success: true, output: {}, durationMs: 50 }; } },
        );

        const capabilityGate = createMockCapabilityGate();
        capabilityGate.denyTool(toolName, `${capability} missing`);

        const llmClient = createMockLlmClient();
        llmClient.pushResponse({
          message: { role: "assistant", content: "", tool_calls: [makeToolCall(toolName)] },
          usage: { promptTokens: 20, completionTokens: 15 },
          raw: {},
        });
        llmClient.pushResponse({
          message: { role: "assistant", content: `${label} denied` },
          usage: { promptTokens: 30, completionTokens: 10 },
          raw: {},
        });

        const config: BetterClawsConfig = {
          ...TEST_CONFIG,
          security: { ...TEST_CONFIG.security, autoGrantCapabilities: [capability] },
        };

        const router = new MessageRouter({
          sessionManager: createMockSessionManager() as unknown as SessionManager,
          llmClient: llmClient as unknown as LlmClient,
          toolRegistry: toolRegistry as unknown as ToolRegistry,
          capabilityGate: capabilityGate as unknown as CapabilityGate,
          executor: createMockExecutor() as unknown as ToolExecutor,
          secretManager: createMockSecretManager(),
          logger: createMockLogger() as unknown as StructuredLogger,
          config,
          promptBuilder: createMockPromptBuilder() as unknown as PromptBuilder,
        });

        await router.handleMessage(makeInbound(label));

        const secondCall = llmClient.capturedMessages[1];
        assert.ok(secondCall);
        const toolMsg = secondCall.find(m => m.role === "tool");
        assert.ok(toolMsg);
        assert.ok(toolMsg.content.includes("denied"));
      });
    }

    it("allows safe capabilities (fs:read) to auto-grant when in autoGrantCapabilities", async () => {
      const toolRegistry = createMockToolRegistry();
      const executor = createMockExecutor();
      (executor as unknown as Record<string, unknown>).execute = async () => ({
        success: true,
        output: { result: "safe_read_data" },
        durationMs: 50,
      });

      toolRegistry.registerTool(
        { name: "read-tool", description: "reads", parameters: { type: "object" }, capabilities: ["fs:read"] },
        { async execute() { return { success: true, output: { result: "safe_read_data" }, durationMs: 50 }; } },
      );

      const capabilityGate = createMockCapabilityGate();
      // Auto-allow the read tool (fs:read is not in NEVER_AUTO_GRANT)
      capabilityGate.allowTool("read-tool");

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("read-tool")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "Read result processed" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const configWithAutoGrant: BetterClawsConfig = {
        ...TEST_CONFIG,
        security: {
          ...TEST_CONFIG.security,
          autoGrantCapabilities: ["fs:read"],
        },
      };

      const router = new MessageRouter({
        sessionManager: createMockSessionManager() as unknown as SessionManager,
        llmClient: llmClient as unknown as LlmClient,
        toolRegistry: toolRegistry as unknown as ToolRegistry,
        capabilityGate: capabilityGate as unknown as CapabilityGate,
        executor: executor as unknown as ToolExecutor,
        secretManager: createMockSecretManager(),
        logger: createMockLogger() as unknown as StructuredLogger,
        config: configWithAutoGrant,
        promptBuilder: createMockPromptBuilder() as unknown as PromptBuilder,
      });

      await router.handleMessage(makeInbound("Read"));

      // Tool should have executed successfully (auto-granted)
      const response = llmClient.capturedMessages[1];
      assert.ok(response);
      const toolMsg = response.find(m => m.role === "tool");
      assert.ok(toolMsg);
      // Should contain the tool result, not a denial message
      assert.ok(!toolMsg.content.includes("denied"));
      assert.ok(!toolMsg.content.includes("error"));
    });

    it("denies tool requiring fs:write AND fs:read when both in autoGrantCapabilities", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "mixed-tool", description: "mixed", parameters: { type: "object" }, capabilities: ["fs:write", "fs:read"] },
        { async execute() { return { success: true, output: {}, durationMs: 50 }; } },
      );

      const capabilityGate = createMockCapabilityGate();
      capabilityGate.denyTool("mixed-tool", "fs:write missing");

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("mixed-tool")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "Mixed denied" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const configWithAutoGrant: BetterClawsConfig = {
        ...TEST_CONFIG,
        security: {
          ...TEST_CONFIG.security,
          autoGrantCapabilities: ["fs:write", "fs:read"],
        },
      };

      const router = new MessageRouter({
        sessionManager: createMockSessionManager() as unknown as SessionManager,
        llmClient: llmClient as unknown as LlmClient,
        toolRegistry: toolRegistry as unknown as ToolRegistry,
        capabilityGate: capabilityGate as unknown as CapabilityGate,
        executor: createMockExecutor() as unknown as ToolExecutor,
        secretManager: createMockSecretManager(),
        logger: createMockLogger() as unknown as StructuredLogger,
        config: configWithAutoGrant,
        promptBuilder: createMockPromptBuilder() as unknown as PromptBuilder,
      });

      await router.handleMessage(makeInbound("Mixed"));

      const secondCall = llmClient.capturedMessages[1];
      assert.ok(secondCall);
      const toolMsg = secondCall.find(m => m.role === "tool");
      assert.ok(toolMsg);
      assert.ok(toolMsg.content.includes("denied"));
    });
  });

  describe("Tool result redaction (security hardening)", () => {
    it("redacts AWS API key pattern in tool output before sending to LLM", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "aws-tool", description: "aws", parameters: { type: "object" }, capabilities: [] },
        {
          async execute() {
            return {
              success: true,
              output: { key: "AKIAIOSFODNN7EXAMPLE" },
              durationMs: 50,
            };
          },
        },
      );

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("aws-tool")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "AWS processed" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const { router } = createRouter({ llmClient, toolRegistry });
      await router.handleMessage(makeInbound("AWS"));

      const secondCall = llmClient.capturedMessages[1];
      assert.ok(secondCall);
      const toolMsg = secondCall.find(m => m.role === "tool");
      assert.ok(toolMsg);
      // The actual key should not appear in the message sent to LLM
      assert.ok(!toolMsg.content.includes("AKIAIOSFODNN7EXAMPLE"));
    });

    it("redacts Bearer token in tool output before sending to LLM", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "token-tool", description: "token", parameters: { type: "object" }, capabilities: [] },
        {
          async execute() {
            return {
              success: true,
              output: { auth: "Bearer sk_live_51234567890abcdefghijklmnop" },
              durationMs: 50,
            };
          },
        },
      );

      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("token-tool")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "Token processed" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const { router } = createRouter({ llmClient, toolRegistry });
      await router.handleMessage(makeInbound("Token"));

      const secondCall = llmClient.capturedMessages[1];
      assert.ok(secondCall);
      const toolMsg = secondCall.find(m => m.role === "tool");
      assert.ok(toolMsg);
      // The actual token should not appear in the message sent to LLM
      assert.ok(!toolMsg.content.includes("sk_live_51234567890abcdefghijklmnop"));
    });

    it("still includes tool result in session log (not redacted there)", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "secret-tool", description: "secret", parameters: { type: "object" }, capabilities: [] },
        {
          async execute() {
            return {
              success: true,
              output: { secret: "AKIAIOSFODNN7EXAMPLE" },
              durationMs: 50,
            };
          },
        },
      );

      const sessionManager = createMockSessionManager();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({
        message: { role: "assistant", content: "", tool_calls: [makeToolCall("secret-tool")] },
        usage: { promptTokens: 20, completionTokens: 15 },
        raw: {},
      });
      llmClient.pushResponse({
        message: { role: "assistant", content: "Done" },
        usage: { promptTokens: 30, completionTokens: 10 },
        raw: {},
      });

      const { router } = createRouter({ llmClient, toolRegistry, sessionManager });
      await router.handleMessage(makeInbound("Secret"));

      const toolResultEntry = sessionManager.appendedEntries.find(
        e => (e as Record<string, unknown>)["type"] === "toolResult",
      );
      assert.ok(toolResultEntry);
      const entry = toolResultEntry as Record<string, unknown>;
      // The tool result itself is stored (with original output)
      assert.ok((entry["result"] as Record<string, unknown>)["output"]);
    });
  });

  describe("handleMessageStream() — reasoning deltas", () => {
    it("yields reasoning-delta events when LLM chunks contain reasoningDelta", async () => {
      const llmClient = createMockLlmClient();
      // Override chatStream to yield reasoning deltas
      (llmClient as unknown as Record<string, unknown>)["chatStream"] = async function* () {
        yield { delta: "", reasoningDelta: "Let me", done: false };
        yield { delta: "", reasoningDelta: " think", done: false };
        yield { delta: "", reasoningDelta: " about", done: false };
        yield { delta: " this.", reasoningDelta: undefined, done: true };
      };

      const { router } = createRouter({ llmClient });
      const response = router.handleMessageStream(makeInbound("Test"));
      const events: Array<{ type?: string; delta?: string }> = [];

      for await (const event of response.stream) {
        events.push(event as { type?: string; delta?: string });
      }

      const reasoningEvents = events.filter((e) => e.type === "reasoning-delta");
      assert.equal(reasoningEvents.length, 3);
      assert.equal(reasoningEvents[0]?.delta, "Let me");
      assert.equal(reasoningEvents[1]?.delta, " think");
      assert.equal(reasoningEvents[2]?.delta, " about");
    });

    it("includes reasoning in done event when reasoning was produced", async () => {
      const llmClient = createMockLlmClient();
      (llmClient as unknown as Record<string, unknown>)["chatStream"] = async function* () {
        yield { delta: "", reasoningDelta: "Thinking process", done: false };
        yield { delta: "Response", reasoningDelta: undefined, done: true };
      };

      const { router } = createRouter({ llmClient });
      const response = router.handleMessageStream(makeInbound("Test"));
      const events: Array<unknown> = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      const doneEvent = events.find((e) => (e as Record<string, unknown>)?.type === "done");
      assert.ok(doneEvent);
      assert.equal((doneEvent as Record<string, unknown>).reasoning, "Thinking process");
    });

    it("omits reasoning field in done event when no reasoning was produced", async () => {
      const llmClient = createMockLlmClient();
      (llmClient as unknown as Record<string, unknown>)["chatStream"] = async function* () {
        yield { delta: "Just a response", reasoningDelta: undefined, done: true };
      };

      const { router } = createRouter({ llmClient });
      const response = router.handleMessageStream(makeInbound("Test"));
      const events: Array<unknown> = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      const doneEvent = events.find((e) => (e as Record<string, unknown>)?.type === "done");
      assert.ok(doneEvent);
      assert.equal((doneEvent as Record<string, unknown>).reasoning, undefined);
    });

    it("reasoning does not appear in text promise", async () => {
      const llmClient = createMockLlmClient();
      (llmClient as unknown as Record<string, unknown>)["chatStream"] = async function* () {
        yield { delta: "", reasoningDelta: "Internal thinking", done: false };
        yield { delta: "Final answer", reasoningDelta: undefined, done: true };
      };

      const { router } = createRouter({ llmClient });
      const response = router.handleMessageStream(makeInbound("Test"));
      const text = await response.text;

      assert.equal(text, "Final answer");
      assert.ok(!text.includes("Internal thinking"));
    });

    it("reasoning resets across tool call iterations", async () => {
      const toolRegistry = createMockToolRegistry();
      toolRegistry.registerTool(
        { name: "test-tool", description: "test", parameters: { type: "object" }, capabilities: [] },
        { async execute() { return { success: true, output: { result: "data" }, durationMs: 50 }; } },
      );

      const llmClient = createMockLlmClient();
      // Simulate two separate streams for the two LLM calls
      let streamCount = 0;
      (llmClient as unknown as Record<string, unknown>)["chatStream"] = async function* () {
        streamCount++;
        if (streamCount === 1) {
          // First stream: reasoning + tool call
          yield { delta: "", reasoningDelta: "First reasoning", done: false };
          yield {
            delta: "",
            toolCallDeltas: [{
              index: 0,
              id: "call-1",
              type: "function",
              function: { name: "test-tool", arguments: "{}" },
            }],
            done: true,
          };
        } else {
          // Second stream: no reasoning, just final response
          yield { delta: "Final response", reasoningDelta: undefined, done: true };
        }
      };

      const { router } = createRouter({ llmClient, toolRegistry });
      const response = router.handleMessageStream(makeInbound("Test"));
      let finalText = "";
      const allReasonings: Array<string | undefined> = [];

      for await (const event of response.stream) {
        const e = event as Record<string, unknown>;
        if (e.type === "done") {
          finalText = e.text as string;
          allReasonings.push(e.reasoning as string | undefined);
        }
      }

      // Should have completed with final response
      assert.equal(finalText, "Final response");
      // Should have two done events (one after tool call, one at end)
      assert.ok(allReasonings.length >= 1);
    });

    it("yields reasoning and text deltas interleaved", async () => {
      const llmClient = createMockLlmClient();
      (llmClient as unknown as Record<string, unknown>)["chatStream"] = async function* () {
        yield { delta: "", reasoningDelta: "Step 1", done: false };
        yield { delta: "A", reasoningDelta: undefined, done: false };
        yield { delta: "", reasoningDelta: "Step 2", done: false };
        yield { delta: "B", reasoningDelta: undefined, done: false };
        yield { delta: "", reasoningDelta: "Step 3", done: false };
        yield { delta: "C", reasoningDelta: undefined, done: true };
      };

      const { router } = createRouter({ llmClient });
      const response = router.handleMessageStream(makeInbound("Test"));
      const events: Array<unknown> = [];

      for await (const event of response.stream) {
        events.push(event);
      }

      const reasoningEvents = events.filter((e) => (e as Record<string, unknown>)?.type === "reasoning-delta");
      const textEvents = events.filter((e) => (e as Record<string, unknown>)?.type === "text-delta");

      assert.equal(reasoningEvents.length, 3);
      assert.equal(textEvents.length, 3);

      // Verify interleaving: reasoning, text, reasoning, text, reasoning, text
      assert.equal((events[0] as Record<string, unknown>)?.type, "reasoning-delta");
      assert.equal((events[1] as Record<string, unknown>)?.type, "text-delta");
      assert.equal((events[2] as Record<string, unknown>)?.type, "reasoning-delta");
      assert.equal((events[3] as Record<string, unknown>)?.type, "text-delta");
      assert.equal((events[4] as Record<string, unknown>)?.type, "reasoning-delta");
      assert.equal((events[5] as Record<string, unknown>)?.type, "text-delta");
    });

    it("accumulates reasoning across multiple chunks into done event", async () => {
      const llmClient = createMockLlmClient();
      (llmClient as unknown as Record<string, unknown>)["chatStream"] = async function* () {
        yield { delta: "", reasoningDelta: "First ", done: false };
        yield { delta: "", reasoningDelta: "second ", done: false };
        yield { delta: "", reasoningDelta: "third", done: false };
        yield { delta: "Response", reasoningDelta: undefined, done: true };
      };

      const { router } = createRouter({ llmClient });
      const response = router.handleMessageStream(makeInbound("Test"));
      let doneReasoning: string | undefined = undefined;

      for await (const event of response.stream) {
        const e = event as Record<string, unknown>;
        if (e.type === "done") {
          doneReasoning = e.reasoning as string | undefined;
        }
      }

      assert.equal(doneReasoning, "First second third");
    });
  });
});
