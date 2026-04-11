import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  CurationWorker,
  type CurationLlmClient,
} from "../../src/memory/curation-worker.js";
import { LongTermStore } from "../../src/memory/long-term-store.js";
import { SessionManager } from "../../src/sessions/session-manager.js";
import { DEFAULT_MEMORY_CONFIG } from "../helpers/memory-config.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { MemoryConfig, LlmResponse, ChatMessage } from "../../src/types.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

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
  return fs.mkdtempSync(path.join(os.tmpdir(), "bc-curation-"));
}

function makeConfig(overrides?: Partial<MemoryConfig>): MemoryConfig {
  return {
    ...DEFAULT_MEMORY_CONFIG,
    ...overrides,
  };
}

function makeLlmResponse(content: string): LlmResponse {
  return {
    message: { role: "assistant", content },
    usage: { promptTokens: 10, completionTokens: 5 },
    raw: {},
  };
}

function createMockLlm(responses: string[]): CurationLlmClient & { calls: ChatMessage[][] } {
  let callIndex = 0;
  const calls: ChatMessage[][] = [];
  return {
    calls,
    async chat(messages: readonly ChatMessage[]): Promise<LlmResponse> {
      calls.push([...messages]);
      const content = responses[callIndex] ?? "[]";
      callIndex++;
      return makeLlmResponse(content);
    },
  };
}

interface TestContext {
  tmpDir: string;
  logger: ReturnType<typeof createMockLogger>;
  store: LongTermStore;
  sessionManager: SessionManager;
  config: MemoryConfig;
}

async function setup(configOverrides?: Partial<MemoryConfig>): Promise<TestContext> {
  const tmpDir = makeTmpDir();
  const logger = createMockLogger();
  const config = makeConfig(configOverrides);

  const store = new LongTermStore({
    directory: path.join(tmpDir, "memory"),
    config,
    logger,
  });
  await store.load();

  const sessionManager = new SessionManager({
    sessionsDirectory: path.join(tmpDir, "sessions"),
    idleTimeoutMs: 50, // very short for testing
    logger,
    workingMemoryBudgetChars: 8192,
  });

  return { tmpDir, logger, store, sessionManager, config };
}

function cleanup(tmpDir: string): void {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CurationWorker", () => {
  describe("start / stop lifecycle", () => {
    it("logs start event when enabled", async () => {
      const ctx = await setup();
      const llm = createMockLlm([]);
      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      await worker.stop();

      const startLog = ctx.logger.logs.find(
        (l) => l["eventType"] === "memory:curation" &&
          (l["payload"] as Record<string, unknown>)["action"] === "start",
      );
      assert.ok(startLog, "should log start event");

      const stopLog = ctx.logger.logs.find(
        (l) => l["eventType"] === "memory:curation" &&
          (l["payload"] as Record<string, unknown>)["action"] === "stop",
      );
      assert.ok(stopLog, "should log stop event");

      cleanup(ctx.tmpDir);
    });

    it("logs disabled when curation is off", async () => {
      const ctx = await setup({ curationEnabled: false });
      const llm = createMockLlm([]);
      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      await worker.stop();

      const disabledLog = ctx.logger.logs.find(
        (l) => l["eventType"] === "memory:curation" &&
          (l["payload"] as Record<string, unknown>)["action"] === "disabled",
      );
      assert.ok(disabledLog, "should log disabled event");

      cleanup(ctx.tmpDir);
    });
  });

  describe("session distillation", () => {
    it("distills idle session into memory entries via LLM", async () => {
      const ctx = await setup();

      // Create a session, add some history, then let it go idle
      const session = await ctx.sessionManager.getOrCreate("test", "chan1", "user1");
      await ctx.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message: {
          id: "1", adapterId: "test", channelId: "chan1",
          senderId: "user1", text: "I prefer dark mode", timestamp: Date.now(),
        },
      });
      await ctx.sessionManager.appendToLog(session.id, {
        type: "outbound",
        message: { channelId: "chan1", text: "Noted, I'll remember your dark mode preference." },
      });

      // Wait for idle
      await new Promise((r) => setTimeout(r, 80));

      const llm = createMockLlm([
        JSON.stringify([
          { category: "preference", content: "User prefers dark mode", confidence: 0.9, tags: ["ui", "theme"] },
        ]),
      ]);

      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.distilledSessions, 1);
      assert.equal(result.entriesCreated, 1);
      assert.equal(ctx.store.count, 1);

      const entries = ctx.store.getAll();
      assert.equal(entries[0]!.category, "preference");
      assert.equal(entries[0]!.content, "User prefers dark mode");
      assert.ok(entries[0]!.sourceSessions.includes(session.id));

      // Verify LLM was called with distillation prompt
      assert.equal(llm.calls.length, 1);
      assert.equal(llm.calls[0]![0]!.role, "system");
      assert.ok(llm.calls[0]![0]!.content.includes("memory curation agent"));

      // Verify logged as memory:curation
      const curationLogs = ctx.logger.logs.filter(
        (l) => l["eventType"] === "memory:curation",
      );
      const distillLog = curationLogs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "distillation_call",
      );
      assert.ok(distillLog, "should log distillation call");

      cleanup(ctx.tmpDir);
    });

    it("skips sessions with no history", async () => {
      const ctx = await setup();

      // Create an empty session and let it idle
      await ctx.sessionManager.getOrCreate("test", "chan1", "user1");
      await new Promise((r) => setTimeout(r, 80));

      const llm = createMockLlm([]);
      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.distilledSessions, 0);
      assert.equal(llm.calls.length, 0);

      cleanup(ctx.tmpDir);
    });

    it("handles malformed LLM response gracefully", async () => {
      const ctx = await setup();

      const session = await ctx.sessionManager.getOrCreate("test", "chan1", "user1");
      await ctx.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message: {
          id: "1", adapterId: "test", channelId: "chan1",
          senderId: "user1", text: "hello", timestamp: Date.now(),
        },
      });
      await new Promise((r) => setTimeout(r, 80));

      const llm = createMockLlm(["not valid json at all"]);
      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.distilledSessions, 1);
      assert.equal(result.entriesCreated, 0);
      assert.equal(ctx.store.count, 0);

      cleanup(ctx.tmpDir);
    });

    it("handles LLM call failure gracefully", async () => {
      const ctx = await setup();

      const session = await ctx.sessionManager.getOrCreate("test", "chan1", "user1");
      await ctx.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message: {
          id: "1", adapterId: "test", channelId: "chan1",
          senderId: "user1", text: "hello", timestamp: Date.now(),
        },
      });
      await new Promise((r) => setTimeout(r, 80));

      const llm: CurationLlmClient = {
        async chat() { throw new Error("LLM unavailable"); },
      };
      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      // Should not crash, should log error
      assert.equal(result.entriesCreated, 0);
      const errorLog = ctx.logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "distillation_error",
      );
      assert.ok(errorLog, "should log distillation error");

      cleanup(ctx.tmpDir);
    });

    it("extracts multiple entries from a single session", async () => {
      const ctx = await setup();

      const session = await ctx.sessionManager.getOrCreate("test", "chan1", "user1");
      await ctx.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message: {
          id: "1", adapterId: "test", channelId: "chan1",
          senderId: "user1", text: "I work at Acme Corp on project Phoenix", timestamp: Date.now(),
        },
      });
      await new Promise((r) => setTimeout(r, 80));

      const llm = createMockLlm([
        JSON.stringify([
          { category: "entity", content: "User works at Acme Corp", confidence: 0.95, tags: ["employer"] },
          { category: "project", content: "User is working on project Phoenix", confidence: 0.85, tags: ["project"] },
        ]),
      ]);

      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.entriesCreated, 2);
      assert.equal(ctx.store.count, 2);

      cleanup(ctx.tmpDir);
    });

    it("clamps confidence to 0-1 range", async () => {
      const ctx = await setup();

      const session = await ctx.sessionManager.getOrCreate("test", "chan1", "user1");
      await ctx.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message: {
          id: "1", adapterId: "test", channelId: "chan1",
          senderId: "user1", text: "test", timestamp: Date.now(),
        },
      });
      await new Promise((r) => setTimeout(r, 80));

      const llm = createMockLlm([
        JSON.stringify([
          { category: "fact", content: "too high", confidence: 5.0, tags: [] },
          { category: "fact", content: "too low", confidence: -1, tags: [] },
        ]),
      ]);

      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      const entries = ctx.store.getAll();
      const high = entries.find((e) => e.content === "too high");
      const low = entries.find((e) => e.content === "too low");
      assert.ok(high!.confidence <= 1, "confidence should be clamped to max 1");
      assert.ok(low!.confidence >= 0, "confidence should be clamped to min 0");

      cleanup(ctx.tmpDir);
    });
  });

  describe("consolidation", () => {
    it("consolidates overlapping entries via LLM", async () => {
      const ctx = await setup();

      // Seed two overlapping entries
      const id1 = await ctx.store.create({
        category: "fact",
        content: "User lives in New York",
        sourceSessions: ["s1"],
        confidence: 0.7,
        tags: ["location"],
      });
      const id2 = await ctx.store.create({
        category: "fact",
        content: "User relocated to San Francisco",
        sourceSessions: ["s2"],
        confidence: 0.9,
        tags: ["location"],
      });

      const llm = createMockLlm([
        // Distillation (no idle sessions, so this won't be called)
        // Consolidation for "fact" category
        JSON.stringify([{
          winnerId: id2,
          supersededIds: [id1],
          updatedContent: "User lives in San Francisco (relocated from New York)",
          updatedConfidence: 0.95,
        }]),
      ]);

      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.consolidated, 1);

      const winner = ctx.store.get(id2);
      assert.equal(winner!.content, "User lives in San Francisco (relocated from New York)");
      assert.ok(Math.abs(winner!.confidence - 0.95) < 1e-6, `expected confidence ≈ 0.95, got ${winner!.confidence}`);

      // Superseded entry should have confidence 0
      const superseded = ctx.store.get(id1);
      assert.equal(superseded!.confidence, 0);

      // Verify consolidation logged
      const consolidationLog = ctx.logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "consolidation_applied",
      );
      assert.ok(consolidationLog);

      cleanup(ctx.tmpDir);
    });

    it("skips consolidation when fewer than 2 entries", async () => {
      const ctx = await setup();

      await ctx.store.create({
        category: "fact",
        content: "Only one entry",
        sourceSessions: ["s1"],
        confidence: 0.8,
        tags: [],
      });

      const llm = createMockLlm([]);
      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.consolidated, 0);
      assert.equal(llm.calls.length, 0);

      cleanup(ctx.tmpDir);
    });
  });

  describe("confidence decay", () => {
    it("applies decay during cycle", async () => {
      const ctx = await setup({ confidenceDecayRate: 0.1 });

      await ctx.store.create({
        category: "fact",
        content: "Old memory",
        sourceSessions: ["s1"],
        confidence: 0.8,
        tags: [],
      });

      // Force the entry to have an old lastAccessed timestamp
      const entries = ctx.store.getAll();
      entries[0]!.lastAccessed = Date.now() - 86_400_000 * 10; // 10 days ago

      const llm = createMockLlm([]);
      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.ok(result.decayed > 0, "should have decayed entries");
      // 0.8 - (0.1 * 10) = -0.2 → clamped to 0
      assert.equal(entries[0]!.confidence, 0);

      cleanup(ctx.tmpDir);
    });
  });

  describe("size budget pruning", () => {
    it("prunes when over budget", async () => {
      const ctx = await setup({ maxLongTermEntries: 3, confidenceDecayRate: 0 });

      // Create 5 entries with recent lastAccessed to avoid decay interference
      for (let i = 0; i < 5; i++) {
        await ctx.store.create({
          category: "fact",
          content: `Entry ${i}`,
          sourceSessions: ["s1"],
          confidence: (i + 1) * 0.2, // 0.2, 0.4, 0.6, 0.8, 1.0
          tags: [],
        });
      }

      const llm = createMockLlm([]);
      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      assert.equal(result.pruned, 2); // 5 - 3 = 2 pruned
      assert.equal(ctx.store.count, 3);

      // Lowest confidence entries should be removed
      const remaining = ctx.store.getAll();
      const confidences = remaining.map((e) => e.confidence);
      assert.ok(confidences.every((c) => c >= 0.6), "lowest confidence entries should be pruned");

      cleanup(ctx.tmpDir);
    });
  });

  describe("rate limiting", () => {
    it("respects maxLlmCallsPerCycle", async () => {
      const ctx = await setup();

      // Create 3 idle sessions with history
      for (let i = 0; i < 3; i++) {
        const session = await ctx.sessionManager.getOrCreate("test", `chan${i}`, "user1");
        await ctx.sessionManager.appendToLog(session.id, {
          type: "inbound",
          message: {
            id: `${i}`, adapterId: "test", channelId: `chan${i}`,
            senderId: "user1", text: `Message ${i}`, timestamp: Date.now(),
          },
        });
      }
      await new Promise((r) => setTimeout(r, 80));

      const llm = createMockLlm([
        JSON.stringify([{ category: "fact", content: "Fact 1", confidence: 0.8, tags: [] }]),
        JSON.stringify([{ category: "fact", content: "Fact 2", confidence: 0.8, tags: [] }]),
        JSON.stringify([{ category: "fact", content: "Fact 3", confidence: 0.8, tags: [] }]),
        // Consolidation calls (shouldn't happen due to rate limit)
        "[]",
      ]);

      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
        maxLlmCallsPerCycle: 2, // only allow 2 LLM calls
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      // Should only distill 2 of 3 sessions due to rate limit
      assert.equal(result.distilledSessions, 2);
      assert.equal(llm.calls.length, 2);

      cleanup(ctx.tmpDir);
    });
  });

  describe("logging", () => {
    it("all LLM calls are logged as memory:curation", async () => {
      const ctx = await setup();

      const session = await ctx.sessionManager.getOrCreate("test", "chan1", "user1");
      await ctx.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message: {
          id: "1", adapterId: "test", channelId: "chan1",
          senderId: "user1", text: "test", timestamp: Date.now(),
        },
      });
      await new Promise((r) => setTimeout(r, 80));

      const llm = createMockLlm([
        JSON.stringify([{ category: "fact", content: "test fact", confidence: 0.8, tags: [] }]),
      ]);

      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      // Every curation-related log should be memory:curation
      const curationLogs = ctx.logger.logs.filter(
        (l) => l["component"] === "curation-worker",
      );
      for (const log of curationLogs) {
        assert.equal(log["eventType"], "memory:curation", `Expected memory:curation, got ${String(log["eventType"])}`);
      }

      cleanup(ctx.tmpDir);
    });

    it("logs cycle_complete with summary", async () => {
      const ctx = await setup();

      const llm = createMockLlm([]);
      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      await worker.runCycle();
      await worker.stop();

      const completeLog = ctx.logger.logs.find(
        (l) => (l["payload"] as Record<string, unknown>)["action"] === "cycle_complete",
      );
      assert.ok(completeLog, "should log cycle_complete");
      const payload = completeLog["payload"] as Record<string, unknown>;
      assert.equal(typeof payload["distilledSessions"], "number");
      assert.equal(typeof payload["entriesCreated"], "number");
      assert.equal(typeof payload["decayed"], "number");
      assert.equal(typeof payload["pruned"], "number");

      cleanup(ctx.tmpDir);
    });
  });

  describe("full cycle integration", () => {
    it("idle session → distillation → memory entry → persist", async () => {
      const ctx = await setup();

      // Create session with conversation
      const session = await ctx.sessionManager.getOrCreate("test", "chan1", "user1");
      await ctx.sessionManager.appendToLog(session.id, {
        type: "inbound",
        message: {
          id: "1", adapterId: "test", channelId: "chan1",
          senderId: "user1", text: "My favorite programming language is TypeScript",
          timestamp: Date.now(),
        },
      });
      await ctx.sessionManager.appendToLog(session.id, {
        type: "outbound",
        message: { channelId: "chan1", text: "Great choice!" },
      });

      // Wait for idle
      await new Promise((r) => setTimeout(r, 80));

      const llm = createMockLlm([
        JSON.stringify([
          { category: "preference", content: "User's favorite language is TypeScript", confidence: 0.9, tags: ["programming", "typescript"] },
        ]),
      ]);

      const worker = new CurationWorker({
        store: ctx.store,
        sessionManager: ctx.sessionManager,
        llmClient: llm,
        config: ctx.config,
        logger: ctx.logger,
      });

      await worker.start();
      const result = await worker.runCycle();
      await worker.stop();

      // Verify the full pipeline
      assert.equal(result.distilledSessions, 1);
      assert.equal(result.entriesCreated, 1);
      assert.equal(ctx.store.count, 1);

      const entry = ctx.store.getAll()[0]!;
      assert.equal(entry.category, "preference");
      assert.ok(entry.content.includes("TypeScript"));
      assert.ok(entry.sourceSessions.includes(session.id));
      assert.deepEqual([...entry.tags], ["programming", "typescript"]);

      // Verify the session was closed
      assert.equal(ctx.sessionManager.get(session.id), undefined);

      // Verify data was persisted to disk
      const persisted = new LongTermStore({
        directory: path.join(ctx.tmpDir, "memory"),
        config: ctx.config,
        logger: ctx.logger,
      });
      await persisted.load();
      assert.equal(persisted.count, 1);
      assert.equal(persisted.getAll()[0]!.content, entry.content);

      cleanup(ctx.tmpDir);
    });
  });
});
