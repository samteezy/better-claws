import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolExecutor } from "../../src/tools/executor.js";
import type { ToolHandler, ExecutionContext } from "../../src/types.js";
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

describe("ToolExecutor abort signal support", () => {
  let tempDir: string;
  let scratchBaseDir: string;
  let mockLogger: ReturnType<typeof createMockLogger>;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "executor-abort-test-"));
    scratchBaseDir = join(tempDir, "scratch");
    await mkdir(scratchBaseDir);
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe("pre-aborted signal", () => {
    it("returns success: false when signal is already aborted (wins race)", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();
      controller.abort();

      const handler: ToolHandler = {
        execute: async () => {
          // Delay so the abort promise wins the race
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          return {
            success: true,
            output: { data: "should not see this" },
            durationMs: 100,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-preabort",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      const result = await executor.execute(handler, {}, context);

      assert.equal(result.success, false);
      assert.match(
        result.error || "",
        /stopped by user/i,
        "Error should mention execution stopped by user",
      );
      assert.equal(result.output, null);
      assert.ok(result.durationMs >= 0);
    });

    it("logs executor:result with aborted: true for pre-aborted signals", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();
      controller.abort();

      const handler: ToolHandler = {
        execute: async () => {
          // Delay so abort promise wins the race
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          return {
            success: true,
            output: null,
            durationMs: 100,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-preabort-log",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      await executor.execute(handler, {}, context);

      const resultEvent = mockLogger.calls.find(
        (c) => c.eventType === "executor:result",
      );
      assert.ok(resultEvent !== undefined);
      assert.equal(resultEvent?.payload.success, false);
      assert.equal(resultEvent?.payload.aborted, true);
    });

    it("abort promise rejects before handler completes when signal is pre-aborted", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();
      controller.abort();

      let handlerCompleted = false;

      const handler: ToolHandler = {
        execute: async () => {
          // Delay to ensure abort promise wins the race
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          handlerCompleted = true;
          return {
            success: true,
            output: null,
            durationMs: 100,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-never-call",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      const result = await executor.execute(handler, {}, context);

      // Handler is called but doesn't complete before abort wins race
      assert.equal(handlerCompleted, false, "Handler should not complete");
      assert.equal(result.success, false);
    });
  });

  describe("signal abort during execution", () => {
    it("aborts mid-execution when signal fires during handler", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();

      const handler: ToolHandler = {
        execute: async () => {
          // Wait for signal to be aborted
          await new Promise((resolve) => {
            const checkInterval = setInterval(() => {
              if (controller.signal.aborted) {
                clearInterval(checkInterval);
                resolve(null);
              }
            }, 10);
          });

          // This should not be reached since abort happens first
          return {
            success: true,
            output: { completed: true },
            durationMs: 100,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-abort-during",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      // Start execution and abort after a short delay
      setTimeout(() => {
        controller.abort();
      }, 50);

      const result = await executor.execute(handler, {}, context);

      assert.equal(result.success, false);
      assert.match(
        result.error || "",
        /stopped by user/i,
        "Should abort with user stopped message",
      );
      assert.ok(result.durationMs < 500); // Should be quick
    });

    it("races abort signal against timeout correctly", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();

      const handler: ToolHandler = {
        execute: async () => {
          // Wait 2 seconds
          await new Promise((resolve) => {
            setTimeout(resolve, 2000);
          });
          return {
            success: true,
            output: null,
            durationMs: 2000,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-abort-vs-timeout",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      // Abort after 500ms (before both timeout and handler completion)
      setTimeout(() => {
        controller.abort();
      }, 500);

      const result = await executor.execute(handler, {}, context);

      assert.equal(result.success, false);
      // Should be aborted, not timed out
      assert.match(
        result.error || "",
        /stopped by user/i,
        "Should report user stopped, not timeout",
      );
      assert.ok(
        result.durationMs < 2000,
        "Duration should be less than handler wait time",
      );
    });

    it("returns success: false on signal abort", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();

      const handler: ToolHandler = {
        execute: async () => {
          // Simulate long-running work
          await new Promise((resolve) => {
            setTimeout(resolve, 1000);
          });
          return {
            success: true,
            output: { data: "test" },
            durationMs: 1000,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-abort-result",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      setTimeout(() => {
        controller.abort();
      }, 100);

      const result = await executor.execute(handler, {}, context);

      assert.equal(result.success, false, "Result should have success: false");
      assert.equal(result.output, null);
      assert.ok(result.error);
    });
  });

  describe("without signal", () => {
    it("works normally when signal is not provided", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const handler: ToolHandler = {
        execute: async () => ({
          success: true,
          output: { result: "completed" },
          durationMs: 10,
        }),
      };

      const context: ExecutionContext = {
        sessionId: "session-no-signal",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        // signal is undefined
      };

      const result = await executor.execute(handler, {}, context);

      assert.equal(result.success, true);
      assert.deepEqual(result.output, { result: "completed" });
      assert.equal(result.error, undefined);
    });

    it("handler completes successfully without signal", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      let executed = false;

      const handler: ToolHandler = {
        execute: async () => {
          executed = true;
          return {
            success: true,
            output: null,
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-no-signal-exec",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      assert.equal(executed, true, "Handler should have executed");
    });
  });

  describe("abort error message", () => {
    it("error message is exactly 'Execution stopped by user' on abort", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();
      controller.abort();

      const handler: ToolHandler = {
        execute: async () => {
          // Delay so abort promise wins the race
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          return {
            success: true,
            output: null,
            durationMs: 100,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-error-msg",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      const result = await executor.execute(handler, {}, context);

      assert.strictEqual(
        result.error,
        "Execution stopped by user",
        "Error message should be exactly 'Execution stopped by user'",
      );
    });
  });

  describe("logging on abort", () => {
    it("logs executor:start event when signal is provided", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();
      controller.abort();

      const handler: ToolHandler = {
        execute: async () => ({
          success: true,
          output: null,
          durationMs: 10,
        }),
      };

      const context: ExecutionContext = {
        sessionId: "session-start-log",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      await executor.execute(handler, {}, context);

      const startEvent = mockLogger.calls.find(
        (c) => c.eventType === "executor:start",
      );
      assert.ok(startEvent !== undefined);
      assert.equal(startEvent?.component, "executor");
      assert.equal(startEvent?.sessionId, "session-start-log");
    });

    it("logs executor:result with aborted: true on abort", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();
      controller.abort();

      const handler: ToolHandler = {
        execute: async () => {
          // Delay so abort promise wins the race
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          return {
            success: true,
            output: null,
            durationMs: 100,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-abort-log",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      await executor.execute(handler, {}, context);

      const resultEvent = mockLogger.calls.find(
        (c) => c.eventType === "executor:result",
      );
      assert.ok(resultEvent !== undefined);
      assert.equal(resultEvent?.payload.success, false);
      assert.equal(resultEvent?.payload.aborted, true);
      assert.equal(resultEvent?.component, "executor");
      assert.equal(resultEvent?.sessionId, "session-abort-log");
    });

    it("includes durationMs in abort log", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();
      controller.abort();

      const handler: ToolHandler = {
        execute: async () => {
          // Delay so abort promise wins the race
          await new Promise((resolve) => {
            setTimeout(resolve, 100);
          });
          return {
            success: true,
            output: null,
            durationMs: 100,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-abort-duration",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      await executor.execute(handler, {}, context);

      const resultEvent = mockLogger.calls.find(
        (c) => c.eventType === "executor:result",
      );
      assert.ok(resultEvent !== undefined);
      assert.ok(typeof resultEvent?.payload.durationMs === "number");
      assert.ok(resultEvent?.payload.durationMs >= 0);
    });
  });

  describe("signal is passed through context", () => {
    it("handler receives signal in context when provided", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const controller = new AbortController();
      let receivedSignal: AbortSignal | undefined;

      const handler: ToolHandler = {
        execute: async (_params, context) => {
          receivedSignal = context.signal;
          return {
            success: true,
            output: null,
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-signal-pass",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
        signal: controller.signal,
      };

      await executor.execute(handler, {}, context);

      assert.equal(receivedSignal, controller.signal);
    });

    it("handler receives undefined signal when not provided", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      let receivedSignal: AbortSignal | undefined = "not-checked" as unknown as AbortSignal;

      const handler: ToolHandler = {
        execute: async (_params, context) => {
          receivedSignal = context.signal;
          return {
            success: true,
            output: null,
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-no-signal-pass",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      assert.equal(receivedSignal, undefined);
    });
  });
});
