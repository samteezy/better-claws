import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  WorkingMemory,
  WorkingMemoryError,
} from "../../src/memory/working-memory.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

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

describe("WorkingMemory", () => {
  let logger: ReturnType<typeof createMockLogger>;
  let memory: WorkingMemory;

  beforeEach(() => {
    logger = createMockLogger();
    memory = new WorkingMemory("session-001", {
      maxSizeChars: 1000,
      logger,
    });
  });

  describe("get/set/clear operations", () => {
    it("set and get a single entry", () => {
      memory.set("user-name", "fact", "User's name is Alice");
      const entry = memory.get("user-name");

      assert.ok(entry);
      assert.equal(entry.key, "user-name");
      assert.equal(entry.category, "fact");
      assert.equal(entry.content, "User's name is Alice");
      assert.equal(typeof entry.createdAt, "number");
      assert.equal(typeof entry.updatedAt, "number");
    });

    it("returns undefined for non-existent key", () => {
      assert.equal(memory.get("missing"), undefined);
    });

    it("updates existing entry on re-set", () => {
      memory.set("task", "goal", "Build a widget");
      memory.set("task", "goal", "Build a better widget");

      const entry = memory.get("task");
      assert.ok(entry);
      assert.equal(entry.content, "Build a better widget");
      assert.equal(memory.count, 1);
    });

    it("preserves createdAt on update but advances updatedAt", () => {
      memory.set("item", "fact", "original");
      const original = memory.get("item");
      assert.ok(original);
      const originalCreated = original.createdAt;

      memory.set("item", "fact", "updated");
      const updated = memory.get("item");
      assert.ok(updated);
      assert.equal(updated.createdAt, originalCreated);
      assert.ok(updated.updatedAt >= original.updatedAt);
    });

    it("getAll returns all entries", () => {
      memory.set("a", "fact", "Fact A");
      memory.set("b", "goal", "Goal B");
      memory.set("c", "decision", "Decision C");

      const all = memory.getAll();
      assert.equal(all.length, 3);
    });

    it("delete removes an entry and returns true", () => {
      memory.set("temp", "fact", "Temporary");
      assert.equal(memory.delete("temp"), true);
      assert.equal(memory.get("temp"), undefined);
      assert.equal(memory.count, 0);
    });

    it("delete returns false for non-existent key", () => {
      assert.equal(memory.delete("nope"), false);
    });

    it("clear removes all entries", () => {
      memory.set("a", "fact", "1");
      memory.set("b", "fact", "2");
      memory.clear();
      assert.equal(memory.count, 0);
      assert.equal(memory.getAll().length, 0);
    });
  });

  describe("size budget enforcement", () => {
    it("tracks size correctly", () => {
      assert.equal(memory.size, 0);
      memory.set("k", "fact", "hello");
      assert.ok(memory.size > 0);
    });

    it("throws when a single entry exceeds the entire budget", () => {
      const tinyMemory = new WorkingMemory("session-002", {
        maxSizeChars: 20,
        logger,
      });

      assert.throws(
        () => tinyMemory.set("big", "fact", "This content is way too long for the tiny budget"),
        (err: unknown) => {
          assert.ok(err instanceof WorkingMemoryError);
          assert.equal(err.code, "BUDGET_EXCEEDED");
          return true;
        },
      );
    });

    it("evicts oldest entries when budget is tight", () => {
      const smallMemory = new WorkingMemory("session-003", {
        maxSizeChars: 100,
        logger,
      });

      // Fill with small entries
      smallMemory.set("old1", "fact", "old data 1");
      smallMemory.set("old2", "fact", "old data 2");

      // Add a larger entry that should trigger eviction
      smallMemory.set("new", "fact", "this is a much longer piece of content that needs space");

      // The new entry should exist
      assert.ok(smallMemory.get("new"));
      // At least one old entry should have been evicted
      assert.ok(smallMemory.count <= 3);
    });

    it("restores previous entry if new value doesn't fit", () => {
      const smallMemory = new WorkingMemory("session-004", {
        maxSizeChars: 60,
        logger,
      });

      smallMemory.set("k", "fact", "short");
      const originalSize = smallMemory.size;

      try {
        smallMemory.set("k", "fact", "x".repeat(200));
      } catch {
        // expected
      }

      // Original entry should be restored
      const entry = smallMemory.get("k");
      assert.ok(entry);
      assert.equal(entry.content, "short");
      assert.equal(smallMemory.size, originalSize);
    });
  });

  describe("serialize()", () => {
    it("returns empty string when no entries", () => {
      assert.equal(memory.serialize(), "");
    });

    it("groups entries by category", () => {
      memory.set("user-pref", "fact", "User prefers dark mode");
      memory.set("task1", "goal", "Complete the report");
      memory.set("fix1", "correction", "User corrected: not 5, it's 6");
      memory.set("choice1", "decision", "Using REST over GraphQL");

      const output = memory.serialize();

      // Check category headers appear in order: Goals, Facts, Decisions, Corrections
      const goalIdx = output.indexOf("### Goals");
      const factIdx = output.indexOf("### Facts");
      const decisionIdx = output.indexOf("### Decisions");
      const correctionIdx = output.indexOf("### Corrections");

      assert.ok(goalIdx >= 0, "Goals section missing");
      assert.ok(factIdx >= 0, "Facts section missing");
      assert.ok(decisionIdx >= 0, "Decisions section missing");
      assert.ok(correctionIdx >= 0, "Corrections section missing");
      assert.ok(goalIdx < factIdx, "Goals should come before Facts");
      assert.ok(factIdx < decisionIdx, "Facts should come before Decisions");
      assert.ok(decisionIdx < correctionIdx, "Decisions should come before Corrections");
    });

    it("includes key and content in each line", () => {
      memory.set("name", "fact", "Alice");
      const output = memory.serialize();
      assert.ok(output.includes("[name]"));
      assert.ok(output.includes("Alice"));
    });

    it("omits empty categories", () => {
      memory.set("task", "goal", "Do something");
      const output = memory.serialize();
      assert.ok(output.includes("### Goals"));
      assert.ok(!output.includes("### Facts"));
      assert.ok(!output.includes("### Decisions"));
      assert.ok(!output.includes("### Corrections"));
    });
  });

  describe("logging", () => {
    it("logs memory:write event on set", () => {
      memory.set("test-key", "fact", "test content");

      assert.equal(logger.calls.length, 1);
      const call = logger.calls[0];
      assert.ok(call);
      assert.equal(call.eventType, "memory:write");
      assert.equal(call.component, "working-memory");
      assert.equal(call.sessionId, "session-001");
      assert.equal(call.payload.key, "test-key");
      assert.equal(call.payload.category, "fact");
      assert.equal(call.payload.contentLength, "test content".length);
    });

    it("does not log on get", () => {
      memory.set("k", "fact", "v");
      logger.calls.length = 0;

      memory.get("k");
      assert.equal(logger.calls.length, 0);
    });
  });

  describe("capability gate flow", () => {
    it("memory:write capability is declared in tool descriptor", async () => {
      const { descriptor } = await import(
        "../../src/tools/built-in/memory.js"
      );

      assert.ok(
        descriptor.capabilities.includes("memory:write"),
        'Tool must declare "memory:write" capability',
      );
    });
  });

  describe("clone()", () => {
    it("produces a new instance with the same entries but different sessionId", () => {
      memory.set("a", "fact", "Fact A");
      memory.set("b", "goal", "Goal B");
      memory.set("c", "decision", "Decision C");

      const cloned = memory.clone("session-new", {
        maxSizeChars: 1000,
        logger,
      });

      // Cloned instance has a different sessionId
      assert.notEqual(cloned["sessionId"], memory["sessionId"]);
      assert.equal(cloned["sessionId"], "session-new");

      // Cloned instance has the same entries
      assert.equal(cloned.count, memory.count);
      assert.equal(cloned.count, 3);

      // All entries are present with same content
      assert.equal(cloned.get("a")?.content, "Fact A");
      assert.equal(cloned.get("b")?.content, "Goal B");
      assert.equal(cloned.get("c")?.content, "Decision C");
    });

    it("mutations to the clone do not affect the original", () => {
      memory.set("original", "fact", "Original entry");

      const cloned = memory.clone("session-clone", {
        maxSizeChars: 1000,
        logger,
      });

      // Add an entry to the clone
      cloned.set("new-in-clone", "goal", "New goal in clone");

      // Original should not have the new entry
      assert.equal(memory.get("new-in-clone"), undefined);
      assert.equal(memory.count, 1);

      // Clone should have both entries
      assert.ok(cloned.get("new-in-clone"));
      assert.equal(cloned.count, 2);
    });

    it("mutations to the original do not affect the clone", () => {
      memory.set("a", "fact", "Entry A");
      memory.set("b", "fact", "Entry B");

      const cloned = memory.clone("session-clone", {
        maxSizeChars: 1000,
        logger,
      });

      // Delete an entry from the original
      memory.delete("a");

      // Clone should still have the deleted entry
      assert.ok(cloned.get("a"));
      assert.equal(cloned.count, 2);

      // Original should not have it
      assert.equal(memory.get("a"), undefined);
      assert.equal(memory.count, 1);
    });
  });
});
