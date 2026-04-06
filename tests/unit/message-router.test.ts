import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MessageRouter } from "../../src/router/message-router.js";
import type {
  InboundMessage,
  LlmResponse,
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
  } as unknown as SessionManager & { appendedEntries: unknown[] };
}

function createMockLlmClient() {
  const responses: LlmResponse[] = [];
  let callCount = 0;
  const capturedMessages: ChatMessage[][] = [];

  const defaultResponse: LlmResponse = {
    message: { role: "assistant", content: "Default response" },
    usage: { promptTokens: 10, completionTokens: 5 },
    raw: {},
  };

  return {
    get callCount() { return callCount; },
    get capturedMessages() { return capturedMessages; },
    pushResponse(r: LlmResponse) { responses.push(r); },
    async chat(messages: readonly ChatMessage[]) {
      callCount++;
      capturedMessages.push([...messages]);
      return responses.shift() ?? defaultResponse;
    },
  } as unknown as LlmClient & {
    callCount: number;
    capturedMessages: ChatMessage[][];
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
  }) {
    const logger = overrides?.logger ?? createMockLogger();
    const sessionManager = overrides?.sessionManager ?? createMockSessionManager();
    const llmClient = overrides?.llmClient ?? createMockLlmClient();
    const toolRegistry = overrides?.toolRegistry ?? createMockToolRegistry();
    const capabilityGate = overrides?.capabilityGate ?? createMockCapabilityGate();
    const executor = overrides?.executor ?? createMockExecutor();

    const router = new MessageRouter({
      sessionManager: sessionManager as unknown as SessionManager,
      llmClient: llmClient as unknown as LlmClient,
      toolRegistry: toolRegistry as unknown as ToolRegistry,
      capabilityGate: capabilityGate as unknown as CapabilityGate,
      executor: executor as unknown as ToolExecutor,
      secretManager: createMockSecretManager(),
      logger: logger as unknown as StructuredLogger,
      config: TEST_CONFIG,
    });

    return { router, logger, sessionManager, llmClient, toolRegistry, capabilityGate, executor };
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
      (llmClient as unknown as Record<string, unknown>)["chat"] = async () => { throw new Error("LLM down"); };

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
});
