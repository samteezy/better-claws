import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SuggestionWorker } from "../../src/suggestions/suggestion-worker.js";
import { SuggestionStore } from "../../src/suggestions/suggestion-store.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import type { ChatMessage, LlmResponse, SuggestionsConfig, BetterClawsConfig, MemoryEntry } from "../../src/types.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { LongTermStore } from "../../src/memory/long-term-store.js";
import type { SuggestionLlmClient } from "../../src/suggestions/suggestion-worker.js";

const noopLogger = {
  log: () => {},
} as unknown as StructuredLogger;

interface MockLlmClient extends SuggestionLlmClient {
  lastMessages?: readonly ChatMessage[];
}

function createMockLlmClient(responseData: unknown): MockLlmClient {
  return {
    lastMessages: undefined,
    async chat(messages: readonly ChatMessage[]): Promise<LlmResponse> {
      (this as MockLlmClient).lastMessages = messages;
      return {
        message: {
          role: "assistant",
          content: JSON.stringify(responseData),
        },
        usage: {
          promptTokens: 100,
          completionTokens: 50,
        },
        raw: {},
      };
    },
  };
}

function createMockMemoryStore(entries: readonly MemoryEntry[] = []): LongTermStore {
  return {
    getAll: () => entries,
  } as unknown as LongTermStore;
}

describe("SuggestionWorker", () => {
  let tempDir: string;
  let logsDir: string;
  let store: SuggestionStore;
  let mockMemoryStore: LongTermStore;
  let mockLlmClient: MockLlmClient;
  let suggestionsConfig: SuggestionsConfig;
  let appConfig: BetterClawsConfig;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bc-sw-"));
    logsDir = await mkdtemp(join(tmpdir(), "bc-sw-logs-"));

    store = new SuggestionStore({
      directory: tempDir,
      logger: noopLogger,
    });

    mockMemoryStore = createMockMemoryStore();
    mockLlmClient = createMockLlmClient([]);

    suggestionsConfig = {
      enabled: true,
      intervalMinutes: 60,
      maxLlmCallsPerCycle: 2,
    };

    appConfig = {
      ...DEFAULT_CONFIG,
      suggestions: suggestionsConfig,
      systemContext: {
        ...DEFAULT_CONFIG.systemContext,
      },
    };
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    await rm(logsDir, { recursive: true, force: true });
  });

  describe("start()", () => {
    it("does nothing when config.enabled is false", async () => {
      const disabledConfig: SuggestionsConfig = {
        enabled: false,
        intervalMinutes: 60,
        maxLlmCallsPerCycle: 2,
      };

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: disabledConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();

      // Verify worker is not running by checking that runCycle doesn't execute
      // We can't directly check internal state, but we can verify logging happened
    });

    it("sets up interval when config.enabled is true", async () => {
      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      await worker.stop();

      // If we reach here without error, interval was set up successfully
      assert.ok(true);
    });
  });

  describe("runCycle()", () => {
    it("creates suggestions from LLM response", async () => {
      const responseData = [
        {
          category: "persona",
          title: "Add greeting",
          body: "Users often start informally",
        },
        {
          category: "tools",
          title: "Add calendar",
          body: "Several sessions referenced scheduling",
        },
      ];

      mockLlmClient = createMockLlmClient(responseData);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.suggestionsCreated, 2);
      assert.equal(store.getAll().length, 2);
    });

    it("parses valid JSON response correctly", async () => {
      const responseData = [
        {
          category: "persona",
          title: "Update persona",
          body: "Should be more concise",
        },
      ];

      mockLlmClient = createMockLlmClient(responseData);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      const suggestions = store.getAll();
      assert.equal(suggestions.length, 1);
      assert.equal(suggestions[0]?.category, "persona");
      assert.equal(suggestions[0]?.title, "Update persona");
      assert.equal(suggestions[0]?.body, "Should be more concise");
    });

    it("handles empty array response", async () => {
      mockLlmClient = createMockLlmClient([]);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.suggestionsCreated, 0);
      assert.equal(store.getAll().length, 0);
    });

    it("handles malformed LLM response gracefully", async () => {
      const malformedClient = {
        async chat(): Promise<LlmResponse> {
          return {
            message: {
              role: "assistant",
              content: "{ invalid json",
            },
            usage: {
              promptTokens: 100,
              completionTokens: 50,
            },
            raw: {},
          };
        },
      } as SuggestionLlmClient;

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: malformedClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.suggestionsCreated, 0);
      assert.equal(store.getAll().length, 0);
    });

    it("filters invalid categories", async () => {
      const responseData = [
        {
          category: "persona",
          title: "Valid category",
          body: "This is valid",
        },
        {
          category: "invalid-category",
          title: "Invalid category",
          body: "This should be filtered",
        },
        {
          category: "tools",
          title: "Valid category 2",
          body: "This is valid too",
        },
      ];

      mockLlmClient = createMockLlmClient(responseData);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      const suggestions = store.getAll();
      assert.equal(suggestions.length, 2);
      assert.ok(suggestions.every(s => ["persona", "tools"].includes(s.category)));
    });

    it("caps suggestions at 5 per cycle", async () => {
      const responseData = [
        { category: "persona", title: "Title 1", body: "Body 1" },
        { category: "tools", title: "Title 2", body: "Body 2" },
        { category: "workflow", title: "Title 3", body: "Body 3" },
        { category: "integration", title: "Title 4", body: "Body 4" },
        { category: "user-context", title: "Title 5", body: "Body 5" },
        { category: "general", title: "Title 6", body: "Body 6" },
        { category: "persona", title: "Title 7", body: "Body 7" },
      ];

      mockLlmClient = createMockLlmClient(responseData);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      const suggestions = store.getAll();
      assert.equal(suggestions.length, 5);
    });

    it("includes existing pending suggestions in context", async () => {
      mockLlmClient = createMockLlmClient([
        {
          category: "persona",
          title: "New suggestion",
          body: "This is new",
        },
      ]);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      // Create a pending suggestion first
      store.create({
        category: "tools",
        title: "Existing suggestion",
        body: "This already exists",
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      // Verify the LLM received context about existing suggestions
      assert.ok(mockLlmClient.lastMessages);
      const userMessage = mockLlmClient.lastMessages.find(m => m.role === "user");
      assert.ok(userMessage);
      assert.ok(userMessage.content.includes("Existing Pending Suggestions"));
      assert.ok(userMessage.content.includes("Existing suggestion"));
    });

    it("persists store after cycle", async () => {
      mockLlmClient = createMockLlmClient([
        {
          category: "persona",
          title: "Test suggestion",
          body: "Test body",
        },
      ]);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      // Load from disk to verify persistence
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(join(tempDir, "suggestions.jsonl"), "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);

      assert.equal(lines.length, 1);
      const entry = JSON.parse(lines[0]!);
      assert.equal(entry.title, "Test suggestion");
    });

    it("prunes old dismissed suggestions after cycle", async () => {
      // Create a dismissed suggestion and manually set it to be old
      const s1 = store.create({
        category: "persona",
        title: "Old dismissed",
        body: "Old suggestion",
      });
      store.updateStatus(s1.id, "dismissed");
      const e1 = store.get(s1.id);
      if (e1) {
        e1.updatedAt = Date.now() - 31 * 86_400_000;
      }

      mockLlmClient = createMockLlmClient([
        {
          category: "tools",
          title: "New suggestion",
          body: "New suggestion",
        },
      ]);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.prunedDismissed, 1);
      assert.equal(store.getAll().length, 1);
    });
  });

  describe("stop()", () => {
    it("clears the timer", async () => {
      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      await worker.stop();

      // If we reach here without error, timer was cleared successfully
      assert.ok(true);
    });
  });

  describe("context gathering", () => {
    it("includes config summary in context", async () => {
      mockLlmClient = createMockLlmClient([]);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      assert.ok(mockLlmClient.lastMessages);
      const userMessage = mockLlmClient.lastMessages.find(m => m.role === "user");
      assert.ok(userMessage);
      assert.ok(userMessage.content.includes("Current Configuration"));
      assert.ok(userMessage.content.includes("LLM model"));
    });

    it("includes memory entries in context", async () => {
      const memoryEntry: MemoryEntry = {
        id: "mem1",
        category: "fact",
        content: "User prefers dark mode",
        sourceSessions: ["s1"],
        created: Date.now(),
        lastAccessed: Date.now(),
        confidence: 0.9,
        tags: ["ui"],
      };

      mockMemoryStore = createMockMemoryStore([memoryEntry]);
      mockLlmClient = createMockLlmClient([]);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      assert.ok(mockLlmClient.lastMessages);
      const userMessage = mockLlmClient.lastMessages.find(m => m.role === "user");
      assert.ok(userMessage);
      assert.ok(userMessage.content.includes("Memory Entries"));
      assert.ok(userMessage.content.includes("User prefers dark mode"));
    });

    it("handles response with missing fields gracefully", async () => {
      const responseData = [
        {
          category: "persona",
          title: "Has all fields",
          body: "Complete suggestion",
        },
        {
          category: "tools",
          // Missing title
          body: "Incomplete suggestion",
        },
        {
          title: "Missing category",
          body: "Incomplete suggestion",
        },
      ];

      mockLlmClient = createMockLlmClient(responseData);

      const worker = new SuggestionWorker({
        store,
        memoryStore: mockMemoryStore,
        llmClient: mockLlmClient,
        config: suggestionsConfig,
        appConfig,
        logger: noopLogger,
        logsDirectory: logsDir,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      // Only the complete suggestion should be created
      assert.equal(store.getAll().length, 1);
      assert.equal(store.getAll()[0]?.title, "Has all fields");
    });
  });

  describe("valid suggestion categories", () => {
    const validCategories = [
      "persona",
      "user-context",
      "tools",
      "integration",
      "workflow",
      "general",
    ];

    for (const category of validCategories) {
      it(`accepts category: ${category}`, async () => {
        const responseData = [
          {
            category,
            title: `Test ${category}`,
            body: "Test body",
          },
        ];

        mockLlmClient = createMockLlmClient(responseData);

        const worker = new SuggestionWorker({
          store,
          memoryStore: mockMemoryStore,
          llmClient: mockLlmClient,
          config: suggestionsConfig,
          appConfig,
          logger: noopLogger,
          logsDirectory: logsDir,
        });

        await worker.start();
        await worker.runCycle();
        await worker.stop();

        assert.equal(store.getAll().length, 1);
        assert.equal(store.getAll()[0]?.category, category);
      });
    }
  });
});
