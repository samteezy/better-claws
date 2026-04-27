import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExecutionContext } from "../../src/types.js";
import { DEFAULT_CONFIG } from "../../src/config.js";
import {
  handler,
  workingMemoryRegistry,
  setLongTermStore,
  setRetriever,
} from "../../src/tools/built-in/memory.js";
import { TfIdfRetriever } from "../../src/memory/retrieval.js";
import { WorkingMemory } from "../../src/memory/working-memory.js";
import { LongTermStore } from "../../src/memory/long-term-store.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

// Test helpers

function createMockLogger() {
  const calls: Array<{
    sessionId: string | null;
    eventType: string;
    component: string;
    payload: Record<string, unknown>;
  }> = [];
  const logger = {
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
  return logger;
}

async function withTempDir(
  fn: (tempDir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await mkdtemp(join(tmpdir(), "bc-memory-update-"));
  try {
    await fn(tempDir);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function makeContext(sessionId: string = "test-session"): ExecutionContext {
  return {
    sessionId,
    capabilities: ["memory:read", "memory:write"],
    scratchDir: "/tmp",
    timeout: 5000,
    secrets: new Map<string, string>(),
  };
}

describe("memory tool", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let sessionId: string;

  beforeEach(() => {
    logger = createMockLogger();
    sessionId = "test-session";

    // Register working memory for the test session
    const memory = new WorkingMemory(sessionId, {
      maxSizeChars: DEFAULT_CONFIG.memory.workingMemoryBudgetChars,
      logger,
    });
    workingMemoryRegistry.set(sessionId, memory);
  });

  afterEach(() => {
    workingMemoryRegistry.clear();
    setLongTermStore(null);
    setRetriever(null);
  });

  describe("set action", () => {
    it("creates an entry in working memory with valid parameters", async () => {
      const result = await handler.execute(
        {
          action: "set",
          key: "user-name",
          category: "fact",
          content: "User prefers to be called Bob",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.output);
      const output = result.output as Record<string, unknown>;
      assert.strictEqual(output["action"], "set");
      assert.strictEqual(output["key"], "user-name");
      assert.strictEqual(output["entryCount"], 1);
      assert.strictEqual(typeof output["sizeChars"], "number");
      assert.ok(result.durationMs >= 0);
    });

    it("returns error when key is missing", async () => {
      const result = await handler.execute(
        {
          action: "set",
          category: "fact",
          content: "Some content",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.output, null);
      assert.ok(result.error);
      assert.match(result.error, /key.*category.*content/);
    });

    it("returns error when category is missing", async () => {
      const result = await handler.execute(
        {
          action: "set",
          key: "test-key",
          content: "Some content",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.output, null);
      assert.ok(result.error);
      assert.match(result.error, /key.*category.*content/);
    });

    it("returns error when content is missing", async () => {
      const result = await handler.execute(
        {
          action: "set",
          key: "test-key",
          category: "fact",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, false);
      assert.strictEqual(result.output, null);
      assert.ok(result.error);
      assert.match(result.error, /key.*category.*content/);
    });

    it("writes entry to long-term store when instance is set", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        const result = await handler.execute(
          {
            action: "set",
            key: "test-key",
            category: "fact",
            content: "Test fact content",
          },
          makeContext(sessionId),
        );

        assert.strictEqual(result.success, true);

        // Verify entry is in long-term store
        const storeEntries = store.getAll();
        assert.strictEqual(storeEntries.length, 1);
        const entry = storeEntries[0]!;
        assert.strictEqual(entry.content, "Test fact content");
        assert.strictEqual(entry.category, "fact");
        assert.ok(entry.tags.includes("wm:test-key"));
        assert.ok(entry.tags.includes("fact"));
        assert.strictEqual(entry.confidence, 1.0);
        assert.ok(entry.sourceSessions.includes(sessionId));
      });
    });

    it("maps working-memory categories to long-term-store categories correctly", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        const testCases: Array<{
          wmCategory: string;
          ltCategory: "fact" | "project" | "preference" | "procedure";
        }> = [
          { wmCategory: "fact", ltCategory: "fact" },
          { wmCategory: "goal", ltCategory: "project" },
          { wmCategory: "correction", ltCategory: "preference" },
          { wmCategory: "decision", ltCategory: "procedure" },
        ];

        for (const testCase of testCases) {
          workingMemoryRegistry.clear();
          const memory = new WorkingMemory(sessionId, {
            maxSizeChars: DEFAULT_CONFIG.memory.workingMemoryBudgetChars,
            logger,
          });
          workingMemoryRegistry.set(sessionId, memory);

          await handler.execute(
            {
              action: "set",
              key: `key-${testCase.wmCategory}`,
              category: testCase.wmCategory,
              content: "Test content",
            },
            makeContext(sessionId),
          );

          const entries = store.search({ tags: [`wm:key-${testCase.wmCategory}`] });
          assert.strictEqual(entries.length, 1);
          assert.strictEqual(entries[0]!.category, testCase.ltCategory);
        }
      });
    });

    it("updates existing long-term store entry on second set with same key", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        // First set
        await handler.execute(
          {
            action: "set",
            key: "test-key",
            category: "fact",
            content: "Original content",
          },
          makeContext(sessionId),
        );

        let storeEntries = store.getAll();
        assert.strictEqual(storeEntries.length, 1);
        const originalId = storeEntries[0]!.id;

        // Second set with same key, different content
        await handler.execute(
          {
            action: "set",
            key: "test-key",
            category: "fact",
            content: "Updated content",
          },
          makeContext(sessionId),
        );

        storeEntries = store.getAll();
        assert.strictEqual(storeEntries.length, 1, "should not create duplicate entry");
        const updatedEntry = storeEntries[0]!;
        assert.strictEqual(updatedEntry.id, originalId, "entry id should remain the same");
        assert.strictEqual(updatedEntry.content, "Updated content");
      });
    });

    it("gracefully handles missing long-term store (null instance)", async () => {
      setLongTermStore(null);

      const result = await handler.execute(
        {
          action: "set",
          key: "test-key",
          category: "fact",
          content: "Test content",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, true, "should succeed without store");
      assert.ok(result.output);
      const output = result.output as Record<string, unknown>;
      assert.strictEqual(output["action"], "set");
      assert.strictEqual(output["key"], "test-key");
    });

    it("includes wm: tag with key in long-term store entry", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        const key = "my-important-fact";
        await handler.execute(
          {
            action: "set",
            key,
            category: "fact",
            content: "Important content",
          },
          makeContext(sessionId),
        );

        const entries = store.getAll();
        const entry = entries[0]!;
        assert.ok(
          entry.tags.includes(`wm:${key}`),
          `should include tag "wm:${key}"`,
        );
      });
    });

    it("includes category tag in long-term store entry", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        const category = "goal";
        await handler.execute(
          {
            action: "set",
            key: "test-key",
            category,
            content: "Test content",
          },
          makeContext(sessionId),
        );

        const entries = store.getAll();
        const entry = entries[0]!;
        assert.ok(entry.tags.includes(category), `should include tag "${category}"`);
      });
    });

    it("sets confidence to 1.0 for new long-term store entries", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        await handler.execute(
          {
            action: "set",
            key: "test-key",
            category: "fact",
            content: "Test content",
          },
          makeContext(sessionId),
        );

        const entries = store.getAll();
        assert.strictEqual(entries[0]!.confidence, 1.0);
      });
    });

    it("sets confidence to 1.0 when updating existing long-term store entry", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        // First set
        await handler.execute(
          {
            action: "set",
            key: "test-key",
            category: "fact",
            content: "Original content",
          },
          makeContext(sessionId),
        );

        // Manually decay confidence
        const entries = store.getAll();
        const entry = entries[0]!;
        entry.confidence = 0.5;

        // Second set
        await handler.execute(
          {
            action: "set",
            key: "test-key",
            category: "fact",
            content: "Updated content",
          },
          makeContext(sessionId),
        );

        const updated = store.getAll()[0]!;
        assert.strictEqual(updated.confidence, 1.0, "confidence should be reset to 1.0");
      });
    });

    it("records source session in long-term store entry", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        const mySessionId = "custom-session-123";

        // Register working memory for custom session
        const memory = new WorkingMemory(mySessionId, {
          maxSizeChars: DEFAULT_CONFIG.memory.workingMemoryBudgetChars,
          logger,
        });
        workingMemoryRegistry.set(mySessionId, memory);

        await handler.execute(
          {
            action: "set",
            key: "test-key",
            category: "fact",
            content: "Test content",
          },
          makeContext(mySessionId),
        );

        const entries = store.getAll();
        assert.strictEqual(entries.length, 1, "should have one entry in store");
        assert.ok(
          entries[0]!.sourceSessions.includes(mySessionId),
          "should record source session",
        );
      });
    });

    it("can update same key across multiple calls without duplicating", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        const key = "evolving-fact";

        // Set 1
        await handler.execute(
          {
            action: "set",
            key,
            category: "fact",
            content: "Version 1",
          },
          makeContext(sessionId),
        );
        assert.strictEqual(store.getAll().length, 1);

        // Set 2
        await handler.execute(
          {
            action: "set",
            key,
            category: "fact",
            content: "Version 2",
          },
          makeContext(sessionId),
        );
        assert.strictEqual(store.getAll().length, 1);

        // Set 3
        await handler.execute(
          {
            action: "set",
            key,
            category: "fact",
            content: "Version 3",
          },
          makeContext(sessionId),
        );
        assert.strictEqual(store.getAll().length, 1);

        assert.strictEqual(store.getAll()[0]!.content, "Version 3");
      });
    });
  });

  describe("delete action", () => {
    it("deletes an entry from working memory", async () => {
      // First, set an entry
      await handler.execute(
        {
          action: "set",
          key: "test-key",
          category: "fact",
          content: "Test content",
        },
        makeContext(sessionId),
      );

      const memory = workingMemoryRegistry.get(sessionId);
      assert.ok(memory);
      assert.strictEqual(memory.count, 1);

      // Now delete it
      const result = await handler.execute(
        {
          action: "delete",
          key: "test-key",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.output);
      const output = result.output as Record<string, unknown>;
      assert.strictEqual(output["action"], "delete");
      assert.strictEqual(output["key"], "test-key");
      assert.strictEqual(output["existed"], true);
      assert.strictEqual(memory.count, 0);
    });

    it("returns error when key is missing for delete", async () => {
      const result = await handler.execute(
        {
          action: "delete",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.match(result.error, /delete.*key/);
    });

    it("indicates key did not exist when deleting non-existent entry", async () => {
      const result = await handler.execute(
        {
          action: "delete",
          key: "nonexistent",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.output);
      const output = result.output as Record<string, unknown>;
      assert.strictEqual(output["existed"], false);
    });
  });

  describe("clear action", () => {
    it("clears all entries from working memory", async () => {
      // Set multiple entries
      await handler.execute(
        {
          action: "set",
          key: "key1",
          category: "fact",
          content: "Content 1",
        },
        makeContext(sessionId),
      );
      await handler.execute(
        {
          action: "set",
          key: "key2",
          category: "goal",
          content: "Content 2",
        },
        makeContext(sessionId),
      );

      const memory = workingMemoryRegistry.get(sessionId);
      assert.ok(memory);
      assert.strictEqual(memory.count, 2);

      // Clear all
      const result = await handler.execute(
        {
          action: "clear",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.output);
      const output = result.output as Record<string, unknown>;
      assert.strictEqual(output["action"], "clear");
      assert.strictEqual(output["entryCount"], 0);
      assert.strictEqual(memory.count, 0);
    });

    it("succeeds when clearing already-empty memory", async () => {
      const result = await handler.execute(
        {
          action: "clear",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, true);
      assert.ok(result.output);
      const output = result.output as Record<string, unknown>;
      assert.strictEqual(output["entryCount"], 0);
    });
  });

  describe("error handling", () => {
    it("returns error when no working memory is registered for session", async () => {
      workingMemoryRegistry.clear();

      const result = await handler.execute(
        {
          action: "set",
          key: "test",
          category: "fact",
          content: "content",
        },
        makeContext("unknown-session"),
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.match(result.error, /unknown-session/);
    });

    it("returns error for unknown action", async () => {
      const result = await handler.execute(
        {
          action: "invalid-action",
        },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.match(result.error, /Unknown action/);
    });

    it("includes durationMs in error responses", async () => {
      const result = await handler.execute(
        {
          action: "invalid-action",
        },
        makeContext(sessionId),
      );

      assert.ok(result.durationMs >= 0);
    });
  });

  describe("multiple sessions", () => {
    it("keeps working memory isolated between sessions", async () => {
      const session1 = "session-1";
      const session2 = "session-2";

      // Set up both sessions
      const logger1 = createMockLogger();
      const logger2 = createMockLogger();
      const memory1 = new WorkingMemory(session1, {
        maxSizeChars: DEFAULT_CONFIG.memory.workingMemoryBudgetChars,
        logger: logger1,
      });
      const memory2 = new WorkingMemory(session2, {
        maxSizeChars: DEFAULT_CONFIG.memory.workingMemoryBudgetChars,
        logger: logger2,
      });
      workingMemoryRegistry.set(session1, memory1);
      workingMemoryRegistry.set(session2, memory2);

      // Set different values in each session
      await handler.execute(
        {
          action: "set",
          key: "shared-key",
          category: "fact",
          content: "Value from session 1",
        },
        makeContext(session1),
      );

      await handler.execute(
        {
          action: "set",
          key: "shared-key",
          category: "fact",
          content: "Value from session 2",
        },
        makeContext(session2),
      );

      // Verify isolation
      const entry1 = memory1.get("shared-key");
      const entry2 = memory2.get("shared-key");

      assert.strictEqual(entry1?.content, "Value from session 1");
      assert.strictEqual(entry2?.content, "Value from session 2");
    });

    it("writes to long-term store with correct sessionId for each session", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        const session1 = "session-1";
        const session2 = "session-2";

        // Set up both sessions
        const logger1 = createMockLogger();
        const logger2 = createMockLogger();
        const memory1 = new WorkingMemory(session1, {
          maxSizeChars: DEFAULT_CONFIG.memory.workingMemoryBudgetChars,
          logger: logger1,
        });
        const memory2 = new WorkingMemory(session2, {
          maxSizeChars: DEFAULT_CONFIG.memory.workingMemoryBudgetChars,
          logger: logger2,
        });
        workingMemoryRegistry.set(session1, memory1);
        workingMemoryRegistry.set(session2, memory2);

        // Set entries from both sessions
        await handler.execute(
          {
            action: "set",
            key: "fact-1",
            category: "fact",
            content: "From session 1",
          },
          makeContext(session1),
        );

        await handler.execute(
          {
            action: "set",
            key: "fact-2",
            category: "fact",
            content: "From session 2",
          },
          makeContext(session2),
        );

        // Verify both entries are recorded with correct sessions
        const entries = store.getAll();
        assert.strictEqual(entries.length, 2);

        const entry1 = entries.find((e) => e.tags.includes("wm:fact-1"));
        const entry2 = entries.find((e) => e.tags.includes("wm:fact-2"));

        assert.ok(entry1?.sourceSessions.includes(session1));
        assert.ok(entry2?.sourceSessions.includes(session2));
      });
    });
  });

  describe("search action", () => {
    it("returns results for matching query", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        await store.create({
          category: "fact",
          content: "The deployment pipeline uses GitHub Actions",
          sourceSessions: ["s1"],
          confidence: 1.0,
          tags: ["infrastructure"],
        });
        await store.create({
          category: "preference",
          content: "User prefers dark mode in all editors",
          sourceSessions: ["s1"],
          confidence: 1.0,
          tags: ["ui"],
        });

        const retriever = new TfIdfRetriever({ store });
        setRetriever(retriever);

        const result = await handler.execute(
          { action: "search", query: "deployment pipeline" },
          makeContext(sessionId),
        );

        assert.strictEqual(result.success, true);
        const output = result.output as Record<string, unknown>;
        assert.strictEqual(output["action"], "search");
        assert.strictEqual(output["query"], "deployment pipeline");
        assert.ok((output["resultCount"] as number) > 0);

        const results = output["results"] as Array<Record<string, unknown>>;
        assert.ok(results.length > 0);
        assert.ok(
          (results[0]!["content"] as string).includes("deployment"),
          "top result should match query",
        );
      });
    });

    it("returns empty results for non-matching query", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        await store.create({
          category: "fact",
          content: "The sky is blue",
          sourceSessions: ["s1"],
          confidence: 1.0,
          tags: [],
        });

        const retriever = new TfIdfRetriever({ store });
        setRetriever(retriever);

        const result = await handler.execute(
          { action: "search", query: "xyznonexistent" },
          makeContext(sessionId),
        );

        assert.strictEqual(result.success, true);
        const output = result.output as Record<string, unknown>;
        assert.strictEqual(output["resultCount"], 0);
        assert.deepStrictEqual(output["results"], []);
      });
    });

    it("respects topK parameter", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        // Create several entries with the same term so they all match
        for (let i = 0; i < 5; i++) {
          await store.create({
            category: "fact",
            content: `Deployment fact number ${i} about infrastructure`,
            sourceSessions: ["s1"],
            confidence: 1.0,
            tags: ["infra"],
          });
        }

        const retriever = new TfIdfRetriever({ store });
        setRetriever(retriever);

        const result = await handler.execute(
          { action: "search", query: "deployment infrastructure", topK: 2 },
          makeContext(sessionId),
        );

        assert.strictEqual(result.success, true);
        const output = result.output as Record<string, unknown>;
        const results = output["results"] as Array<Record<string, unknown>>;
        assert.ok(results.length <= 2, `expected at most 2 results, got ${results.length}`);
      });
    });

    it("returns error when query is missing", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        const retriever = new TfIdfRetriever({ store });
        setRetriever(retriever);

        const result = await handler.execute(
          { action: "search" },
          makeContext(sessionId),
        );

        assert.strictEqual(result.success, false);
        assert.ok(result.error);
        assert.match(result.error, /query/);
      });
    });

    it("returns error when retriever is not initialized", async () => {
      setRetriever(null);

      const result = await handler.execute(
        { action: "search", query: "test" },
        makeContext(sessionId),
      );

      assert.strictEqual(result.success, false);
      assert.ok(result.error);
      assert.match(result.error, /retriever not initialized/);
    });

    it("succeeds without working memory registered", async () => {
      await withTempDir(async (tempDir) => {
        workingMemoryRegistry.clear();

        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        const retriever = new TfIdfRetriever({ store });
        setRetriever(retriever);

        const result = await handler.execute(
          { action: "search", query: "anything" },
          makeContext("no-wm-session"),
        );

        assert.strictEqual(
          result.success,
          true,
          "search should not require working memory",
        );
      });
    });

    it("result shape includes expected fields", async () => {
      await withTempDir(async (tempDir) => {
        const store = new LongTermStore({
          directory: tempDir,
          config: DEFAULT_CONFIG.memory,
          logger,
        });
        await store.load();
        setLongTermStore(store);

        await store.create({
          category: "procedure",
          content: "Run npm test before committing code changes",
          sourceSessions: ["s1"],
          confidence: 0.9,
          tags: ["workflow", "testing"],
        });

        const retriever = new TfIdfRetriever({ store });
        setRetriever(retriever);

        const result = await handler.execute(
          { action: "search", query: "npm test committing" },
          makeContext(sessionId),
        );

        assert.strictEqual(result.success, true);
        const output = result.output as Record<string, unknown>;
        const results = output["results"] as Array<Record<string, unknown>>;
        assert.ok(results.length > 0);

        const first = results[0]!;
        assert.strictEqual(typeof first["id"], "string");
        assert.strictEqual(typeof first["category"], "string");
        assert.strictEqual(typeof first["content"], "string");
        assert.ok(Array.isArray(first["tags"]));
        assert.strictEqual(typeof first["confidence"], "number");
        assert.strictEqual(typeof first["score"], "number");
      });
    });
  });
});
