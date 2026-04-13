import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TelegramAdapter } from "../../src/adapters/telegram/telegram-adapter.js";
import { MessageRouter } from "../../src/router/message-router.js";
import { ConfirmationBroker } from "../../src/router/confirmation-broker.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import { LlmClient } from "../../src/llm/llm-client.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { CapabilityGate } from "../../src/tools/capability-gate.js";
import { CompositeExecutor } from "../../src/tools/composite-executor.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { SecretManager } from "../../src/secrets/secret-manager.js";
import type { BetterClawsConfig, LlmStreamChunk } from "../../src/types.js";
import { PromptBuilder } from "../../src/prompt/prompt-builder.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const TEST_CONFIG: BetterClawsConfig = {
  gateway: { host: "127.0.0.1", port: 18700 },
  llm: { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "test", maxTokens: 1024, temperature: 0.7 },
  adapters: {},
  security: { defaultCapabilityPolicy: "deny", sandboxTimeout: 30000, stripEnvironment: true, allowPersistentGrants: false },
  memory: { maxLongTermEntries: 2000, confidenceDecayRate: 0.01, staleThreshold: 0.2, curationIntervalMinutes: 60, curationEnabled: true, workingMemoryBudgetChars: 8192 },
  logging: { directory: "data/logs", redactSensitive: true, retentionDays: 90 },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function createMockSecretManager(): SecretManager {
  const store = new Map<string, string>();
  return {
    register(key: string, value: string) { store.set(key, value); },
    get(key: string) { return store.get(key) ?? ""; },
    has(key: string) { return store.has(key); },
    keys() { return [...store.keys()]; },
    revoke(key: string) { return store.delete(key); },
    projectForTool: () => new Map(),
  } as unknown as SecretManager;
}

function createMockLogger(): StructuredLogger & { logs: Array<Record<string, unknown>> } {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    log(e: Record<string, unknown>) { logs.push(e); },
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger & { logs: typeof logs };
}

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bc-integ-"));
}

/**
 * Creates a mock fetch that behaves as both the Telegram API and LLM API,
 * routing by URL.
 */
function createDualMockFetch(options: {
  telegramUpdates: unknown[];
  llmResponse: string;
}) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const sentMessages: Array<{ chat_id: string; text: string }> = [];
  let telegramCallIndex = 0;

  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body ? JSON.parse(init.body as string) as unknown : null;
    calls.push({ url, body });

    // Telegram getUpdates
    if (url.includes("/getUpdates")) {
      const result = telegramCallIndex < options.telegramUpdates.length
        ? options.telegramUpdates[telegramCallIndex]
        : [];
      telegramCallIndex++;
      return {
        json: async () => ({ ok: true, result }),
        status: 200,
      } as Response;
    }

    // Telegram sendMessage
    if (url.includes("/sendMessage")) {
      const params = body as Record<string, unknown>;
      sentMessages.push({
        chat_id: String(params["chat_id"]),
        text: String(params["text"]),
      });
      return {
        json: async () => ({ ok: true, result: { message_id: 999 } }),
        status: 200,
      } as Response;
    }

    // LLM chat completions
    if (url.includes("/chat/completions")) {
      const requestBody = body as Record<string, unknown> | null;
      const isStream = requestBody?.["stream"] === true;

      if (isStream) {
        // Return SSE stream format
        const sseData = [
          `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: options.llmResponse }, finish_reason: null }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
          `data: [DONE]\n\n`,
        ].join("");
        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(sseData));
            controller.close();
          },
        });
        return {
          ok: true,
          status: 200,
          body: stream,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              role: "assistant",
              content: options.llmResponse,
            },
          }],
          usage: { prompt_tokens: 10, completion_tokens: 5 },
        }),
        status: 200,
      } as Response;
    }

    // Fallback
    return {
      json: async () => ({ ok: true, result: null }),
      status: 200,
    } as Response;
  };

  return { fn: fn as typeof fetch, calls, sentMessages };
}

// ── Integration Tests ───────────────────────────────────────────────────────

describe("Telegram → Router integration", () => {
  it("message received by TelegramAdapter flows through router and response is sent back", async () => {
    const tmpDir = makeTmpDir();
    const logger = createMockLogger();

    const telegramUpdate = [{
      update_id: 1,
      message: {
        message_id: 42,
        from: { id: 100, first_name: "Alice" },
        chat: { id: 200, type: "private" },
        date: 1700000000,
        text: "What is the weather?",
      },
    }];

    const mock = createDualMockFetch({
      telegramUpdates: [telegramUpdate, []], // first poll gets message, second gets nothing
      llmResponse: "I don't have access to weather data right now.",
    });

    // Wire up real components with mock fetch/LLM
    const sessionManager = new SessionManager({
      sessionsDirectory: path.join(tmpDir, "sessions"),
      idleTimeoutMs: 60000,
      logger,
      workingMemoryBudgetChars: 8192,
    });

    const mockSecrets = createMockSecretManager();
    mockSecrets.register("llm:apiKey", "test-key", "config" as never);
    const llmClient = new LlmClient({
      baseUrl: "http://mock-llm:11434/v1",
      secretManager: mockSecrets,
      model: "test-model",
      maxTokens: 1024,
      temperature: 0.7,
      logger,
    });

    // Patch LlmClient to use our mock fetch
    llmClient.chat = async (messages, tools) => {
      const response = await mock.fn("http://mock-llm:11434/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages, tools }),
      });
      const raw = await response.json() as Record<string, unknown>;
      const choices = raw["choices"] as Array<{ message: { role: string; content: string } }>;
      const choice = choices[0]!;
      return {
        message: {
          role: choice.message.role as "assistant",
          content: choice.message.content,
        },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw,
      };
    };
    llmClient.chatStream = async function*(messages, tools): AsyncGenerator<LlmStreamChunk> {
      const resp = await llmClient.chat(messages, tools);
      if (resp.message.content) yield { delta: resp.message.content, done: false };
      yield { delta: "", done: true };
    };

    const toolRegistry = new ToolRegistry({ toolsDirectory: path.join(tmpDir, "tools"), logger });
    const capabilityGate = new CapabilityGate({
      defaultPolicy: "deny",
      logger,
    });
    const executor = new CompositeExecutor({
      scratchBaseDir: path.join(tmpDir, "scratch"),
      defaultTimeout: 5000,
      stripEnvironment: true,
      logger,
    });

    const router = new MessageRouter({
      sessionManager,
      llmClient,
      toolRegistry,
      capabilityGate,
      executor,
      secretManager: createMockSecretManager(),
      logger,
      config: TEST_CONFIG,
      promptBuilder: new PromptBuilder({ systemPrompt: "test", tokenBudget: 1024 }),
      confirmationBroker: new ConfirmationBroker(logger),
    });

    const adapter = new TelegramAdapter({
      token: "test-token",
      pollingIntervalMs: 10,
      pollingTimeoutSecs: 1,
      logger,
      fetchFn: mock.fn,
    });

    router.registerAdapter(adapter);
    await adapter.start();

    // Wait for polling to pick up the message, process it through the router,
    // and send the response back via Telegram
    await new Promise((resolve) => setTimeout(resolve, 300));
    await adapter.stop();

    // Verify the response was sent back through Telegram
    assert.ok(
      mock.sentMessages.length >= 1,
      `Expected at least 1 sent message, got ${mock.sentMessages.length}`,
    );
    assert.equal(mock.sentMessages[0]!.chat_id, "200");
    assert.equal(
      mock.sentMessages[0]!.text,
      "I don't have access to weather data right now.",
    );

    // Verify session was created
    const inboundLogs = logger.logs.filter(
      (l) => l["eventType"] === "message:inbound" && l["component"] === "router",
    );
    assert.ok(inboundLogs.length >= 1, "Router should log inbound message");

    const outboundLogs = logger.logs.filter(
      (l) => l["eventType"] === "message:outbound" && l["component"] === "router",
    );
    assert.ok(outboundLogs.length >= 1, "Router should log outbound message");

    // Cleanup
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adapter error does not crash the router", async () => {
    const tmpDir = makeTmpDir();
    const logger = createMockLogger();

    // First poll errors, second succeeds with a message, third empty
    let callCount = 0;
    const telegramUpdate = {
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: 50, first_name: "Bob" },
        chat: { id: 300, type: "private" },
        date: 1700000000,
        text: "Hello",
      },
    };

    const sentMessages: Array<{ chat_id: string; text: string }> = [];

    const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(init.body as string) as unknown : null;

      if (url.includes("/getUpdates")) {
        callCount++;
        if (callCount === 1) {
          // Simulate API error on first poll
          return {
            json: async () => ({ ok: false, description: "Too many requests", error_code: 429 }),
            status: 429,
          } as Response;
        }
        if (callCount === 2) {
          return {
            json: async () => ({ ok: true, result: [telegramUpdate] }),
            status: 200,
          } as Response;
        }
        return {
          json: async () => ({ ok: true, result: [] }),
          status: 200,
        } as Response;
      }

      if (url.includes("/sendMessage")) {
        const params = body as Record<string, unknown>;
        sentMessages.push({
          chat_id: String(params["chat_id"]),
          text: String(params["text"]),
        });
        return {
          json: async () => ({ ok: true, result: {} }),
          status: 200,
        } as Response;
      }

      if (url.includes("/chat/completions")) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: "assistant", content: "Hi Bob!" } }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
          status: 200,
        } as Response;
      }

      return { json: async () => ({ ok: true }), status: 200 } as Response;
    };

    const sessionManager = new SessionManager({
      sessionsDirectory: path.join(tmpDir, "sessions"),
      idleTimeoutMs: 60000,
      logger,
      workingMemoryBudgetChars: 8192,
    });

    const llmClient = new LlmClient({
      baseUrl: "http://mock-llm:11434/v1",
      secretManager: createMockSecretManager(),
      model: "test",
      maxTokens: 512,
      temperature: 0,
      logger,
    });

    llmClient.chat = async () => {
      const response = await (fn as typeof fetch)("http://mock-llm:11434/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const raw = await response.json() as Record<string, unknown>;
      const choices = raw["choices"] as Array<{ message: { role: string; content: string } }>;
      return {
        message: { role: choices[0]!.message.role as "assistant", content: choices[0]!.message.content },
        usage: { promptTokens: 5, completionTokens: 3 },
        raw,
      };
    };
    llmClient.chatStream = async function*(): AsyncGenerator<LlmStreamChunk> {
      const resp = await llmClient.chat([], undefined);
      if (resp.message.content) yield { delta: resp.message.content, done: false };
      yield { delta: "", done: true };
    };

    const toolRegistry = new ToolRegistry({ toolsDirectory: path.join(tmpDir, "tools"), logger });
    const capabilityGate = new CapabilityGate({ defaultPolicy: "deny", logger });
    const executor = new CompositeExecutor({
      scratchBaseDir: path.join(tmpDir, "scratch"),
      defaultTimeout: 5000,
      stripEnvironment: true,
      logger,
    });

    const router = new MessageRouter({
      sessionManager,
      llmClient,
      toolRegistry,
      capabilityGate,
      executor,
      secretManager: createMockSecretManager(),
      logger,
      config: TEST_CONFIG,
      promptBuilder: new PromptBuilder({ systemPrompt: "test", tokenBudget: 1024 }),
      confirmationBroker: new ConfirmationBroker(logger),
    });

    const adapter = new TelegramAdapter({
      token: "test-token",
      pollingIntervalMs: 10,
      pollingTimeoutSecs: 1,
      logger,
      fetchFn: fn as typeof fetch,
    });

    router.registerAdapter(adapter);
    await adapter.start();

    // Wait for recovery and message processing
    await new Promise((resolve) => setTimeout(resolve, 300));
    await adapter.stop();

    // Despite the initial error, the adapter recovered and processed the message
    assert.ok(
      sentMessages.length >= 1,
      `Expected response after error recovery, got ${sentMessages.length} sent messages`,
    );
    assert.equal(sentMessages[0]!.chat_id, "300");
    assert.equal(sentMessages[0]!.text, "Hi Bob!");

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("multiple messages from different users create separate sessions", async () => {
    const tmpDir = makeTmpDir();
    const logger = createMockLogger();

    const updates = [
      {
        update_id: 1,
        message: {
          message_id: 1,
          from: { id: 10, first_name: "Alice" },
          chat: { id: 10, type: "private" },
          date: 1700000000,
          text: "Hello from Alice",
        },
      },
      {
        update_id: 2,
        message: {
          message_id: 2,
          from: { id: 20, first_name: "Bob" },
          chat: { id: 20, type: "private" },
          date: 1700000001,
          text: "Hello from Bob",
        },
      },
    ];

    const sentMessages: Array<{ chat_id: string; text: string }> = [];
    let llmCallCount = 0;

    const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = init?.body ? JSON.parse(init.body as string) as unknown : null;

      if (url.includes("/getUpdates")) {
        // Return both updates on first poll, then empty
        const result = sentMessages.length === 0 ? updates : [];
        return {
          json: async () => ({ ok: true, result }),
          status: 200,
        } as Response;
      }

      if (url.includes("/sendMessage")) {
        const params = body as Record<string, unknown>;
        sentMessages.push({
          chat_id: String(params["chat_id"]),
          text: String(params["text"]),
        });
        return {
          json: async () => ({ ok: true, result: {} }),
          status: 200,
        } as Response;
      }

      if (url.includes("/chat/completions")) {
        llmCallCount++;
        const content = llmCallCount === 1 ? "Hi Alice!" : "Hi Bob!";
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { role: "assistant", content } }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }),
          status: 200,
        } as Response;
      }

      return { json: async () => ({ ok: true }), status: 200 } as Response;
    };

    const sessionManager = new SessionManager({
      sessionsDirectory: path.join(tmpDir, "sessions"),
      idleTimeoutMs: 60000,
      logger,
      workingMemoryBudgetChars: 8192,
    });

    const llmClient = new LlmClient({
      baseUrl: "http://mock-llm:11434/v1",
      secretManager: createMockSecretManager(),
      model: "test",
      maxTokens: 512,
      temperature: 0,
      logger,
    });

    llmClient.chat = async () => {
      const response = await (fn as typeof fetch)("http://mock-llm:11434/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const raw = await response.json() as Record<string, unknown>;
      const choices = raw["choices"] as Array<{ message: { role: string; content: string } }>;
      return {
        message: { role: choices[0]!.message.role as "assistant", content: choices[0]!.message.content },
        usage: { promptTokens: 5, completionTokens: 3 },
        raw,
      };
    };
    llmClient.chatStream = async function*(): AsyncGenerator<LlmStreamChunk> {
      const resp = await llmClient.chat([], undefined);
      if (resp.message.content) yield { delta: resp.message.content, done: false };
      yield { delta: "", done: true };
    };

    const toolRegistry = new ToolRegistry({ toolsDirectory: path.join(tmpDir, "tools"), logger });
    const capabilityGate = new CapabilityGate({ defaultPolicy: "deny", logger });
    const executor = new CompositeExecutor({
      scratchBaseDir: path.join(tmpDir, "scratch"),
      defaultTimeout: 5000,
      stripEnvironment: true,
      logger,
    });

    const router = new MessageRouter({
      sessionManager,
      llmClient,
      toolRegistry,
      capabilityGate,
      executor,
      secretManager: createMockSecretManager(),
      logger,
      config: TEST_CONFIG,
      promptBuilder: new PromptBuilder({ systemPrompt: "test", tokenBudget: 1024 }),
      confirmationBroker: new ConfirmationBroker(logger),
    });

    const adapter = new TelegramAdapter({
      token: "test-token",
      pollingIntervalMs: 10,
      pollingTimeoutSecs: 1,
      logger,
      fetchFn: fn as typeof fetch,
    });

    router.registerAdapter(adapter);
    await adapter.start();

    await new Promise((resolve) => setTimeout(resolve, 500));
    await adapter.stop();

    // Both users should have received responses
    assert.ok(sentMessages.length >= 2, `Expected 2 responses, got ${sentMessages.length}`);

    const chatIds = sentMessages.map((m) => m.chat_id);
    assert.ok(chatIds.includes("10"), "Alice should have received a response");
    assert.ok(chatIds.includes("20"), "Bob should have received a response");

    // Verify separate sessions were created
    const sessionCreateLogs = logger.logs.filter(
      (l) => l["eventType"] === "session:create",
    );
    assert.ok(
      sessionCreateLogs.length >= 2,
      `Expected 2 sessions created, got ${sessionCreateLogs.length}`,
    );

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
