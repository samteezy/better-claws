import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolExecutor } from "../../src/tools/executor.js";
import type { ToolHandler, ExecutionContext, ToolResult } from "../../src/types.js";
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

describe("ToolExecutor", () => {
  let tempDir: string;
  let scratchBaseDir: string;
  let mockLogger: ReturnType<typeof createMockLogger>;

  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "executor-test-"));
    scratchBaseDir = join(tempDir, "scratch");
    await mkdir(scratchBaseDir);
  });

  after(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockLogger = createMockLogger();
  });

  describe("execute()", () => {
    it("successful execution returns ToolResult with success: true", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const handler: ToolHandler = {
        execute: async (params, context) => {
          return {
            success: true,
            output: { received: params, scratchDir: context.scratchDir },
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-123",
        capabilities: ["fs:read"],
        scratchDir: "", // Will be filled by executor
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      const result = await executor.execute(handler, { test: "input" }, context);

      assert.equal(result.success, true);
      assert.ok(result.output !== undefined);
      assert.ok(result.durationMs >= 0);
      assert.equal(result.error, undefined);
    });

    it("timeout enforcement: handler that takes too long produces timeout result", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 100, // 100ms timeout
        stripEnvironment: true,
        logger: mockLogger,
      });

      const handler: ToolHandler = {
        execute: async () => {
          // Simulate long-running operation
          await new Promise((resolve) => {
            setTimeout(resolve, 500); // Wait 500ms
          });
          return {
            success: true,
            output: null,
            durationMs: 500,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-timeout",
        capabilities: [],
        scratchDir: "",
        timeout: 100,
        secrets: new Map<string, string>(),
      };

      const result = await executor.execute(handler, {}, context);

      assert.equal(result.success, false);
      assert.ok(result.error !== undefined);
      assert.match(result.error, /timed out/i);
      assert.ok(result.durationMs < 500); // Should timeout before handler completes
    });

    it("scratch directory is created for execution", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      let capturedScratchDir: string | undefined;

      const handler: ToolHandler = {
        execute: async (params, context) => {
          capturedScratchDir = context.scratchDir;
          // Verify it's a real directory
          const stats = await stat(context.scratchDir);
          assert.ok(stats.isDirectory());
          return {
            success: true,
            output: null,
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-scratch",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      const result = await executor.execute(handler, {}, context);

      assert.equal(result.success, true);
      assert.ok(capturedScratchDir !== undefined);
    });

    it("scratch directory is cleaned up after execution", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      let capturedScratchDir: string | undefined;

      const handler: ToolHandler = {
        execute: async (params, context) => {
          capturedScratchDir = context.scratchDir;
          return {
            success: true,
            output: null,
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-cleanup",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      // Verify scratch directory was cleaned up
      assert.ok(capturedScratchDir !== undefined);
      try {
        await stat(capturedScratchDir);
        assert.fail("Scratch directory should have been cleaned up");
      } catch (err) {
        // Expected: directory should not exist
        assert.ok(
          err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ENOENT",
        );
      }
    });

    it("error in handler produces ToolResult with success: false", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const handler: ToolHandler = {
        execute: async () => {
          throw new Error("Handler error");
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-error",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      const result = await executor.execute(handler, {}, context);

      assert.equal(result.success, false);
      assert.ok(result.error !== undefined);
      assert.match(result.error, /Handler error/);
      assert.equal(result.output, null);
      assert.ok(result.durationMs >= 0);
    });

    it("scratch directory is cleaned up even on handler error", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      let capturedScratchDir: string | undefined;

      const handler: ToolHandler = {
        execute: async (params, context) => {
          capturedScratchDir = context.scratchDir;
          throw new Error("Test error");
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-error-cleanup",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      // Verify scratch directory was cleaned up despite error
      assert.ok(capturedScratchDir !== undefined);
      try {
        await stat(capturedScratchDir);
        assert.fail("Scratch directory should have been cleaned up after error");
      } catch (err) {
        assert.ok(
          err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ENOENT",
        );
      }
    });

    it("scratch directory is cleaned up even on timeout", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 100,
        stripEnvironment: true,
        logger: mockLogger,
      });

      let capturedScratchDir: string | undefined;

      const handler: ToolHandler = {
        execute: async (params, context) => {
          capturedScratchDir = context.scratchDir;
          await new Promise((resolve) => {
            setTimeout(resolve, 500);
          });
          return {
            success: true,
            output: null,
            durationMs: 500,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-timeout-cleanup",
        capabilities: [],
        scratchDir: "",
        timeout: 100,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      // Verify scratch directory was cleaned up despite timeout
      assert.ok(capturedScratchDir !== undefined);
      try {
        await stat(capturedScratchDir);
        assert.fail("Scratch directory should have been cleaned up after timeout");
      } catch (err) {
        assert.ok(
          err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ENOENT",
        );
      }
    });

    it("passes execution context with updated scratchDir and timeout to handler", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 10000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      let receivedContext: ExecutionContext | undefined;

      const handler: ToolHandler = {
        execute: async (params, context) => {
          receivedContext = context;
          return {
            success: true,
            output: null,
            durationMs: 10,
          };
        },
      };

      const originalContext: ExecutionContext = {
        sessionId: "session-context",
        capabilities: ["fs:read"],
        scratchDir: "", // Will be populated
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, originalContext);

      assert.ok(receivedContext !== undefined);
      assert.equal(receivedContext?.sessionId, "session-context");
      assert.deepEqual(receivedContext?.capabilities, ["fs:read"]);
      assert.ok(receivedContext?.scratchDir.length > 0);
      assert.ok(receivedContext?.scratchDir !== "");
      assert.equal(receivedContext?.timeout, 5000);
    });
  });

  describe("logging", () => {
    it("executor:start event is logged at execution start", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

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
      };

      await executor.execute(handler, {}, context);

      const startEvent = mockLogger.calls.find(
        (c) => c.eventType === "executor:start",
      );
      assert.ok(startEvent !== undefined);
      assert.equal(startEvent?.component, "executor");
      assert.equal(startEvent?.sessionId, "session-start-log");
      assert.ok(startEvent?.payload.scratchDir !== undefined);
      assert.equal(startEvent?.payload.timeout, 5000);
    });

    it("executor:result event is logged on successful execution", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const handler: ToolHandler = {
        execute: async () => ({
          success: true,
          output: { data: "test" },
          durationMs: 25,
        }),
      };

      const context: ExecutionContext = {
        sessionId: "session-result-log",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      const resultEvent = mockLogger.calls.find(
        (c) => c.eventType === "executor:result",
      );
      assert.ok(resultEvent !== undefined);
      assert.equal(resultEvent?.component, "executor");
      assert.equal(resultEvent?.sessionId, "session-result-log");
      assert.equal(resultEvent?.payload.success, true);
      assert.ok(resultEvent?.payload.durationMs !== undefined);
    });

    it("executor:result event is logged on handler error", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const handler: ToolHandler = {
        execute: async () => {
          throw new Error("Test handler error");
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-error-log",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      const resultEvent = mockLogger.calls.find(
        (c) => c.eventType === "executor:result",
      );
      assert.ok(resultEvent !== undefined);
      assert.equal(resultEvent?.component, "executor");
      assert.equal(resultEvent?.sessionId, "session-error-log");
      assert.equal(resultEvent?.payload.success, false);
      assert.ok((resultEvent?.payload.error as string).includes("Test handler error"));
    });

    it("executor:timeout event is logged on timeout", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 100,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const handler: ToolHandler = {
        execute: async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 500);
          });
          return {
            success: true,
            output: null,
            durationMs: 500,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-timeout-log",
        capabilities: [],
        scratchDir: "",
        timeout: 100,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      const timeoutEvent = mockLogger.calls.find(
        (c) => c.eventType === "executor:timeout",
      );
      assert.ok(timeoutEvent !== undefined);
      assert.equal(timeoutEvent?.component, "executor");
      assert.equal(timeoutEvent?.sessionId, "session-timeout-log");
      assert.equal(timeoutEvent?.payload.timeout, 100);
      assert.ok(timeoutEvent?.payload.durationMs !== undefined);
    });

    it("both executor:start and executor:result/executor:timeout are logged", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const handler: ToolHandler = {
        execute: async () => ({
          success: true,
          output: null,
          durationMs: 10,
        }),
      };

      const context: ExecutionContext = {
        sessionId: "session-multi-log",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      const startEvents = mockLogger.calls.filter(
        (c) => c.eventType === "executor:start",
      );
      const resultEvents = mockLogger.calls.filter(
        (c) => c.eventType === "executor:result",
      );

      assert.equal(startEvents.length, 1);
      assert.equal(resultEvents.length, 1);
    });
  });

  describe("handler params and context", () => {
    it("passes params to handler exactly as provided", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const testParams = {
        string: "value",
        number: 42,
        boolean: true,
        object: { nested: "data" },
        array: [1, 2, 3],
      };

      let receivedParams: Record<string, unknown> | undefined;

      const handler: ToolHandler = {
        execute: async (params) => {
          receivedParams = params;
          return {
            success: true,
            output: null,
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-params",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, testParams, context);

      assert.deepEqual(receivedParams, testParams);
    });

    it("preserves context capabilities", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      let receivedCapabilities: unknown;

      const handler: ToolHandler = {
        execute: async (params, context) => {
          receivedCapabilities = context.capabilities;
          return {
            success: true,
            output: null,
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-caps",
        capabilities: ["fs:read", "fs:write", "net:outbound"],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);

      assert.deepEqual(receivedCapabilities, ["fs:read", "fs:write", "net:outbound"]);
    });
  });

  describe("timing and duration", () => {
    it("ToolResult durationMs is approximately correct", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const handler: ToolHandler = {
        execute: async () => {
          await new Promise((resolve) => {
            setTimeout(resolve, 50);
          });
          return {
            success: true,
            output: null,
            durationMs: 50,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-timing",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      const result = await executor.execute(handler, {}, context);

      assert.ok(result.durationMs >= 50);
    });
  });

  describe("multiple executions", () => {
    it("can execute multiple handlers sequentially", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      let callCount = 0;

      const handler: ToolHandler = {
        execute: async () => {
          callCount++;
          return {
            success: true,
            output: { callNumber: callCount },
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-multi",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      const result1 = await executor.execute(handler, {}, context);
      const result2 = await executor.execute(handler, {}, context);
      const result3 = await executor.execute(handler, {}, context);

      assert.equal((result1.output as Record<string, unknown>).callNumber, 1);
      assert.equal((result2.output as Record<string, unknown>).callNumber, 2);
      assert.equal((result3.output as Record<string, unknown>).callNumber, 3);
    });

    it("each execution gets a unique scratch directory", async () => {
      const executor = new ToolExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
      });

      const scratchDirs: string[] = [];

      const handler: ToolHandler = {
        execute: async (params, context) => {
          scratchDirs.push(context.scratchDir);
          return {
            success: true,
            output: null,
            durationMs: 10,
          };
        },
      };

      const context: ExecutionContext = {
        sessionId: "session-unique-dirs",
        capabilities: [],
        scratchDir: "",
        timeout: 5000,
        secrets: new Map<string, string>(),
      };

      await executor.execute(handler, {}, context);
      await executor.execute(handler, {}, context);
      await executor.execute(handler, {}, context);

      assert.equal(scratchDirs.length, 3);
      assert.notEqual(scratchDirs[0], scratchDirs[1]);
      assert.notEqual(scratchDirs[1], scratchDirs[2]);
      assert.notEqual(scratchDirs[0], scratchDirs[2]);
    });
  });
});
