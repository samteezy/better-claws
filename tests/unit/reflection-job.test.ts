import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ReflectionJob } from "../../src/router/reflection-job.js";
import type { AgendaItem, ChatMessage, SessionState } from "../../src/types.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";
import type { LongTermStore } from "../../src/memory/long-term-store.js";
import type { AgendaStore } from "../../src/memory/agenda-store.js";

function mockLogger(): StructuredLogger {
  return { log(): void {}, async flush(): Promise<void> {}, async close(): Promise<void> {} } as unknown as StructuredLogger;
}

function mockAgendaStore(): AgendaStore {
  return {} as unknown as AgendaStore;
}

function mockSession(): SessionState {
  return {
    id: "session-1",
    adapterId: "cli",
    channelId: "cli",
    senderId: "user1",
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    capabilityGrants: new Map(),
    toolPolicyOverrides: new Map(),
  };
}

const HISTORY: readonly ChatMessage[] = [
  { role: "user", content: "Can you help me fix the login bug?" },
  { role: "assistant", content: "Sure, the issue is in auth.ts line 42. I've explained the fix." },
];

describe("ReflectionJob", () => {
  describe("run", () => {
    it("returns taskComplete:false on empty history", async () => {
      const llmClient = {
        async chat(): Promise<{ message: ChatMessage }> {
          throw new Error("should not be called");
        },
      };
      const createdEntries: unknown[] = [];
      const store = {
        async create(input: unknown): Promise<string> { createdEntries.push(input); return "id-1"; },
      } as unknown as LongTermStore;

      const job = new ReflectionJob(llmClient, mockAgendaStore(), store, mockLogger(), {});
      const result = await job.run(mockSession(), [], [], undefined);
      assert.equal(result.taskComplete, false);
      assert.equal(createdEntries.length, 0);
    });

    it("returns taskComplete:false when signal is already aborted", async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const llmClient = {
        async chat(): Promise<{ message: ChatMessage }> {
          throw new Error("should not be called");
        },
      };
      const store = { async create(): Promise<string> { return "id"; } } as unknown as LongTermStore;
      const job = new ReflectionJob(llmClient, mockAgendaStore(), store, mockLogger(), {});
      const result = await job.run(mockSession(), HISTORY, [], ctrl.signal);
      assert.equal(result.taskComplete, false);
    });

    it("parses taskComplete and completionSummary from LLM output", async () => {
      const llmOutput = JSON.stringify({
        taskComplete: true,
        completionSummary: "Explained the login bug fix in auth.ts",
        nudgeItemId: undefined,
        memoryCandidate: undefined,
        selfPattern: undefined,
      });
      const llmClient = {
        async chat(): Promise<{ message: ChatMessage }> {
          return { message: { role: "assistant", content: llmOutput } };
        },
      };
      const createdEntries: Array<{ category: string; tags: readonly string[] }> = [];
      const store = {
        async create(input: { category: string; tags: readonly string[] }): Promise<string> {
          createdEntries.push(input);
          return "id-1";
        },
      } as unknown as LongTermStore;

      const job = new ReflectionJob(llmClient, mockAgendaStore(), store, mockLogger(), {});
      const result = await job.run(mockSession(), HISTORY, [], undefined);

      assert.equal(result.taskComplete, true);
      assert.equal(result.completionSummary, "Explained the login bug fix in auth.ts");
      assert.equal(createdEntries.length, 1);
      assert.equal(createdEntries[0]!.category, "fact");
      assert.ok((createdEntries[0]!.tags as string[]).includes("reflect:candidate"));
    });

    it("writes self-memory entry when selfPattern present", async () => {
      const llmOutput = JSON.stringify({
        taskComplete: false,
        selfPattern: "I consistently struggle with TypeScript generics",
      });
      const llmClient = {
        async chat(): Promise<{ message: ChatMessage }> {
          return { message: { role: "assistant", content: llmOutput } };
        },
      };
      const createdEntries: Array<{ category: string; tags: readonly string[] }> = [];
      const store = {
        async create(input: { category: string; tags: readonly string[] }): Promise<string> {
          createdEntries.push(input);
          return "id-1";
        },
      } as unknown as LongTermStore;

      const job = new ReflectionJob(llmClient, mockAgendaStore(), store, mockLogger(), {});
      const result = await job.run(mockSession(), HISTORY, [], undefined);

      assert.equal(result.selfPattern, "I consistently struggle with TypeScript generics");
      const selfEntry = createdEntries.find((e) => e.category === "self");
      assert.ok(selfEntry !== undefined);
      assert.ok((selfEntry.tags as string[]).includes("agent:self"));
    });

    it("returns nudgeItemId from LLM output", async () => {
      const pendingItems: AgendaItem[] = [
        {
          id: "agenda-42",
          senderId: "user1",
          type: "follow-up",
          content: "Check deployment status",
          status: "pending",
          priority: "normal",
          addedAt: Date.now(),
          updatedAt: Date.now(),
        },
      ];
      const llmOutput = JSON.stringify({
        taskComplete: false,
        nudgeItemId: "agenda-42",
        nudgeRationale: "Good time to check in",
      });
      const llmClient = {
        async chat(): Promise<{ message: ChatMessage }> {
          return { message: { role: "assistant", content: llmOutput } };
        },
      };
      const store = { async create(): Promise<string> { return "id"; } } as unknown as LongTermStore;

      const job = new ReflectionJob(llmClient, mockAgendaStore(), store, mockLogger(), {});
      const result = await job.run(mockSession(), HISTORY, pendingItems, undefined);

      assert.equal(result.nudgeItemId, "agenda-42");
      assert.equal(result.nudgeRationale, "Good time to check in");
    });

    it("handles malformed LLM JSON gracefully", async () => {
      const llmClient = {
        async chat(): Promise<{ message: ChatMessage }> {
          return { message: { role: "assistant", content: "not valid json }" } };
        },
      };
      const store = { async create(): Promise<string> { return "id"; } } as unknown as LongTermStore;

      const job = new ReflectionJob(llmClient, mockAgendaStore(), store, mockLogger(), {});
      const result = await job.run(mockSession(), HISTORY, [], undefined);
      assert.equal(result.taskComplete, false);
    });

    it("strips markdown fences from LLM output", async () => {
      const inner = JSON.stringify({ taskComplete: true, completionSummary: "Done" });
      const llmClient = {
        async chat(): Promise<{ message: ChatMessage }> {
          return { message: { role: "assistant", content: "```json\n" + inner + "\n```" } };
        },
      };
      const store = { async create(): Promise<string> { return "id"; } } as unknown as LongTermStore;

      const job = new ReflectionJob(llmClient, mockAgendaStore(), store, mockLogger(), {});
      const result = await job.run(mockSession(), HISTORY, [], undefined);
      assert.equal(result.taskComplete, true);
    });

    it("handles LLM error gracefully", async () => {
      const llmClient = {
        async chat(): Promise<{ message: ChatMessage }> {
          throw new Error("LLM timeout");
        },
      };
      const store = { async create(): Promise<string> { return "id"; } } as unknown as LongTermStore;

      const job = new ReflectionJob(llmClient, mockAgendaStore(), store, mockLogger(), {});
      const result = await job.run(mockSession(), HISTORY, [], undefined);
      assert.equal(result.taskComplete, false);
    });
  });
});
