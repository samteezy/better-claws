import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SessionCompactor,
  CompactionError,
} from "../../src/sessions/compactor.js";
import type {
  ChatMessage,
} from "../../src/types.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { LlmClient } from "../../src/llm/llm-client.js";
import type { SessionManager } from "../../src/sessions/session-manager.js";

function createMockLogger() {
  const logs: Array<Record<string, unknown>> = [];
  return {
    logs,
    log(e: Record<string, unknown>) { logs.push(e); },
    async flush() {},
    async close() {},
  } as unknown as StructuredLogger & { logs: typeof logs };
}

function createMockSessionManager() {
  const appendedEntries: unknown[] = [];
  let history: ChatMessage[] = [];

  const mock = {
    get history() {
      return history;
    },
    set history(h: ChatMessage[]) {
      history = h;
    },
    get appendedEntries() {
      return appendedEntries;
    },
    async getHistory(_sessionId: string) {
      return [...history];
    },
    async appendToLog(_sessionId: string, entry: unknown) {
      appendedEntries.push(entry);
    },
    async close() {},
    getGrants() { return new Map(); },
    get() { return undefined; },
    markActive() {},
    checkIdleSessions() { return []; },
  };

  return mock as unknown as SessionManager & {
    appendedEntries: unknown[];
    history: ChatMessage[];
  };
}

function createMockLlmClient() {
  const responses: Array<{ message: { content: string } }> = [];
  const capturedMessages: ChatMessage[][] = [];
  const capturedOptions: Array<Record<string, unknown>> = [];
  let callCount = 0;

  const mock = {
    get callCount() {
      return callCount;
    },
    get capturedMessages() {
      return capturedMessages;
    },
    get capturedOptions() {
      return capturedOptions;
    },
    pushResponse(msg: { message: { content: string } }) {
      responses.push(msg);
    },
    async chat(
      messages: readonly ChatMessage[],
      _tools?: unknown,
      options?: Record<string, unknown>,
    ) {
      callCount++;
      capturedMessages.push(Array.from(messages));
      if (options) {
        capturedOptions.push({ ...options });
      }
      const response = responses.shift();
      if (!response) {
        return {
          message: { role: "assistant" as const, content: "Default summary" },
          usage: { promptTokens: 10, completionTokens: 5 },
          raw: {},
        };
      }
      return {
        message: { role: "assistant" as const, content: response.message.content },
        usage: { promptTokens: 10, completionTokens: 5 },
        raw: {},
      };
    },
  };

  return mock as unknown as LlmClient & {
    callCount: number;
    capturedMessages: ChatMessage[][];
    capturedOptions: Array<Record<string, unknown>>;
    pushResponse(msg: { message: { content: string } }): void;
  };
}

describe("SessionCompactor", () => {
  describe("compact()", () => {
    it("returns early with zeros when history has fewer than 2 messages", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "Hello" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 100,
        },
        logger: logger as unknown as StructuredLogger,
      });

      const result = await compactor.compact("test-session");

      assert.equal(result.compressedTurnCount, 0);
      assert.equal(result.summaryLength, 0);
      assert.equal(llmClient.callCount, 0, "should not call LLM");
      assert.equal(sessionManager.appendedEntries.length, 0, "should not append to log");
    });

    it("uses weakLlmClient for summarisation when provided", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      const weakLlmClient = createMockLlmClient();
      weakLlmClient.pushResponse({ message: { content: "Test summary" } });

      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "First message" },
        { role: "assistant", content: "Reply one" },
        { role: "user", content: "Second" },
        { role: "assistant", content: "OK" },
        { role: "user", content: "Third message now" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        weakLlmClient: weakLlmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 5,
        },
        logger: logger as unknown as StructuredLogger,
      });

      const result = await compactor.compact("test-session");

      assert.ok(result.compressedTurnCount > 0, `Expected to compress some messages, got ${result.compressedTurnCount}`);
      assert.equal(weakLlmClient.callCount, 1, "weak client should be called");
      assert.equal(llmClient.callCount, 0, "strong client should not be called");
    });

    it("falls back to strong llmClient when no weakLlmClient is provided", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({ message: { content: "Test summary" } });

      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Message 2" },
        { role: "assistant", content: "Reply 2" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 1,
        },
        logger: logger as unknown as StructuredLogger,
      });

      await compactor.compact("test-session");

      assert.equal(llmClient.callCount, 1, "strong client should be used as fallback");
    });

    it("appends compaction log entry with correct type and summary", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({ message: { content: "Summarised content" } });

      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Message 2" },
        { role: "assistant", content: "Reply 2" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 1,
        },
        logger: logger as unknown as StructuredLogger,
      });

      await compactor.compact("test-session");

      assert.equal(sessionManager.appendedEntries.length, 1);
      const entry = sessionManager.appendedEntries[0] as Record<string, unknown>;
      assert.equal(entry.type, "compaction");
      assert.equal(entry.summary, "Summarised content");
      assert.ok(typeof entry.createdAt === "number");
    });

    it("returns correct compressedTurnCount", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({ message: { content: "Summary" } });

      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "Msg1" },
        { role: "assistant", content: "Reply1" },
        { role: "user", content: "Msg2" },
        { role: "assistant", content: "Reply2" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 1, // keep only 4 chars
        },
        logger: logger as unknown as StructuredLogger,
      });

      const result = await compactor.compact("test-session");

      // First 3 messages (12 chars total) exceed the 4-char keepRecentTokens budget
      // so they get summarised
      assert.ok(result.compressedTurnCount > 0);
      const entry = sessionManager.appendedEntries[0] as Record<string, unknown>;
      assert.equal(entry.compressedTurnCount, result.compressedTurnCount);
    });

    it("returns correct summaryLength", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      const summaryText = "A long summary with exactly 42 characters!!";
      llmClient.pushResponse({ message: { content: summaryText } });

      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "Msg1" },
        { role: "assistant", content: "Reply1" },
        { role: "user", content: "Msg2" },
        { role: "assistant", content: "Reply2" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 1,
        },
        logger: logger as unknown as StructuredLogger,
      });

      const result = await compactor.compact("test-session");

      assert.equal(result.summaryLength, summaryText.length);
    });

    it("logs session:compaction event with success:true", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({ message: { content: "Summary" } });

      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "Msg1" },
        { role: "assistant", content: "Reply1" },
        { role: "user", content: "Msg2" },
        { role: "assistant", content: "Reply2" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 1,
        },
        logger: logger as unknown as StructuredLogger,
      });

      await compactor.compact("test-session");

      const compactionLog = logger.logs.find(
        (l) => (l as Record<string, unknown>).eventType === "session:compaction"
      );
      assert.ok(compactionLog);
      const payload = compactionLog.payload as Record<string, unknown>;
      assert.equal(payload.success, true);
    });

    it("propagates error as CompactionError when LLM call fails", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      (llmClient as unknown as Record<string, unknown>).chat = async () => {
        throw new Error("LLM service down");
      };

      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "Msg1" },
        { role: "assistant", content: "Reply1" },
        { role: "user", content: "Msg2" },
        { role: "assistant", content: "Reply2" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 1,
        },
        logger: logger as unknown as StructuredLogger,
      });

      try {
        await compactor.compact("test-session");
        assert.fail("should throw CompactionError");
      } catch (err) {
        assert.ok(err instanceof CompactionError);
        assert.ok((err as CompactionError).message.includes("LLM service down"));
      }
    });

    it("returns early with zeros when all history fits in keepRecentTokens window", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();

      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hi" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 1000, // large budget, everything fits
        },
        logger: logger as unknown as StructuredLogger,
      });

      const result = await compactor.compact("test-session");

      assert.equal(result.compressedTurnCount, 0);
      assert.equal(result.summaryLength, 0);
      assert.equal(llmClient.callCount, 0, "should not call LLM");
    });

    it("sends correct conversation text to LLM", async () => {
      const logger = createMockLogger();
      const llmClient = createMockLlmClient();
      llmClient.pushResponse({ message: { content: "Summary" } });

      const sessionManager = createMockSessionManager();
      sessionManager.history = [
        { role: "user", content: "User message" },
        { role: "assistant", content: "Assistant reply" },
      ];

      const compactor = new SessionCompactor({
        sessionManager,
        llmClient: llmClient as unknown as LlmClient,
        compactionConfig: {
          enabled: true,
          tokenBudget: 1024,
          reserveTokens: 512,
          keepRecentTokens: 0, // keep nothing, summarise everything
        },
        logger: logger as unknown as StructuredLogger,
      });

      await compactor.compact("test-session");

      assert.equal(llmClient.capturedMessages.length, 1);
      const messages = llmClient.capturedMessages[0];
      assert.ok(messages);
      // First message should be system prompt
      assert.equal(messages[0]?.role, "system");
      // Second message should be user with the conversation text
      assert.equal(messages[1]?.role, "user");
      assert.ok(messages[1]?.content.includes("user: User message"));
      assert.ok(messages[1]?.content.includes("assistant: Assistant reply"));
    });
  });
});
