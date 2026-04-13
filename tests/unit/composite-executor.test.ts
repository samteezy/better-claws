import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CompositeExecutor } from "../../src/tools/composite-executor.js";
import type { ToolHandler, ExecutionContext, ToolResult } from "../../src/types.js";
import type { StructuredLogger } from "../../src/logger/structured-logger.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

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

// ── Test Fixtures ───────────────────────────────────────────────────────────

function createTestContext(overrides?: Partial<ExecutionContext>): ExecutionContext {
  return {
    sessionId: overrides?.sessionId ?? "test-session",
    capabilities: overrides?.capabilities ?? [],
    scratchDir: overrides?.scratchDir ?? "/tmp/scratch",
    timeout: overrides?.timeout ?? 5000,
    secrets: overrides?.secrets ?? new Map<string, string>(),
  };
}

function createSimpleHandler(): ToolHandler {
  return {
    execute: async () => ({
      success: true,
      output: { test: "data" },
      durationMs: 5,
    }),
  };
}

interface ExecutorSpies {
  inProcess: {
    execute: (h: ToolHandler, p: unknown, c: ExecutionContext) => Promise<ToolResult>;
  };
  forked: {
    execute: (path: string, p: unknown, c: ExecutionContext) => Promise<ToolResult>;
  };
}

function getExecutorSpies(executor: unknown): ExecutorSpies {
  const executorAsAny = executor as unknown as Record<string, unknown>;
  return {
    inProcess: executorAsAny["inProcess"] as unknown as ExecutorSpies["inProcess"],
    forked: executorAsAny["forked"] as unknown as ExecutorSpies["forked"],
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("CompositeExecutor", () => {
  let tempDir: string;
  let scratchBaseDir: string;
  let handlersDir: string;
  let mockLogger: ReturnType<typeof createMockLogger>;

  describe("routing logic", () => {
    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "composite-executor-test-"));
      scratchBaseDir = join(tempDir, "scratch");
      handlersDir = join(tempDir, "handlers");
      mockLogger = createMockLogger();
      await mkdir(scratchBaseDir);
      await mkdir(handlersDir);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("delegates to ForkedExecutor when useForkedExecution is true and handlerPath is not null", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: true,
      });

      const spies = getExecutorSpies(executor);

      // Track which executor was called
      let inProcessCalled = false;
      let forkedCalled = false;

      const originalInProcess = spies.inProcess.execute;

      spies.inProcess.execute = async (h, p, c) => {
        inProcessCalled = true;
        return originalInProcess.call(spies.inProcess, h, p, c);
      };

      spies.forked.execute = async (path, _p, _c) => {
        forkedCalled = true;
        return {
          success: true,
          output: { forked: true, path },
          durationMs: 10,
        };
      };

      const handler = createSimpleHandler();
      const context = createTestContext();

      await executor.execute(handler, "/path/to/handler.js", {}, context);

      assert.equal(forkedCalled, true, "ForkedExecutor should have been called");
      assert.equal(inProcessCalled, false, "ToolExecutor should not have been called");
    });

    it("delegates to ToolExecutor when handlerPath is null", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: true,
      });

      const spies = getExecutorSpies(executor);

      // Track which executor was called
      let inProcessCalled = false;
      let forkedCalled = false;

      const originalInProcess = spies.inProcess.execute;

      inProcessCalled = false;
      spies.inProcess.execute = async (h, p, c) => {
        inProcessCalled = true;
        return originalInProcess.call(spies.inProcess, h, p, c);
      };

      spies.forked.execute = async (_path, _p, _c) => {
        forkedCalled = true;
        return {
          success: true,
          output: { forked: true },
          durationMs: 10,
        };
      };

      const handler = createSimpleHandler();
      const context = createTestContext();

      await executor.execute(handler, null, {}, context);

      assert.equal(inProcessCalled, true, "ToolExecutor should have been called");
      assert.equal(forkedCalled, false, "ForkedExecutor should not have been called");
    });

    it("delegates to ToolExecutor when useForkedExecution is false even with handlerPath", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: false,
      });

      const spies = getExecutorSpies(executor);

      // Track which executor was called
      let inProcessCalled = false;
      let forkedCalled = false;

      const originalInProcess = spies.inProcess.execute;

      spies.inProcess.execute = async (h, p, c) => {
        inProcessCalled = true;
        return originalInProcess.call(spies.inProcess, h, p, c);
      };

      spies.forked.execute = async (_path, _p, _c) => {
        forkedCalled = true;
        return {
          success: true,
          output: { forked: true },
          durationMs: 10,
        };
      };

      const handler = createSimpleHandler();
      const context = createTestContext();

      // Even with a handlerPath, should use in-process
      await executor.execute(handler, "/path/to/handler.js", {}, context);

      assert.equal(inProcessCalled, true, "ToolExecutor should have been called");
      assert.equal(forkedCalled, false, "ForkedExecutor should not have been called");
    });

    it("defaults useForkedExecution to true when not provided", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        // useForkedExecution not provided
      });

      // Access private fields to verify default
      const executorAsAny = executor as unknown as Record<string, unknown>;
      const useForkedExecution = executorAsAny["useForkedExecution"] as boolean;

      assert.equal(
        useForkedExecution,
        true,
        "useForkedExecution should default to true",
      );
    });
  });

  describe("routing decision matrix", () => {
    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "composite-matrix-test-"));
      scratchBaseDir = join(tempDir, "scratch");
      handlersDir = join(tempDir, "handlers");
      mockLogger = createMockLogger();
      await mkdir(scratchBaseDir);
      await mkdir(handlersDir);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("uses in-process when useForkedExecution=true, handlerPath=null", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: true,
      });

      const spies = getExecutorSpies(executor);

      let calledExecutor: string = "";

      const originalInProcess = spies.inProcess.execute;
      spies.inProcess.execute = async (h, p, c) => {
        calledExecutor = "in-process";
        return originalInProcess.call(spies.inProcess, h, p, c);
      };

      spies.forked.execute = async (_path, _p, _c) => {
        calledExecutor = "forked";
        return { success: true, output: null, durationMs: 1 };
      };

      const handler = createSimpleHandler();
      const context = createTestContext();

      await executor.execute(handler, null, {}, context);

      assert.equal(calledExecutor, "in-process");
    });

    it("uses forked when useForkedExecution=true, handlerPath=provided", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: true,
      });

      const spies = getExecutorSpies(executor);

      let calledExecutor: string = "";

      spies.inProcess.execute = async (_h, _p, _c) => {
        calledExecutor = "in-process";
        return { success: true, output: null, durationMs: 1 };
      };

      spies.forked.execute = async (_path, _p, _c) => {
        calledExecutor = "forked";
        return { success: true, output: null, durationMs: 1 };
      };

      const handler = createSimpleHandler();
      const context = createTestContext();

      await executor.execute(handler, "/path/to/handler.js", {}, context);

      assert.equal(calledExecutor, "forked");
    });

    it("uses in-process when useForkedExecution=false, handlerPath=null", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: false,
      });

      const spies = getExecutorSpies(executor);

      let calledExecutor: string = "";

      const originalInProcess = spies.inProcess.execute;
      spies.inProcess.execute = async (h, p, c) => {
        calledExecutor = "in-process";
        return originalInProcess.call(spies.inProcess, h, p, c);
      };

      spies.forked.execute = async (_path, _p, _c) => {
        calledExecutor = "forked";
        return { success: true, output: null, durationMs: 1 };
      };

      const handler = createSimpleHandler();
      const context = createTestContext();

      await executor.execute(handler, null, {}, context);

      assert.equal(calledExecutor, "in-process");
    });

    it("uses in-process when useForkedExecution=false, handlerPath=provided", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: false,
      });

      const spies = getExecutorSpies(executor);

      let calledExecutor: string = "";

      const originalInProcess = spies.inProcess.execute;
      spies.inProcess.execute = async (h, p, c) => {
        calledExecutor = "in-process";
        return originalInProcess.call(spies.inProcess, h, p, c);
      };

      spies.forked.execute = async (_path, _p, _c) => {
        calledExecutor = "forked";
        return { success: true, output: null, durationMs: 1 };
      };

      const handler = createSimpleHandler();
      const context = createTestContext();

      // Even with a path, should use in-process
      await executor.execute(handler, "/path/to/handler.js", {}, context);

      assert.equal(calledExecutor, "in-process");
    });
  });

  describe("executor configuration", () => {
    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "composite-config-test-"));
      scratchBaseDir = join(tempDir, "scratch");
      mockLogger = createMockLogger();
      await mkdir(scratchBaseDir);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("constructs ToolExecutor with provided options", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir: "/tmp/scratch",
        defaultTimeout: 3000,
        stripEnvironment: false,
        logger: mockLogger,
        useForkedExecution: false,
      });

      // Verify the executor was constructed (smoke test)
      assert.ok(executor);

      const executorAsAny = executor as unknown as Record<string, unknown>;
      const inProcess = executorAsAny["inProcess"] as unknown;
      assert.ok(inProcess !== undefined);
    });

    it("constructs ForkedExecutor with provided options", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir: "/tmp/scratch",
        defaultTimeout: 7000,
        stripEnvironment: true,
        logger: mockLogger,
        maxMemoryMb: 256,
        useForkedExecution: true,
      });

      // Verify both executors were constructed
      assert.ok(executor);

      const executorAsAny = executor as unknown as Record<string, unknown>;
      const forked = executorAsAny["forked"] as unknown;
      assert.ok(forked !== undefined);
    });

    it("handles maxMemoryMb option correctly", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        maxMemoryMb: 512,
      });

      // Just verify it constructs without error
      assert.ok(executor);
    });
  });

  describe("parameter passing", () => {
    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "composite-params-test-"));
      scratchBaseDir = join(tempDir, "scratch");
      mockLogger = createMockLogger();
      await mkdir(scratchBaseDir);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("passes handler and params to in-process executor", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: false,
      });

      const spies = getExecutorSpies(executor);

      let receivedHandler: ToolHandler | null = null;
      let receivedParams: Record<string, unknown> | null = null;

      const originalExecute = spies.inProcess.execute;
      spies.inProcess.execute = async (h, p, c) => {
        receivedHandler = h;
        receivedParams = p as Record<string, unknown>;
        return originalExecute.call(spies.inProcess, h, p, c);
      };

      const handler = createSimpleHandler();
      const params = { key: "value", nested: { data: 42 } };
      const context = createTestContext();

      await executor.execute(handler, null, params, context);

      assert.equal(receivedHandler, handler);
      assert.deepEqual(receivedParams, params);
    });

    it("passes handlerPath and params to forked executor", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: true,
      });

      const spies = getExecutorSpies(executor);

      let receivedPath: string | null = null;
      let receivedParams: Record<string, unknown> | null = null;

      spies.forked.execute = async (path, p, _c) => {
        receivedPath = path;
        receivedParams = p as Record<string, unknown>;
        return { success: true, output: null, durationMs: 1 };
      };

      const handler = createSimpleHandler();
      const params = { input: "data" };
      const context = createTestContext();
      const handlerPath = "/path/to/handler.js";

      await executor.execute(handler, handlerPath, params, context);

      assert.equal(receivedPath, handlerPath);
      assert.deepEqual(receivedParams, params);
    });

    it("passes execution context to selected executor", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: false,
      });

      const spies = getExecutorSpies(executor);

      let receivedContext: ExecutionContext | null = null;

      const originalExecute = spies.inProcess.execute;
      spies.inProcess.execute = async (h, p, c) => {
        receivedContext = c;
        return originalExecute.call(spies.inProcess, h, p, c);
      };

      const handler = createSimpleHandler();
      const context = createTestContext({
        sessionId: "custom-session",
        capabilities: ["fs:read", "fs:write"],
        timeout: 3000,
      });

      await executor.execute(handler, null, {}, context);

      assert.ok(receivedContext !== null);
      const ctx = receivedContext as ExecutionContext;
      assert.equal(ctx.sessionId, "custom-session");
      assert.deepEqual(ctx.capabilities, ["fs:read", "fs:write"]);
      assert.equal(ctx.timeout, 3000);
    });
  });

  describe("result handling", () => {
    beforeEach(async () => {
      tempDir = await mkdtemp(join(tmpdir(), "composite-result-test-"));
      scratchBaseDir = join(tempDir, "scratch");
      mockLogger = createMockLogger();
      await mkdir(scratchBaseDir);
    });

    afterEach(async () => {
      await rm(tempDir, { recursive: true, force: true });
    });

    it("returns result from in-process executor unchanged", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: false,
      });

      const handler = createSimpleHandler();
      const context = createTestContext();

      const result = await executor.execute(handler, null, {}, context);

      assert.equal(result.success, true);
      assert.ok(result.output !== undefined);
      assert.ok(result.durationMs >= 0);
      assert.equal(result.error, undefined);
    });

    it("returns result from forked executor unchanged", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: true,
      });

      const spies = getExecutorSpies(executor);

      const testResult: ToolResult = {
        success: true,
        output: { test: "data" },
        durationMs: 42,
      };

      spies.forked.execute = async () => testResult;

      const handler = createSimpleHandler();
      const context = createTestContext();

      const result = await executor.execute(
        handler,
        "/path/to/handler.js",
        {},
        context,
      );

      assert.deepEqual(result, testResult);
    });

    it("propagates error results from in-process executor", async () => {
      const executor = new CompositeExecutor({
        scratchBaseDir,
        defaultTimeout: 5000,
        stripEnvironment: true,
        logger: mockLogger,
        useForkedExecution: false,
      });

      const spies = getExecutorSpies(executor);

      const errorResult: ToolResult = {
        success: false,
        output: null,
        error: "Handler failed",
        durationMs: 100,
      };

      spies.inProcess.execute = async () => errorResult;

      const handler = createSimpleHandler();
      const context = createTestContext();

      const result = await executor.execute(handler, null, {}, context);

      assert.equal(result.success, false);
      assert.equal(result.error, "Handler failed");
    });
  });
});
