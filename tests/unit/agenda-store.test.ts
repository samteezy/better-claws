import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AgendaStore } from "../../src/memory/agenda-store.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

function createMockLogger() {
  return {
    log(): void {},
    async flush(): Promise<void> {},
    async close(): Promise<void> {},
  } as unknown as StructuredLogger;
}

describe("AgendaStore", () => {
  let tempDir: string;
  let filePath: string;
  let store: AgendaStore;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bc-agenda-"));
    filePath = join(tempDir, "agenda.jsonl");
    store = new AgendaStore(filePath, createMockLogger());
    await store.load();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("adds an item and assigns an id", async () => {
    const id = await store.add({
      senderId: "user1",
      type: "follow-up",
      content: "Check on the PR status",
      status: "pending",
      priority: "normal",
    });
    assert.ok(id.length > 0);
    const item = store.get(id);
    assert.ok(item !== undefined);
    assert.equal(item.content, "Check on the PR status");
    assert.equal(item.status, "pending");
    assert.equal(item.senderId, "user1");
  });

  it("persists and reloads items", async () => {
    const id = await store.add({
      senderId: "user1",
      type: "capability-gap",
      content: "Struggling with date parsing",
      status: "pending",
      priority: "high",
    });

    const store2 = new AgendaStore(filePath, createMockLogger());
    await store2.load();
    const reloaded = store2.get(id);
    assert.ok(reloaded !== undefined);
    assert.equal(reloaded.content, "Struggling with date parsing");
    assert.equal(reloaded.priority, "high");
  });

  it("listPending filters by senderId", async () => {
    await store.add({ senderId: "user1", type: "general", content: "Item A", status: "pending", priority: "normal" });
    await store.add({ senderId: "user2", type: "general", content: "Item B", status: "pending", priority: "normal" });

    const user1Items = store.listPending("user1");
    assert.equal(user1Items.length, 1);
    assert.equal(user1Items[0]!.content, "Item A");
  });

  it("listPending excludes resolved items", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Done", status: "pending", priority: "normal" });
    await store.resolve(id);
    assert.equal(store.listPending("user1").length, 0);
  });

  it("listPending excludes snoozed items before snooze expires", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Snoozed", status: "pending", priority: "normal" });
    await store.snooze(id, Date.now() + 60_000);
    assert.equal(store.listPending("user1").length, 0);
  });

  it("listPending includes snoozed items after snooze expires", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Expired snooze", status: "pending", priority: "normal" });
    await store.snooze(id, Date.now() - 1);
    assert.equal(store.listPending("user1").length, 1);
  });

  it("markRaised sets lastRaisedAt", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Raise me", status: "pending", priority: "normal" });
    const before = Date.now();
    const raised = await store.markRaised(id);
    assert.ok(raised.lastRaisedAt !== undefined && raised.lastRaisedAt >= before);
    assert.equal(raised.status, "raised");
  });

  it("resolve sets status to resolved", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Resolved", status: "pending", priority: "normal" });
    const resolved = await store.resolve(id);
    assert.equal(resolved.status, "resolved");
  });

  it("canRaise returns false for resolved items", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Done", status: "pending", priority: "normal" });
    await store.resolve(id);
    const item = store.get(id)!;
    assert.equal(store.canRaise(item), false);
  });

  it("canRaise respects 24h cooldown for normal priority", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Cool down", status: "pending", priority: "normal" });
    // Simulate recently raised
    await store.markRaised(id);
    const item = store.get(id)!;
    assert.equal(store.canRaise(item), false);
  });

  it("canRaise ignores cooldown for high priority", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Urgent", status: "pending", priority: "high" });
    await store.markRaised(id);
    const item = store.get(id)!;
    assert.equal(store.canRaise(item), true);
  });

  it("serializeForPrompt includes id in output", async () => {
    const id = await store.add({ senderId: "user1", type: "follow-up", content: "Review the PR", status: "pending", priority: "normal" });
    const lines = store.serializeForPrompt("user1", 5);
    assert.equal(lines.length, 1);
    assert.ok(lines[0]!.includes(`[id:${id}]`));
    assert.ok(lines[0]!.includes("Review the PR"));
  });

  it("serializeForPrompt respects maxItems", async () => {
    for (let i = 0; i < 8; i++) {
      await store.add({ senderId: "user1", type: "general", content: `Item ${i}`, status: "pending", priority: "normal" });
    }
    const lines = store.serializeForPrompt("user1", 3);
    assert.equal(lines.length, 3);
  });

  it("serializeForPrompt sorts high priority first", async () => {
    await store.add({ senderId: "user1", type: "general", content: "Low item", status: "pending", priority: "low" });
    await store.add({ senderId: "user1", type: "general", content: "High item", status: "pending", priority: "high" });
    const lines = store.serializeForPrompt("user1", 5);
    assert.ok(lines[0]!.includes("High item"));
  });

  it("remove deletes item", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Delete me", status: "pending", priority: "normal" });
    await store.remove(id);
    assert.equal(store.get(id), undefined);
  });

  it("update changes content and priority", async () => {
    const id = await store.add({ senderId: "user1", type: "general", content: "Original", status: "pending", priority: "low" });
    const updated = await store.update(id, { content: "Updated", priority: "high" });
    assert.equal(updated.content, "Updated");
    assert.equal(updated.priority, "high");
  });

  it("JSONL file contains one line per item", async () => {
    await store.add({ senderId: "user1", type: "general", content: "A", status: "pending", priority: "normal" });
    await store.add({ senderId: "user1", type: "general", content: "B", status: "pending", priority: "normal" });
    const raw = await readFile(filePath, "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    assert.equal(lines.length, 2);
  });
});
