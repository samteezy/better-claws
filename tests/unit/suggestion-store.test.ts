import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SuggestionStore } from "../../src/suggestions/suggestion-store.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

const noopLogger = {
  log: () => {},
} as unknown as StructuredLogger;

describe("SuggestionStore", () => {
  let tempDir: string;
  let store: SuggestionStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bc-ss-"));
    store = new SuggestionStore({
      directory: tempDir,
      logger: noopLogger,
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("create()", () => {
    it("creates a suggestion with all fields populated", () => {
      const suggestion = store.create({
        category: "persona",
        title: "Add greeting",
        body: "Users often start informally",
      });

      assert.ok(suggestion.id);
      assert.equal(suggestion.category, "persona");
      assert.equal(suggestion.title, "Add greeting");
      assert.equal(suggestion.body, "Users often start informally");
      assert.equal(suggestion.status, "pending");
      assert.ok(suggestion.createdAt > 0);
      assert.ok(suggestion.updatedAt > 0);
    });

    it("generates UUID for id", () => {
      const s1 = store.create({
        category: "tools",
        title: "Title 1",
        body: "Body 1",
      });
      const s2 = store.create({
        category: "tools",
        title: "Title 2",
        body: "Body 2",
      });

      // UUIDs are 36 chars with hyphens
      assert.ok(s1.id.length === 36);
      assert.ok(s2.id.length === 36);
      assert.notEqual(s1.id, s2.id);
    });

    it("status defaults to pending", () => {
      const suggestion = store.create({
        category: "workflow",
        title: "Test",
        body: "Test body",
      });

      assert.equal(suggestion.status, "pending");
    });

    it("sets createdAt and updatedAt timestamps", () => {
      const before = Date.now();
      const suggestion = store.create({
        category: "general",
        title: "Test",
        body: "Test body",
      });
      const after = Date.now();

      assert.ok(suggestion.createdAt >= before && suggestion.createdAt <= after);
      assert.ok(suggestion.updatedAt >= before && suggestion.updatedAt <= after);
    });
  });

  describe("get()", () => {
    it("returns suggestion by id", () => {
      const created = store.create({
        category: "persona",
        title: "Greeting",
        body: "Add friendly greeting",
      });

      const retrieved = store.get(created.id);
      assert.ok(retrieved);
      assert.equal(retrieved.id, created.id);
      assert.equal(retrieved.title, "Greeting");
    });

    it("returns undefined for unknown id", () => {
      const result = store.get("unknown-id");
      assert.equal(result, undefined);
    });
  });

  describe("getAll()", () => {
    it("returns empty array when no suggestions exist", () => {
      const all = store.getAll();
      assert.equal(all.length, 0);
    });

    it("returns all suggestions", () => {
      const s1 = store.create({
        category: "persona",
        title: "Title 1",
        body: "Body 1",
      });
      const s2 = store.create({
        category: "tools",
        title: "Title 2",
        body: "Body 2",
      });
      const s3 = store.create({
        category: "workflow",
        title: "Title 3",
        body: "Body 3",
      });

      const all = store.getAll();
      assert.equal(all.length, 3);
      assert.ok(all.some(s => s.id === s1.id));
      assert.ok(all.some(s => s.id === s2.id));
      assert.ok(all.some(s => s.id === s3.id));
    });
  });

  describe("getByStatus()", () => {
    it("filters by pending status", () => {
      const s1 = store.create({
        category: "persona",
        title: "Title 1",
        body: "Body 1",
      });
      const s2 = store.create({
        category: "tools",
        title: "Title 2",
        body: "Body 2",
      });

      store.updateStatus(s2.id, "accepted");

      const pending = store.getByStatus("pending");
      assert.equal(pending.length, 1);
      assert.equal(pending[0]?.id, s1.id);
    });

    it("filters by accepted status", () => {
      const s1 = store.create({
        category: "persona",
        title: "Title 1",
        body: "Body 1",
      });
      const s2 = store.create({
        category: "tools",
        title: "Title 2",
        body: "Body 2",
      });

      store.updateStatus(s1.id, "accepted");
      store.updateStatus(s2.id, "dismissed");

      const accepted = store.getByStatus("accepted");
      assert.equal(accepted.length, 1);
      assert.equal(accepted[0]?.id, s1.id);
    });

    it("filters by dismissed status", () => {
      const s1 = store.create({
        category: "persona",
        title: "Title 1",
        body: "Body 1",
      });
      store.create({
        category: "tools",
        title: "Title 2",
        body: "Body 2",
      });

      store.updateStatus(s1.id, "dismissed");

      const dismissed = store.getByStatus("dismissed");
      assert.equal(dismissed.length, 1);
      assert.equal(dismissed[0]?.id, s1.id);
    });

    it("returns empty array when no matches", () => {
      store.create({
        category: "persona",
        title: "Title 1",
        body: "Body 1",
      });

      const accepted = store.getByStatus("accepted");
      assert.equal(accepted.length, 0);
    });
  });

  describe("updateStatus()", () => {
    it("changes status and updates updatedAt", async () => {
      const created = store.create({
        category: "persona",
        title: "Test",
        body: "Test body",
      });
      const originalUpdatedAt = created.updatedAt;

      // Small delay to ensure time difference
      await new Promise(resolve => setTimeout(resolve, 10));

      const updated = store.updateStatus(created.id, "accepted");
      assert.ok(updated);
      assert.equal(updated.status, "accepted");
      assert.ok(updated.updatedAt > originalUpdatedAt);
    });

    it("returns undefined for unknown id", () => {
      const result = store.updateStatus("unknown-id", "accepted");
      assert.equal(result, undefined);
    });

    it("can update status multiple times", () => {
      const created = store.create({
        category: "tools",
        title: "Test",
        body: "Test body",
      });

      const accepted = store.updateStatus(created.id, "accepted");
      assert.ok(accepted);
      assert.equal(accepted.status, "accepted");

      const dismissed = store.updateStatus(created.id, "dismissed");
      assert.ok(dismissed);
      assert.equal(dismissed.status, "dismissed");

      const retrieved = store.get(created.id);
      assert.ok(retrieved);
      assert.equal(retrieved.status, "dismissed");
    });
  });

  describe("delete()", () => {
    it("removes suggestion and returns true", () => {
      const created = store.create({
        category: "persona",
        title: "Test",
        body: "Test body",
      });

      const deleted = store.delete(created.id);
      assert.equal(deleted, true);

      const retrieved = store.get(created.id);
      assert.equal(retrieved, undefined);
    });

    it("returns false for unknown id", () => {
      const deleted = store.delete("unknown-id");
      assert.equal(deleted, false);
    });

    it("removes from getAll() results", () => {
      const s1 = store.create({
        category: "persona",
        title: "Title 1",
        body: "Body 1",
      });
      const s2 = store.create({
        category: "tools",
        title: "Title 2",
        body: "Body 2",
      });

      assert.equal(store.getAll().length, 2);

      store.delete(s1.id);

      const all = store.getAll();
      assert.equal(all.length, 1);
      assert.equal(all[0]?.id, s2.id);
    });
  });

  describe("persist() and load()", () => {
    it("writes suggestions to JSONL file", async () => {
      store.create({
        category: "persona",
        title: "Title 1",
        body: "Body 1",
      });
      store.create({
        category: "tools",
        title: "Title 2",
        body: "Body 2",
      });

      await store.persist();

      // Verify file exists and contains JSONL
      const fs = await import("node:fs/promises");
      const content = await fs.readFile(join(tempDir, "suggestions.jsonl"), "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      assert.equal(lines.length, 2);

      const first = JSON.parse(lines[0]!);
      assert.equal(first.category, "persona");
      assert.equal(first.title, "Title 1");
    });

    it("round-trips data through persist and load", async () => {
      const s1 = store.create({
        category: "persona",
        title: "Greeting",
        body: "Add friendly greeting",
      });
      const s2 = store.create({
        category: "tools",
        title: "Calendar tool",
        body: "Add calendar integration",
      });

      store.updateStatus(s2.id, "accepted");

      await store.persist();

      // Create new store instance and load
      const store2 = new SuggestionStore({
        directory: tempDir,
        logger: noopLogger,
      });
      await store2.load();

      const loaded = store2.getAll();
      assert.equal(loaded.length, 2);

      const loadedS1 = store2.get(s1.id);
      assert.ok(loadedS1);
      assert.equal(loadedS1.title, "Greeting");
      assert.equal(loadedS1.status, "pending");

      const loadedS2 = store2.get(s2.id);
      assert.ok(loadedS2);
      assert.equal(loadedS2.title, "Calendar tool");
      assert.equal(loadedS2.status, "accepted");
    });

    it("loads empty file gracefully", async () => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(tempDir, { recursive: true });
      await fs.writeFile(join(tempDir, "suggestions.jsonl"), "", "utf-8");

      const store2 = new SuggestionStore({
        directory: tempDir,
        logger: noopLogger,
      });
      await store2.load();

      assert.equal(store2.getAll().length, 0);
    });

    it("handles missing file on load", async () => {
      const store2 = new SuggestionStore({
        directory: tempDir,
        logger: noopLogger,
      });

      // Should not throw when file doesn't exist
      await store2.load();
      assert.equal(store2.getAll().length, 0);
    });

    it("skips malformed JSONL lines on load", async () => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(tempDir, { recursive: true });

      // Write one good line and one bad line
      const goodEntry = {
        id: "test-id",
        category: "persona",
        title: "Test",
        body: "Test body",
        status: "pending",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      const content = `${JSON.stringify(goodEntry)}\n{bad json\n`;
      await fs.writeFile(join(tempDir, "suggestions.jsonl"), content, "utf-8");

      const store2 = new SuggestionStore({
        directory: tempDir,
        logger: noopLogger,
      });
      await store2.load();

      // Should have loaded the good entry and skipped the bad one
      assert.equal(store2.getAll().length, 1);
      assert.equal(store2.get("test-id")?.title, "Test");
    });
  });

  describe("pruneOld()", () => {
    it("removes dismissed suggestions older than threshold", () => {
      const now = Date.now();
      const oneMonthAgo = now - 31 * 86_400_000;

      const s1 = store.create({
        category: "persona",
        title: "Old",
        body: "Old suggestion",
      });
      store.updateStatus(s1.id, "dismissed");

      // Manually set updatedAt to simulate old entry
      const entry = store.get(s1.id);
      if (entry) {
        entry.updatedAt = oneMonthAgo;
      }

      const s2 = store.create({
        category: "tools",
        title: "Recent",
        body: "Recent suggestion",
      });
      store.updateStatus(s2.id, "dismissed");

      assert.equal(store.getAll().length, 2);

      const pruned = store.pruneOld(30);
      assert.equal(pruned, 1);

      const remaining = store.getAll();
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0]?.id, s2.id);
    });

    it("keeps pending suggestions regardless of age", () => {
      const oneMonthAgo = Date.now() - 31 * 86_400_000;

      const s1 = store.create({
        category: "persona",
        title: "Old pending",
        body: "Old pending suggestion",
      });

      // Manually set updatedAt to simulate old entry
      const entry = store.get(s1.id);
      if (entry) {
        entry.updatedAt = oneMonthAgo;
      }

      assert.equal(store.getAll().length, 1);

      const pruned = store.pruneOld(30);
      assert.equal(pruned, 0);

      const remaining = store.getAll();
      assert.equal(remaining.length, 1);
    });

    it("keeps accepted suggestions regardless of age", () => {
      const oneMonthAgo = Date.now() - 31 * 86_400_000;

      const s1 = store.create({
        category: "tools",
        title: "Old accepted",
        body: "Old accepted suggestion",
      });
      store.updateStatus(s1.id, "accepted");

      // Manually set updatedAt to simulate old entry
      const entry = store.get(s1.id);
      if (entry) {
        entry.updatedAt = oneMonthAgo;
      }

      assert.equal(store.getAll().length, 1);

      const pruned = store.pruneOld(30);
      assert.equal(pruned, 0);

      const remaining = store.getAll();
      assert.equal(remaining.length, 1);
    });

    it("returns count of pruned entries", () => {
      const oneMonthAgo = Date.now() - 31 * 86_400_000;

      const s1 = store.create({
        category: "persona",
        title: "Old 1",
        body: "Old suggestion 1",
      });
      store.updateStatus(s1.id, "dismissed");
      const e1 = store.get(s1.id);
      if (e1) e1.updatedAt = oneMonthAgo;

      const s2 = store.create({
        category: "tools",
        title: "Old 2",
        body: "Old suggestion 2",
      });
      store.updateStatus(s2.id, "dismissed");
      const e2 = store.get(s2.id);
      if (e2) e2.updatedAt = oneMonthAgo;

      const s3 = store.create({
        category: "workflow",
        title: "Recent",
        body: "Recent suggestion",
      });
      store.updateStatus(s3.id, "dismissed");

      const pruned = store.pruneOld(30);
      assert.equal(pruned, 2);
    });
  });
});
