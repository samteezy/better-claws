import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LongTermStore, LongTermStoreError } from "../../src/memory/long-term-store.js";
import { DEFAULT_MEMORY_CONFIG } from "../helpers/memory-config.js";
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

describe("LongTermStore", () => {
  let tempDir: string;
  let logger: ReturnType<typeof createMockLogger>;
  let store: LongTermStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bc-lts-"));
    logger = createMockLogger();
    store = new LongTermStore({
      directory: tempDir,
      config: { ...DEFAULT_MEMORY_CONFIG, maxLongTermEntries: 100 },
      logger,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("create()", () => {
    it("creates an entry and returns an id", async () => {
      const id = await store.create({
        category: "fact",
        content: "User's name is Alice",
        sourceSessions: ["s1"],
        confidence: 0.9,
        tags: ["identity"],
      });

      assert.ok(typeof id === "string");
      assert.ok(id.length > 0);
      assert.equal(store.count, 1);
    });

    it("persists entry to JSONL file", async () => {
      await store.create({
        category: "preference",
        content: "Prefers dark mode",
        sourceSessions: ["s2"],
        confidence: 0.8,
        tags: ["ui"],
      });

      const content = await readFile(join(tempDir, "entries.jsonl"), "utf-8");
      const entry = JSON.parse(content.trim());
      assert.equal(entry.content, "Prefers dark mode");
      assert.equal(entry.category, "preference");
    });

    it("logs memory:write event", async () => {
      await store.create({
        category: "fact",
        content: "test",
        sourceSessions: [],
        confidence: 1,
        tags: [],
      });

      assert.equal(logger.calls.length, 1);
      assert.equal(logger.calls[0]?.eventType, "memory:write");
      assert.equal(logger.calls[0]?.payload.action, "create");
    });

    it("sets created and lastAccessed timestamps", async () => {
      const before = Date.now();
      const id = await store.create({
        category: "fact",
        content: "test",
        sourceSessions: [],
        confidence: 1,
        tags: [],
      });
      const after = Date.now();

      const entry = store.get(id);
      assert.ok(entry);
      assert.ok(entry.created >= before && entry.created <= after);
      assert.ok(entry.lastAccessed >= before && entry.lastAccessed <= after);
    });
  });

  describe("get()", () => {
    it("returns entry by id", async () => {
      const id = await store.create({
        category: "entity",
        content: "Acme Corp is a client",
        sourceSessions: ["s1"],
        confidence: 0.95,
        tags: ["client"],
      });

      const entry = store.get(id);
      assert.ok(entry);
      assert.equal(entry.content, "Acme Corp is a client");
    });

    it("returns undefined for missing id", () => {
      assert.equal(store.get("nonexistent"), undefined);
    });

    it("updates lastAccessed on read", async () => {
      const id = await store.create({
        category: "fact",
        content: "test",
        sourceSessions: [],
        confidence: 1,
        tags: [],
      });

      const entry1 = store.get(id);
      assert.ok(entry1);
      const firstAccess = entry1.lastAccessed;

      // Small delay to ensure timestamp changes
      const entry2 = store.get(id);
      assert.ok(entry2);
      assert.ok(entry2.lastAccessed >= firstAccess);
    });

    it("logs memory:read event", async () => {
      const id = await store.create({
        category: "fact",
        content: "test",
        sourceSessions: [],
        confidence: 1,
        tags: [],
      });
      logger.calls.length = 0;

      store.get(id);
      assert.equal(logger.calls.length, 1);
      assert.equal(logger.calls[0]?.eventType, "memory:read");
    });
  });

  describe("update()", () => {
    it("updates content", async () => {
      const id = await store.create({
        category: "fact",
        content: "Old content",
        sourceSessions: [],
        confidence: 1,
        tags: [],
      });

      const updated = await store.update(id, { content: "New content" });
      assert.equal(updated.content, "New content");
      assert.equal(store.get(id)?.content, "New content");
    });

    it("updates confidence", async () => {
      const id = await store.create({
        category: "fact",
        content: "test",
        sourceSessions: [],
        confidence: 0.5,
        tags: [],
      });

      await store.update(id, { confidence: 0.9 });
      assert.equal(store.get(id)?.confidence, 0.9);
    });

    it("throws for missing entry", async () => {
      await assert.rejects(
        () => store.update("nonexistent", { content: "x" }),
        (err: unknown) => {
          assert.ok(err instanceof LongTermStoreError);
          assert.equal(err.code, "NOT_FOUND");
          return true;
        },
      );
    });

    it("preserves fields not in patch", async () => {
      const id = await store.create({
        category: "preference",
        content: "Likes cats",
        sourceSessions: ["s1"],
        confidence: 0.8,
        tags: ["pets"],
      });

      await store.update(id, { content: "Loves cats" });
      const entry = store.get(id);
      assert.ok(entry);
      assert.equal(entry.category, "preference");
      assert.deepEqual([...entry.sourceSessions], ["s1"]);
    });
  });

  describe("delete()", () => {
    it("removes entry and returns true", async () => {
      const id = await store.create({
        category: "fact",
        content: "test",
        sourceSessions: [],
        confidence: 1,
        tags: [],
      });

      assert.equal(await store.delete(id), true);
      assert.equal(store.get(id), undefined);
      assert.equal(store.count, 0);
    });

    it("returns false for missing entry", async () => {
      assert.equal(await store.delete("nope"), false);
    });
  });

  describe("search()", () => {
    beforeEach(async () => {
      await store.create({ category: "fact", content: "Alice is 30", sourceSessions: [], confidence: 0.9, tags: ["identity"] });
      await store.create({ category: "preference", content: "Dark mode", sourceSessions: [], confidence: 0.8, tags: ["ui"] });
      await store.create({ category: "project", content: "Sprint 5", sourceSessions: [], confidence: 0.7, tags: ["work"] });
      await store.create({ category: "fact", content: "Lives in NY", sourceSessions: [], confidence: 0.1, tags: ["identity"] });
    });

    it("filters by category", () => {
      const facts = store.search({ category: "fact" });
      assert.equal(facts.length, 2);
      assert.ok(facts.every((e) => e.category === "fact"));
    });

    it("filters by tags", () => {
      const results = store.search({ tags: ["identity"] });
      assert.equal(results.length, 2);
    });

    it("filters by minConfidence", () => {
      const results = store.search({ minConfidence: 0.5 });
      assert.equal(results.length, 3);
    });

    it("combines filters", () => {
      const results = store.search({
        category: "fact",
        minConfidence: 0.5,
      });
      assert.equal(results.length, 1);
      assert.equal(results[0]?.content, "Alice is 30");
    });

    it("returns all entries with no filters", () => {
      assert.equal(store.search().length, 4);
    });
  });

  describe("confidence decay", () => {
    it("decays confidence based on time since last access", async () => {
      const id = await store.create({
        category: "fact",
        content: "test",
        sourceSessions: [],
        confidence: 1.0,
        tags: [],
      });

      // Simulate 10 days since last access
      const entry = store.get(id);
      assert.ok(entry);
      entry.lastAccessed = Date.now() - 10 * 86_400_000;

      const result = store.applyConfidenceDecay();
      assert.ok(result.decayed > 0);
      assert.ok(entry.confidence < 1.0);
      // 10 days * 0.01 rate = 0.1 decay → confidence ~0.9
      assert.ok(entry.confidence >= 0.89 && entry.confidence <= 0.91);
    });

    it("confidence never goes below 0", async () => {
      const id = await store.create({
        category: "fact",
        content: "test",
        sourceSessions: [],
        confidence: 0.05,
        tags: [],
      });

      const entry = store.get(id);
      assert.ok(entry);
      entry.lastAccessed = Date.now() - 365 * 86_400_000;

      store.applyConfidenceDecay();
      assert.equal(entry.confidence, 0);
    });

    it("reports stale entries", async () => {
      const id = await store.create({
        category: "fact",
        content: "test",
        sourceSessions: [],
        confidence: 0.25,
        tags: [],
      });

      const entry = store.get(id);
      assert.ok(entry);
      entry.lastAccessed = Date.now() - 10 * 86_400_000;

      const result = store.applyConfidenceDecay();
      // 0.25 - (10 * 0.01) = 0.15 which is < 0.2 threshold
      assert.ok(result.stale > 0);
    });
  });

  describe("pruning", () => {
    it("prunes lowest-confidence entries when over limit", async () => {
      const smallStore = new LongTermStore({
        directory: tempDir,
        config: { ...DEFAULT_MEMORY_CONFIG, maxLongTermEntries: 3 },
        logger,
      });

      await smallStore.create({ category: "fact", content: "high", sourceSessions: [], confidence: 1.0, tags: [] });
      await smallStore.create({ category: "fact", content: "mid", sourceSessions: [], confidence: 0.5, tags: [] });
      await smallStore.create({ category: "fact", content: "low", sourceSessions: [], confidence: 0.1, tags: [] });
      await smallStore.create({ category: "fact", content: "lower", sourceSessions: [], confidence: 0.05, tags: [] });

      assert.equal(smallStore.count, 4);
      const pruned = smallStore.prune();
      assert.equal(pruned, 1);
      assert.equal(smallStore.count, 3);

      // Lowest confidence should be gone
      const remaining = smallStore.getAll();
      assert.ok(remaining.every((e) => e.confidence >= 0.1));
    });

    it("does nothing when under limit", () => {
      assert.equal(store.prune(), 0);
    });
  });

  describe("supersedes chain", () => {
    it("resolves a chain of corrections", async () => {
      const id1 = await store.create({
        category: "fact",
        content: "User is 29",
        sourceSessions: ["s1"],
        confidence: 0.5,
        tags: [],
      });

      const id2 = await store.create({
        category: "fact",
        content: "User is 30",
        sourceSessions: ["s2"],
        confidence: 0.9,
        supersedes: id1,
        tags: [],
      });

      const chain = store.resolveChain(id2);
      assert.equal(chain.length, 2);
      assert.equal(chain[0]?.content, "User is 30");
      assert.equal(chain[1]?.content, "User is 29");
    });

    it("returns single entry for no supersedes", async () => {
      const id = await store.create({
        category: "fact",
        content: "standalone",
        sourceSessions: [],
        confidence: 1,
        tags: [],
      });

      const chain = store.resolveChain(id);
      assert.equal(chain.length, 1);
    });

    it("returns empty for missing entry", () => {
      assert.equal(store.resolveChain("nonexistent").length, 0);
    });
  });

  describe("load() and persist()", () => {
    it("persists and reloads entries", async () => {
      await store.create({ category: "fact", content: "A", sourceSessions: [], confidence: 1, tags: [] });
      await store.create({ category: "preference", content: "B", sourceSessions: [], confidence: 0.8, tags: ["x"] });

      await store.persist();

      // Create a fresh store and load
      const store2 = new LongTermStore({
        directory: tempDir,
        config: DEFAULT_MEMORY_CONFIG,
        logger,
      });
      await store2.load();

      assert.equal(store2.count, 2);
      const all = store2.getAll();
      assert.ok(all.some((e) => e.content === "A"));
      assert.ok(all.some((e) => e.content === "B"));
    });

    it("load handles missing file gracefully", async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), "bc-lts-empty-"));
      const emptyStore = new LongTermStore({
        directory: emptyDir,
        config: DEFAULT_MEMORY_CONFIG,
        logger,
      });

      await emptyStore.load();
      assert.equal(emptyStore.count, 0);

      await rm(emptyDir, { recursive: true, force: true });
    });

    it("load skips malformed lines", async () => {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(
        join(tempDir, "entries.jsonl"),
        '{"id":"1","category":"fact","content":"ok","sourceSessions":[],"created":1,"lastAccessed":1,"confidence":1,"tags":[]}\n{not valid json\n',
        "utf-8",
      );

      await store.load();
      assert.equal(store.count, 1);
    });
  });
});
