import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tokenize, TfIdfRetriever } from "../../src/memory/retrieval.js";
import { LongTermStore } from "../../src/memory/long-term-store.js";
import { DEFAULT_MEMORY_CONFIG } from "../helpers/memory-config.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

function createMockLogger() {
  return {
    calls: [] as unknown[],
    log(): void {},
    async flush(): Promise<void> {},
    async close(): Promise<void> {},
  } as unknown as StructuredLogger;
}

describe("tokenize()", () => {
  it("lowercases and splits on non-alphanumeric", () => {
    const tokens = tokenize("Hello, World! This is a TEST.");
    assert.ok(tokens.includes("hello"));
    assert.ok(tokens.includes("world"));
    assert.ok(tokens.includes("test"));
  });

  it("filters tokens shorter than 3 chars", () => {
    const tokens = tokenize("I am OK so we go");
    assert.ok(!tokens.includes("am"));
    assert.ok(!tokens.includes("ok"));
    assert.ok(!tokens.includes("so"));
  });

  it("filters stop words", () => {
    const tokens = tokenize("the quick brown fox with many jumps");
    assert.ok(!tokens.includes("the"));
    assert.ok(!tokens.includes("with"));
    assert.ok(!tokens.includes("many"));
    assert.ok(tokens.includes("quick"));
    assert.ok(tokens.includes("brown"));
    assert.ok(tokens.includes("fox"));
    assert.ok(tokens.includes("jumps"));
  });

  it("returns empty for stop-words-only input", () => {
    const tokens = tokenize("the and for are but not");
    assert.equal(tokens.length, 0);
  });
});

describe("TfIdfRetriever", () => {
  let tempDir: string;
  let store: LongTermStore;
  let retriever: TfIdfRetriever;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bc-tfidf-"));
    store = new LongTermStore({
      directory: tempDir,
      config: { ...DEFAULT_MEMORY_CONFIG, maxLongTermEntries: 1000 },
      logger: createMockLogger(),
    });
    retriever = new TfIdfRetriever({ store, minConfidence: 0 });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("retrieve()", () => {
    it("ranks relevant entries higher", async () => {
      await store.create({ category: "fact", content: "Alice works as a software engineer at TechCorp", sourceSessions: [], confidence: 1, tags: [] });
      await store.create({ category: "preference", content: "User prefers dark chocolate over milk chocolate", sourceSessions: [], confidence: 1, tags: [] });
      await store.create({ category: "project", content: "The software project uses TypeScript and Node.js", sourceSessions: [], confidence: 1, tags: [] });

      const results = retriever.retrieve("What software does Alice use?");
      assert.ok(results.length > 0);
      // Both "software" entries should rank above "chocolate"
      const topContent = results.map((r) => r.entry.content);
      const chocolateIdx = topContent.findIndex((c) => c.includes("chocolate"));
      const softwareIdx = topContent.findIndex((c) => c.includes("software"));
      if (chocolateIdx >= 0 && softwareIdx >= 0) {
        assert.ok(softwareIdx < chocolateIdx);
      }
    });

    it("returns empty for no matches", async () => {
      await store.create({ category: "fact", content: "Alice likes cats", sourceSessions: [], confidence: 1, tags: [] });

      const results = retriever.retrieve("quantum physics research");
      assert.equal(results.length, 0);
    });

    it("returns empty for empty store", () => {
      const results = retriever.retrieve("anything");
      assert.equal(results.length, 0);
    });

    it("respects topK limit", async () => {
      for (let i = 0; i < 10; i++) {
        await store.create({ category: "fact", content: `Fact number ${i} about coding`, sourceSessions: [], confidence: 1, tags: [] });
      }

      const results = retriever.retrieve("coding fact", 3);
      assert.ok(results.length <= 3);
    });

    it("filters by category", async () => {
      await store.create({ category: "fact", content: "Python is a programming language", sourceSessions: [], confidence: 1, tags: [] });
      await store.create({ category: "preference", content: "User prefers Python over Java", sourceSessions: [], confidence: 1, tags: [] });

      const results = retriever.retrieve("Python programming", 10, "preference");
      assert.ok(results.length > 0);
      assert.ok(results.every((r) => r.entry.category === "preference"));
    });

    it("respects minConfidence filter", async () => {
      const confRetriever = new TfIdfRetriever({ store, minConfidence: 0.5 });

      await store.create({ category: "fact", content: "High confidence coding fact", sourceSessions: [], confidence: 0.9, tags: [] });
      await store.create({ category: "fact", content: "Low confidence coding fact", sourceSessions: [], confidence: 0.1, tags: [] });

      const results = confRetriever.retrieve("coding fact");
      assert.equal(results.length, 1);
      assert.ok(results[0]!.entry.confidence >= 0.5);
    });

    it("includes tags in scoring", async () => {
      await store.create({ category: "fact", content: "A random entry", sourceSessions: [], confidence: 1, tags: ["typescript", "node"] });
      await store.create({ category: "fact", content: "Another random entry", sourceSessions: [], confidence: 1, tags: ["python"] });

      const results = retriever.retrieve("typescript node development");
      assert.ok(results.length > 0);
      assert.ok(results[0]!.entry.tags.includes("typescript") || results[0]!.entry.tags.includes("node"));
    });

    it("all results have positive scores", async () => {
      await store.create({ category: "fact", content: "Coding in TypeScript", sourceSessions: [], confidence: 1, tags: [] });
      await store.create({ category: "fact", content: "Unrelated gardening tips", sourceSessions: [], confidence: 1, tags: [] });

      const results = retriever.retrieve("TypeScript coding");
      assert.ok(results.every((r) => r.score > 0));
    });
  });

  describe("inferCategory()", () => {
    it("infers preference from preference keywords", () => {
      assert.equal(retriever.inferCategory("I prefer dark mode"), "preference");
      assert.equal(retriever.inferCategory("I always use vim"), "preference");
      assert.equal(retriever.inferCategory("My favorite color"), "preference");
    });

    it("infers project from project keywords", () => {
      assert.equal(retriever.inferCategory("The project deadline"), "project");
      assert.equal(retriever.inferCategory("The repo has issues"), "project");
      assert.equal(retriever.inferCategory("Sprint planning"), "project");
    });

    it("infers procedure from how-to keywords", () => {
      assert.equal(retriever.inferCategory("How to deploy"), "procedure");
      assert.equal(retriever.inferCategory("The deployment process"), "procedure");
      assert.equal(retriever.inferCategory("Step by step guide"), "procedure");
    });

    it("infers entity from entity keywords", () => {
      assert.equal(retriever.inferCategory("Who is the CEO"), "entity");
      assert.equal(retriever.inferCategory("The company policy"), "entity");
    });

    it("returns undefined for ambiguous messages", () => {
      assert.equal(retriever.inferCategory("What time is it"), undefined);
      assert.equal(retriever.inferCategory("Tell me a joke"), undefined);
    });
  });

  describe("retrieveWithInference()", () => {
    it("falls back to unfiltered when category yields too few results", async () => {
      await store.create({ category: "fact", content: "Python programming language details", sourceSessions: [], confidence: 1, tags: [] });
      await store.create({ category: "project", content: "Python deployment pipeline project", sourceSessions: [], confidence: 1, tags: [] });

      // "prefer Python" triggers preference category, but no preference entries exist
      const results = retriever.retrieveWithInference("I prefer Python programming", 5);
      // Should fall back and find the fact/project entries
      assert.ok(results.length > 0);
    });

    it("uses inferred category when it yields enough results", async () => {
      for (let i = 0; i < 5; i++) {
        await store.create({ category: "preference", content: `User preference about coding style ${i}`, sourceSessions: [], confidence: 1, tags: [] });
      }
      await store.create({ category: "fact", content: "Coding fact unrelated", sourceSessions: [], confidence: 1, tags: [] });

      const results = retriever.retrieveWithInference("I always prefer coding style", 5);
      // Should get preference entries
      assert.ok(results.length > 0);
    });
  });
});
